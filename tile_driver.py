#!/usr/bin/env python3
"""Run rio-rgbify or rio-terrarium over the tiles that actually hold data.

Both tilers enumerate every tile in the bounding box of their input and encode
each one, whether or not any source pixel reaches it. That is fine for a dense
DEM and ruinous for a sparse one: survey-line or coastal data can fill under a
percent of its bounding box, and the rest becomes tiles of flat FILL_VALUE that
cost time to make, space to keep and requests to serve.

gdal2NPtiles does not have this problem, because it is handed a raster whose
nodata is intact and skips tiles with nothing in them. The RGB encodings have
no way to say "no value", so the fill has to happen first, and by the time the
tiler sees the raster every pixel looks like data.

So the coverage is worked out here instead, from the footprints of the input
GeoTIFFs, and the tilers are pointed at that set. Their own enumeration is
replaced at the module level, which is where `run()` looks it up.

The footprints come from the mosaic VRT rather than from the GeoTIFFs. Opening
every input costs about 12 ms a file on a Windows bind mount, 7.5 minutes for
37,850 files, and the VRT already records where each one sits (#18).

The tilers' per-tile worker is replaced as well, so that low zooms read an
overview of the source instead of the full resolution raster (#17). Without
it, each tile that covers the whole extent reads every pixel of it, one worker
per tile: on a 30 Gpx raster z5-z7 had not produced a single tile after 50
minutes.
"""
import argparse
import sys
import xml.etree.ElementTree as ET

import mercantile
import numpy as np
import rasterio
from rasterio import transform
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.warp import reproject, transform_bounds


def vrt_footprints(vrt_path):
    """(crs, [(left, bottom, right, top), ...]) of the sources in a mosaic VRT.

    gdalbuildvrt writes each source's position as a DstRect in VRT pixels. The
    inputs sit on the VRT grid, so the offsets are whole pixels and the bounds
    come out exactly as rasterio reports them for the file itself.
    """
    root = ET.parse(vrt_path).getroot()
    srs = root.findtext("SRS")
    if not srs:
        sys.exit(f"tile_driver: {vrt_path} has no SRS")
    gt = [float(v) for v in root.findtext("GeoTransform").split(",")]
    if gt[2] or gt[4]:
        sys.exit(f"tile_driver: {vrt_path} is rotated, which is not supported")
    band = root.find("VRTRasterBand")
    boxes = []
    for source in band:
        rect = source.find("DstRect")
        if rect is None:
            continue
        x0, y0 = float(rect.get("xOff")), float(rect.get("yOff"))
        x1, y1 = x0 + float(rect.get("xSize")), y0 + float(rect.get("ySize"))
        left, right = gt[0] + x0 * gt[1], gt[0] + x1 * gt[1]
        top, bottom = gt[3] + y0 * gt[5], gt[3] + y1 * gt[5]
        boxes.append((left, bottom, right, top))
    return CRS.from_wkt(srs), boxes


def coverage_tiles(vrt_path, min_z, max_z):
    """Tiles touched by the footprint of any input raster."""
    crs, boxes = vrt_footprints(vrt_path)
    if not boxes:
        sys.exit(f"tile_driver: {vrt_path} lists no sources")
    keep = set()
    for box in boxes:
        w, s, e, n = transform_bounds(crs, "EPSG:4326", *box, densify_pts=21)
        for z in range(min_z, max_z + 1):
            for t in mercantile.tiles(w, s, e, n, [z]):
                keep.add((t.x, t.y, z))
    return keep


# ---------------------------------------------------------------------------
# Overview aware tile worker
#
# Mirrors _tile_worker in rio-rgbify / rio-terrarium, which is identical in
# both apart from the encoder call. The only change is which dataset the tile
# is warped from. rasterio.warp.reproject does not pick an overview by itself
# the way `gdalwarp -ovr AUTO` does, so the level is chosen here: the coarsest
# overview that is still at least as fine as the tile. Zooms at or beyond the
# source resolution get no overview and take exactly the old code path, so
# their tiles are byte for byte what they were.
# ---------------------------------------------------------------------------
_mbtiler = None
_datasets = {}
_factors = []


