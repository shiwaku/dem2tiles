#!/bin/bash
# dem2tiles の出力（ZXY ディレクトリ）から、3 種類の PMTiles を作って照合する。
#
#   scripts/make_pmtiles.sh <dem2tiles の出力> <名前の接頭辞> [作業ディレクトリ]
#
#   scripts/make_pmtiles.sh output-yamanashi yamanashi-lp
#   → output-yamanashi/pmtiles/yamanashi-lp-{terrarium,terrain-rgb,dem-png}.pmtiles
#
# 名前は R2 のキー（pmtiles/{県}/{名前}.pmtiles）と Worker の URL にそのまま使う。
# 接頭辞は「県-元データの種類」（静岡は shizuoka-alb、山梨は yamanashi-lp）。
#
# dem2tiles が書く *.mbtiles は使わない。インデックスも範囲の metadata も無く、変換が終わらない
# ことがある（Issue #28）。ZXY ディレクトリを mb-util で詰め直すと、インデックスは mb-util が張る。
#
# 要るもの: python と、PATH の通った mbutil / pmtiles（pip install mbutil pmtiles）。
# 作業ディレクトリには中間の mbtiles（出力と同じくらいの容量）ができ、最後に消す。
set -euo pipefail

OUT=${1:?dem2tiles の出力ディレクトリ}
PREFIX=${2:?名前の接頭辞（例 yamanashi-lp）}
WORK=${3:-$OUT/pmtiles-work}
PY=${PYTHON:-python}
HERE=$(cd "$(dirname "$0")" && pwd)
# どちらも pip が入れる Python スクリプト。Windows の venv では直接実行できないことがあるので python に渡す
MBUTIL=$(command -v mb-util) || { echo "mb-util が見つからない（pip install mbutil）" >&2; exit 1; }
CONVERT=$(command -v pmtiles-convert) || { echo "pmtiles-convert が見つからない（pip install pmtiles）" >&2; exit 1; }

mkdir -p "$OUT/pmtiles" "$WORK"
stamp() { echo "[$(date '+%H:%M:%S')] $*"; }

# 出力ディレクトリ名 → [R2 の名前の後半, 拡張子]
for spec in "terrarium:terrarium" "mapbox:terrain-rgb" "gsidem:dem-png"; do
    dir=${spec%%:*}
    name="$PREFIX-${spec#*:}"
    src="$OUT/$dir"
    [ -d "$src" ] || { stamp "skip $dir（$src が無い）"; continue; }
    # 拡張子は中身で決まる。RGB 系は TILE_FORMAT 次第、gsidem は常に png
    ext=$(find "$src" -mindepth 3 -maxdepth 3 -type f \( -name '*.png' -o -name '*.webp' \) -print -quit)
    ext=${ext##*.}

    stamp "pack $dir → $name.mbtiles ($ext)"
    rm -f "$WORK/$name.mbtiles"
    "$PY" "$MBUTIL" --image_format="$ext" --scheme=xyz "$src" "$WORK/$name.mbtiles" > "$WORK/$name.mbutil.log" 2>&1
    "$PY" "$HERE/mbtiles_metadata.py" "$WORK/$name.mbtiles" "$ext" "$name"

    stamp "convert $name.pmtiles"
    rm -f "$OUT/pmtiles/$name.pmtiles"
    "$PY" "$CONVERT" "$WORK/$name.mbtiles" "$OUT/pmtiles/$name.pmtiles"

    stamp "verify $name.pmtiles"
    "$PY" "$HERE/verify_pmtiles.py" "$OUT/pmtiles/$name.pmtiles" "$src" "$ext"
    rm -f "$WORK/$name.mbtiles" "$WORK/$name.mbutil.log"
done
rmdir "$WORK" 2>/dev/null || true
ls -l "$OUT/pmtiles"
