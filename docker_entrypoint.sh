#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override with `docker run -e NAME=value ...`)
# ---------------------------------------------------------------------------
INPUT_DIR="${INPUT_DIR:-/input}"
OUTPUT_DIR="${OUTPUT_DIR:-/output}"
# Which tile sets to produce, space or comma separated: mapbox terrarium gsidem
OUTPUTS="${OUTPUTS:-mapbox terrarium gsidem}"
# Zoom range. "auto" derives the maximum from the input resolution so that the
# finest tiles match the source grid instead of throwing detail away.
MIN_ZOOM="${MIN_ZOOM:-5}"
RGB_MAX_ZOOM="${RGB_MAX_ZOOM:-auto}"
GSIDEM_MIN_ZOOM="${GSIDEM_MIN_ZOOM:-$MIN_ZOOM}"
GSIDEM_MAX_ZOOM="${GSIDEM_MAX_ZOOM:-auto}"
# Tile size in pixels, 256 or 512, for each kind of tile set. The defaults are
# what each kind is usually served at: Terrain-RGB / Terrarium at 512, as
# Mapbox and Mapterhorn do, and gsidem at 256, as the GSI elevation tiles are.
RGB_TILE_SIZE="${RGB_TILE_SIZE:-512}"
GSIDEM_TILE_SIZE="${GSIDEM_TILE_SIZE:-256}"
# Nodata handling. SRC_NODATA is only needed when the input GeoTIFFs do not
# carry a nodata value themselves; leave empty to use the embedded one.
SRC_NODATA="${SRC_NODATA:-}"
DST_NODATA="${DST_NODATA:--9999}"
# Reproject to this CRS when the input is in something else. Empty = keep as is.
TARGET_SRS="${TARGET_SRS:-EPSG:4326}"
RESAMPLING="${RESAMPLING:-bilinear}"
# Terrain-RGB encoding parameters
RGBIFY_BASE="${RGBIFY_BASE:--10000}"
RGBIFY_INTERVAL="${RGBIFY_INTERVAL:-0.1}"
# Image format for the RGB encoded tile sets (mapbox, terrarium): png or webp.
# WebP is what Mapterhorn serves, and it is about 40% smaller at identical
# pixels -- rio-rgbify and rio-terrarium both hardcode lossless=True, so the
# decoded elevations are bit for bit the same as the PNG ones.
#
# gsidem is deliberately not covered. Its reason to exist is compatibility with
# the GSI elevation tiles (PNG), whose specification is 256x256 PNG.
TILE_FORMAT="${TILE_FORMAT:-webp}"
# 数値PNGタイルの分解能。地理院標高タイル（PNG形式）の仕様は 0.01 m。
GSIDEM_RESOLUTION="${GSIDEM_RESOLUTION:-0.01}"
# Half the CPUs by default. Every heavy step (the warp, GeoTIFF compression,
# the overviews, both tilers) runs this wide for an hour or more on a large
# extent, and using all of them left the machine running Docker unusable.
JOBS="${JOBS:-$(( $(nproc) / 2 > 0 ? $(nproc) / 2 : 1 ))}"
# Rebuild everything, ignoring what is already in the output directory.
FORCE="${FORCE:-}"

MERGED="$OUTPUT_DIR/merged.tif"
STATE_DIR="$OUTPUT_DIR/.state"

# Bumped whenever a change here alters what a step produces. The fingerprints
# cover settings and inputs, but nothing tells them the code moved, so without
# this an old output would be accepted as current after an upgrade.
PIPELINE_VERSION=2

