# 検証レポート: 静岡データで 3 種類のタイルを出力する（2026-09-28）

`TILE_FORMAT` の既定を `webp` にした（#19）あと、3 種類のタイル（Terrain-RGB / Terrarium /
数値PNG）が正しく出力されるかを静岡のデータで確かめた。経緯は Issue #15 にある。

## 結論

- 3 種類とも完走し、ズームごとの枚数も 9/21 の PNG の実行と一致した
- WebP は PNG とデコード後の画素が全枚数で一致した（可逆であることの実測）
- 元の GeoTIFF と照合した標高の差は、中央値でおおむね 0.02 m
- サイズは Terrarium で 31.4%、Terrain-RGB で 41.5% 減った
- 公開ビューアを WebP 版に切り替えた（#20 / #21）

## 条件

| 項目 | 値 |
| --- | --- |
| 入力 | 静岡県の航空レーザ測深（ALB）、GeoTIFF 1,164 図郭（`grid2geotiff/testdata/shizuoka-alb/out`） |
| 入力の座標系・解像度 | EPSG:6676、0.5 m |
| イメージ | `main`（a25d822）をビルドしたもの |
| 設定 | すべて既定（`OUTPUTS=mapbox terrarium gsidem`、`TILE_FORMAT=webp`） |
| ズーム | RGB 系 z5〜17（512 px）、gsidem z5〜18（256 px）。いずれも auto |
| 比較対象 | 9/21 に同じ入力を PNG で出力したもの（`output/`） |

## 結果

### 枚数と画素

| 種類 | 枚数（ズーム） | 9/21 PNG とのデコード後画素 |
| --- | --- | --- |
| Terrain-RGB（WebP） | 3,460（z5〜17） | 3,460 / 3,460 一致 |
| Terrarium（WebP） | 3,460（z5〜17） | 3,460 / 3,460 一致 |
| 数値PNG（PNG） | 9,017（z5〜18） | 9,017 / 9,017 一致（バイト単位でも同一） |

ズームごとの枚数も、全ズームで一致した。

### 元の GeoTIFF との照合

元の GeoTIFF から有効な画素を無作為に 400 点選び、同じ地点のタイルの標高と比べた（seed 1）。

| | 中央値 \|d\| | p95 | 最大 | 偏り |
| --- | --- | --- | --- | --- |
| Terrarium z17 | 0.021 m | 0.113 m | 2.256 m | +0.000 |
| Terrain-RGB z17 | 0.000 m | 0.100 m | 2.300 m | +0.003 |
| 数値PNG z18 | 0.020 m | 0.111 m | 0.980 m | -0.008 |

同じ画素で Terrarium と Terrain-RGB を比べると、差は最大 0.052 m で、Terrain-RGB の量子化幅（0.1 m）に収まる。

最大の外れ（約 2.3 m）は RGB 系だけに出ていて、同じ地点の数値PNG は元の値と一致する
（08PD0359: 元の値 -8.60 m、数値PNG -8.61 m、Terrarium -6.34 m）。RGB 系は NoData を 0 で
埋めてからタイルにするので（fill）、データの縁で 0 が補間に混ざったためと見ている。未確認。

### タイルサイズ

| 種類 | 枚数 | PNG 合計 | WebP 合計 | 削減 | 1 枚平均（PNG → WebP） |
| --- | --- | --- | --- | --- | --- |
| Terrarium | 3,460 | 339.0 MB | 232.5 MB | 31.4% | 98.0 KB → 67.2 KB |
| Terrain-RGB | 3,460 | 113.3 MB | 66.3 MB | 41.5% | 32.8 KB → 19.2 KB |
| 数値PNG | 9,017 | 259.6 MB | （PNG のまま） | ― | 28.8 KB（256 px） |

- WebP のほうが大きくなったタイルは 0 枚
- 低ズームほど削減率が大きい

  | ズーム | z5 | z8 | z11 | z14 | z17 |
  | --- | --- | --- | --- | --- | --- |
  | Terrarium | 83% | 58% | 37% | 32% | 31% |
  | Terrain-RGB | 89% | 68% | 54% | 47% | 40% |

- Terrarium が Terrain-RGB の約 3 倍大きいのは、標高の小数部を 1/256 m 刻みで B チャンネルに
  持つので画素値が細かくばらつくため（Terrain-RGB は 0.1 m 刻み）

