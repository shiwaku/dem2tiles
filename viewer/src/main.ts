import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

import { BASEMAPS, getBasemapStyle, type Basemap } from './basemap'
import {
  CONTOUR_LINE_ID,
  CONTOUR_SOURCE,
  CONTOUR_TEXT_ID,
  DEFAULT_HILLSHADE_METHOD,
  DEM_SOURCE,
  HILLSHADE_ID,
  HILLSHADE_METHODS,
  HILLSHADE_PRESETS,
  REGIONS,
  RELIEF_ID,
  contourLayers,
  contourSourceSpec,
  demByKey,
  demSourceSpec,
  hillshadeLayer,
  regionAt,
  registerDemProtocols,
  type DemDef,
  type DemKind,
  type HillshadeMethod,
  type Region,
} from './dem'
import {
  DEFAULT_RELIEF_OPACITY,
  RELIEF_RANGES,
  RELIEF_SOURCE,
  reliefDecimals,
  reliefLayer,
  reliefLegend,
  reliefRangeByKey,
  reliefSourceSpec,
  reliefTickEvery,
  registerReliefProtocol,
  type ReliefRange,
  elevationAt,
  viewElevationStats,
  withBase,
} from './relief'
import { applyThemeAttr, initialTheme, type Theme } from './theme'

/**
 * 画面の構成（パネル・地図のコントロール・背景地図の切替・レイヤーの積み順）は
 * shiwaku/naisui-risk-verification の viewer にそろえている。
 */

/**
 * 最初に開く地域。URL の #ズーム/緯度/経度 がどこかの地域を指していればそこ、無ければ先頭（静岡）。
 * 共有された URL を開いたとき、その場所にデータのある地域を選んでおく。
 */
function initialRegion(): Region {
  const [, lat, lng] = location.hash.slice(1).split('/').map(Number)
  return (lat !== undefined && lng !== undefined && regionAt(lng, lat)) || REGIONS[0]!
}

const isMobile = window.matchMedia('(max-width: 640px)').matches

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id)
  if (!e) throw new Error(`#${id} が無い`)
  return e as T
}

// ---- 状態 ----
let theme: Theme = initialTheme()
let region: Region = initialRegion()
let demKind: DemKind = 'terrarium'
let dem: DemDef = demByKey(region.key, demKind)
let base: Basemap = 'pale'
let reliefOn = true
let reliefOpacity = DEFAULT_RELIEF_OPACITY
let reliefRange: ReliefRange = reliefRangeByKey(region.reliefRange)
/** 'linear' レンジの下限（m）。幅と刻みは reliefRange が持つ。 */
let reliefBase = 0
/** 実際に塗るレンジ。 */
const effectiveRelief = (): ReliefRange => withBase(reliefRange, reliefBase)
let hillshadeOn = true
let hillshadeMethod: HillshadeMethod = DEFAULT_HILLSHADE_METHOD
let hillshadeExag = HILLSHADE_PRESETS[DEFAULT_HILLSHADE_METHOD].exaggeration
let terrainOn = false
let terrainExag = 1
let contoursOn = false

applyThemeAttr(theme)

// 背景の最適化ベクトルタイルは PMTiles で配信されている
maplibregl.addProtocol('pmtiles', new Protocol().tile as never)
registerDemProtocols(maplibregl as never)
registerReliefProtocol(maplibregl as never)

// ---- 地図 ----

const map = new maplibregl.Map({
  container: 'map',
  style: await getBasemapStyle(base, theme),
  // URL に位置があれば hash がそちらを優先する
  bounds: region.bounds,
  fitBoundsOptions: { padding: 40 },
  maxZoom: 18,
  maxPitch: 70,
  // 地図位置を URL の #ズーム/緯度/経度 に反映（共有・リロード時の位置維持）
  hash: true,
  attributionControl: false,
})

map.addControl(
  new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
  'top-right',
)
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: false },
    fitBoundsOptions: { maxZoom: 16 },
    trackUserLocation: true,
    showUserLocation: true,
  }),
  'top-right',
)
map.addControl(new maplibregl.FullscreenControl(), 'top-right')
map.addControl(new maplibregl.ScaleControl({ maxWidth: 200, unit: 'metric' }), 'bottom-left')
map.addControl(new maplibregl.AttributionControl({ compact: true }))

