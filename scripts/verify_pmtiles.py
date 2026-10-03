"""PMTiles の全タイルを ZXY ディレクトリとバイト単位で突き合わせる。

使い方:
    python scripts/verify_pmtiles.py yamanashi-lp-terrarium.pmtiles output-yamanashi/terrarium webp

ヘッダ（形式・ズーム・範囲）を表示し、次を数える。
- mismatch: 同じ ZXY のタイルの中身が違う
- missing:  ディレクトリにあって PMTiles に無い
- extra:    PMTiles にあってディレクトリに無い
"""

import os
import sys

from pmtiles.reader import MmapSource, Reader, all_tiles


def main() -> None:
    pm, d, ext = sys.argv[1:4]
    seen = set()
    bad = 0
    with open(pm, "rb") as f:
        r = Reader(MmapSource(f))
        h = r.header()
        print({k: h[k] for k in ("tile_type", "tile_compression", "min_zoom", "max_zoom",
                                 "addressed_tiles_count", "tile_entries_count",
                                 "tile_contents_count")})
        print("bounds", [h[k] / 1e7 for k in ("min_lon_e7", "min_lat_e7", "max_lon_e7", "max_lat_e7")])
        for (z, x, y), data in all_tiles(r.get_bytes):
            seen.add((z, x, y))
            p = os.path.join(d, str(z), str(x), f"{y}.{ext}")
            if not os.path.exists(p) or open(p, "rb").read() != data:
                bad += 1
                if bad <= 5:
                    print("MISMATCH", z, x, y)

    on_disk = set()
    for z in os.listdir(d):
        if not z.isdigit():
            continue
        for x in os.listdir(os.path.join(d, z)):
            for fn in os.listdir(os.path.join(d, z, x)):
                if fn.endswith("." + ext):
                    on_disk.add((int(z), int(x), int(fn.split(".")[0])))

    print(f"pmtiles={len(seen)} disk={len(on_disk)} mismatch={bad} "
          f"missing={len(on_disk - seen)} extra={len(seen - on_disk)}")
    sys.exit(1 if bad or on_disk != seen else 0)


if __name__ == "__main__":
    main()