# Creation options for the merged rasters.
#
# TILED is not optional at this scale. A stripped GeoTIFF puts one row per
# strip, and a wide extent makes that row huge: 222,948 px of float32 is
# 891 KB. gdalwarp writes the destination in rectangular chunks, and every
# partial write into a compressed strip costs a decompress-modify-recompress
# of the whole strip. Writing a wide raster that way rewrites the same strips
# over and over: a 22.66 Gpx destination made no progress at all in 18 minutes
# (the write offset went backwards), while the same warp with TILED finished
# in 150 seconds.
#
# SPARSE_OK keeps blocks that are entirely nodata out of the file. Coastal or
# survey-line data covers a small fraction of its bounding box — one real
# dataset came to 0.98% — and those blocks cost nothing to skip.
#
# DEFLATE at level 1 beats LZW here: a little larger, noticeably faster, and
# the intermediate files are deleted once the tiles exist.
#
# NUM_THREADS spreads the compression over the cores. Without it GTiff
# compresses on one thread, and that is what gdalwarp -multi and gdal_calc.py
# end up waiting on: on a dense 179 Mpx sample the warp went from 17 s to
# 11.5 s and the fill from 14 s to 6 s, with pixel-identical output.
# (A larger gdalwarp -wm is deliberately not used: it changed no timings and
# did change the values, because the warp approximates its transform per chunk.)
BLOCKSIZE="${BLOCKSIZE:-512}"
COMPRESS="${COMPRESS:-DEFLATE}"
CREATE_OPTS=(
    -co TILED=YES
    -co "BLOCKXSIZE=$BLOCKSIZE"
    -co "BLOCKYSIZE=$BLOCKSIZE"
    -co "COMPRESS=$COMPRESS"
    -co SPARSE_OK=TRUE
    -co BIGTIFF=YES
    -co "NUM_THREADS=$JOBS"
)
# ZLEVEL only exists for DEFLATE; GTiff warns about it under any other codec.
if [ "$COMPRESS" = "DEFLATE" ]; then
    CREATE_OPTS+=(-co ZLEVEL=1)
fi

case "$TILE_FORMAT" in
    png|webp) ;;
    *)
        echo "[dem2tiles] ERROR: TILE_FORMAT must be png or webp, got '$TILE_FORMAT'" >&2
        exit 1
        ;;
esac

for v in RGB_TILE_SIZE GSIDEM_TILE_SIZE; do
    case "${!v}" in
        256|512) ;;
        *)
            echo "[dem2tiles] ERROR: $v must be 256 or 512, got '${!v}'" >&2
            exit 1
            ;;
    esac
done

want() {
    [[ " ${OUTPUTS//,/ } " == *" $1 "* ]]
}

log() {
    echo "[dem2tiles] $*"
}

# ---------------------------------------------------------------------------
# Step bookkeeping
#
# A step is skipped only when its marker exists, the recorded fingerprint still
# matches, and every declared output is present. Anything else rebuilds the
# step, after clearing what the previous attempt left behind.
#
# The marker alone is not enough. A run that died half way still leaves an
# mbtiles file or a tile directory on disk, and checking only for those used to
# count as "done", so the next run reported success over a stale result.
#
# Fingerprints chain onto the upstream step, so changing an input or a setting
# rebuilds everything downstream of it.
# ---------------------------------------------------------------------------
fingerprint() {
    printf '%s\n' "$@" | sha256sum | cut -d' ' -f1
}

# step_current <step> <fingerprint> [outputs...]
step_current() {
    local step=$1 fp=$2
    shift 2
    [ -z "$FORCE" ] || return 1
    local marker="$STATE_DIR/$step"
    [ -f "$marker" ] || return 1
    [ "$(cat "$marker")" = "$fp" ] || return 1
    local out
    for out in "$@"; do
        [ -e "$out" ] || return 1
    done
    return 0
}

# step_begin <step> [paths to clear...]
step_begin() {
    local step=$1
    shift
    rm -f "$STATE_DIR/$step"
    [ "$#" -eq 0 ] || rm -rf "$@"
}

# step_done <step> <fingerprint>
step_done() {
    printf '%s\n' "$2" > "$STATE_DIR/$1"
}

# ---------------------------------------------------------------------------
# Collect input GeoTIFFs
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR" "$STATE_DIR"
cd "$OUTPUT_DIR"

FILE_LIST="$OUTPUT_DIR/input_files.txt"
find "$INPUT_DIR" -type f \( -iname '*.tif' -o -iname '*.tiff' \) | sort > "$FILE_LIST"
INPUT_COUNT=$(wc -l < "$FILE_LIST")
if [ "$INPUT_COUNT" -eq 0 ]; then
    log "ERROR: no GeoTIFF found under $INPUT_DIR"
    exit 1
