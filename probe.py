#!/usr/bin/env python3
"""Validate the input GeoTIFFs and report properties the pipeline needs.

Writes shell-evalable assignments to stdout. Exits non-zero when the inputs
cannot be merged safely, rather than letting gdalbuildvrt drop the odd ones
out with a warning nobody reads.

The check runs against the mosaic VRT, not the files. gdalbuildvrt has already
opened every input and skipped the ones it could not mosaic (another CRS, an
unreadable file), so an input missing from the VRT is exactly an input that
would be lost. Only those, and the first file for its pixel size, are opened
here: opening all of them again cost 449 s for 37,850 files on a Windows bind
mount (#18).
"""
import argparse
import math
import sys
import xml.etree.ElementTree as ET

import rasterio
from rasterio.crs import CRS
from rasterio.warp import transform as warp_transform

# Web Mercator resolution at zoom 0, in metres per pixel, for a 256 px tile.
EQUATORIAL_RES = 156543.033928041


def crs_key(crs):
    """A comparable name for a CRS."""
    if crs is None:
        return "unknown"
    epsg = crs.to_epsg()
    return f"EPSG:{epsg}" if epsg else crs.to_wkt()[:60]


def vrt_sources(vrt_path):
    """(crs, set of source file names) of a mosaic VRT."""
    root = ET.parse(vrt_path).getroot()
    srs = root.findtext("SRS")
    names = {el.text for el in root.iter("SourceFilename")}
    return (CRS.from_wkt(srs) if srs else None), names


def centre_lat(src):
    """Latitude of the dataset centre, or None if there is no usable CRS."""
    if src.crs is None:
        return None
    x = (src.bounds.left + src.bounds.right) / 2
    y = (src.bounds.bottom + src.bounds.top) / 2
    try:
        _, lat = warp_transform(src.crs, "EPSG:4326", [x], [y])
    except Exception:
        return None
    return lat[0]


def native_res_m(src, lat):
    """Pixel size in metres. Degrees are converted using the centre latitude."""
    res = max(src.res)
    if src.crs is not None and src.crs.is_geographic:
        return res * 111320.0 * math.cos(math.radians(lat))
    factor = 1.0
    if src.crs is not None:
        factor = src.crs.linear_units_factor[1]
    return res * factor


def matching_zoom(res_m, lat, tile_size=256):
    """Smallest zoom whose Web Mercator resolution is finer than res_m.

    The zoom that resolves a grid depends on how many pixels a tile carries.
    A 512 px tile covers the same ground as a 256 px one, at twice the detail,
    so it reaches the source resolution a zoom level earlier. Ignoring that
    asks for four times as many tiles, each one oversampled.
    """
    ground = EQUATORIAL_RES * math.cos(math.radians(lat)) * 256 / tile_size
    return max(0, math.ceil(math.log2(ground / res_m)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file_list")
    ap.add_argument("vrt", help="mosaic VRT built from file_list by gdalbuildvrt")
    args = ap.parse_args()

    with open(args.file_list) as fh:
        paths = [line.strip() for line in fh if line.strip()]
    if not paths:
        sys.exit("probe: input file list is empty")

    vrt_crs, in_vrt = vrt_sources(args.vrt)
    key = crs_key(vrt_crs)
    dropped = [p for p in paths if p not in in_vrt]
    if dropped:
        print(f"probe: gdalbuildvrt left {len(dropped)} of {len(paths)} input(s) "
              f"out of the mosaic ({key}), refusing to merge:", file=sys.stderr)
        by_reason = {}
        for path in dropped:
            try:
                with rasterio.open(path) as src:
                    other = crs_key(src.crs)
                reason = (f"CRS {other}" if other != key
                          else "same CRS; see the gdalbuildvrt warnings above")
            except rasterio.errors.RasterioIOError as exc:
                reason = f"cannot open: {exc}"
            by_reason.setdefault(reason, []).append(path)
        for reason, files in sorted(by_reason.items()):
            print(f"  {reason}: {len(files)} file(s), e.g. {files[0]}",
                  file=sys.stderr)
        print("Inputs in another CRS have to be reprojected to a common CRS first.",
              file=sys.stderr)
        sys.exit(1)

    with rasterio.open(paths[0]) as src:
        lat = centre_lat(src)
        if lat is None:
            # No usable CRS: report the raw pixel size and let the caller decide.
            lat, res_m = 0.0, max(src.res)
        else:
            res_m = native_res_m(src, lat)

    print(f"SRC_SRS={key if key.startswith('EPSG:') else ''}")
    print(f"NATIVE_RES_M={res_m:.6f}")
    print(f"CENTRE_LAT={lat:.6f}")
    # One per tile size, because the tilers disagree: rio-rgbify and
    # rio-terrarium render 512 px tiles, gdal2NPtiles renders 256 px ones.
    print(f"NATIVE_ZOOM_256={matching_zoom(res_m, lat, 256)}")
    print(f"NATIVE_ZOOM_512={matching_zoom(res_m, lat, 512)}")


if __name__ == "__main__":
    main()