def _open_level(level):
    if level not in _datasets:
        path = _mbtiler.src.name
        if level is None:
            _datasets[level] = _mbtiler.src
        else:
            _datasets[level] = rasterio.open(path, overview_level=level)
    return _datasets[level]


def _pick_level(bounds):
    """Overview level for a tile with these EPSG:3857 bounds, or None."""
    global _factors
    src = _mbtiler.src
    if not _factors:
        _factors = list(src.overviews(1)) or [0]
    if _factors == [0]:
        return None
    left, bottom, right, top = transform_bounds(
        "EPSG:3857", src.crs, *bounds, densify_pts=21)
    tile_res = min((right - left) / 512, (top - bottom) / 512)
    src_res = max(abs(src.res[0]), abs(src.res[1]))
    level = None
    for i, factor in enumerate(_factors):
        if src_res * factor <= tile_res:
            level = i
    return level


def overview_tile_worker(tile):
    x, y, z = tile
    bounds = [
        c
        for i in (
            mercantile.xy(*mercantile.ul(x, y + 1, z)),
            mercantile.xy(*mercantile.ul(x + 1, y, z)),
        )
        for c in i
    ]
    toaffine = transform.from_bounds(*bounds + [512, 512])

    src = _open_level(_pick_level(bounds))
    out = np.empty((512, 512), dtype=src.meta["dtype"])
    reproject(
        rasterio.band(src, 1),
        out,
        dst_transform=toaffine,
        dst_crs="EPSG:3857",
        resampling=Resampling.bilinear,
    )

    g = _mbtiler.global_args
    if "base_val" in g:  # rio-rgbify
        out = _mbtiler.data_to_rgb(out, g["base_val"], g["interval"], g["round_digits"])
    else:  # rio-terrarium
        out = _mbtiler.data_to_rgb(out)
    return tile, g["writer_func"](out, g["kwargs"].copy(), toaffine)


def main():
    global _mbtiler
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoding", choices=("mapbox", "terrarium"), required=True)
    ap.add_argument("--src", required=True, help="raster to encode (nodata already filled)")
    ap.add_argument("--dst", required=True, help="mbtiles to write")
    ap.add_argument("--vrt", required=True, help="mosaic VRT of the inputs, for the footprint")
    ap.add_argument("--min-z", type=int, required=True)
    ap.add_argument("--max-z", type=int, required=True)
    ap.add_argument("--format", choices=("png", "webp"), default="png")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--base-val", type=float, default=-10000.0)
    ap.add_argument("--interval", type=float, default=0.1)
    args = ap.parse_args()

    keep = coverage_tiles(args.vrt, args.min_z, args.max_z)
    if not keep:
        sys.exit("tile_driver: the inputs cover no tiles at these zooms")

    if args.encoding == "mapbox":
        from rio_rgbify import mbtiler
        tiler = mbtiler.RGBTiler(
            args.src, args.dst,
            min_z=args.min_z, max_z=args.max_z,
            base_val=args.base_val, interval=args.interval,
            format=args.format,
        )
    else:
        from rio_terrarium import mbtiler
        tiler = mbtiler.RGBTiler(
            args.src, args.dst,
            min_z=args.min_z, max_z=args.max_z,
            format=args.format,
        )

    # `run()` resolves _make_tiles from module globals, so replacing it there
    # is enough. The signature has to match: run() passes the bbox and crs it
    # read from the source, both of which are ignored here.
    def only_covered(bbox, src_crs, minz, maxz):
        for z in range(minz, maxz + 1):
            for x, y, tz in sorted(t for t in keep if t[2] == z):
                yield [x, y, tz]

    mbtiler._make_tiles = only_covered

    # The pool initializer (_main_worker) opens the source into mbtiler.src in
    # each worker; the replacement worker reads it from there. Workers are
    # forked, so the module reference set here is inherited.
    _mbtiler = mbtiler
    tiler.run_function = overview_tile_worker
    with rasterio.open(args.src) as src:
        levels = src.overviews(1)
    print(f"tile_driver: source overviews {levels or 'none'}", flush=True)

    print(f"tile_driver: {len(keep)} tile(s) intersect the inputs "
          f"(z{args.min_z}-{args.max_z})", flush=True)

    with tiler as t:
        t.run(args.workers)


if __name__ == "__main__":
    main()
