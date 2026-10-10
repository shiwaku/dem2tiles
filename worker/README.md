# tiles worker

R2 に置いた PMTiles から 1 タイルずつ取り出し、ZXY で配る Cloudflare Worker。
[Mapterhorn](https://github.com/mapterhorn/mapterhorn)（`tiles.mapterhorn.com`）と同じ構成で、
R2 には県・種類ごとに PMTiles を 1 ファイル置き、利用側には `{z}/{x}/{y}` の URL を見せる。

ZXY のまま R2 に上げると、山梨だけで 3 種類 585,117 オブジェクトになる。PMTiles なら 3 ファイル。

## URL

| リクエスト | 読む R2 のキー |
| --- | --- |
| `https://tiles.shi-works.com/{dir...}/{name}/{z}/{x}/{y}.{ext}` | `pmtiles/{dir...}/{name}.pmtiles` |
| `https://tiles.shi-works.com/{dir...}/{name}.json`（TileJSON） | 同上 |

```
https://tiles.shi-works.com/pref-yamanashi/yamanashi-lp-terrarium/{z}/{x}/{y}.webp
https://tiles.shi-works.com/pref-yamanashi/yamanashi-lp-terrain-rgb/{z}/{x}/{y}.webp
https://tiles.shi-works.com/pref-yamanashi/yamanashi-lp-dem-png/{z}/{x}/{y}.png
```

### 複数アーカイブに分かれたデータ（ピラミッド）

Mapterhorn の配布形式（z0–12 の `planet.pmtiles` と、z13 以上を z6 タイル単位に分けた `6-{x}-{y}.pmtiles`）を
1 つの名前で引けるよう、`src/index.ts` の `PYRAMIDS` でズームごとに読むアーカイブを切り替える。

| リクエスト | 読む R2 のキー |
| --- | --- |
| `https://tiles.shi-works.com/mapterhorn/{z}/{x}/{y}.webp`（z ≤ 12） | `pmtiles/mapterhorn/planet-japan.pmtiles` |
| 同（z ≥ 13） | `pmtiles/mapterhorn/6-{x>>(z-6)}-{y>>(z-6)}.pmtiles` |
| `https://tiles.shi-works.com/mapterhorn.json` | `planet-japan` の TileJSON（maxzoom を 16 に上書き） |

R2 への配置と週次更新は [shiwaku/japan-basemap-tile-pipeline](https://github.com/shiwaku/japan-basemap-tile-pipeline) が行う（日本域のみ）。
サブピラミッドが無い所は 404。

- 拡張子は中身の形式と一致させる。違えば 404（`.png` で WebP を返さない）
- データの無いタイルは 404。dem2tiles の ZXY 出力でもファイルが無い所なので、挙動を合わせている
- CORS は全オリジン。タイルは `Cache-Control: public, max-age=86400` で返し、Cache API にも置く
  （R2 を Range で読むと 1 回 0.2 秒ほど掛かるため）

キーの第 1 階層 `pmtiles/` は xserver-cleanup の `R2-STRUCTURE.md` §4 に従う。同じアーカイブは
`https://shi-works.com/pmtiles/...` からも `pmtiles://` で直接読める。

shi-works.com 本体は R2 のカスタムドメインで、Worker は通らない。この Worker は配信用の
サブドメイン `tiles.shi-works.com` だけを受け持つ。

## PMTiles の作り方

dem2tiles の出力（展開済みの ZXY ディレクトリ）から `scripts/make_pmtiles.sh` で作る。

```bash
pip install mbutil pmtiles
scripts/make_pmtiles.sh output-yamanashi yamanashi-lp
# → output-yamanashi/pmtiles/yamanashi-lp-{terrarium,terrain-rgb,dem-png}.pmtiles
```

ディレクトリを mb-util で mbtiles に詰め、範囲の metadata を足して `pmtiles convert` にかけ、
全タイルを照合する。dem2tiles が書く `*.mbtiles` はインデックスが無く変換が終わらないので
使わない（Issue #28）。

上げたあとの照合は `scripts/verify_worker.mjs`（ルートの README「配信」）。

## ローカルで確かめる

```bash
cd worker
npm install
# ローカルの R2 に置く（--local。本番のバケットには触らない）
npx wrangler r2 object put shi-works/pmtiles/pref-shizuoka/shizuoka-alb-terrarium.pmtiles \
  --file shizuoka-alb-terrarium.pmtiles --local
npm run dev   # http://127.0.0.1:8787/pref-shizuoka/shizuoka-alb-terrarium/12/3612/1626.webp
```

ビューワをローカルの Worker に向けるには:

```bash
cd viewer
VITE_TILES_BASE=http://127.0.0.1:8787/pref-shizuoka VITE_TILES_EXT=webp npm run dev
```

## デプロイ

```bash
npm run deploy
```

初回は `tiles.shi-works.com` のカスタムドメインが作られる（`wrangler.jsonc` の `routes`）。

PMTiles のアップロードは `wrangler r2 object put` では上限（300 MB 程度）を超えるので、
R2 の S3 互換 API（aws cli のマルチパート）で上げる。山梨は aws cli のプロファイル `r2-shiworks` で上げた（ルートの README「配信」）。
