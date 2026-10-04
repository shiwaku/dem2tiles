import type { LayerSpecification, RasterSourceSpecification } from 'maplibre-gl'
import { ATTRIBUTION, RELIEF_ID, absoluteTileUrl, demByKey, type RegionKey } from './dem'

/**
 * 段彩図（標高を色で塗り分けたラスタ）。陰影起伏の下に敷いて陰影段彩図にする。
 *
 * MapLibre 5 には標高を直接色に写すレイヤーが無いため、DEM タイルを取得して
 * 画素ごとに標高を読み、色に置き換えたラスタタイルを返すカスタムプロトコルで
 * 実現する。配色・レンジ・既定値は shiwaku/naisui-risk-verification の viewer に
 * そろえる。元をたどると国土地理院の点群タイル閲覧サイト（gsi-cyberjapan/3dpc-3dtiles）と
 * 全国Ｑ地図（qchizu/qchizu_maplibre, MIT）の実装。
 *
 * 読む DEM は数値PNGタイルに固定する。数値PNGは欠測を NA（x = 2^23）として持つので、
 * 無データ域を透明にできる。参照元は全球の Mapterhorn を読むので無データ域が無いが、
 * こちらは県境や測線の外側が無データで、そこを塗ると背景地図が読めなくなる。
 * 3種類とも同じ DEM が元なので、どの表示を選んでいても段彩は一致する。
 */

export const RELIEF_SOURCE = 'relief'
export const RELIEF_PROTOCOL = 'relief'

/** 段彩の既定不透明度。背景地図の地名や水系が透ける程度に抑える。 */
export const DEFAULT_RELIEF_OPACITY = 0.55

/** 段彩タイルを実際に生成する最大ズーム。 */
const RELIEF_MAX_ZOOM = 15

/** 数値PNGタイルの分解能 [m]。 */
const GSI_U = 0.01

type Rgb = [number, number, number]
export interface Stop {
  from: number
  color: Rgb
}

/**
 * 標高の色。国土地理院の点群タイル閲覧サイトの既定値（全国Ｑ地図由来）。
 * 低地は青緑、平野は緑、山地は黄〜茶、高山は白。
 */
const TINTS: Stop[] = [
  { from: -10, color: [83, 135, 148] },
  { from: 0, color: [83, 135, 148] },
  { from: 1, color: [0, 204, 204] },
  { from: 10, color: [128, 215, 255] },
  { from: 30, color: [191, 255, 191] },
  { from: 60, color: [117, 255, 117] },
  { from: 140, color: [73, 179, 2] },
  { from: 300, color: [255, 255, 0] },
  { from: 600, color: [253, 164, 32] },
  { from: 900, color: [217, 109, 0] },
  { from: 1100, color: [163, 87, 10] },
  { from: 1500, color: [148, 107, 64] },
  { from: 2000, color: [143, 132, 122] },
  { from: 2500, color: [187, 181, 175] },
  { from: 3000, color: [230, 229, 227] },
  { from: 4000, color: [255, 255, 255] },
]

export interface ReliefRange {
  key: string
  label: string
  /** 'abs' は地形図の絶対標高、'linear' は min〜max を step 刻みで塗る。 */
  mode: 'abs' | 'linear'
  min: number
  max: number
  /** 'linear' の 1 段の標高幅（m）。(max - min) を割り切る値にする。 */
  step?: number
}

/**
 * 「全国」の配色は -10〜4000m を 16 段で塗る。山地を含む広域では正しいが、低地の
 * 微小な起伏は 2 段に収まって読めない。そこでレンジを選べるようにし、指定レンジでは
 * 1 段の刻み幅（0.5m、1m、5m…）を決めて、全国の配色を段数ぶんに補間して塗る。
 * 刻みを先に決めれば、凡例の目盛りが 0, 0.5, 1.0… とそろう。
 */