// タイルの 404 はデータの無い領域で常に出るので、それ以外だけを拾う。
// gsidem:// プロトコル（maplibre-gl-gsi-terrain）は Error でなく文字列を投げる。
map.on('error', (e) => {
  const err = (e as { error?: Error | string }).error
  const msg = typeof err === 'string' ? err : (err?.message ?? String(e))
  if (msg.includes('404')) return
  console.error('[dem2tiles]', msg)
})
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__map = map
}

// ---- レイヤーの積み順 ----
//
// 背景スタイルを差し替えると自前のレイヤーは全部消えるため、切替のたびに貼り直す。

/** 自前のレイヤーID。背景スタイル側のレイヤーと見分けるために使う。 */
const OWN_LAYER_IDS = new Set([RELIEF_ID, HILLSHADE_ID, CONTOUR_LINE_ID, CONTOUR_TEXT_ID])

/**
 * 背景地図の注記（地名・河川名など）の先頭レイヤーのID。
 * 自前のレイヤーはこの手前に差し込み、注記だけを上に残す。
 * 写真・白図の背景には注記が無いため undefined（最前面に積む）。
 *
 * 「最初の symbol レイヤー」を注記とみなすと、地理院 最適化ベクトルタイルでは
 * 水部の小さな注記（`水部表記線point`、123レイヤー中の13番目）に当たり、自前の
 * レイヤーが背景地図の 100 レイヤー余りの下に埋まる。市街地では建築物の不透明な
 * 塗りに段彩も陰影も潰される。注記は `source-layer` が `Anno` のレイヤー群で、
 * それ以降に他のレイヤーは無いので、これを目印にする。
 */
const ANNO_SOURCE_LAYER = 'Anno'

function labelBeforeId(): string | undefined {
  const layers = map.getStyle()?.layers ?? []
  const anno = layers.find(
    (l) => (l as { 'source-layer'?: string })['source-layer'] === ANNO_SOURCE_LAYER,
  )
  if (anno) return anno.id
  return layers.find((l) => l.type === 'symbol' && !OWN_LAYER_IDS.has(l.id))?.id
}

/**
 * 自前レイヤーの積み順（下から）:
 *   背景地図 → 段彩 → 陰影起伏 → 等高線 → 背景地図の注記
 *
 * 段彩を陰影起伏の下に置くのが要点。陰影が段彩の上に乗ることで陰影段彩図になる。
 * 各グループは「自分より上にあるグループのうち、いま地図にある最初のレイヤー」の
 * 手前に差し込む。
 */
const LAYER_GROUPS = {
  relief: [RELIEF_ID],
  hillshade: [HILLSHADE_ID],
  contour: [CONTOUR_LINE_ID, CONTOUR_TEXT_ID],
} as const
type LayerGroup = keyof typeof LAYER_GROUPS
const GROUP_ORDER = Object.keys(LAYER_GROUPS) as LayerGroup[]

function beforeIdFor(group: LayerGroup): string | undefined {
  const above = GROUP_ORDER.slice(GROUP_ORDER.indexOf(group) + 1).flatMap(
    (g) => LAYER_GROUPS[g] as readonly string[],
  )
  return above.find((id) => map.getLayer(id)) ?? labelBeforeId()
}

function removeLayer(id: string): void {
  if (map.getLayer(id)) map.removeLayer(id)
}

function removeSource(id: string): void {
  if (map.getSource(id)) map.removeSource(id)
}

/** 段彩（標高の色）。陰影起伏の下に敷く。 */
function applyRelief(): void {
  removeLayer(RELIEF_ID)
  if (!reliefOn) {
    removeSource(RELIEF_SOURCE)
    return
  }
  if (!map.getSource(RELIEF_SOURCE)) map.addSource(RELIEF_SOURCE, reliefSourceSpec(effectiveRelief(), region.key))
  map.addLayer(reliefLayer(reliefOpacity), beforeIdFor('relief'))
}

/** 陰影起伏。 */
function applyHillshade(): void {
  removeLayer(HILLSHADE_ID)
  if (!hillshadeOn) return
  map.addLayer(hillshadeLayer(hillshadeMethod, hillshadeExag), beforeIdFor('hillshade'))
}

function applyContours(): void {
  removeLayer(CONTOUR_LINE_ID)
  removeLayer(CONTOUR_TEXT_ID)
  if (!contoursOn) return
  if (!map.getSource(CONTOUR_SOURCE)) map.addSource(CONTOUR_SOURCE, contourSourceSpec(region.key))
  for (const l of contourLayers(theme)) map.addLayer(l, beforeIdFor('contour'))
}