fi
log "found $INPUT_COUNT GeoTIFF(s) under $INPUT_DIR"
[ -z "$FORCE" ] || log "FORCE is set, rebuilding everything"

# The list of paths, not the pixels: hashing the rasters themselves would cost
# more than the conversion does. Replacing a file in place without renaming it
# is therefore not noticed; delete the output directory in that case.
INPUT_FP=$(sha256sum "$FILE_LIST" | cut -d' ' -f1)

# ---------------------------------------------------------------------------
# Mosaic VRT of the inputs
#
# Built once, up front, and reused by everything that needs to know about the
# inputs: probe.py validates against it, gdalwarp reads it, and tile_driver.py
# takes the footprints from it. Each of those used to open every input itself,
# at about 12 ms a file on a Windows bind mount -- 7 to 12 minutes apiece for
# 37,850 files (#18). This way a run opens the inputs once, and a rerun on the
# same inputs not at all.
# ---------------------------------------------------------------------------
VRT="$OUTPUT_DIR/merged.vrt"
VRT_FP=$(fingerprint "$PIPELINE_VERSION" "$INPUT_FP" "$SRC_NODATA")

if step_current vrt "$VRT_FP" "$VRT"; then
    log "mosaic VRT is up to date, skipping"
else
    step_begin vrt "$VRT"
    log "building the mosaic VRT"
    VRT_OPTS=()
    [ -n "$SRC_NODATA" ] && VRT_OPTS+=(-srcnodata "$SRC_NODATA")
    gdalbuildvrt "${VRT_OPTS[@]}" -input_file_list "$FILE_LIST" "$VRT"
    # Marked done only once probe.py has accepted it below. A VRT that left
    # inputs out must not be reused after the inputs are fixed in place.
    VRT_BUILT=1
fi

# ---------------------------------------------------------------------------
# Validate the inputs and derive SRC_SRS / NATIVE_ZOOM
# ---------------------------------------------------------------------------
# Assign first: `eval "$(cmd)"` alone would swallow a non-zero exit from cmd.
# probe.py needs rasterio, which lives in the virtualenv, not in the
# system interpreter that carries osgeo.
PROBE_OUT="$(/opt/rio/bin/python /usr/local/bin/probe.py "$FILE_LIST" "$VRT")"
eval "$PROBE_OUT"
[ -z "${VRT_BUILT:-}" ] || step_done vrt "$VRT_FP"
log "source CRS: ${SRC_SRS:-unknown}, pixel size: ${NATIVE_RES_M} m, centre latitude: ${CENTRE_LAT}"

# The zoom that resolves the grid depends on the tile size: a 512 px tile
# reaches it a zoom level before a 256 px one. Using the 256 px answer for
# 512 px tiles asks for four times as many tiles, each oversampled twice over.
native_zoom() {
    local v="NATIVE_ZOOM_$1"
    echo "${!v}"
}
if [ "$RGB_MAX_ZOOM" = "auto" ]; then
    RGB_MAX_ZOOM=$(native_zoom "$RGB_TILE_SIZE")
    log "RGB_MAX_ZOOM=auto -> $RGB_MAX_ZOOM ($RGB_TILE_SIZE px tiles)"
fi
if [ "$GSIDEM_MAX_ZOOM" = "auto" ]; then
    GSIDEM_MAX_ZOOM=$(native_zoom "$GSIDEM_TILE_SIZE")
    log "GSIDEM_MAX_ZOOM=auto -> $GSIDEM_MAX_ZOOM ($GSIDEM_TILE_SIZE px tiles)"
fi

# ---------------------------------------------------------------------------
# Merge into a single GeoTIFF, reprojecting if needed
# ---------------------------------------------------------------------------
MERGE_FP=$(fingerprint "$PIPELINE_VERSION" "$INPUT_FP" "$SRC_NODATA" "$DST_NODATA" "$TARGET_SRS" "$RESAMPLING" "$BLOCKSIZE" "$COMPRESS")

if step_current merge "$MERGE_FP" "$MERGED"; then
    log "merge is up to date, skipping"
