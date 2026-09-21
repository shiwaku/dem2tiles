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

タイルサイズが揃っていないのは意図的で、地理院標高タイルの仕様が 256 のため。

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
[dem2tiles] RGB_MAX_ZOOM=auto -> 18
[dem2tiles] GSIDEM_MAX_ZOOM=auto -> 18
[dem2tiles] reprojecting EPSG:6676 -> EPSG:4326
Creating output file that is 1707P x 1045L.
[dem2tiles] replacing nodata (-9999) with 0
...
[dem2tiles] done
```

z5〜18 で3形式それぞれ 83 タイルが出る。

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
| `JOBS` | `nproc` | 並列数 |

`TARGET_SRS` は入力から読み取った `EPSG:xxxx` と文字列で比較する。`epsg:4326` のような
別表記や WKT を渡すと一致せず、毎回再投影が走る。

### 最大ズームの自動決定

`auto` は入力の画素サイズから決める。Web Mercator の地上分解能が入力の格子間隔より
細かくなる最小のズームを選ぶので、元データの解像度をそのまま活かせる。

0.5m グリッドを緯度 35.7° で変換した場合:

```
[dem2tiles] source CRS: EPSG:6676, pixel size: 0.500000 m, centre latitude: 35.666033
[dem2tiles] RGB_MAX_ZOOM=auto -> 18
```

緯度 35.7° での地上分解能は z16 で約 1.9 m/px、z17 で約 1.0 m/px、z18 で約 0.5 m/px。
0.5m データを z16 で打ち切ると情報の 1/16 しか使わないことになる。

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

## 中間ファイルと再実行

各ステップは出力が既にあればスキップする。全部そろった状態で再実行すると、何もせずに
終わる。

- `output/input_files.txt` — 拾った入力の一覧
- `output/merged.vrt` — 入力をまとめた仮想ラスタ
- `output/merged.tif` — 再投影済み。NoData は保持。地理院標高タイルの元
- `output/merged_filled.tif` — NoData を `FILL_VALUE` に置換。RGB 系タイルの元。
  `OUTPUTS` に `mapbox` も `terrarium` も無いときは作られない
- `output/mapbox.mbtiles`, `output/terrarium.mbtiles` — 展開前の mbtiles
- `output/mapbox`, `output/terrarium`, `output/gsidem` — 展開済みタイル

なお `output/gsidem` には gdal2NPtiles が生成する確認用ビューア
（`leaflet.html` / `openlayers.html` / `googlemaps.html` / `mapml.mapml`）も入る。

### 作り直すとき

**mbtiles と展開済みディレクトリは対にして消すこと。** mbtiles だけ消すと、`mb-util` が
既存のディレクトリに書けずに落ちる。

```bash
rm -rf output/mapbox.mbtiles output/mapbox
```

### スキップ判定の限界

スキップ判定は出力の**存在**しか見ていない。そのため次のケースでは、古い結果が残った
まま正常終了する。

- 途中で失敗した実行の成果物も「完了」とみなされる
- ズームや符号化の設定を変えて再実行しても、既存の出力があれば反映されない

確実に作り直したいときは `output/` を消してから実行する。詳細と改善案は
[#4](https://github.com/shiwaku/dem2tiles/issues/4)。

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