function applyTerrain(): void {
  map.setTerrain(terrainOn ? { source: DEM_SOURCE, exaggeration: terrainExag } : null)
}

/**
 * 背景スタイルの上に DEM 由来のソースとレイヤーを載せる。
 *
 * 背景（地理院最適化ベクトルタイル）のスタイルは丸ごと差し替える方式なので、
 * 背景・テーマ・標高タイル・陰影の算出方法のいずれを変えてもここを通って積み直す。
 * raster-dem のソース定義は後から差し替えられないため、どのみち作り直しが要る。
 */
function injectDemLayers(): void {
  map.addSource(DEM_SOURCE, demSourceSpec(dem))
  applyRelief()
  applyHillshade()
  applyContours()
  applyTerrain()

  el('dem-badge').textContent = `${dem.tileSize}px z${dem.minzoom}–${dem.maxzoom}`
  el('tile-url').textContent = dem.url
  el('dem-note').innerHTML =
    dem.key === 'gsidem'
      ? '数値PNGは <code>gsidem://</code> プロトコルで取得時に terrarium へ再符号化している。' +
        'MapLibre の <code>custom</code> は線形式しか持たず、<code>x&gt;2<sup>23</sup></code> の' +
        '2の補数（負の標高）を表せないため。'
      : ''
}

/** 背景スタイルを入れ替えて DEM を載せ直す。 */
async function reloadStyle(): Promise<void> {
  map.setTerrain(null)
  map.setStyle(await getBasemapStyle(base, theme), { diff: false })
  // 'style.load' はスタイルの解釈が終わった時点で発火する。'load' は初回描画まで
  // 待つので、タブが背面にあると requestAnimationFrame が止まって永久に来ない。
  map.once('style.load', injectDemLayers)
}

map.once('style.load', () => {
  injectDemLayers()
  el('zoom-val').textContent = map.getZoom().toFixed(2)
})
map.on('zoom', () => {
  el('zoom-val').textContent = map.getZoom().toFixed(2)
})

// ---- 地域 ----

const regionModesEl = el('region-modes')
const regionNoteEl = el('region-note')

function syncRegion(): void {
  for (const x of regionModesEl.querySelectorAll('button')) {
    x.setAttribute('aria-pressed', String(x.dataset.key === region.key))
  }
  regionNoteEl.textContent = region.source
}

regionModesEl.replaceChildren(
  ...REGIONS.map((r) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = r.label
    b.dataset.key = r.key
    b.addEventListener('click', () => {
      if (r.key === region.key) return
      region = r
      // 選んでいる種類（Terrarium など）はそのまま、地域だけ替える
      dem = demByKey(region.key, demKind)
      reliefRange = reliefRangeByKey(region.reliefRange)
      reliefRangeEl.value = reliefRange.key
      setReliefBase(0, '')
      syncRegion()
      map.fitBounds(region.bounds, { padding: 40, duration: 0 })
      void reloadStyle()
    })
    return b
  }),
)
syncRegion()

// ---- 標高タイル ----

const demModesEl = el('dem-modes')
demModesEl.replaceChildren(
  ...region.dems.map((d) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = d.label
    b.dataset.key = d.key
    b.setAttribute('aria-pressed', String(d.key === dem.key))
    b.addEventListener('click', () => {
      if (d.key === dem.key) return
      demKind = d.key
      dem = demByKey(region.key, demKind)
      for (const x of demModesEl.querySelectorAll('button')) {
        x.setAttribute('aria-pressed', String(x.dataset.key === dem.key))
      }
      void reloadStyle()
    })
    return b
  }),
)

// ---- 地形 ----

const reliefOnEl = el<HTMLInputElement>('relief-on')
const reliefOptsEl = el('relief-opts')
const reliefOpacityEl = el<HTMLInputElement>('relief-opacity')
const reliefOpacityValEl = el('relief-opacity-val')
const reliefLegendEl = el('relief-legend')
const reliefRangeEl = el<HTMLSelectElement>('relief-range')
const reliefBaseEl = el<HTMLInputElement>('relief-base')
const reliefFitEl = el<HTMLButtonElement>('relief-fit')
const reliefFitNoteEl = el('relief-fit-note')
const elevCenterEl = el('elev-center')
const elevCursorEl = el('elev-cursor')
const crosshairEl = el('crosshair')

