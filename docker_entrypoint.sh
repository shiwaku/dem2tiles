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
# Nodata handling. SRC_NODATA is only needed when the input GeoTIFFs do not
# carry a nodata value themselves; leave empty to use the embedded one.
SRC_NODATA="${SRC_NODATA:-}"
DST_NODATA="${DST_NODATA:--9999}"
# Value that nodata is replaced with before building the RGB encoded tiles.
FILL_VALUE="${FILL_VALUE:-0}"
# Reproject to this CRS when the input is in something else. Empty = keep as is.
TARGET_SRS="${TARGET_SRS:-EPSG:4326}"
RESAMPLING="${RESAMPLING:-bilinear}"
# Terrain-RGB encoding parameters
RGBIFY_BASE="${RGBIFY_BASE:--10000}"
RGBIFY_INTERVAL="${RGBIFY_INTERVAL:-0.1}"
JOBS="${JOBS:-$(nproc)}"
# Rebuild everything, ignoring what is already in the output directory.
FORCE="${FORCE:-}"

MERGED="$OUTPUT_DIR/merged.tif"
FILLED="$OUTPUT_DIR/merged_filled.tif"
STATE_DIR="$OUTPUT_DIR/.state"

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
# Validate the inputs and derive SRC_SRS / NATIVE_ZOOM
# ---------------------------------------------------------------------------
# Assign first: `eval "$(cmd)"` alone would swallow a non-zero exit from cmd.
# probe.py needs rasterio, which lives in the virtualenv, not in the
# system interpreter that carries osgeo.
PROBE_OUT="$(/opt/rio/bin/python /usr/local/bin/probe.py "$FILE_LIST")"
eval "$PROBE_OUT"
log "source CRS: ${SRC_SRS:-unknown}, pixel size: ${NATIVE_RES_M} m, centre latitude: ${CENTRE_LAT}"

if [ "$RGB_MAX_ZOOM" = "auto" ]; then
    RGB_MAX_ZOOM="$NATIVE_ZOOM"
    log "RGB_MAX_ZOOM=auto -> $RGB_MAX_ZOOM"
fi
if [ "$GSIDEM_MAX_ZOOM" = "auto" ]; then
    GSIDEM_MAX_ZOOM="$NATIVE_ZOOM"
    log "GSIDEM_MAX_ZOOM=auto -> $GSIDEM_MAX_ZOOM"
fi

# ---------------------------------------------------------------------------
# Merge into a single GeoTIFF, reprojecting if needed
# ---------------------------------------------------------------------------
MERGE_FP=$(fingerprint "$INPUT_FP" "$SRC_NODATA" "$DST_NODATA" "$TARGET_SRS" "$RESAMPLING")

if step_current merge "$MERGE_FP" "$MERGED"; then
    log "merge is up to date, skipping"
else
    step_begin merge "$MERGED" "$OUTPUT_DIR/merged.vrt"
    log "merging $INPUT_COUNT GeoTIFF(s)"
    VRT_OPTS=()
    [ -n "$SRC_NODATA" ] && VRT_OPTS+=(-srcnodata "$SRC_NODATA")
    gdalbuildvrt "${VRT_OPTS[@]}" -input_file_list "$FILE_LIST" merged.vrt

    if [ -n "$TARGET_SRS" ] && [ "$SRC_SRS" != "$TARGET_SRS" ]; then
        log "reprojecting ${SRC_SRS:-unknown} -> $TARGET_SRS"
        gdalwarp -t_srs "$TARGET_SRS" -r "$RESAMPLING" \
            -dstnodata "$DST_NODATA" -multi -wo NUM_THREADS="$JOBS" \
            -co COMPRESS=LZW -co BIGTIFF=YES -of GTiff \
            merged.vrt "$MERGED"
    else
        gdal_translate -a_nodata "$DST_NODATA" \
            -co COMPRESS=LZW -co BIGTIFF=YES -of GTiff \
            merged.vrt "$MERGED"
    fi
    step_done merge "$MERGE_FP"
fi

# ---------------------------------------------------------------------------
# Replace nodata with FILL_VALUE for the RGB encoded tile sets
# ---------------------------------------------------------------------------
FILL_FP=$(fingerprint "$MERGE_FP" "$DST_NODATA" "$FILL_VALUE")

