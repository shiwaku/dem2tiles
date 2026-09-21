# dem2tiles viewer

dem2tiles が出力する3種類の標高タイルを切り替えて確認するビューワ。
段彩・陰影起伏・等高線・3D地形を重ねられる。

背景は地理院の最適化ベクトルタイル。構成は
[shiwaku/ksj-suigai-rireki-converter](https://github.com/shiwaku/ksj-suigai-rireki-converter)
の viewer に倣っている。

公開版: https://shiwaku.github.io/dem2tiles/

## 使い方

タイルを先に作っておく（リポジトリのルートで）。

```bash
docker build -t dem2tiles .
docker run --rm -v /path/to/dem:/input -v $(pwd)/output:/output dem2tiles
```

ビューワを起動する。

```bash
cd viewer
npm install
npm run dev
```

## タイルの配信元

URL は配信側（R2）のキー名で組む。dem2tiles の出力ディレクトリ名とは違うが、名前を
2系統持つと URL の組み立てが環境変数で分岐してしまうため、コードは配信キー名に統一し、
dev サーバ側で実体へ読み替える（`vite.config.ts` の `KEY_TO_DIR`）。

| 環境 | `VITE_TILES_BASE` | 実体 |
| --- | --- | --- |
| dev | `/tiles`（既定） | `../output/{terrarium,mapbox,gsidem}` |
| 本番 | `https://shi-works.com/raster-tiles/pref-shizuoka` | R2 バケット `shi-works` |

```
https://shi-works.com/raster-tiles/pref-shizuoka/shizuoka-alb-terrarium/{z}/{x}/{y}.png
https://shi-works.com/raster-tiles/pref-shizuoka/shizuoka-alb-terrain-rgb/{z}/{x}/{y}.png
https://shi-works.com/raster-tiles/pref-shizuoka/shizuoka-alb-dem-png/{z}/{x}/{y}.png
```

キー設計は [shiwaku/xserver-cleanup](https://github.com/shiwaku/xserver-cleanup) の
`R2-STRUCTURE.md` に従う（第1階層はアクセス方法、第2階層以下は変更しない）。

## デプロイ

`main` の `viewer/` が変わると GitHub Actions がビルドして Pages に出す
（`.github/workflows/pages.yml`）。タイルの生成とアップロードは手元で行う。

## 中身

| ファイル | 役割 |
| --- | --- |
| `src/dem.ts` | 3種類の標高タイルの定義、`raster-dem` / 等高線のソース、陰影起伏レイヤー |
| `src/relief.ts` | 段彩。DEM を色に置き換えるカスタムプロトコルと配色・レンジ |
| `src/basemap.ts` | 背景地図。最適化ベクトルタイルのスタイルを読み、ダークは色を明度反転 |
| `src/theme.ts` | テーマの保存と適用 |
| `src/main.ts` | 地図の生成、レイヤーの注入、UI の配線 |

## 素材の出所

`public/pale.json` / `public/std.json` は地理院 最適化ベクトルタイルのスタイル。
[shiwaku/ksj-suigai-rireki-converter](https://github.com/shiwaku/ksj-suigai-rireki-converter)
の viewer から持ってきたもので、元は
[gsi-cyberjapan/optimal_bvmap](https://github.com/gsi-cyberjapan/optimal_bvmap)。
glyphs と sprite も同リポジトリの GitHub Pages を参照している。

段彩の配色（`src/relief.ts` の `TINTS`）は国土地理院の点群タイル閲覧サイトの既定値で、
全国Ｑ地図（[qchizu/qchizu_maplibre](https://github.com/qchizu/qchizu_maplibre), MIT）に由来する。
海面下の `BATHY` はこのリポジトリで足したもの。

## 実装上の注意

**数値PNGタイルは取得時に変換している。** 地理院形式は `x > 2^23` で
`h = (x - 2^24) * 0.01` という2の補数表現をとるが、MapLibre の `custom`
エンコーディングは線形式しか持たずこれを表せない。負の標高を含む DEM では
海面下が約 +167,772 m として解釈されてしまう。`gsidem://` プロトコル
（maplibre-gl-gsi-terrain）でデコードし terrarium に再符号化して渡している。

**等高線は terrarium タイルから作る。** `maplibre-contour` は DEM を自前の
HTTP で取るため MapLibre のプロトコルを経由できない。3種類とも同じ DEM が元なので、
どの表示を選んでいても等高線の位置は一致する。

**レイヤーの注入は `style.load` で行う。** `load` は初回描画まで待つので、
タブが背面にあると `requestAnimationFrame` が止まって永久に発火しない。

**段彩はメインスレッドで色に変換している。** 1 タイル 512×512 = 26 万画素なので、
実タイルを作るのは z15 までに抑え、それより深いズームは overzoom で伸ばす。