// ---- 標高の読み取り ----
// 下限を手で入れるには、見ている場所の標高が分からないと決めようがない。
// 段彩と同じ数値PNGの画素値を出す（地図のズーム + 1 の段なので z15 で約 2.4m/画素）。

const fmtElev = (h: number | null): string => (h === null ? 'データなし' : `${h.toFixed(2)}m`)

/**
 * 非同期の読み取りを、最後に頼んだものだけ表示する。
 * mousemove は速く、先に頼んだタイルの読み込みが後から返ると古い値で上書きされる。
 */
function latestOnly(target: HTMLElement): (job: Promise<number | null>) => void {
  let seq = 0
  return (job) => {
    const mine = ++seq
    void job.then((h) => {
      if (mine === seq) target.textContent = fmtElev(h)
    })
  }
}

const showCenter = latestOnly(elevCenterEl)
const showCursor = latestOnly(elevCursorEl)

function updateCenterElevation(): void {
  const c = map.getCenter()
  showCenter(elevationAt(region.key, c.lng, c.lat, map.getZoom()))
}

map.on('moveend', updateCenterElevation)
// タイルは地図の描画と別に取るので、'load' を待たずに引ける
updateCenterElevation()
map.on('mousemove', (e) => {
  showCursor(elevationAt(region.key, e.lngLat.lng, e.lngLat.lat, map.getZoom()))
})
map.getCanvas().addEventListener('mouseleave', () => {
  elevCursorEl.textContent = '–'
})

reliefOnEl.addEventListener('change', () => {
  reliefOn = reliefOnEl.checked
  reliefOptsEl.hidden = !reliefOn
  crosshairEl.hidden = !reliefOn
  applyRelief()
})

for (const r of RELIEF_RANGES) {
  const opt = document.createElement('option')
  opt.value = r.key
  opt.textContent = r.label
  reliefRangeEl.append(opt)
}
reliefRangeEl.value = reliefRange.key
reliefRangeEl.addEventListener('change', () => {
  reliefRange = reliefRangeByKey(reliefRangeEl.value)
  refreshRelief()
})

/** レンジか下限を変えたあとに、凡例と段彩タイルを作り直す。 */
function refreshRelief(): void {
  const abs = reliefRange.mode === 'abs'
  reliefBaseEl.disabled = abs
  reliefFitEl.disabled = abs
  reliefBaseEl.step = String(reliefRange.step ?? 1)
  buildReliefLegend()
  // レンジはタイルURLに入っている。ソースを差し替えないと、MapLibre が
  // URL単位で持っている古い色のタイルがそのまま残る。
  removeLayer(RELIEF_ID)
  removeSource(RELIEF_SOURCE)
  applyRelief()
}

function setReliefBase(base: number, note: string): void {
  reliefBase = base
  reliefBaseEl.value = String(base)
  reliefFitNoteEl.textContent = note
  refreshRelief()
}

reliefBaseEl.addEventListener('change', () => {
  const v = Number(reliefBaseEl.value)
  if (Number.isFinite(v)) setReliefBase(v, '')
  else reliefBaseEl.value = String(reliefBase)
})

/**
 * 下限を画面内の標高に合わせる。下から 2% の標高を刻みで切り下げて下限にする。
 *
 * 最小値にしないのは、河道の底や水路の数画素で下限が引き下げられ、
 * 見たい面が上の方の数段に寄ってしまうため。それより低い所は最下段の色で塗られる。
 */