// 刻み幅はセレクトの名前に入れない（幅に収まらず末尾が切れる）。凡例の横の「1段 0.5m」が示す。
// 'linear' の min / max は下限 0m のときの値。実際の下限は withBase で動かす（名前は幅で書く）。
export const RELIEF_RANGES: ReliefRange[] = [
  { key: 'all', label: '全国（地形図の絶対標高）', mode: 'abs', min: -10, max: 4000 },
  { key: 'mountain', label: '山地 幅1000m', mode: 'linear', min: 0, max: 1000, step: 50 },
  { key: 'plain', label: '平野 幅100m', mode: 'linear', min: 0, max: 100, step: 5 },
  { key: 'lowland', label: '低地 幅20m', mode: 'linear', min: 0, max: 20, step: 1 },
  { key: 'micro', label: '微地形 幅5m（窪地）', mode: 'linear', min: 0, max: 5, step: 0.5 },
]

/**
 * 'linear' のレンジを、幅と刻みはそのままに下限 base から始まるようにずらす。
 *
 * 下限が 0m 固定だと、海から離れた低地（甲府盆地は 250〜400m）ではどの幅を選んでも
 * 全域が上限を超えて一色になる。内水の判読で見たいのは周囲との相対的な高低なので、
 * 幅（何 m の起伏を色で分けるか）と下限（どの標高から数えるか）を分けて持つ。
 */
export function withBase(range: ReliefRange, base: number): ReliefRange {
  if (range.mode === 'abs') return range
  const width = range.max - range.min
  return { ...range, min: base, max: Number((base + width).toFixed(6)) }
}

export const DEFAULT_RELIEF_RANGE = RELIEF_RANGES[3]!

export const reliefRangeByKey = (key: string): ReliefRange =>
  RELIEF_RANGES.find((r) => r.key === key) ?? DEFAULT_RELIEF_RANGE

/** 凡例の目盛りに要る小数桁。刻みが 0.5m なら 1 桁、整数なら 0 桁。 */
export function reliefDecimals(range: ReliefRange): number {
  if (range.mode === 'abs' || !range.step) return 0
  const frac = String(range.step).split('.')[1]
  return frac ? frac.length : 0
}

/**
 * 凡例に数字を出す目盛りの間隔（何段ごとか）。
 * 全段に出すと数字が重なるので、段数を割り切る 1・2・5・10… のうち
 * 数字が 6 個以下に収まる最小の間隔を選ぶ。
 */
export function reliefTickEvery(range: ReliefRange): number {
  const bands = reliefStops(range).length - 1
  for (const k of [1, 2, 5, 10, 20, 50, 100]) {
    if (bands % k === 0 && bands / k <= 5) return k
  }
  return Math.max(1, Math.ceil(bands / 5))
}

/**
 * レンジに応じた色の帯。凡例と LUT の両方がこれを使う。
 *
 * 補間の元にするのは TINTS の先頭を 1 つ落とした 15 色。−10m と 0m は意図的に
 * 同色（海面下と海面を同じ色）で、そのまま使うとレンジの下端が 1 段ぶん潰れる。
 */
export function reliefStops(range: ReliefRange): Stop[] {
  if (range.mode === 'abs') return TINTS
  const step = range.step ?? (range.max - range.min) / 14
  const bands = Math.round((range.max - range.min) / step)
  const ramp = TINTS.slice(1).map((t) => t.color)
  const stops: Stop[] = []
  for (let i = 0; i <= bands; i++) {
    // 段の位置 0〜1 を 15 色のグラデーション上の位置に写して補間する
    const u = (i / bands) * (ramp.length - 1)
    const lo = Math.floor(u)
    const hi = Math.min(lo + 1, ramp.length - 1)
    const t = u - lo
    const a = ramp[lo]!
    const b = ramp[hi]!
    const color: Rgb = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]
    // 0.1 の 3 倍が 0.30000000000000004 になる類の誤差を刻みの桁で丸め、
    // 凡例の数字とタイル URL のキーを揃える
    const from = Number((range.min + step * i).toFixed(6))
    stops.push({ from, color })
  }
  return stops
}

/** 凡例に出す帯。 */
export function reliefLegend(range: ReliefRange): { from: number; color: string }[] {
  return reliefStops(range).map((t) => ({
    from: t.from,
    color: `rgb(${Math.round(t.color[0])},${Math.round(t.color[1])},${Math.round(t.color[2])})`,
  }))
}

