import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import './style.css'

import { BASEMAPS, getBasemapStyle, type Basemap } from './basemap'
import {
  CONTOUR_LINE_ID,
  CONTOUR_SOURCE,
  CONTOUR_TEXT_ID,
  DEMS,
  DEM_SOURCE,
  HILLSHADE_ID,
  RELIEF_ID,
  contourLayers,
  contourSourceSpec,
  demByKey,
  demSourceSpec,
  firstSymbolLayerId,
  hillshadeLayer,
  registerDemProtocols,
  type DemDef,
} from './dem'
import {
  DEFAULT_RELIEF_RANGE,
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
} from './relief'
import { applyThemeAttr, initialTheme, type Theme } from './theme'

/** 静岡県の航空レーザ測深のおおよその範囲。 */
const BOUNDS: [number, number, number, number] = [137.4786, 34.588, 138.6521, 35.1231]

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} が無い`)
  return el as T
}
const checked = (id: string): boolean => $<HTMLInputElement>(id).checked
const num = (id: string): number => Number($<HTMLInputElement>(id).value)

// ---- 状態 ----
let theme: Theme = initialTheme()
let dem: DemDef = DEMS[0]!
let basemap: Basemap = 'pale'
let range: ReliefRange = DEFAULT_RELIEF_RANGE

applyThemeAttr(theme)

// 背景の最適化ベクトルタイルは PMTiles で配信されている
maplibregl.addProtocol('pmtiles', new Protocol().tile as never)
registerDemProtocols(maplibregl as never, demByKey('gsidem'))
registerReliefProtocol(maplibregl as never)

const map = new maplibregl.Map({
  container: 'map',
  hash: true,
  bounds: BOUNDS,
  fitBoundsOptions: { padding: 40 },
  maxZoom: 18,
  maxPitch: 85,
  style: await getBasemapStyle(basemap, theme),
})
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
map.addControl(new maplibregl.ScaleControl({ maxWidth: 140 }))

// タイルの 404 はデータの無い領域で常に出るので、それ以外だけを拾う。
map.on('error', (e) => {
  const msg = (e as { error?: Error }).error?.message ?? String(e)
  if (msg.includes('404')) return
  console.error('[dem2tiles]', msg)
})
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__map = map
}

/**
 * 背景スタイルの上に DEM 由来のソースとレイヤーを載せる。
 *
 * 背景（地理院最適化ベクトルタイル）のスタイルは丸ごと差し替える方式なので、
 * 背景・テーマ・標高タイルのいずれを変えてもここを通って積み直す。
 * raster-dem のソース定義は後から差し替えられないため、どのみち作り直しが要る。
 */
function injectDemLayers(): void {
  // 地名より下に入れて、段彩で文字が潰れないようにする
  const before = firstSymbolLayerId(map as never)

  map.addSource(DEM_SOURCE, demSourceSpec(dem))
  map.addSource(RELIEF_SOURCE, reliefSourceSpec(range))
  map.addSource(CONTOUR_SOURCE, contourSourceSpec())

  map.addLayer(reliefLayer(num('relief-opacity')), before)
  map.addLayer(hillshadeLayer(num('hillshade-exag')), before)
  for (const l of contourLayers(theme)) map.addLayer(l, before)

  applyVisibility()

  if (checked('terrain-on')) {
    map.setTerrain({ source: DEM_SOURCE, exaggeration: num('terrain-exag') })
  }

  $('dem-badge').textContent = `${dem.tileSize}px z${dem.minzoom}–${dem.maxzoom}`
  $('tile-url').textContent = dem.url
  $('dem-note').innerHTML =
    dem.key === 'gsidem'
      ? '数値PNGは <code>gsidem://</code> プロトコルで取得時に terrarium へ再符号化している。' +
        'MapLibre の <code>custom</code> は線形式しか持たず、<code>x&gt;2<sup>23</sup></code> の' +
        '2の補数（負の標高）を表せないため。'
      : ''
}

/** 背景スタイルを入れ替えて DEM を載せ直す。 */
async function reloadStyle(): Promise<void> {
  map.setTerrain(null)
  map.setStyle(await getBasemapStyle(basemap, theme), { diff: false })
  // 'style.load' はスタイルの解釈が終わった時点で発火する。'load' は初回描画まで
  // 待つので、タブが背面にあると requestAnimationFrame が止まって永久に来ない。
  map.once('style.load', injectDemLayers)
}

const setVis = (id: string, on: boolean): void => {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
}

function applyVisibility(): void {
  setVis(RELIEF_ID, checked('relief-on'))
  setVis(HILLSHADE_ID, checked('hillshade-on'))
  const c = checked('contour-on')
  setVis(CONTOUR_LINE_ID, c)
  setVis(CONTOUR_TEXT_ID, c)
}

// ---- 凡例 ----
function drawLegend(): void {
  const bands = reliefLegend(range)
  $('legend-bar').replaceChildren(
    ...bands.slice(0, -1).map((b) => {
      const s = document.createElement('span')
      s.style.background = b.color
      return s
    }),
  )
  const every = reliefTickEvery(range)
  const dec = reliefDecimals(range)
  $('legend-ticks').replaceChildren(
    ...bands.map((b, i) => {
      const s = document.createElement('span')
      s.textContent = i % every === 0 || i === bands.length - 1 ? b.from.toFixed(dec) : ''
      return s
    }),
  )
  $('step-badge').textContent = range.mode === 'abs' ? '絶対標高' : `1段 ${range.step}m`
}

// ---- UI の組み立て ----
function segment(
  host: HTMLElement,
  items: { label: string }[],
  isOn: (i: number) => boolean,
  pick: (i: number) => void,
): void {
  host.replaceChildren(
    ...items.map((item, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = item.label
      b.setAttribute('aria-pressed', String(isOn(i)))
      b.addEventListener('click', () => {
        for (const el of host.querySelectorAll('button')) {
          el.setAttribute('aria-pressed', String(el === b))
        }
        pick(i)
      })
      return b
    }),
  )
}

segment(
  $('dem-modes'),
  DEMS,
  (i) => DEMS[i]!.key === dem.key,
  (i) => {
    dem = DEMS[i]!
    void reloadStyle()
  },
)
segment(
  $('basemap-modes'),
  BASEMAPS,
  (i) => BASEMAPS[i]!.key === basemap,
  (i) => {
    basemap = BASEMAPS[i]!.key
    void reloadStyle()
  },
)

$<HTMLSelectElement>('relief-range').replaceChildren(
  ...RELIEF_RANGES.map((r) => {
    const o = document.createElement('option')
    o.value = r.key
    o.textContent = r.label
    o.selected = r.key === range.key
    return o
  }),
)

drawLegend()

map.once('style.load', () => {
  injectDemLayers()
  $('zoom-val').textContent = map.getZoom().toFixed(2)
})
map.on('zoom', () => {
  $('zoom-val').textContent = map.getZoom().toFixed(2)
})

// ---- 配線 ----
for (const id of ['relief-on', 'hillshade-on', 'contour-on']) {
  $(id).addEventListener('change', applyVisibility)
}

$('relief-opacity').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  $('relief-opacity-val').textContent = `${Math.round(v * 100)}%`
  if (map.getLayer(RELIEF_ID)) map.setPaintProperty(RELIEF_ID, 'raster-opacity', v)
})

$('hillshade-exag').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  $('hillshade-exag-val').textContent = v.toFixed(2)
  if (map.getLayer(HILLSHADE_ID)) {
    map.setPaintProperty(HILLSHADE_ID, 'hillshade-exaggeration', v)
  }
})

$('terrain-on').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) {
    map.setTerrain({ source: DEM_SOURCE, exaggeration: num('terrain-exag') })
    map.easeTo({ pitch: 62, duration: 700 })
  } else {
    map.setTerrain(null)
    map.easeTo({ pitch: 0, duration: 700 })
  }
})

$('terrain-exag').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  $('terrain-exag-val').textContent = v.toFixed(1)
  if (checked('terrain-on')) map.setTerrain({ source: DEM_SOURCE, exaggeration: v })
})

$('relief-range').addEventListener('change', (e) => {
  range = reliefRangeByKey((e.target as HTMLSelectElement).value)
  drawLegend()
  // 色はタイルに焼かれているので、レンジを変えたらソースごと作り直す
  if (map.getLayer(RELIEF_ID)) {
    map.removeLayer(RELIEF_ID)
    map.removeSource(RELIEF_SOURCE)
    map.addSource(RELIEF_SOURCE, reliefSourceSpec(range))
    map.addLayer(reliefLayer(num('relief-opacity')), firstSymbolLayerId(map as never))
    applyVisibility()
  }
})

$('theme-btn').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'
  applyThemeAttr(theme)
  syncThemeBtn()
  void reloadStyle()
})

$('collapse-btn').addEventListener('click', () => {
  $('panel').classList.toggle('collapsed')
  syncCollapseBtn()
})

function syncThemeBtn(): void {
  $('theme-btn').textContent = theme === 'dark' ? '☀' : '☾'
}
function syncCollapseBtn(): void {
  $('collapse-btn').textContent = $('panel').classList.contains('collapsed') ? '▾' : '▴'
}
syncThemeBtn()
syncCollapseBtn()