reliefFitEl.addEventListener('click', async () => {
  const b = map.getBounds()
  reliefFitEl.disabled = true
  reliefFitNoteEl.textContent = '画面内の標高を読んでいます…'
  try {
    const stats = await viewElevationStats(
      region.key,
      [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      map.getZoom(),
    )
    if (!stats) {
      reliefFitNoteEl.textContent = '画面内に標高データがありません。'
      return
    }
    const step = reliefRange.step ?? 1
    const base = Number((Math.floor(stats.lo / step) * step).toFixed(6))
    const width = reliefRange.max - reliefRange.min
    const f = (v: number): string => v.toFixed(1)
    let note = `画面内の標高 ${f(stats.lo)}〜${f(stats.hi)}m（下から2〜98%）。`
    if (stats.hi > base + width) note += `幅 ${width}m を超える高い所は最上段の色になる。`
    setReliefBase(base, note)
  } finally {
    reliefFitEl.disabled = reliefRange.mode === 'abs'
  }
})

reliefOpacityEl.addEventListener('input', () => {
  reliefOpacity = Number(reliefOpacityEl.value)
  reliefOpacityValEl.textContent = `${Math.round(reliefOpacity * 100)}%`
  if (map.getLayer(RELIEF_ID)) map.setPaintProperty(RELIEF_ID, 'raster-opacity', reliefOpacity)
})

/**
 * 標高の凡例。帯は等幅で並べる。
 *
 * 「全国」レンジでは実際の標高間隔が 1m〜1000m と幅が違い、値に比例した幅に
 * すると低標高側が潰れて読めなくなる。指定レンジでは刻み幅で等間隔に割っているので、
 * 等幅がそのまま実際の間隔になる。どちらでも実際の境界は目盛りの数字が示す。
 */
function buildReliefLegend(): void {
  const range = effectiveRelief()
  const legend = reliefLegend(range)
  // 刻みの桁で丸めたうえで末尾の 0 は落とす（0.5m 刻みでも整数の目盛りは「1」と出す）
  const fmt = (v: number): string => String(Number(v.toFixed(reliefDecimals(reliefRange))))

  const bar = document.createElement('div')
  bar.className = 'rl-bar'
  for (const { from, color } of legend) {
    const cell = document.createElement('span')
    cell.className = 'rl-cell'
    cell.style.background = color
    cell.title = `${fmt(from)}m 以上`
    bar.append(cell)
  }

  const ticks = document.createElement('div')
  ticks.className = 'rl-ticks'
  const every = reliefRange.mode === 'abs' ? 2 : reliefTickEvery(reliefRange)
  const show = (i: number): boolean => (reliefRange.mode === 'abs' ? i % 2 === 1 : i % every === 0)
  legend.forEach(({ from }, i) => {
    const t = document.createElement('span')
    t.className = 'rl-tick'
    t.textContent = show(i) ? fmt(from) : ''
    ticks.append(t)
  })

  const unit = document.createElement('div')
  unit.className = 'rl-unit'
  unit.textContent =
    reliefRange.mode === 'abs'
      ? '標高（m）・段の幅は実際の標高間隔と異なる'
      : `標高（m）・1段 ${fmt(reliefRange.step ?? 0)}m`
  reliefLegendEl.replaceChildren(bar, ticks, unit)
}
buildReliefLegend()
reliefBaseEl.disabled = reliefFitEl.disabled = reliefRange.mode === 'abs'
reliefBaseEl.step = String(reliefRange.step ?? 1)

const hillshadeOnEl = el<HTMLInputElement>('hillshade-on')
const hillshadeOptsEl = el('hillshade-opts')
const hillshadeMethodEl = el<HTMLSelectElement>('hillshade-method')
const hillshadeExagEl = el<HTMLInputElement>('hillshade-exag')
const hillshadeExagValEl = el('hillshade-exag-val')
const hillshadeDescEl = el('hillshade-desc')

hillshadeOnEl.addEventListener('change', () => {
  hillshadeOn = hillshadeOnEl.checked
  hillshadeOptsEl.hidden = !hillshadeOn
  applyHillshade()
})

const renderHillshadeDesc = (): void => {
  hillshadeDescEl.textContent = HILLSHADE_METHODS.find((m) => m.key === hillshadeMethod)?.desc ?? ''
}
for (const { key, label } of HILLSHADE_METHODS) {
  const opt = document.createElement('option')
  opt.value = key
  opt.textContent = label
  hillshadeMethodEl.append(opt)
}
hillshadeMethodEl.value = hillshadeMethod
renderHillshadeDesc()
hillshadeMethodEl.addEventListener('change', () => {
  hillshadeMethod = hillshadeMethodEl.value as HillshadeMethod
  renderHillshadeDesc()
  // 算出方法ごとに見え方の落ち着く強調が違うため、プリセット値へ戻す
  hillshadeExag = HILLSHADE_PRESETS[hillshadeMethod].exaggeration
  hillshadeExagEl.value = String(hillshadeExag)
  hillshadeExagValEl.textContent = hillshadeExag.toFixed(2)
  // setPaintProperty では multidirectional の色の配列が描画に反映されない。
  // 陰影のレイヤーだけを外して付け直すと、共有している DEM ソースのタイルが
  // 読み込み中のまま戻らないことがある（MapLibre 5.6、参照元の viewer で確認済み）。
  // 背景・テーマの切り替えと同じく、スタイルごと積み直す。
  void reloadStyle()
})

hillshadeExagEl.addEventListener('input', () => {
  hillshadeExag = Number(hillshadeExagEl.value)
  hillshadeExagValEl.textContent = hillshadeExag.toFixed(2)
  if (map.getLayer(HILLSHADE_ID)) {
    map.setPaintProperty(HILLSHADE_ID, 'hillshade-exaggeration', hillshadeExag)
  }
})

const terrainOnEl = el<HTMLInputElement>('terrain-on')
const terrainOptsEl = el('terrain-opts')
const terrainExagEl = el<HTMLInputElement>('terrain-exag')
const terrainExagValEl = el('terrain-exag-val')

terrainOnEl.addEventListener('change', () => {
  terrainOn = terrainOnEl.checked
  terrainOptsEl.hidden = !terrainOn

  if (!terrainOn) {
    // 傾きを戻すのは地形を外したあと。順序を逆にすると、平面へ戻る途中の
    // フレームでも地形メッシュを描き続けることになる。
    applyTerrain()
    if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 600 })
    return
  }

  // 地形メッシュの生成・DEMタイルの取得・カメラの傾けを同時に走らせると、
  // その間フレームが落ちて操作が固まったように見える。地形が落ち着いてから傾ける。
  // 自分で戻した角度を勝手に上書きしないよう、水平のときだけ触る。
  applyTerrain()
  if (map.getPitch() === 0) {
    map.once('idle', () => {
      if (terrainOn && map.getPitch() === 0) map.easeTo({ pitch: 55, duration: 600 })
    })
  }
})