/** 標高（m）から色を線形補間で引く。 */
function tintAt(h: number, stops: Stop[]): Rgb {
  const first = stops[0]!
  if (h <= first.from) return first.color
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i]!
    if (h < hi.from) {
      const lo = stops[i - 1]!
      const t = (h - lo.from) / (hi.from - lo.from)
      return [
        lo.color[0] + t * (hi.color[0] - lo.color[0]),
        lo.color[1] + t * (hi.color[1] - lo.color[1]),
        lo.color[2] + t * (hi.color[2] - lo.color[2]),
      ]
    }
  }
  return stops[stops.length - 1]!.color
}

/**
 * 標高 → 色のルックアップテーブル。レンジごとに一度だけ作って使い回す。
 *
 * 画素ごとに色の帯を線形探索すると 1 タイル 512×512 = 26 万回の分岐が走る。
 * テーブルなら「配列 3 回読み」で済む。段数はレンジの幅から決め、どのレンジでも
 * 標高 1cm 刻みにする。固定段数にすると広いレンジで 1 段が粗くなり、凡例と
 * 色が食い違う。
 */
const LUT_RESOLUTION_M = 0.01
const LUT_MAX_STEPS = 400_001

const lutCache = new Map<string, Uint8Array>()

function lutSteps(range: ReliefRange): number {
  return Math.min(LUT_MAX_STEPS, Math.round((range.max - range.min) / LUT_RESOLUTION_M) + 1)
}

function lut(range: ReliefRange): Uint8Array {
  const key = `${range.mode}:${range.min}:${range.max}:${range.step ?? ''}`
  const hit = lutCache.get(key)
  if (hit) return hit
  const stops = reliefStops(range)
  const steps = lutSteps(range)
  const t = new Uint8Array(steps * 3)
  const span = range.max - range.min
  for (let i = 0; i < steps; i++) {
    const [r, g, b] = tintAt(range.min + (span * i) / (steps - 1), stops)
    t[i * 3] = r
    t[i * 3 + 1] = g
    t[i * 3 + 2] = b
  }
  lutCache.set(key, t)
  return t
}

/** 標高（m）に対して、実際にタイルへ書かれる色。配色の検証に使う。 */
export function reliefColorAt(h: number, range: ReliefRange = DEFAULT_RELIEF_RANGE): Rgb {
  const table = lut(range)
  const last = lutSteps(range) - 1
  const t = ((h - range.min) / (range.max - range.min)) * last
  const i = (t < 0 ? 0 : t > last ? last : Math.round(t)) * 3
  return [table[i]!, table[i + 1]!, table[i + 2]!]
}

/**
 * 数値PNGタイル1枚を段彩の RGBA タイルに置き換える。
 *
 * `x = 2^16 R + 2^8 G + B` として、`x = 2^23` は NA、`x > 2^23` は
 * `(x - 2^24) * u` で負の標高。NA は透明にする。無データ域を塗ると、
 * 測線の外側が一面の色で覆われて背景地図が読めなくなる。
 */