数値PNG は地理院の標高タイル（PNG 形式）と互換にするための出力で、仕様が 256x256 の PNG なので
`TILE_FORMAT` の対象外にしてある。

### 処理時間

> **訂正（同日）**: 当初ここに載せた工程別の時間（Terrain-RGB 645 秒、数値PNG 107 秒など）は
> 誤りだった。ログに 1 行ずつ `date` コマンドでタイムスタンプを付けていたため、mb-util が
> タイル 1 枚ごとに出す 2 行のログを処理しきれず、記録の時刻が実際より数分遅れていた。
> 「Terrain-RGB だけ 2 倍遅い」「数値PNG が 4 倍速い」はこの遅れによる見かけで、実際の差ではない。

gawk の `systime()` でタイムスタンプを付け直し、同じ出力の RGB 系タイルだけを作り直して
測った値（#17 の修正前のコード）:

| 工程 | 9/21 PNG（参考） | WebP |
| --- | --- | --- |
| Terrain-RGB（範囲の計算を含む） | 309 秒 | 303 秒 |
| Terrarium（範囲の計算を含む） | 314 秒 | 298 秒 |

**WebP にしても RGB 系タイルの生成は遅くならない。** 9/21 の値は古い記録で測り方の条件が
そろっていないので参考だが、差は数 % に収まる。全体の合計（1,401 秒と 1,415 秒）も同程度だった。

エンコードだけを単体で測ると（z17 の 40 枚、Pillow）、WebP（lossless）は PNG より 1 枚あたり
7〜11 倍遅い。

| | PNG | WebP |
| --- | --- | --- |
| Terrain-RGB | 9.1 ms | 63.7 ms |
| Terrarium | 8.5 ms | 96.3 ms |

それでも全体が遅くならないのは、1 枚あたりの時間の大半がエンコードではなく、元のラスタを
読んで縮める処理だったため。低ズームのタイルが原寸のラスタを読む問題（#17）を直したあとは
Terrain-RGB 66 秒、Terrarium 77 秒になった（README「低ズームのタイルとオーバービュー」）。

### ビューア

`VITE_TILES_EXT=webp` で 3 種類とも表示できた。数値PNG のデータの無い領域で出る 404 が
`[object Object]` としてエラー表示される不具合が見つかり、#20 で直した。

## 公開ビューアの WebP 化

dem2tiles が直接出力した WebP（可逆）を R2 にアップロードし、公開ビューアを切り替えた。
PNG から変換したものではない。

- アップロード先: `raster-tiles/pref-shizuoka/shizuoka-alb-terrarium/` と `shizuoka-alb-terrain-rgb/` に 3,460 枚ずつ。既存の PNG は残した
- 確認したこと
  - R2 上の枚数が手元と一致
  - `shi-works.com` から取得したタイルが手元とバイト単位で一致（無作為 8 枚）
  - `Content-Type: image/webp`、`Access-Control-Allow-Origin: *` が返る
  - 公開中の PNG と数値PNG も、手元の出力とバイト単位で一致（数値PNG はアップロード不要）
- #21（`viewer/.env.production` に `VITE_TILES_EXT=webp`）をマージし、公開ページで Terrarium /
  Terrain-RGB が `.webp` から描画されることを確認した

`xserver-cleanup` の方針 B'（`.png` の URL に WebP を返す Worker）はまだ動いていない
（変換済みの CS 立体図も `.png` で取ると 404）。そのため URL の拡張子を `.webp` に変えて対応した。
Worker が動き出したら、URL を `.png` に戻せる。

## 再現手順

```bash
# タイルを出力する（設定はすべて既定）
docker build -t dem2tiles .
docker run --rm -v /path/to/shizuoka-alb/out:/input:ro -v $(pwd)/output-webp:/output dem2tiles

# 比較元（PNG）と照合する
python scripts/verify_tiles.py --old output --new output-webp \
    --src /path/to/shizuoka-alb/out
```

`scripts/verify_tiles.py` は、枚数・ズーム範囲・デコード後の画素の一致と、元の GeoTIFF との
標高の照合を行う。Python に `numpy`、`rasterio`、WebP 対応の `Pillow` が要る。
実行中の出力は読まないこと。