// setTerrain は地形メッシュを作り直す。スライダーの1目盛りごとに呼ぶと
// ドラッグ中に描画が追いつかないため、1フレームに1回へ束ねる。
let terrainExagScheduled = false
terrainExagEl.addEventListener('input', () => {
  terrainExag = Number(terrainExagEl.value)
  terrainExagValEl.textContent = terrainExag.toFixed(2)
  if (!terrainOn || terrainExagScheduled) return
  terrainExagScheduled = true
  requestAnimationFrame(() => {
    terrainExagScheduled = false
    if (terrainOn && map.getSource(DEM_SOURCE)) applyTerrain()
  })
})

const contoursOnEl = el<HTMLInputElement>('contours-on')
contoursOnEl.addEventListener('change', () => {
  contoursOn = contoursOnEl.checked
  applyContours()
})

// ---- 背景地図スイッチャー（右下） ----

class BasemapControl implements maplibregl.IControl {
  private el!: HTMLElement
  onAdd(): HTMLElement {
    this.el = document.createElement('div')
    this.el.className = 'maplibregl-ctrl basemap-switch'
    for (const { key, label } of BASEMAPS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      btn.dataset.base = key
      btn.setAttribute('aria-selected', String(key === base))
      btn.addEventListener('click', () => setBase(key))
      this.el.append(btn)
    }
    return this.el
  }
  onRemove(): void {
    this.el.remove()
  }
  sync(): void {
    for (const btn of this.el.querySelectorAll<HTMLButtonElement>('button')) {
      btn.setAttribute('aria-selected', String(btn.dataset.base === base))
    }
  }
}
const basemapCtrl = new BasemapControl()
map.addControl(basemapCtrl, 'bottom-right')

function setBase(next: Basemap): void {
  if (next === base) return
  base = next
  basemapCtrl.sync()
  void reloadStyle()
}

// ---- テーマ・パネル ----

el('theme-btn').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'
  applyThemeAttr(theme)
  syncThemeBtn()
  void reloadStyle()
})

el('collapse-btn').addEventListener('click', () => {
  el('panel').classList.toggle('collapsed')
  syncCollapseBtn()
})

function syncThemeBtn(): void {
  el('theme-btn').textContent = theme === 'dark' ? '☀️' : '🌙'
}
function syncCollapseBtn(): void {
  el('collapse-btn').textContent = el('panel').classList.contains('collapsed') ? '▾' : '▴'
}
syncThemeBtn()
// 狭い画面では地図を隠さないよう、パネルを畳んだ状態で始める
if (isMobile) el('panel').classList.add('collapsed')
syncCollapseBtn()