async function colorize(buffer: ArrayBuffer, range: ReliefRange): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([buffer]))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  const table = lut(range)
  const last = lutSteps(range) - 1
  const scale = last / (range.max - range.min)
  const NA = 0x800000
  for (let i = 0; i < d.length; i += 4) {
    const x = (d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!
    if (x === NA) {
      d[i + 3] = 0
      continue
    }
    // 海面下もレンジの下端の色で塗る。透明にするのは NA（無データ）だけ。
    const h = (x < NA ? x : x - 0x1000000) * GSI_U
    let t = (h - range.min) * scale
    t = t < 0 ? 0 : t > last ? last : t
    const p = ((t + 0.5) | 0) * 3
    d[i] = table[p]!
    d[i + 1] = table[p + 1]!
    d[i + 2] = table[p + 2]!
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
}

interface MaplibreLike {
  addProtocol(name: string, fn: (...args: never[]) => unknown): void
}

/**
 * `relief://<mode>/<min>/<max>/<step>/<DEMタイルのURL>` を登録する。
 * 地図の生成前に一度だけ呼ぶ。
 *
 * レンジを URL に埋めるのは、MapLibre がタイルを URL でキャッシュするため。
 * モジュール変数で持つと、レンジを変えても古い色のタイルが残ってしまう。
 */
export function registerReliefProtocol(maplibre: MaplibreLike): void {
  maplibre.addProtocol(RELIEF_PROTOCOL, (async (
    params: { url: string },
    abortController: AbortController,
  ) => {
    const rest = params.url.replace(`${RELIEF_PROTOCOL}://`, '')
    const [mode, min, max, step, ...urlParts] = rest.split('/')
    const range: ReliefRange = {
      key: 'url',
      label: '',
      mode: mode === 'abs' ? 'abs' : 'linear',
      min: Number(min),
      max: Number(max),
      step: step === '-' ? undefined : Number(step),
    }
    const res = await fetch(urlParts.join('/'), { signal: abortController.signal })
    if (!res.ok) return { data: null }
    return { data: await colorize(await res.arrayBuffer(), range) }
  }) as never)
}

/** 画面内の標高の分布。外れ値（河道の底や構造物）を除くため、両端は分位点で持つ。 */
export interface ElevationStats {
  /** 下から 2% の標高（m）。 */
  lo: number
  /** 下から 98% の標高（m）。 */
  hi: number
  /** 数えた画素数。 */
  count: number
}

/** 画面内の標高を数えるのに取るタイルの上限。超えるならズームを下げる。 */
const STATS_MAX_TILES = 36
/** 1 タイルから読む画素の間引き（縦横とも何画素おきか）。256px なら 64×64 点。 */
const STATS_STRIDE = 4

const lngToX = (lng: number, n: number): number => ((lng + 180) / 360) * n
const latToY = (lat: number, n: number): number => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
}

/** 標高を読むズーム。段彩のタイルと同じ段（256px なので地図のズーム + 1）にそろえる。 */
function readZoom(region: RegionKey, mapZoom: number): number {
  const src = demByKey(region, 'gsidem')
  return Math.max(src.minzoom, Math.min(Math.floor(mapZoom) + 1, RELIEF_MAX_ZOOM))
}

function tileUrl(region: RegionKey, z: number, x: number, y: number): string {
  return absoluteTileUrl(demByKey(region, 'gsidem').url)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
}

/** 数値PNGを標高（m）の配列にしたもの。NA は NaN。 */
interface DecodedTile {
  size: number
  h: Float32Array
}

/**
 * デコード済みタイルのキャッシュ。カーソルの標高は mousemove ごとに引くので、
 * 同じタイルを毎回デコードしないようにする。256px で 1 枚 256KB、上限 64 枚。
 */
const TILE_CACHE_MAX = 64
const tileCache = new Map<string, Promise<DecodedTile | null>>()

function decodedTile(url: string): Promise<DecodedTile | null> {
  const hit = tileCache.get(url)
  if (hit) {
    // 最近使ったものを末尾へ（Map は挿入順なので先頭から捨てれば LRU になる）
    tileCache.delete(url)
    tileCache.set(url, hit)
    return hit
  }
  const job = (async (): Promise<DecodedTile | null> => {
    const res = await fetch(url)
    if (!res.ok) return null
    const bitmap = await createImageBitmap(await res.blob())
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const h = new Float32Array(canvas.width * canvas.height)
    const NA = 0x800000
    for (let i = 0, k = 0; i < h.length; i++, k += 4) {
      const v = (d[k]! << 16) | (d[k + 1]! << 8) | d[k + 2]!
      h[i] = v === NA ? NaN : (v < NA ? v : v - 0x1000000) * GSI_U
    }
    return { size: canvas.width, h }
  })().catch(() => null)
  tileCache.set(url, job)
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!)
  return job
}

/**
 * 経緯度の標高（m）。段彩と同じ数値PNGタイルの画素値をそのまま返す。
 * 無データやタイルの範囲外は null。
 */