else
    step_begin merge "$MERGED"
    log "merging $INPUT_COUNT GeoTIFF(s)"

    if [ -n "$TARGET_SRS" ] && [ "$SRC_SRS" != "$TARGET_SRS" ]; then
        log "reprojecting ${SRC_SRS:-unknown} -> $TARGET_SRS"
        gdalwarp -t_srs "$TARGET_SRS" -r "$RESAMPLING" \
            -dstnodata "$DST_NODATA" -multi -wo NUM_THREADS="$JOBS" \
            "${CREATE_OPTS[@]}" -of GTiff \
            "$VRT" "$MERGED"
    else
        gdal_translate -a_nodata "$DST_NODATA" \
            "${CREATE_OPTS[@]}" -of GTiff \
            "$VRT" "$MERGED"
    fi
    step_done merge "$MERGE_FP"
fi

# ---------------------------------------------------------------------------
# Overviews for the low zoom RGB tiles
#
# rio-rgbify and rio-terrarium warp every tile straight from the source. With
# no overviews, a tile that covers the whole extent reads all of it at full
# resolution, one worker per tile: on a 190,850 x 160,374 px raster z5-z7 had
# not produced a tile after 50 minutes (#17). tile_driver.py picks the level
# that matches each tile; tiles at or beyond the source resolution still read
# the full raster.
#
# The RGB tiles read merged.tif itself, nodata and all, so that nodata becomes
# transparent in the tiles instead of being painted as some elevation. The
# overviews hang off a VRT of merged.tif rather than off merged.tif, because
# GDAL uses a raster's overviews for any downsampled read, and gdal2NPtiles
# reads merged.tif: attaching them there could change the gsidem tiles.
#
# Levels are left to gdaladdo, which halves until the raster fits 256 px.
# average rather than bilinear: each overview pixel is the mean of the valid
# pixels it covers, which is what a coarser elevation grid should hold.
# ---------------------------------------------------------------------------
RGB_SRC="$OUTPUT_DIR/merged_rgb.vrt"
OVERVIEW_FP=$(fingerprint "$MERGE_FP" average "$BLOCKSIZE" "$COMPRESS")

# Left over from before the RGB tiles kept their nodata: merged_filled.tif,
# the same size as merged.tif, is no longer read by anything.
if [ -e "$OUTPUT_DIR/merged_filled.tif" ] || [ -e "$STATE_DIR/fill" ]; then
    log "removing merged_filled.tif, which this version no longer uses"
    rm -f "$OUTPUT_DIR/merged_filled.tif" "$OUTPUT_DIR/merged_filled.tif.ovr" "$STATE_DIR/fill"
fi

if want mapbox || want terrarium; then
    if step_current overview "$OVERVIEW_FP" "$RGB_SRC" "$RGB_SRC.ovr"; then
        log "overviews are up to date, skipping"
    else
        step_begin overview "$RGB_SRC" "$RGB_SRC.ovr"
        log "building overviews for the RGB tiles"
        gdal_translate -q -of VRT "$MERGED" "$RGB_SRC"
        gdaladdo -ro -r average \
            --config COMPRESS_OVERVIEW "$COMPRESS" \
            --config BIGTIFF_OVERVIEW YES \
            --config GDAL_TIFF_OVR_BLOCKSIZE "$BLOCKSIZE" \
            --config GDAL_NUM_THREADS "$JOBS" \
            "$RGB_SRC"
        step_done overview "$OVERVIEW_FP"
    fi
fi

# ---------------------------------------------------------------------------
# Mapbox Terrain-RGB
# ---------------------------------------------------------------------------
MAPBOX_FP=$(fingerprint "$OVERVIEW_FP" "$DST_NODATA" alpha "$MIN_ZOOM" "$RGB_MAX_ZOOM" "$RGBIFY_BASE" "$RGBIFY_INTERVAL" "$TILE_FORMAT" "$RGB_TILE_SIZE")

