# dem2tiles

DEM の GeoTIFF を標高タイルに変換する。

[grid2geotiff](https://github.com/shiwaku/grid2geotiff) の後続ツール。グリッドデータ
（XYZ座標値テキスト）→ GeoTIFF → 標高タイル、というパイプラインの後半を担う。

入力ディレクトリの GeoTIFF をまとめて、3種類のタイルを出力する。

| 出力 | 形式 | タイルサイズ | 出力先 |
| --- | --- | --- | --- |
| Mapbox Terrain-RGB | PNG / WebP（`mbtiles` と展開済みディレクトリ） | 512 | `output/mapbox` |
| Terrarium | PNG / WebP（`mbtiles` と展開済みディレクトリ） | 512 | `output/terrarium` |
| 地理院標高タイル | PNG（数値PNGタイル） | 256 | `output/gsidem` |

タイルサイズが揃っていないのは意図的。地理院標高タイル（PNG形式）の仕様が
256x256 のため。

RGB 系2種の形式は `TILE_FORMAT` で選ぶ（既定 `webp`、後述）。

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
| `TARGET_SRS` | `EPSG:4326` | 入力が別の座標系なら再投影する。空なら入力のまま。`EPSG:xxxx` 形式で指定する（後述） |
| `RESAMPLING` | `bilinear` | 再投影時のリサンプリング方法 |
| `RGBIFY_BASE` | `-10000` | Terrain-RGB の基準値 |
| `RGBIFY_INTERVAL` | `0.1` | Terrain-RGB の刻み |
| `TILE_FORMAT` | `webp` | Terrain-RGB / Terrarium の画像形式（`png` / `webp`）。gsidem は常に PNG |
| `GSIDEM_RESOLUTION` | `0.01` | 数値PNGタイルの分解能 [m]。地理院仕様は 0.01 |
| `JOBS` | `nproc` の半分 | 並列数。全 CPU を使うと Docker を動かしている PC が重くなるため半分にしてある |
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
データが届かないタイルも符号化する。密な DEM なら問題ないが、
測線状・飛び地状のデータでは大半が中身のないタイルになる。

`tile_driver.py` が入力図郭のフットプリントから、データが届くタイルだけを列挙して
タイラーに渡す。フットプリントは `merged.vrt` に記録された各図郭の位置から求めるので、
入力ファイルを開き直さない。生成後に消すのではなく生成対象そのものを絞るので、時間も容量も減る。

静岡県の航空レーザ測深（1164 図郭、外接矩形 107 x 58.9 km、有効データ 61.6 km2）での実測:

| | 対象を絞る前 | 絞った後 |
| --- | --- | --- |
| mapbox / terrarium | 136,148 枚・39 分 | **3,460 枚・5 分** |
| 容量（3形式合計） | 約 1.8 GB | **715 MB** |

`gdal2NPtiles` は nodata を保持した `merged.tif` を読むので、もともとデータのない
タイルを書き出さない。絞り込みは RGB 系にだけ要る。

## NoData の扱い（RGB 系は透過）

Terrain-RGB と Terrarium には「値なし」を表す値がない。そこで RGB 系のタイルは
**RGBA で出力し、NoData の画素を透過（アルファ 0）にする**。林野庁
[マップタイル作成マニュアル](https://forestgeo.info/%e3%83%9e%e3%83%83%e3%83%97%e3%82%bf%e3%82%a4%e3%83%ab%e4%bd%9c%e6%88%90%e3%83%9e%e3%83%8b%e3%83%a5%e3%82%a2%e3%83%ab%ef%bc%88%e7%ac%ac1-0%e7%89%88%ef%bc%89/)
の Terrain-RGB と同じ扱いで、QGIS などでは NoData がそのまま透けて見える。

- 透過の画素の RGB には `DST_NODATA`（既定 -9999）を符号化した値を入れる。Terrain-RGB
  なら (0, 0, 10) で、マニュアルが `-vrtnodata "0 0 10"` で透過にしている値と同じ。
  アルファを見ないソフトでも -9999 として読める
- マニュアルは RGB に変換してから最近傍で縮める（RGB を補間すると標高が壊れるため）。
  dem2tiles は標高のまま双線形で縮め、NoData を除いて補間してから RGB にするので、
  補間で値が壊れず、低ズームもなめらかになる
- データのある画素が 1 つもないタイルは書き出さない
- 地理院標高タイル（数値PNG）は仕様上の NoData 値（RGB 128, 0, 0）を持つので、従来どおり

ブラウザは透過の画素の RGB を 0 に潰すことがある。MapLibre でそうなった場合、NoData は
Terrain-RGB で -10,000 m、Terrarium で -32,768 m として読まれる。マニュアルの方式で作った
タイルでも同じことが起きる。

以前の版は NoData を 0 m で埋めてから符号化していた（`FILL_VALUE`）。NoData が着色されるうえ、
データの縁で 0 m が補間に混ざって値がずれていた（静岡で最大 2.3 m）。透過にしてからは
縁の値も元の GeoTIFF と合う（最大 1.0 m、数値PNG と同程度）。

## 低ズームのタイルとオーバービュー

`rio rgbify` と `rio terrarium` は、タイルを 1 枚作るたびに元のラスタから 512x512 に
縮める。オーバービューが無いと、範囲全体を覆う低ズームのタイルは 1 枚ごとに全画素を
原寸で読み、しかも 1 枚を 1 ワーカーが担当するので並列にならない。山梨県全域
（190,850 x 160,374 px）では、z5〜z7 のタイルが 50 分経っても 1 枚もできなかった（#17）。

そこで `gdaladdo` で `merged_rgb.vrt.ovr`（`merged.tif` を指す VRT の外部オーバービュー、
`average`）を作り、`tile_driver.py` がタイルの解像度に合う段を選んで読む。元の解像度に近いズーム
（静岡・山梨の 0.5 m なら z16〜17）はオーバービューを使わず、**出力は変更前とバイト単位で
同じ**。それより低いズームは縮小のしかたが変わるので値が少し変わる。

静岡県の航空レーザ測深（1164 図郭、222,948 x 101,654 px）での実測（NoData を 0 m で埋めていた版、並列 14）:

| | 変更前 | 変更後 |
| --- | --- | --- |
| オーバービューの作成 | ― | 34 秒 |
| mapbox（z5〜17） | 303 秒 | **66 秒** |
| terrarium（z5〜17） | 298 秒 | **77 秒** |

z5〜15 の値の変化（山梨の 400 図郭、terrarium）は、データの縁から離れた場所で中央値
0.008 m、99.9% が 0.27 m 以内。

オーバービューを `merged.tif` に直接付けないのは、GDAL が縮小して読むときに自動で
オーバービューを使うため。地理院標高タイルを作る `gdal2NPtiles` は `merged.tif` を読むので、
そちらの出力が変わりうる。

## 入力の検証

マージの前に入力を点検し、**座標系が混在していればエラーで止める**。

```console
probe: gdalbuildvrt left 12 of 140 input(s) out of the mosaic (EPSG:6676), refusing to merge:
  CRS EPSG:6677: 12 file(s), e.g. /input/09xxxxxx.tif
Inputs in another CRS have to be reprojected to a common CRS first.
```

`gdalbuildvrt` は座標系が食い違うファイルを警告だけ出して除外するため、放っておくと
出力から一部の図郭が黙って欠ける。系をまたぐデータは事前に揃えること。

点検は `merged.vrt` に対して行う。入力の一覧と VRT に入った図郭を突き合わせ、
抜けたものだけを開いて理由を調べる。全ファイルを開き直すと、Windows のフォルダを
マウントした環境では 37,850 図郭で 7 分半かかっていた（#18）。

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

圧縮は `NUM_THREADS=$JOBS` で並列に行う。GTiff は既定では 1 スレッドで圧縮するので、
`gdalwarp -multi` で再投影を並列にしても書き込みで詰まる。データの詰まった範囲
（山梨の 400 図郭、出力 17,073 x 10,491 px）での実測:

| | 変更前 | `NUM_THREADS` あり |
| --- | --- | --- |
| 再投影（`gdalwarp`） | 20 秒 | 14 秒 |
| NoData 置換（`gdal_calc.py`） | 14 秒 | 9 秒 |

出力は画素単位で同一。`gdalwarp -wm` を大きくするのは試したが、速くならず、
再投影の近似がチャンク単位のため値が変わる（最大 0.66 m）ので採用していない。

## 中間ファイルと再実行

- `output/input_files.txt` — 拾った入力の一覧
- `output/merged.vrt` — 入力をまとめた仮想ラスタ。最初に一度だけ作り、入力の点検・
  マージ・タイルの範囲の計算がこれを使う。入力ファイルを全部開くのはこの 1 回だけ
- `output/merged.tif` — 再投影済み。NoData は保持。地理院標高タイルの元
- `output/merged_rgb.vrt`, `output/merged_rgb.vrt.ovr` — `merged.tif` を指す VRT と
  そのオーバービュー。RGB 系タイルの元。`OUTPUTS` に `mapbox` も `terrarium` も無いときは
  作られない
- `output/mapbox.mbtiles`, `output/terrarium.mbtiles` — 展開前の mbtiles。`tiles` に
  インデックスが無く範囲の metadata も無いので、PMTiles の元にはしない（後述、Issue #28）。
  再実行時のスキップの判定に使うので、消すと RGB 系が作り直しになる
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
[dem2tiles] mosaic VRT is up to date, skipping
[dem2tiles] merge is up to date, skipping
[dem2tiles] overviews are up to date, skipping
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

## タイルの画像形式（PNG / WebP）

既定では Terrain-RGB と Terrarium を WebP で出力する。
[Mapterhorn](https://github.com/mapterhorn/mapterhorn) が terrain タイルの配信形式に
採用しているのがこれで、dem2tiles の既存出力とはエンコーディング（terrarium）も
タイルサイズ（512）も既に同じなので、違うのは形式だけになる。

PNG で出したいときは `TILE_FORMAT=png` を指定する。

```bash
docker run --rm -u `id -u`:`id -g` -e TILE_FORMAT=png \
  -v /path/to/dem:/input -v $(pwd)/output:/output dem2tiles
```

同一データ（grid2geotiff の 0.5m グリッド 4図郭、z5-18、83タイル）での実測。

| | PNG | WebP | 削減 |
| --- | --- | --- | --- |
| `mapbox.mbtiles` | 1,462,272 B | 831,488 B | 43% |
| `terrarium.mbtiles` | 5,844,992 B | 3,411,968 B | 42% |

**標高値は変わらない。** 83タイル全てで PNG と WebP の復号画素が完全一致した。
`rio-rgbify` / `rio-terrarium` はどちらも `im.save(f, format="webp", lossless=True)` と
ハードコードされていて、非可逆圧縮になる経路がない。

静岡県の航空レーザ測深（1164 図郭）でも、3,460 タイル全てで復号画素が PNG と一致した。
サイズは Terrarium で 31.4%、Terrain-RGB で 41.5% 減った。詳細は
[`docs/verification-shizuoka.md`](docs/verification-shizuoka.md)、照合は
`scripts/verify_tiles.py` で再現できる。

配信済みの PNG タイルを作り直すときは `TILE_FORMAT=png` を指定する。形式を変えると
タイル URL の拡張子（`.png` / `.webp`）が変わり、参照側の設定も直す必要があるため。

`gsidem` はこの設定の対象外で、常に PNG を出す。地理院標高タイル（PNG形式）の仕様が
256x256 の PNG であり、地理院互換であることがこの出力の存在理由のため。

## 配信（PMTiles + Worker）

[Mapterhorn](https://github.com/mapterhorn/mapterhorn)（`tiles.mapterhorn.com`）と同じ構成で配る。
R2 には県・種類ごとに PMTiles を 1 ファイル置き、Worker（[`worker/`](worker/)）が
`{z}/{x}/{y}` の URL で 1 タイルずつ取り出して返す。利用側から見れば ZXY のタイルのまま。

ZXY のまま R2 に上げると、山梨だけで 3 種類 585,117 オブジェクトになる。PMTiles なら 3 ファイル。

```
https://tiles.shi-works.com/pref-yamanashi/yamanashi-lp-terrarium/{z}/{x}/{y}.webp
https://tiles.shi-works.com/pref-yamanashi/yamanashi-lp-terrain-rgb/{z}/{x}/{y}.webp
https://tiles.shi-works.com/pref-yamanashi/yamanashi-lp-dem-png/{z}/{x}/{y}.png
```

| | 置き場所 |
| --- | --- |
| PMTiles | R2 バケット `shi-works` の `pmtiles/{県}/{県}-{元データ}-{種類}.pmtiles` |
| 同じアーカイブを `pmtiles://` で直接読む | `https://shi-works.com/pmtiles/...`（R2 のカスタムドメイン） |
| ZXY で読む | `https://tiles.shi-works.com/{県}/{名前}/{z}/{x}/{y}.{ext}`（Worker） |

名前の「元データ」は静岡が `alb`（航空レーザ測深）、山梨が `lp`（航空レーザ測量）。
種類は `terrarium` / `terrain-rgb` / `dem-png`。

静岡は先に ZXY のまま `raster-tiles/pref-shizuoka/` に上げてあり、そちらで配っている。

### PMTiles を作る

```bash
pip install mbutil pmtiles
scripts/make_pmtiles.sh output-yamanashi yamanashi-lp
# → output-yamanashi/pmtiles/yamanashi-lp-{terrarium,terrain-rgb,dem-png}.pmtiles
```

展開済みの ZXY ディレクトリを mb-util で mbtiles に詰め直し、範囲の metadata を足して
`pmtiles convert` にかけ、全タイルを ZXY ディレクトリとバイト単位で照合する。

dem2tiles が書く `*.mbtiles` は使わない。`tiles` にインデックスが無く、山梨の規模では
変換が終わらない（2 時間 44 分で出力 0 バイト。Issue #28）。範囲とズームの metadata も無い。

山梨での実測は [`docs/verification-yamanashi.md`](docs/verification-yamanashi.md#pmtiles-化と配信)。

### R2 に上げる

1 ファイルが数十 GB あり `wrangler r2 object put` の上限を超えるので、S3 互換 API
（aws cli のマルチパート）で上げる。

```bash
aws s3 cp output-yamanashi/pmtiles/yamanashi-lp-terrarium.pmtiles \
  s3://shi-works/pmtiles/pref-yamanashi/yamanashi-lp-terrarium.pmtiles \
  --profile r2-shiworks --endpoint-url https://<アカウントID>.r2.cloudflarestorage.com
```

上げたあと、Worker 経由のタイルを照合する（深いズームは抜き取り）。

```bash
node scripts/verify_worker.mjs \
  https://tiles.shi-works.com/pref-yamanashi/yamanashi-lp-terrarium output-yamanashi/terrarium webp 2000
```

### ビューワ

[`viewer/`](viewer/) は 3 種類を切り替えて段彩・陰影起伏・等高線・3D 地形で確かめるビューワ。
公開版は <https://shiwaku.github.io/dem2tiles/>。静岡と山梨をパネルで切り替える。

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

- 以前の版が作っていた `merged_filled.tif` は、今の版で実行すると自動で消える。

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
