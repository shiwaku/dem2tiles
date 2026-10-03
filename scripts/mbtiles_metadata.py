"""mbtiles に PMTiles のヘッダが要る metadata を足す。

`pmtiles convert` は mbtiles の metadata から PMTiles のヘッダ（範囲・ズーム・中心）を作る。
mb-util でディレクトリから詰めた mbtiles も、dem2tiles（rio-rgbify）が書く mbtiles も
`bounds` / `minzoom` / `maxzoom` / `center` を持たないので、最大ズームのタイル範囲から計算して入れる。

dem2tiles の mbtiles は `tiles` にインデックスも無く、そのままでは変換が終わらない（Issue #28）。
念のためここで一意インデックスも張る（mb-util で詰めたものには最初からある）。

使い方:
    python scripts/mbtiles_metadata.py tiles.mbtiles webp yamanashi-lp-terrarium
"""

import math
import sqlite3
import sys


def main() -> None:
    path, fmt, name = sys.argv[1:4]
    c = sqlite3.connect(path)
    c.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row)"
    )
    have = dict(c.execute("SELECT name, value FROM metadata").fetchall())
    zmin, zmax = c.execute("SELECT min(zoom_level), max(zoom_level) FROM tiles").fetchone()
    x0, x1, r0, r1 = c.execute(
        "SELECT min(tile_column), max(tile_column), min(tile_row), max(tile_row)"
        " FROM tiles WHERE zoom_level = ?",
        (zmax,),
    ).fetchone()
    n = 1 << zmax

    def lon(x: int) -> float:
        return x / n * 360 - 180

    def lat(y: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))

    # tile_row は TMS（下から数える）。XYZ の y に戻してから経緯度にする
    y_top, y_bot = n - 1 - r1, n - 1 - r0
    w, e, s, nn = lon(x0), lon(x1 + 1), lat(y_bot + 1), lat(y_top)
    want = {
        "name": name,
        "format": fmt,
        "type": "baselayer",
        "version": "1",
        "minzoom": str(zmin),
        "maxzoom": str(zmax),
        "bounds": f"{w:.6f},{s:.6f},{e:.6f},{nn:.6f}",
        "center": f"{(w + e) / 2:.6f},{(s + nn) / 2:.6f},{zmin}",
    }
    # 範囲とズームは毎回計算し直す。それ以外は空のときだけ埋める
    recompute = {"minzoom", "maxzoom", "bounds", "center"}
    for k, v in want.items():
        if k in recompute or not have.get(k):
            c.execute("DELETE FROM metadata WHERE name = ?", (k,))
            c.execute("INSERT INTO metadata VALUES (?, ?)", (k, v))
    c.commit()
    print(dict(c.execute("SELECT name, value FROM metadata").fetchall()))


if __name__ == "__main__":
    main()