if want mapbox; then
    if step_current mapbox "$MAPBOX_FP" "$OUTPUT_DIR/mapbox.mbtiles" "$OUTPUT_DIR/mapbox"; then
        log "mapbox tiles are up to date, skipping"
    else
        # mb-util refuses to write into a directory that already exists, so the
        # previous attempt has to go before this one starts.
        step_begin mapbox "$OUTPUT_DIR/mapbox.mbtiles" "$OUTPUT_DIR/mapbox"
        log "building mapbox tiles (z$MIN_ZOOM-$RGB_MAX_ZOOM, $TILE_FORMAT, $RGB_TILE_SIZE px)"
        /opt/rio/bin/python /usr/local/bin/tile_driver.py --encoding mapbox \
            --src "$RGB_SRC" --dst mapbox.mbtiles --vrt "$VRT" \
            --min-z "$MIN_ZOOM" --max-z "$RGB_MAX_ZOOM" --format "$TILE_FORMAT" \
            --base-val "$RGBIFY_BASE" --interval "$RGBIFY_INTERVAL" \
            --tile-size "$RGB_TILE_SIZE" --workers "$JOBS"
        mb-util --image_format="$TILE_FORMAT" mapbox.mbtiles "$OUTPUT_DIR/mapbox"
        step_done mapbox "$MAPBOX_FP"
    fi
fi

# ---------------------------------------------------------------------------
# Terrarium
# ---------------------------------------------------------------------------
TERRARIUM_FP=$(fingerprint "$OVERVIEW_FP" "$DST_NODATA" alpha "$MIN_ZOOM" "$RGB_MAX_ZOOM" "$TILE_FORMAT" "$RGB_TILE_SIZE")

if want terrarium; then
    if step_current terrarium "$TERRARIUM_FP" "$OUTPUT_DIR/terrarium.mbtiles" "$OUTPUT_DIR/terrarium"; then
        log "terrarium tiles are up to date, skipping"
    else
        step_begin terrarium "$OUTPUT_DIR/terrarium.mbtiles" "$OUTPUT_DIR/terrarium"
        log "building terrarium tiles (z$MIN_ZOOM-$RGB_MAX_ZOOM, $TILE_FORMAT, $RGB_TILE_SIZE px)"
        /opt/rio/bin/python /usr/local/bin/tile_driver.py --encoding terrarium \
            --src "$RGB_SRC" --dst terrarium.mbtiles --vrt "$VRT" \
            --min-z "$MIN_ZOOM" --max-z "$RGB_MAX_ZOOM" --format "$TILE_FORMAT" \
            --tile-size "$RGB_TILE_SIZE" --workers "$JOBS"
        mb-util --image_format="$TILE_FORMAT" terrarium.mbtiles "$OUTPUT_DIR/terrarium"
        step_done terrarium "$TERRARIUM_FP"
    fi
fi

# ---------------------------------------------------------------------------
# GSI numerical DEM tiles (nodata preserved)
# ---------------------------------------------------------------------------
GSIDEM_FP=$(fingerprint "$MERGE_FP" "$GSIDEM_MIN_ZOOM" "$GSIDEM_MAX_ZOOM" "$DST_NODATA" "$GSIDEM_RESOLUTION" "$GSIDEM_TILE_SIZE")

if want gsidem; then
    if step_current gsidem "$GSIDEM_FP" "$OUTPUT_DIR/gsidem"; then
        log "gsidem tiles are up to date, skipping"
    else
        step_begin gsidem "$OUTPUT_DIR/gsidem"
        log "building gsidem tiles (z$GSIDEM_MIN_ZOOM-$GSIDEM_MAX_ZOOM, $GSIDEM_TILE_SIZE px)"
        /usr/bin/python3 /usr/local/bin/gdal2NPtiles.py --numerical \
            --numerical-resolution "$GSIDEM_RESOLUTION" \
            --processes="$JOBS" --xyz -a "$DST_NODATA" \
            --tilesize="$GSIDEM_TILE_SIZE" \
            -z "$GSIDEM_MIN_ZOOM-$GSIDEM_MAX_ZOOM" \
            "$MERGED" "$OUTPUT_DIR/gsidem"
        step_done gsidem "$GSIDEM_FP"
    fi
fi

log "done"
