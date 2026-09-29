import type { LayerSpecification, RasterSourceSpecification } from 'maplibre-gl'
import { ATTRIBUTION, RELIEF_ID, absoluteTileUrl, demByKey } from './dem'

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
export const RELIEF_RANGES: ReliefRange[] = [
  { key: 'all', label: '全国（地形図の絶対標高）', mode: 'abs', min: -10, max: 4000 },
  { key: 'mountain', label: '山地 0〜1000m', mode: 'linear', min: 0, max: 1000, step: 50 },
  { key: 'plain', label: '平野 0〜100m', mode: 'linear', min: 0, max: 100, step: 5 },
  { key: 'lowland', label: '低地 0〜20m', mode: 'linear', min: 0, max: 20, step: 1 },
  { key: 'micro', label: '微地形 0〜5m（窪地）', mode: 'linear', min: 0, max: 5, step: 0.5 },
]

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

export function reliefSourceSpec(range: ReliefRange): RasterSourceSpecification {
  const src = demByKey('gsidem')
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
