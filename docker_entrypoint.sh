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

MERGED="$OUTPUT_DIR/merged.tif"
FILLED="$OUTPUT_DIR/merged_filled.tif"

want() {
    [[ " ${OUTPUTS//,/ } " == *" $1 "* ]]
}

log() {
    echo "[dem2tiles] $*"
}

# ---------------------------------------------------------------------------
# Collect input GeoTIFFs
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
cd "$OUTPUT_DIR"

FILE_LIST="$OUTPUT_DIR/input_files.txt"
find "$INPUT_DIR" -type f \( -iname '*.tif' -o -iname '*.tiff' \) | sort > "$FILE_LIST"
INPUT_COUNT=$(wc -l < "$FILE_LIST")
if [ "$INPUT_COUNT" -eq 0 ]; then
    log "ERROR: no GeoTIFF found under $INPUT_DIR"
    exit 1
fi
log "found $INPUT_COUNT GeoTIFF(s) under $INPUT_DIR"

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
if [ -f "$MERGED" ]; then
    log "$MERGED exists, skipping merge"
else
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
fi

# ---------------------------------------------------------------------------
# Replace nodata with FILL_VALUE for the RGB encoded tile sets
# ---------------------------------------------------------------------------
if want mapbox || want terrarium; then
    if [ -f "$FILLED" ]; then
        log "$FILLED exists, skipping nodata fill"
    else
        log "replacing nodata ($DST_NODATA) with $FILL_VALUE"
        # Debian's gdal_calc.py does not accept --NoDataValue=None.
        gdal_calc.py -A "$MERGED" --outfile="$FILLED" \
            --calc="where(A==$DST_NODATA, $FILL_VALUE, A)" \
            --NoDataValue=None --type=Float32 \
            --co="COMPRESS=LZW" --co="BIGTIFF=YES"
    fi
fi

# ---------------------------------------------------------------------------
# Mapbox Terrain-RGB
# ---------------------------------------------------------------------------
if want mapbox; then
    if [ -f "$OUTPUT_DIR/mapbox.mbtiles" ]; then
        log "mapbox.mbtiles exists, skipping rio rgbify"
    else
        rio rgbify -b "$RGBIFY_BASE" -i "$RGBIFY_INTERVAL" --format png \
            --max-z "$RGB_MAX_ZOOM" --min-z "$MIN_ZOOM" -j "$JOBS" \
            "$FILLED" mapbox.mbtiles
        mb-util --image_format=png mapbox.mbtiles "$OUTPUT_DIR/mapbox"
    fi
fi

# ---------------------------------------------------------------------------
# Terrarium
# ---------------------------------------------------------------------------
if want terrarium; then
    if [ -f "$OUTPUT_DIR/terrarium.mbtiles" ]; then
        log "terrarium.mbtiles exists, skipping rio terrarium"
    else
        rio terrarium --format png \
            --max-z "$RGB_MAX_ZOOM" --min-z "$MIN_ZOOM" -j "$JOBS" \
            "$FILLED" terrarium.mbtiles
        mb-util --image_format=png terrarium.mbtiles "$OUTPUT_DIR/terrarium"
    fi
fi

# ---------------------------------------------------------------------------
# GSI numerical DEM tiles (nodata preserved)
# ---------------------------------------------------------------------------
if want gsidem; then
    if [ -d "$OUTPUT_DIR/gsidem" ]; then
        log "gsidem directory exists, skipping gdal2NPtiles"
    else
        /usr/bin/python3 /usr/local/bin/gdal2NPtiles.py --numerical \
            --processes="$JOBS" --xyz -a "$DST_NODATA" \
            -z "$GSIDEM_MIN_ZOOM-$GSIDEM_MAX_ZOOM" \
            "$MERGED" "$OUTPUT_DIR/gsidem"
    fi
fi

log "done"
