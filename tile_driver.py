#!/usr/bin/env python3
"""Run rio-rgbify or rio-terrarium over the tiles that actually hold data.

Both tilers enumerate every tile in the bounding box of their input and encode
each one, whether or not any source pixel reaches it. That is fine for a dense
DEM and ruinous for a sparse one: survey-line or coastal data can fill under a
percent of its bounding box, and the rest becomes tiles with nothing in them
that cost time to make, space to keep and requests to serve.

So the coverage is worked out here instead, from the footprints of the input
GeoTIFFs, and the tilers are pointed at that set. Their own enumeration is
replaced at the module level, which is where `run()` looks it up.

The footprints come from the mosaic VRT rather than from the GeoTIFFs. Opening
every input costs about 12 ms a file on a Windows bind mount, 7.5 minutes for
37,850 files, and the VRT already records where each one sits (#18).

The tilers' per-tile worker is replaced as well, for two reasons.

- Nodata. The RGB encodings have no value that means "no data", so the tilers
  paint every pixel as some elevation. The worker here writes RGBA instead and
  makes nodata fully transparent, as the Forestry Agency's map tile manual
  does for Terrain-RGB. Under the transparent pixels the RGB still holds
  DST_NODATA, encoded, for clients that ignore alpha.
- Low zooms read an overview of the source instead of the full resolution
  raster (#17). Without it, each tile that covers the whole extent reads every
  pixel of it, one worker per tile: on a 30 Gpx raster z5-z7 had not produced
  a single tile after 50 minutes.
"""
import argparse
import sqlite3
import sys
from io import BytesIO
import xml.etree.ElementTree as ET

import mercantile
import numpy as np
import rasterio
from PIL import Image
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
# Tile worker: nodata as transparency, overviews for low zooms
#
# Follows _tile_worker in rio-rgbify / rio-terrarium, which is identical in
# both apart from the encoder call, with three changes:
#
# - The warp keeps the source nodata, and the tile gets an alpha band that is
#   0 wherever no valid pixel reached. Bilinear interpolation then uses the
#   valid neighbours only, so edges do not blend with a filled-in value.
# - The tile is encoded as RGBA here rather than by the tilers' RGB writers.
# - rasterio.warp.reproject does not pick an overview by itself the way
#   `gdalwarp -ovr AUTO` does, so the level is chosen here: the coarsest
#   overview that is still at least as fine as the tile. Zooms at or beyond
#   the source resolution read the full raster.
# ---------------------------------------------------------------------------
_mbtiler = None
_image_format = "png"
_tile_size = 512
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
    tile_res = min((right - left) / _tile_size, (top - bottom) / _tile_size)
    src_res = max(abs(src.res[0]), abs(src.res[1]))
    level = None
    for i, factor in enumerate(_factors):
        if src_res * factor <= tile_res:
            level = i
    return level


def _encode(rgba, image_format):
    """RGBA (4, size, size) uint8 -> PNG or lossless WebP bytes.

    exact=True keeps the RGB under fully transparent pixels. libwebp otherwise
    rewrites it to whatever compresses best, and a client that ignores alpha
    would then decode an arbitrary elevation there instead of DST_NODATA.
    """
    im = Image.fromarray(np.moveaxis(rgba, 0, -1), "RGBA")
    with BytesIO() as f:
        if image_format == "webp":
            im.save(f, format="webp", lossless=True, exact=True)
        else:
            im.save(f, format="png")
        return f.getvalue()


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
    toaffine = transform.from_bounds(*bounds + [_tile_size, _tile_size])

    src = _open_level(_pick_level(bounds))
    nodata = src.nodata
    out = np.full((_tile_size, _tile_size), nodata if nodata is not None else 0,
                  dtype=src.meta["dtype"])
    # The source keeps its nodata, so the warp leaves nodata where no valid
    # pixel reaches and interpolates from the valid ones only. Edges no longer
    # blend with a filled-in value.
    reproject(
        rasterio.band(src, 1),
        out,
        dst_transform=toaffine,
        dst_crs="EPSG:3857",
        dst_nodata=nodata,
        resampling=Resampling.bilinear,
    )
    if nodata is None:
        alpha = np.full((_tile_size, _tile_size), 255, dtype=np.uint8)
    else:
        alpha = np.where(out == nodata, 0, 255).astype(np.uint8)
        # The footprints are the inputs' bounding boxes, so some tiles in the
        # coverage hold no data at all. run() inserts whatever comes back; an
        # empty blob marks the tile for removal once it is done.
        if not alpha.any():
            return tile, b""

    g = _mbtiler.global_args
    if "base_val" in g:  # rio-rgbify
        rgb = _mbtiler.data_to_rgb(out, g["base_val"], g["interval"], g["round_digits"])
    else:  # rio-terrarium
        rgb = _mbtiler.data_to_rgb(out)
    return tile, _encode(np.concatenate([rgb, alpha[None]]), _image_format)


def main():
    global _mbtiler, _image_format, _tile_size
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoding", choices=("mapbox", "terrarium"), required=True)
    ap.add_argument("--src", required=True, help="raster to encode, with its nodata")
    ap.add_argument("--dst", required=True, help="mbtiles to write")
    ap.add_argument("--vrt", required=True, help="mosaic VRT of the inputs, for the footprint")
    ap.add_argument("--min-z", type=int, required=True)
    ap.add_argument("--max-z", type=int, required=True)
    ap.add_argument("--format", choices=("png", "webp"), default="png")
    ap.add_argument("--workers", type=int, default=4)
    # The tile is rendered here, not by rio-rgbify / rio-terrarium, so their
    # 512 px is only a default. Any power of two works for the XYZ grid.
    ap.add_argument("--tile-size", type=int, default=512)
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
    _image_format = args.format
    _tile_size = args.tile_size
    tiler.run_function = overview_tile_worker
    with rasterio.open(args.src) as src:
        levels = src.overviews(1)
    print(f"tile_driver: source overviews {levels or 'none'}", flush=True)

    print(f"tile_driver: {len(keep)} tile(s) intersect the inputs "
          f"(z{args.min_z}-{args.max_z}, {_tile_size} px)", flush=True)

    with tiler as t:
        t.run(args.workers)

    conn = sqlite3.connect(args.dst)
    empty = conn.execute("DELETE FROM tiles WHERE length(tile_data) = 0").rowcount
    conn.commit()
    conn.close()
    print(f"tile_driver: dropped {empty} tile(s) with no data", flush=True)


if __name__ == "__main__":
    main()
