"""dem2tiles の出力を検証する。

2 つの出力ディレクトリ（例: PNG の実行と WebP の実行）について、3 種類のタイルの
枚数・ズーム範囲・デコード後の画素が一致するかを確かめ、さらに元の GeoTIFF から
無作為に選んだ画素とタイルの標高を照合する。

    python scripts/verify_tiles.py --old output --new output-webp \
        --src /path/to/geotiffs

--new 側の RGB 系（mapbox / terrarium）は --new-ext の拡張子で読む。gsidem は常に PNG。
画素の比較は RGBA で行う。RGB 系の NoData は透過（アルファ 0）なので、標高の照合では
透過の画素を「値なし」として数える。
実行中の出力は読まないこと（mbtiles は開かないが、展開済みディレクトリが書きかけになる）。
"""
import argparse
import math
import random
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import transform


def tiles(root, ext):
    out = {}
    for p in root.rglob(f"*.{ext}"):
        z, x, y = p.relative_to(root).with_suffix("").parts
        out[(int(z), int(x), int(y))] = p
    return out


def rgb(p):
    return np.asarray(Image.open(p).convert("RGBA"), dtype=np.int64)


def compare(old_root, new_root, kind, old_ext, new_ext):
    old, new = tiles(old_root / kind, old_ext), tiles(new_root / kind, new_ext)
    zo, zn = Counter(k[0] for k in old), Counter(k[0] for k in new)
    print(f"\n== {kind}: old {old_ext} {len(old)} tiles, new {new_ext} {len(new)} tiles")
    for z in sorted(set(zo) | set(zn)):
        mark = "" if zo[z] == zn[z] else "  <-- MISMATCH"
        print(f"  z{z:<2} old {zo[z]:>6}  new {zn[z]:>6}{mark}")
    only_old, only_new = set(old) - set(new), set(new) - set(old)
    if only_old or only_new:
        print(f"  only in old: {len(only_old)}, only in new: {len(only_new)}")
    common = sorted(set(old) & set(new))
    diff = 0
    for k in common:
        if not np.array_equal(rgb(old[k]), rgb(new[k])):
            diff += 1
            if diff <= 5:
                print(f"  pixel diff at {k}")
    print(f"  pixel-identical: {len(common) - diff} / {len(common)}")
    size_o = sum(old[k].stat().st_size for k in common)
    size_n = sum(new[k].stat().st_size for k in common)
    if size_o:
        print(f"  bytes: old {size_o:,}  new {size_n:,}  ({1 - size_n / size_o:.1%} smaller)")
    return diff == 0 and not only_old and not only_new


def decode(kind, px):
    r, g, b = px[0], px[1], px[2]
    if px[3] == 0:  # 透過（NoData）
        return None
    if kind == "terrarium":
        return r * 256 + g + b / 256 - 32768
    if kind == "mapbox":
        return -10000 + (r * 65536 + g * 256 + b) * 0.1
    v = r * 65536 + g * 256 + b  # gsidem（地理院の数値PNG）
    if v == 2**23:
        return None
    return (v - 2**24 if v > 2**23 else v) * 0.01


def sample_tile(root, ext, kind, z, size, lon, lat):
    n = 2**z * size
    gx = (lon + 180) / 360 * n
    s = math.sin(math.radians(lat))
    gy = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    tx, ty = int(gx // size), int(gy // size)
    p = root / kind / str(z) / str(tx) / f"{ty}.{ext}"
    if not p.exists():
        return None
    return decode(kind, rgb(p)[int(gy) - ty * size, int(gx) - tx * size])


def elevation_check(root, ext, src, rgb_z, gsi_z, n, seed):
    random.seed(seed)
    files = sorted(src.glob("*.tif"))
    rows = []
    while len(rows) < n:
        f = random.choice(files)
        with rasterio.open(f) as ds:
            a = ds.read(1)
            valid = np.argwhere(a != ds.nodata) if ds.nodata is not None else np.argwhere(np.isfinite(a))
            if len(valid) == 0:
                continue
            r, c = valid[random.randrange(len(valid))]
            x, y = ds.xy(r, c)
            lon, lat = transform(ds.crs, "EPSG:4326", [x], [y])
            value = float(a[r, c])
        lon, lat = lon[0], lat[0]
        rows.append((
            f.name, lon, lat, value,
            sample_tile(root, ext, "terrarium", rgb_z, 512, lon, lat),
            sample_tile(root, ext, "mapbox", rgb_z, 512, lon, lat),
            sample_tile(root, "png", "gsidem", gsi_z, 256, lon, lat),
        ))
    print(f"\n== elevation vs source GeoTIFF ({n} random valid pixels, seed {seed})")
    for i, name in ((4, f"terrarium z{rgb_z}"), (5, f"mapbox z{rgb_z}"), (6, f"gsidem z{gsi_z}")):
        d = np.array([r[i] - r[3] for r in rows if r[i] is not None])
        miss = sum(r[i] is None for r in rows)
        if len(d) == 0:
            print(f"  {name:<14} no samples (missing={miss})")
            continue
        ad = np.abs(d)
        print(f"  {name:<14} n={len(d)} missing={miss}  median|d|={np.median(ad):.3f}  "
              f"p95={np.percentile(ad, 95):.3f}  max={ad.max():.3f} m  bias={d.mean():+.3f}")
    both = [(r[4], r[5]) for r in rows if r[4] is not None and r[5] is not None]
    if both:
        tm = max(abs(a - b) for a, b in both)
        print(f"  terrarium vs mapbox same pixel: max|d|={tm:.3f} m (expect <= 0.1 quantisation)")
    worst = sorted(rows, key=lambda r: -abs((r[4] if r[4] is not None else r[3]) - r[3]))[:5]
    for w in worst:
        print(f"    worst: {w[0]} ({w[1]:.6f},{w[2]:.6f}) src={w[3]:.2f} "
              f"terrarium={w[4]} mapbox={w[5]} gsidem={w[6]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--old", type=Path, required=True, help="比較元の出力ディレクトリ")
    ap.add_argument("--new", type=Path, required=True, help="比較先の出力ディレクトリ")
    ap.add_argument("--src", type=Path, help="元の GeoTIFF のディレクトリ。省略すると標高の照合をしない")
    ap.add_argument("--old-ext", default="png", help="--old の RGB 系タイルの拡張子")
    ap.add_argument("--new-ext", default="webp", help="--new の RGB 系タイルの拡張子")
    ap.add_argument("--rgb-zoom", type=int, default=17, help="照合に使う RGB 系の最大ズーム")
    ap.add_argument("--gsidem-zoom", type=int, default=18, help="照合に使う gsidem の最大ズーム")
    ap.add_argument("--samples", type=int, default=400)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    ok = True
    ok &= compare(args.old, args.new, "mapbox", args.old_ext, args.new_ext)
    ok &= compare(args.old, args.new, "terrarium", args.old_ext, args.new_ext)
    ok &= compare(args.old, args.new, "gsidem", "png", "png")
    if args.src:
        elevation_check(args.new, args.new_ext, args.src, args.rgb_zoom, args.gsidem_zoom,
                        args.samples, args.seed)
    print("\nRESULT:", "tile sets match" if ok else "MISMATCH")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
