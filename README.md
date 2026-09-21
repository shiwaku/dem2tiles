# dem2tiles

DEM の GeoTIFF を標高タイルに変換する。

[grid2geotiff](https://github.com/shiwaku/grid2geotiff) の後続ツール。グリッドデータ
（XYZ座標値テキスト）→ GeoTIFF → 標高タイル、というパイプラインの後半を担う。

入力ディレクトリの GeoTIFF をまとめて、3種類のタイルを出力する。

| 出力 | 形式 | タイルサイズ | 出力先 |
| --- | --- | --- | --- |
| Mapbox Terrain-RGB | PNG（`mbtiles` と展開済みディレクトリ） | 512 | `output/mapbox` |
| Terrarium | PNG（`mbtiles` と展開済みディレクトリ） | 512 | `output/terrarium` |
| 地理院標高タイル | PNG（数値PNGタイル） | 256 | `output/gsidem` |

タイルサイズが揃っていないのは意図的。地理院標高タイル（PNG形式）の仕様が
256x256 のため。

## 使い方

```bash
docker build -t dem2tiles .
docker run --rm -u `id -u`:`id -g` \
  -v /path/to/dem:/input \
  -v $(pwd)/output:/output \
  dem2tiles
```

`/input` 以下を再帰探索して `*.tif` / `*.tiff` を集める。拡張子の大文字小文字は
区別しないので `*.TIF` も拾う。

### grid2geotiff からつなぐ

```bash
grid2geotiff convert data/raw -o data/out --crs EPSG:6676 -j 4
docker run --rm -u `id -u`:`id -g` \
  -v $(pwd)/data/out:/input \
  -v $(pwd)/output:/output \
  dem2tiles
```

grid2geotiff は平面直角座標系（例 EPSG:6676）で NoData `-9999` の GeoTIFF を出す。
dem2tiles の既定値はそれをそのまま受けられるようにしてある。

### 実行例

grid2geotiff の出力（0.5m グリッド 4図郭、EPSG:6676）を変換した場合。

```console
$ docker run --rm -u `id -u`:`id -g` -v $(pwd)/data/out:/input -v $(pwd)/output:/output dem2tiles
[dem2tiles] found 4 GeoTIFF(s) under /input
[dem2tiles] source CRS: EPSG:6676, pixel size: 0.500000 m, centre latitude: 35.666033
[dem2tiles] RGB_MAX_ZOOM=auto -> 17 (512 px tiles)
[dem2tiles] GSIDEM_MAX_ZOOM=auto -> 18 (256 px tiles)
[dem2tiles] merging 4 GeoTIFF(s)
[dem2tiles] reprojecting EPSG:6676 -> EPSG:4326
Creating output file that is 1707P x 1045L.
[dem2tiles] replacing nodata (-9999) with 0
[dem2tiles] building mapbox tiles (z5-17)
tile_driver: 3460 tile(s) intersect the inputs (z5-17)
[dem2tiles] building terrarium tiles (z5-17)
tile_driver: 3460 tile(s) intersect the inputs (z5-17)
[dem2tiles] building gsidem tiles (z5-18)
[dem2tiles] done
```

RGB 系と gsidem で最大ズームが 1 段ちがうのは正しい挙動（後述）。

## 設定

すべて環境変数で指定する（例 `-e OUTPUTS=terrarium -e RGB_MAX_ZOOM=14`）。

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `INPUT_DIR` | `/input` | 入力 GeoTIFF を探すディレクトリ |
| `OUTPUT_DIR` | `/output` | 出力先 |
| `OUTPUTS` | `mapbox terrarium gsidem` | 生成するタイル（空白かカンマ区切り） |
| `MIN_ZOOM` | `5` | Terrain-RGB / Terrarium の最小ズーム |
| `RGB_MAX_ZOOM` | `auto` | Terrain-RGB / Terrarium の最大ズーム |
| `GSIDEM_MIN_ZOOM` | `$MIN_ZOOM` | 地理院標高タイルの最小ズーム |
| `GSIDEM_MAX_ZOOM` | `auto` | 地理院標高タイルの最大ズーム |
| `SRC_NODATA` | *(なし)* | 入力の NoData 値を上書き。空なら GeoTIFF 埋め込み値を使う |
| `DST_NODATA` | `-9999` | マージ後 GeoTIFF と地理院標高タイルの NoData 値 |
| `FILL_VALUE` | `0` | RGB 符号化前に NoData を置き換える値 |
| `TARGET_SRS` | `EPSG:4326` | 入力が別の座標系なら再投影する。空なら入力のまま。`EPSG:xxxx` 形式で指定する（後述） |
| `RESAMPLING` | `bilinear` | 再投影時のリサンプリング方法 |
| `RGBIFY_BASE` | `-10000` | Terrain-RGB の基準値 |
| `RGBIFY_INTERVAL` | `0.1` | Terrain-RGB の刻み |
| `GSIDEM_RESOLUTION` | `0.01` | 数値PNGタイルの分解能 [m]。地理院仕様は 0.01 |
| `JOBS` | `nproc` | 並列数 |
| `BLOCKSIZE` | `512` | マージ後 GeoTIFF の内部ブロックサイズ |
| `COMPRESS` | `DEFLATE` | マージ後 GeoTIFF の圧縮方式 |
| `FORCE` | *(なし)* | 空でなければ既存の出力を無視して全部作り直す |

`TARGET_SRS` は入力から読み取った `EPSG:xxxx` と文字列で比較する。`epsg:4326` のような
別表記や WKT を渡すと一致せず、毎回再投影が走る。

### 最大ズームの自動決定

`auto` は入力の画素サイズから決める。Web Mercator の地上分解能が入力の格子間隔より
細かくなる最小のズームを選ぶので、元データの解像度をそのまま活かせる。

**ズームはタイルサイズに依存する。** 512 px のタイルは 256 px のタイルと同じ範囲を
倍の密度で描くので、同じ解像度に 1 段手前のズームで到達する。`rio rgbify` と
`rio terrarium` は 512 px、`gdal2NPtiles` は 256 px なので、同じ入力でも正しい
最大ズームが 1 段ちがう。

0.5m グリッドを緯度 35.7° で変換した場合:

```
[dem2tiles] RGB_MAX_ZOOM=auto -> 17 (512 px tiles)
[dem2tiles] GSIDEM_MAX_ZOOM=auto -> 18 (256 px tiles)
```

緯度 35.7° での地上分解能:

| ズーム | 256 px タイル | 512 px タイル |
| --- | --- | --- |
| z16 | 1.94 m/px | 0.97 m/px |
| z17 | 0.97 m/px | **0.485 m/px** |
| z18 | **0.485 m/px** | 0.243 m/px |

512 px タイルで z18 まで作ると、タイル数が 4 倍になったうえで元データに無い解像度を
作ることになる。

## データのあるタイルだけ作る

`rio rgbify` と `rio terrarium` は入力の外接矩形に含まれるタイルを機械的に列挙し、
データが届かないタイルも `FILL_VALUE` 一色として符号化する。密な DEM なら問題ないが、
測線状・飛び地状のデータでは大半が中身のないタイルになる。

`tile_driver.py` が入力図郭のフットプリントから、データが届くタイルだけを列挙して
タイラーに渡す。生成後に消すのではなく生成対象そのものを絞るので、時間も容量も減る。

静岡県の航空レーザ測深（1164 図郭、外接矩形 107 x 58.9 km、有効データ 61.6 km2）での実測:

| | 対象を絞る前 | 絞った後 |
| --- | --- | --- |
| mapbox / terrarium | 136,148 枚・39 分 | **3,460 枚・5 分** |
| 容量（3形式合計） | 約 1.8 GB | **715 MB** |

`gdal2NPtiles` は nodata を保持した `merged.tif` を読むので、もともとデータのない
タイルを書き出さない。絞り込みは RGB 系にだけ要る。

## 入力の検証

マージの前に入力を点検し、**座標系が混在していればエラーで止める**。

```console
probe: inputs are in more than one CRS, refusing to merge:
  EPSG:6676: 128 file(s), e.g. /input/08LE2134.tif
  EPSG:6677: 12 file(s), e.g. /input/09xxxxxx.tif
Reproject them to a common CRS first.
```

`gdalbuildvrt` は座標系が食い違うファイルを警告だけ出して除外するため、放っておくと
出力から一部の図郭が黙って欠ける。系をまたぐデータは事前に揃えること。

## マージ後 GeoTIFF の作り方

`merged.tif` はタイル型・スパースで書く。これは大きな範囲では必須で、既定を変えると
処理が終わらなくなる。

ストリップ型の GeoTIFF は 1 行を 1 ストリップにする。範囲が横に広いとこの 1 行が巨大に
なり、float32 で 222,948 px なら 891 KB。`gdalwarp` は出力を矩形のチャンクに分けて
書くので、圧縮されたストリップへの部分書き込みのたびに、そのストリップ全体を
展開・修正・再圧縮することになる。同じストリップを何度も書き直し続けて前に進まない。

実測（静岡県の航空レーザ測深、1164 図郭、出力 222,948 x 101,654 px）:

| 作成オプション | `gdalwarp` の所要 |
| --- | --- |
| ストリップ型 | **18 分で 1 バイトも進まず**（書き込み位置が後退） |
| `TILED=YES` + `SPARSE_OK=TRUE` | **150 秒**、613 MB |

`SPARSE_OK` は全体が NoData のブロックをファイルに置かない。海岸線や測線に沿った
データは外接矩形のごく一部しか埋めない（この例では 0.98%）ので効果が大きい。

圧縮は DEFLATE の level 1。LZW より少し大きいが速く、中間ファイルはタイルができれば
消してよいもの。`BLOCKSIZE` と `COMPRESS` で変更できる。

## 中間ファイルと再実行

- `output/input_files.txt` — 拾った入力の一覧
- `output/merged.vrt` — 入力をまとめた仮想ラスタ
- `output/merged.tif` — 再投影済み。NoData は保持。地理院標高タイルの元
- `output/merged_filled.tif` — NoData を `FILL_VALUE` に置換。RGB 系タイルの元。
  `OUTPUTS` に `mapbox` も `terrarium` も無いときは作られない
- `output/mapbox.mbtiles`, `output/terrarium.mbtiles` — 展開前の mbtiles
- `output/mapbox`, `output/terrarium`, `output/gsidem` — 展開済みタイル
- `output/.state/` — 各ステップの完了マーカー

なお `output/gsidem` には gdal2NPtiles が生成する確認用ビューア
（`leaflet.html` / `openlayers.html` / `googlemaps.html` / `mapml.mapml`）も入る。

### スキップの条件

ステップを飛ばすのは、次の3つがすべて成り立つときだけ。

1. `output/.state/` に完了マーカーがある
2. マーカーに記録された設定のフィンガープリントが今回と一致する
3. そのステップの出力がすべて存在する

どれかが崩れていれば、そのステップの出力を消してから作り直す。マーカーはステップが
最後まで通ったときにしか書かれないので、途中で失敗した成果物が「完了」とみなされる
ことはない。

フィンガープリントは上流のステップのものを含む。入力の顔ぶれや `TARGET_SRS` を変えれば
その下流がすべて作り直され、`RGB_MAX_ZOOM` だけを変えれば `mapbox` と `terrarium` だけが
作り直される。

```console
$ docker run ... -e RGB_MAX_ZOOM=16 dem2tiles
[dem2tiles] merge is up to date, skipping
[dem2tiles] nodata fill is up to date, skipping
[dem2tiles] building mapbox tiles (z5-16)
[dem2tiles] building terrarium tiles (z5-16)
[dem2tiles] gsidem tiles are up to date, skipping
```

出力の一部を手で消した場合も、そのステップだけが作り直される。mbtiles と展開済み
ディレクトリのどちらを消しても同じ結果になる。

すべて作り直したいときは `FORCE=1` を渡すか、`output/` を消す。

### 検出できないもの

入力の指紋はファイルパスの一覧だけを見ている。ラスタの中身までハッシュすると変換より
高くつくため。**ファイル名を変えずに中身を差し替えた場合は検出できない**ので、そのときは
`FORCE=1` を使う。

## 地理院標高タイル（PNG形式）について

`output/gsidem` は地理院の標高タイル（PNG形式）と同じ符号化で出力する。

| 項目 | 値 |
| --- | --- |
| タイルサイズ | 256x256、24bit カラー PNG |
| 変換式 | `x = 2^16 R + 2^8 G + B` |
| 分解能 `u` | 0.01 m（`GSIDEM_RESOLUTION`） |
| 標高 | `x < 2^23` なら `h = xu`、`x > 2^23` なら `h = (x - 2^24)u` |
| 無効値 | `x = 2^23`、すなわち `RGB(128, 0, 0)` |

この方式は産業技術総合研究所地質調査総合センター（GSJ）が考案した
[数値PNGタイル](https://www.jstage.jst.go.jp/article/geoinformatics/26/4/26_155/_article/-char/ja)
で、地理院の標高タイル（PNG形式）もこれを採用している。

分解能は `gdal2NPtiles` の既定値も 0.01 だが、地理院互換の要になる値なので
上流の既定に任せず明示的に渡している。

なお `gdal2NPtiles` は RGB のままリサンプリングせず、数値に戻してから
リサンプリングして再符号化する。低ズームのタイルも正しい標高値になる。

## 補足

- Debian の `gdal_calc.py` は `--NoDataValue=None` が効かない。
- 地理院標高タイルは `merged.tif`、RGB 系タイルは `merged_filled.tif` から作る。
  Terrain-RGB と Terrarium には「値なし」を表す方法がないため。

## クレジット

同じ組み合わせ（rio-rgbify / rio-terrarium / gdal2NPtiles を並べて3形式の標高タイルを
作る）を先に形にしていた [smellman/gsigml2tiles](https://github.com/smellman/gsigml2tiles)
を参考にした。実装は書き起こしたもので、コードは引き継いでいない。

イメージに含まれるツール:

| ツール | ライセンス |
| --- | --- |
| [mapbox/rio-rgbify](https://github.com/mapbox/rio-rgbify) | MIT |
| [smellman/rio-terrarium](https://github.com/smellman/rio-terrarium) | MIT |
| [smellman/gdal2NPtiles](https://github.com/smellman/gdal2NPtiles)（[qchizu/gdal2NPtiles](https://github.com/qchizu/gdal2NPtiles) の fork） | MIT |
| [mapbox/mbutil](https://github.com/mapbox/mbutil) | BSD-3-Clause |

## ライセンス

MIT