export async function elevationAt(
  region: RegionKey,
  lng: number,
  lat: number,
  mapZoom: number,
): Promise<number | null> {
  const z = readZoom(region, mapZoom)
  const n = 2 ** z
  const fx = lngToX(lng, n)
  const fy = latToY(lat, n)
  const x = Math.floor(fx)
  const y = Math.floor(fy)
  const t = await decodedTile(tileUrl(region, z, x, y))
  if (!t) return null
  const i = Math.min(t.size - 1, Math.floor((fx - x) * t.size))
  const j = Math.min(t.size - 1, Math.floor((fy - y) * t.size))
  const h = t.h[j * t.size + i]!
  return Number.isNaN(h) ? null : h
}

/**
 * 画面の範囲 [西, 南, 東, 北] にある標高の分布を、段彩と同じ数値PNGタイルから数える。
 * 段彩の下限を「今見ている場所」に合わせるのに使う。NA は数えない。データが無ければ null。
 */
export async function viewElevationStats(
  region: RegionKey,
  bounds: [number, number, number, number],
  mapZoom: number,
): Promise<ElevationStats | null> {
  const minzoom = demByKey(region, 'gsidem').minzoom
  const [w, s, e, n] = bounds
  let z = readZoom(region, mapZoom)
  // タイル単位の範囲。広すぎるならズームを下げて枚数を抑える。
  let x0: number, x1: number, y0: number, y1: number
  for (;;) {
    const size = 2 ** z
    x0 = Math.floor(lngToX(w, size))
    x1 = Math.floor(lngToX(e, size))
    y0 = Math.floor(latToY(n, size))
    y1 = Math.floor(latToY(s, size))
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= STATS_MAX_TILES || z <= minzoom) break
    z--
  }
  const size = 2 ** z

  const jobs: Promise<number[]>[] = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(
        decodedTile(tileUrl(region, z, x, y)).then((t) => {
          if (!t) return []
          // 画面の範囲を、このタイルの画素座標で
          const i0 = (lngToX(w, size) - x) * t.size
          const i1 = (lngToX(e, size) - x) * t.size
          const j0 = (latToY(n, size) - y) * t.size
          const j1 = (latToY(s, size) - y) * t.size
          const out: number[] = []
          for (let j = 0; j < t.size; j += STATS_STRIDE) {
            if (j < j0 || j > j1) continue
            for (let i = 0; i < t.size; i += STATS_STRIDE) {
              if (i < i0 || i > i1) continue
              const h = t.h[j * t.size + i]!
              if (!Number.isNaN(h)) out.push(h)
            }
          }
          return out
        }),
      )
    }
  }
  const values = (await Promise.all(jobs)).flat()
  if (values.length === 0) return null
  values.sort((a, b) => a - b)
  const at = (p: number): number => values[Math.min(values.length - 1, Math.floor(p * values.length))]!
  return { lo: at(0.02), hi: at(0.98), count: values.length }
}

export function reliefSourceSpec(range: ReliefRange, region: RegionKey): RasterSourceSpecification {
  const src = demByKey(region, 'gsidem')
  const url = absoluteTileUrl(src.url)
  return {
    type: 'raster',
    tiles: [
      `${RELIEF_PROTOCOL}://${range.mode}/${range.min}/${range.max}/${range.step ?? '-'}/${url}`,
    ],
    tileSize: src.tileSize,
    minzoom: src.minzoom,
    // 色への変換はメインスレッドで走る。1 タイル 512×512 = 26 万画素なので、
    // 深いズームまで実タイルを取ると描画が詰まる。ここで打ち切り、それより先は
    // overzoom で伸ばす（参考実装も同じ理由で 15 に抑えている）。
    maxzoom: Math.min(src.maxzoom, RELIEF_MAX_ZOOM),
    attribution: ATTRIBUTION,
  }
}

export function reliefLayer(opacity: number): LayerSpecification {
  return {
    id: RELIEF_ID,
    type: 'raster',
    source: RELIEF_SOURCE,
    paint: {
      'raster-opacity': opacity,
      // 補間で隣接ピクセルが混ざると、1 段の差と縁がぼやける
      'raster-resampling': 'nearest',
    },
  } as LayerSpecification
}
