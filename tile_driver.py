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
"""
import argparse
import sys

import mercantile
import rasterio
from rasterio.warp import transform_bounds


def coverage_tiles(paths, min_z, max_z):
    """Tiles touched by the footprint of any input raster."""
    keep = set()
    for path in paths:
        with rasterio.open(path) as src:
            if src.crs is None:
                sys.exit(f"tile_driver: {path} has no CRS")
            w, s, e, n = transform_bounds(src.crs, "EPSG:4326", *src.bounds,
                                          densify_pts=21)
        for z in range(min_z, max_z + 1):
            for t in mercantile.tiles(w, s, e, n, [z]):
                keep.add((t.x, t.y, z))
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoding", choices=("mapbox", "terrarium"), required=True)
    ap.add_argument("--src", required=True, help="raster to encode (nodata already filled)")
    ap.add_argument("--dst", required=True, help="mbtiles to write")
    ap.add_argument("--file-list", required=True, help="the inputs, for the footprint")
    ap.add_argument("--min-z", type=int, required=True)
    ap.add_argument("--max-z", type=int, required=True)
    ap.add_argument("--format", choices=("png", "webp"), default="png")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--base-val", type=float, default=-10000.0)
    ap.add_argument("--interval", type=float, default=0.1)
    args = ap.parse_args()

    with open(args.file_list) as fh:
        paths = [line.strip() for line in fh if line.strip()]
    if not paths:
        sys.exit("tile_driver: input file list is empty")

    keep = coverage_tiles(paths, args.min_z, args.max_z)
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

    print(f"tile_driver: {len(keep)} tile(s) intersect the inputs "
          f"(z{args.min_z}-{args.max_z})", flush=True)

    with tiler as t:
        t.run(args.workers)


if __name__ == "__main__":
    main()
