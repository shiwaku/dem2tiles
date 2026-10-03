# 検証レポート: 山梨県全域で 3 種類のタイルを作る（2026-09-29）

山梨県全域の DEM で、3 種類のタイルを 1 種類ずつ作り、処理時間と出力を確かめた（Issue #15）。

## 結論

- 3 種類とも完走した。出力が空の状態から 3 種類そろうまで、計 **17,076 秒（約 4 時間 45 分）**
- 1 種類だけ作る場合の「タイル化まで」の時間は、Terrain-RGB 約 2 時間、Terrarium 約 2 時間 28 分、
  数値PNG 約 1 時間 55 分
- 元の GeoTIFF との照合（400 点）で、3 種類とも中央値 0.06 m、最大 0.54 m
- RGB 系の NoData は透過になっていて、透過の画素は -9999 を符号化した値を持つ
- 3 種類を PMTiles にして R2 に上げ、Worker（`tiles.shi-works.com`）で ZXY として配った
  （2026-10-03、[PMTiles 化と配信](#pmtiles-化と配信)）。全タイルが ZXY 出力とバイト一致

## 条件

| 項目 | 値 |
| --- | --- |
| 入力 | 山梨県 航空LP グリッドデータ（DEM）、GeoTIFF 37,850 図郭、20.8 GB（`grid2geotiff/testdata/yamanashi-dem/out`） |
| 入力の座標系・解像度 | EPSG:6676、0.5 m、float32 |
| マージ後 | 190,850 x 160,374 px、`merged.tif` 50 GB |
| イメージ | `main`（17e7f50）。NoData 透過（#24）、オーバービューと VRT の再利用（#23）を含む |
| 設定 | 既定（`TILE_FORMAT=webp`、`JOBS` は `nproc` の半分で 7） |
| 実行 | `OUTPUTS=mapbox` → `terrarium` → `gsidem` の順に 3 回。2 回目以降は VRT・merge・オーバービューを再利用 |

### 処理した PC

| 項目 | 内容 |
| --- | --- |
| 機種 | MouseComputer JGA7G60B5ABC |
| CPU | AMD Ryzen 7 5700X（8 コア 16 スレッド、ベース 3.4 GHz） |
| メモリ | 64 GB |
| ストレージ | NVMe SSD 4 TB（CSSD-M2O4000GBG3NQL）。入力・出力とも同じ SSD |
| OS | Windows 11 Pro（10.0.26200） |
| Docker Desktop | 14 CPU / 47 GB を割り当て。入力・出力は Windows のフォルダをバインドマウント |

処理時間のタイムスタンプは gawk の `systime()` で付けた。

## 処理時間

### 工程ごと

| 工程 | 所要 | 備考 |
| --- | --- | --- |
| VRT の作成と入力の点検 | 785 秒 | 全ファイルを開くのはここだけ（`gdalbuildvrt`） |
| 再投影（merge） | 1,984 秒 | `merged.tif` 50 GB |
| オーバービュー（RGB 系用） | 494 秒 | `merged_rgb.vrt.ovr` 17 GB |
| Terrain-RGB タイル化 | 3,311 秒 | 範囲の計算 9 秒を含む。約 30 枚/秒 |
| Terrain-RGB 書き出し（mb-util） | 709 秒 | |
| Terrarium タイル化 | 4,097 秒 | 約 24 枚/秒 |
| Terrarium 書き出し（mb-util） | 1,529 秒 | |
| 数値PNG（z18） | 約 2,690 秒 | gdal2NPtiles の出力はまとめて書き出されるので目安 |
| 数値PNG（z5〜17） | 約 1,470 秒 | 同上 |

### 1 種類だけ作る場合（タイル化まで）

共通の前処理（VRT・点検・merge）に、それぞれの工程を足したもの。数値PNG はオーバービューを使わない。

| 種類 | 前処理 | タイル化と書き出し | 合計 |
| --- | --- | --- | --- |
| Terrain-RGB | 3,263 秒（オーバービュー込み） | 4,020 秒 | **7,285 秒**（実測） |
| Terrarium | 3,263 秒（オーバービュー込み） | 5,626 秒 | **8,889 秒**（前処理は Terrain-RGB の実測値） |
| 数値PNG | 2,769 秒 | 4,158 秒 | **6,927 秒**（前処理は Terrain-RGB の実測値） |

3 種類を続けて作ると、前処理は 1 回で済むので計 17,076 秒（7,285 + 5,630 + 4,161）。

### 以前の実行との比較（Terrain-RGB）

| 工程 | 9/23（修正前、並列 14） | 9/28（#23 後、並列 14、NoData は 0 m で塗る） | 今回（並列 7、NoData 透過） |
| --- | --- | --- | --- |
| VRT・入力の点検 | 1,205 秒 | 767 秒 | 785 秒 |
| 再投影 | 2,070 秒 | 1,975 秒 | 1,984 秒 |
| fill（NoData を 0 m に） | 1,528 秒 | 1,318 秒 | ― |
| オーバービュー | ― | 399 秒 | 494 秒 |
| タイル化 | 50 分で z5〜7 が 1 枚もできず、z16 で中断 | 2,284 秒 | 3,311 秒 |
| 書き出し | ― | 755 秒 | 709 秒 |
| 合計 | 完走せず | 7,498 秒 | 7,285 秒 |

- 並列数を半分にしてタイル化は 1.45 倍になったが、fill が無くなった分で相殺され、合計はわずかに短い
- 再投影は並列 7 でも 14 でも変わらない。CPU より読み書きで決まっている
- 9/23 のタイル化は 8〜9.5 枚/秒で、z5〜7 が終わらなかった（#17）

## 出力

| 種類 | 枚数 | 展開済み | mbtiles |
| --- | --- | --- | --- |
| Terrain-RGB（WebP） | 98,373（z5〜17） | 5.8 GB | 5.7 GB |
| Terrarium（WebP） | 98,373（z5〜17） | 20 GB | 20 GB |
| 数値PNG（PNG） | 389,371（z5〜18、うち z18 が 290,997） | 24 GB | ― |

RGB 系は、範囲の計算で入った 98,786 枚のうち、データが 1 画素も無い 413 枚を除いた。

mbtiles は PMTiles を作ったあと 2026-10-03 に消した（中身は展開済みディレクトリと PMTiles にある）。

Terrarium が Terrain-RGB の約 3.5 倍大きいのは、標高の小数部を 1/256 m 刻みで持つため
（[`verification-shizuoka.md`](verification-shizuoka.md) 参照）。

## 標高の照合

元の GeoTIFF から有効な画素を無作為に 400 点選び、同じ地点のタイルの標高と比べた（seed 1）。

| | 中央値 \|d\| | p95 | 最大 | 偏り |
| --- | --- | --- | --- | --- |
| Terrarium z17 | 0.058 m | 0.250 m | 0.521 m | -0.011 |
| Terrain-RGB z17 | 0.060 m | 0.250 m | 0.540 m | -0.010 |
| 数値PNG z18 | 0.060 m | 0.250 m | 0.530 m | -0.014 |

- 3 種類とも同程度で、最悪の地点でも 3 種類の値がそろっている。差は符号化ではなく、
  再投影とタイルの格子への補間によるもの
- 静岡（中央値 0.02 m）より大きいのは、山地で起伏が大きく、補間の影響を受けやすいため
- 同じ画素の Terrarium と Terrain-RGB の差は最大 0.052 m で、Terrain-RGB の量子化幅（0.1 m）の範囲内

## NoData の透過

RGB 系の z12 の全タイルと z16 の 60 枚を抜き取って確かめた。

| | 透過の画素 | 透過なのに -9999 でない画素 | 全面が透過のタイル |
| --- | --- | --- | --- |
| Terrain-RGB | 19.9% | 0 | 0 |
| Terrarium | 21.8% | 0 | 0 |

アルファは 0 と 255 の 2 値だけ。

## PMTiles 化と配信

2026-10-03。3 種類を PMTiles にし、R2 に上げ、Worker で ZXY として配った（PR #29、#30）。
構成は README の「配信（PMTiles + Worker）」。

### PMTiles 化

| 種類 | PMTiles | サイズ | 変換 |
| --- | --- | ---: | ---: |
| Terrarium | `yamanashi-lp-terrarium.pmtiles` | 20.7 GB | 730 秒 |
| Terrain-RGB | `yamanashi-lp-terrain-rgb.pmtiles` | 6.0 GB | 未計測 |
| 数値PNG | `yamanashi-lp-dem-png.pmtiles` | 24.0 GB | 903 秒（mbtiles に詰めるのに別途 25 分） |

- 3 種類とも、全タイル（98,373 / 98,373 / 389,371）が ZXY 出力とバイト一致し、欠け・余りも無かった
  （`scripts/verify_pmtiles.py`）
- 変換は Python 版 pmtiles 3.8.1 の `pmtiles-convert`。数値PNG は mb-util でディレクトリから
  mbtiles に詰め（約 725 枚/秒）、範囲の metadata を足してから変換した
- RGB 系は当初 dem2tiles の mbtiles をそのまま変換しようとして、Terrarium が 2 時間 44 分経っても
  出力 0 バイトだった。`tiles` にインデックスが無く、1 枚引くたびに 20 GB を全件走査していた（Issue #28）。
  コピーに一意インデックスを張ると 730 秒で終わった
- Terrain-RGB の変換時間は、止めたつもりの最初の実行が裏で変換を終えていたため測れていない

`scripts/make_pmtiles.sh` は、この経験から RGB 系もディレクトリから mb-util で詰め直す手順に
そろえたもの。静岡（3 種類）では同じ PMTiles がバイト数まで一致して作れることを確かめたが、
山梨の規模では通していない。

### R2 へのアップロード

aws cli（S3 互換 API、マルチパート）で `pmtiles/pref-yamanashi/` に上げた。

| ファイル | 所要 |
| --- | ---: |
| `yamanashi-lp-terrain-rgb.pmtiles`（6.0 GB） | 8 分 37 秒 |
| `yamanashi-lp-terrarium.pmtiles`（20.7 GB） | 29 分 34 秒 |
| `yamanashi-lp-dem-png.pmtiles`（24.0 GB） | 34 分 7 秒 |
| 計 50.7 GB | 1 時間 12 分（平均約 12 MB/s） |

R2 上のサイズは 3 ファイルとも手元とバイト数まで一致した。

### Worker 経由の照合

`https://tiles.shi-works.com/pref-yamanashi/{名前}/{z}/{x}/{y}.{ext}` から取り、ZXY 出力と比べた
（`scripts/verify_worker.mjs`）。全部取ると約 50 GB の通信になるので、z12 以下は全部、z13 以上は
無作為に 2,000 枚。

| 種類 | 照合した枚数 | 一致 | データの無い隣接タイルが 404 | 所要 |
| --- | ---: | ---: | ---: | ---: |
| Terrarium | 2,150 | 2,150 | 53 / 53 | 66 秒 |
| Terrain-RGB | 2,150 | 2,150 | 52 / 52 | 50 秒 |
| 数値PNG | 2,150 | 2,150 | 37 / 37 | 61 秒 |

公開版のビューワ（<https://shiwaku.github.io/dem2tiles/>）で、山梨の段彩・陰影起伏・等高線が
描画されることも確かめた。

### 気づいたこと

z13 前後で、川や道路沿いに白い点が並ぶ所がある。無データ（川など）の縁で陰影起伏が
出しているように見えるが、未確認。

## 再現手順

```bash
docker build -t dem2tiles .
for kind in mapbox terrarium gsidem; do
  docker run --rm -e OUTPUTS=$kind \
    -v /path/to/yamanashi-dem/out:/input:ro -v $(pwd)/output-yamanashi:/output dem2tiles \
    | awk -v s=$(date +%s) '{printf "%6ds  %s\n", systime()-s, $0; fflush()}' > run-$kind.log
done
```

Windows の Git Bash から実行するときは、マウントに `$(pwd)` を使わず `C:/...` の形で書くこと
（一時フォルダなどが `/tmp/...` と解釈され、Docker の内部に出力されることがある）。

PMTiles 化から配信の照合まで:

```bash
pip install mbutil pmtiles
scripts/make_pmtiles.sh output-yamanashi yamanashi-lp      # 作って全タイルを照合する
for n in terrarium terrain-rgb dem-png; do
  aws s3 cp output-yamanashi/pmtiles/yamanashi-lp-$n.pmtiles \
    s3://shi-works/pmtiles/pref-yamanashi/yamanashi-lp-$n.pmtiles \
    --profile r2-shiworks --endpoint-url https://<アカウントID>.r2.cloudflarestorage.com
done
B=https://tiles.shi-works.com/pref-yamanashi
node scripts/verify_worker.mjs $B/yamanashi-lp-terrarium   output-yamanashi/terrarium webp 2000
node scripts/verify_worker.mjs $B/yamanashi-lp-terrain-rgb output-yamanashi/mapbox    webp 2000
node scripts/verify_worker.mjs $B/yamanashi-lp-dem-png     output-yamanashi/gsidem    png  2000
```