if want mapbox || want terrarium; then
    if step_current fill "$FILL_FP" "$FILLED"; then
        log "nodata fill is up to date, skipping"
    else
        step_begin fill "$FILLED"
        log "replacing nodata ($DST_NODATA) with $FILL_VALUE"
        # Debian's gdal_calc.py does not accept --NoDataValue=None.
        gdal_calc.py -A "$MERGED" --outfile="$FILLED" \
            --calc="where(A==$DST_NODATA, $FILL_VALUE, A)" \
            --NoDataValue=None --type=Float32 \
            --co="COMPRESS=LZW" --co="BIGTIFF=YES"
        step_done fill "$FILL_FP"
    fi
fi

# ---------------------------------------------------------------------------
# Mapbox Terrain-RGB
# ---------------------------------------------------------------------------
MAPBOX_FP=$(fingerprint "$FILL_FP" "$MIN_ZOOM" "$RGB_MAX_ZOOM" "$RGBIFY_BASE" "$RGBIFY_INTERVAL")

if want mapbox; then
    if step_current mapbox "$MAPBOX_FP" "$OUTPUT_DIR/mapbox.mbtiles" "$OUTPUT_DIR/mapbox"; then
        log "mapbox tiles are up to date, skipping"
    else
        # mb-util refuses to write into a directory that already exists, so the
        # previous attempt has to go before this one starts.
        step_begin mapbox "$OUTPUT_DIR/mapbox.mbtiles" "$OUTPUT_DIR/mapbox"
        log "building mapbox tiles (z$MIN_ZOOM-$RGB_MAX_ZOOM)"
        rio rgbify -b "$RGBIFY_BASE" -i "$RGBIFY_INTERVAL" --format png \
            --max-z "$RGB_MAX_ZOOM" --min-z "$MIN_ZOOM" -j "$JOBS" \
            "$FILLED" mapbox.mbtiles
        mb-util --image_format=png mapbox.mbtiles "$OUTPUT_DIR/mapbox"
        step_done mapbox "$MAPBOX_FP"
    fi
fi

# ---------------------------------------------------------------------------
# Terrarium
# ---------------------------------------------------------------------------
TERRARIUM_FP=$(fingerprint "$FILL_FP" "$MIN_ZOOM" "$RGB_MAX_ZOOM")

if want terrarium; then
    if step_current terrarium "$TERRARIUM_FP" "$OUTPUT_DIR/terrarium.mbtiles" "$OUTPUT_DIR/terrarium"; then
        log "terrarium tiles are up to date, skipping"
    else
        step_begin terrarium "$OUTPUT_DIR/terrarium.mbtiles" "$OUTPUT_DIR/terrarium"
        log "building terrarium tiles (z$MIN_ZOOM-$RGB_MAX_ZOOM)"
        rio terrarium --format png \
            --max-z "$RGB_MAX_ZOOM" --min-z "$MIN_ZOOM" -j "$JOBS" \
            "$FILLED" terrarium.mbtiles
        mb-util --image_format=png terrarium.mbtiles "$OUTPUT_DIR/terrarium"
        step_done terrarium "$TERRARIUM_FP"
    fi
fi

# ---------------------------------------------------------------------------
# GSI numerical DEM tiles (nodata preserved)
# ---------------------------------------------------------------------------
GSIDEM_FP=$(fingerprint "$MERGE_FP" "$GSIDEM_MIN_ZOOM" "$GSIDEM_MAX_ZOOM" "$DST_NODATA")

if want gsidem; then
    if step_current gsidem "$GSIDEM_FP" "$OUTPUT_DIR/gsidem"; then
        log "gsidem tiles are up to date, skipping"
    else
        step_begin gsidem "$OUTPUT_DIR/gsidem"
        log "building gsidem tiles (z$GSIDEM_MIN_ZOOM-$GSIDEM_MAX_ZOOM)"
        /usr/bin/python3 /usr/local/bin/gdal2NPtiles.py --numerical \
            --processes="$JOBS" --xyz -a "$DST_NODATA" \
            -z "$GSIDEM_MIN_ZOOM-$GSIDEM_MAX_ZOOM" \
            "$MERGED" "$OUTPUT_DIR/gsidem"
        step_done gsidem "$GSIDEM_FP"
    fi
fi

log "done"
