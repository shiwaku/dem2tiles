import mlcontour from 'maplibre-contour'
import { useGsiTerrainSource } from 'maplibre-gl-gsi-terrain'
import type {
  LayerSpecification,
  RasterDEMSourceSpecification,
  VectorSourceSpecification,
} from 'maplibre-gl'

/**
 * dem2tiles が出力する3種類の標高タイルを切り替えて重ねる。
 *
 * 同じ DEM を3通りに符号化したものなので、見える地形は同じになるはず。
 * 違いが出るならどこかが壊れている、という確認に使う。
 */

/**
 * タイルの配信元。
 *
 * パスは配信側（R2）のキー名で書く。dem2tiles の出力ディレクトリ名とは違うが、
 * 名前を2系統持つと URL の組み立てが env の値で分岐してしまう。dev では
 * vite.config.ts が配信キー名から ../output の実ディレクトリへ読み替える。
 */
const BASE = import.meta.env.VITE_TILES_BASE ?? '/tiles'

export const ATTRIBUTION = 'dem2tiles'

export type DemKind = 'terrarium' | 'mapbox' | 'gsidem'

export interface DemDef {
  key: DemKind
  label: string
  /** タイル画素数。rio 系は 512、gdal2NPtiles は 256。 */
  tileSize: number
  minzoom: number
  /**
   * そのタイルセットが持つ最大ズーム。
   *
   * 512px と 256px では同じ地上分解能に達するズームが 1 段ずれる。
   * 0.5m グリッドなら 512px は z17、256px は z18 でどちらも約 0.49 m/px。
   */
  maxzoom: number
  url: string
}

export const DEMS: DemDef[] = [
  {
    key: 'terrarium',
    label: 'Terrarium',
    tileSize: 512,
    minzoom: 5,
    maxzoom: 17,
    url: `${BASE}/shizuoka-alb-terrarium/{z}/{x}/{y}.png`,
  },
  {
    key: 'mapbox',
    label: 'Mapbox Terrain-RGB',
    tileSize: 512,
    minzoom: 5,
    maxzoom: 17,
    url: `${BASE}/shizuoka-alb-terrain-rgb/{z}/{x}/{y}.png`,
  },
  {
    key: 'gsidem',
    label: '数値PNG（地理院互換）',
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    url: `${BASE}/shizuoka-alb-dem-png/{z}/{x}/{y}.png`,
  },
]

export const demByKey = (key: string): DemDef =>
  DEMS.find((d) => d.key === key) ?? DEMS[0]!

/**
 * タイル URL を絶対 URL にする。
 *
 * `new URL()` は `{z}/{x}/{y}` を `%7Bz%7D` にパーセントエンコードしてしまう。
 * そのまま渡すと MapLibre もプラグインもプレースホルダを置換できず、
 * タイルを一度取りに行って終わる。波括弧だけ戻す。
 */
export function absoluteTileUrl(url: string): string {
  return new URL(url, location.href).href.replaceAll('%7B', '{').replaceAll('%7D', '}')
}

export const DEM_SOURCE = 'dem'
export const CONTOUR_SOURCE = 'contours'
export const RELIEF_ID = 'relief'
export const HILLSHADE_ID = 'hillshade'
export const CONTOUR_LINE_ID = 'contour-lines'
export const CONTOUR_TEXT_ID = 'contour-text'

/** 等高線を描き始めるズーム。広域では線が詰まって地形が読めない。 */
export const CONTOUR_MINZOOM = 11
/** 標高の数字を描き始めるズーム。 */
export const CONTOUR_TEXT_MINZOOM = 13

/**
 * MapLibre 名前空間のうち、ここで必要な部分だけ。
 * addProtocol のシグネチャは maplibre-gl と各プラグインで型が噛み合わないため緩く受ける。
 */
interface MaplibreLike {
  addProtocol(name: string, fn: (...args: never[]) => unknown): void
}

/** gsidem を読むための source 定義。プロトコル登録の副作用つきなので使い回す。 */
let gsiSpec: RasterDEMSourceSpecification | null = null
let demSource: InstanceType<typeof mlcontour.DemSource> | null = null

/**
 * プロトコルを登録する。地図の生成前に一度だけ呼ぶ。
 *
 * 数値PNGタイルは `h = (2^16 R + 2^8 G + B) * 0.01`、ただし `x > 2^23` は
 * `(x - 2^24) * 0.01` という2の補数表現をとる。MapLibre の custom エンコーディングは
 * 係数と定数の線形式しか持たないため、この折り返しを表せない。負の標高を含む DEM
 * （海底や水部）では海面下が +167,772 m として解釈されてしまう。
 *
 * そこで maplibre-gl-gsi-terrain の `gsidem://` プロトコルで取得時にデコードし、
 * terrarium に再符号化して渡す。
 */
export function registerDemProtocols(maplibre: MaplibreLike, gsidem: DemDef): void {
  gsiSpec = useGsiTerrainSource(maplibre.addProtocol as never, {
    tileUrl: absoluteTileUrl(gsidem.url),
    minzoom: gsidem.minzoom,
    maxzoom: gsidem.maxzoom,
    attribution: ATTRIBUTION,
  })

  // DemSource は DEM タイルを自前の HTTP で取るため MapLibre のプロトコルを経由できない。
  // 等高線はどの表示を選んでいても terrarium タイルから作る。3種類とも同じ DEM が
  // 元なので、等高線の位置は表示中のタイルと一致する。
  const terrarium = demByKey('terrarium')
  demSource = new mlcontour.DemSource({
    url: absoluteTileUrl(terrarium.url),
    encoding: 'terrarium',
    // 深くすると等高線を細かく刻めるが、生成するセグメント数が跳ね上がり
    // 3D地形と併用したときに描画が追いつかない。
    maxzoom: 14,
    worker: true,
  })
  demSource.setupMaplibre(maplibre as never)
}

export function demSourceSpec(dem: DemDef): RasterDEMSourceSpecification {
  if (dem.key === 'gsidem') {
    if (!gsiSpec) throw new Error('registerDemProtocols() を先に呼ぶこと')
    return gsiSpec
  }
  return {
    type: 'raster-dem',
    tiles: [dem.url],
    encoding: dem.key === 'mapbox' ? 'mapbox' : 'terrarium',
    tileSize: dem.tileSize,
    minzoom: dem.minzoom,
    maxzoom: dem.maxzoom,
    attribution: ATTRIBUTION,
  }
}

export function contourSourceSpec(): VectorSourceSpecification {
  if (!demSource) throw new Error('registerDemProtocols() を先に呼ぶこと')
  return {
    type: 'vector',
    tiles: [
      demSource.contourProtocolUrl({
        // [補助間隔, 主曲線間隔]（m）。沿岸の低平地が対象なので上流サンプルより細かい。
        thresholds: {
          11: [50, 250],
          12: [20, 100],
          13: [10, 50],
          14: [5, 25],
        },
        elevationKey: 'ele',
        levelKey: 'level',
        contourLayer: 'contours',
        buffer: 1,
        overzoom: 3,
      }),
    ],
    // DemSource の maxzoom(14) + overzoom(3)
    maxzoom: 17,
    attribution: ATTRIBUTION,
  }
}

/**
 * 背景スタイルの上に DEM 由来のソースとレイヤーを載せる。
 *
 * 背景は地理院最適化ベクトルタイルのスタイルをそのまま使うので、こちらは
 * 「注入する側」に徹する。シンボル（地名）より下に入れて、段彩で文字が
 * 潰れないようにする。
 */
export function firstSymbolLayerId(map: {
  getStyle(): { layers: { id: string; type: string }[] }
}): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id
}

export function hillshadeLayer(exaggeration: number): LayerSpecification {
  return {
    id: HILLSHADE_ID,
    type: 'hillshade',
    source: DEM_SOURCE,
    paint: {
      'hillshade-method': 'igor',
      'hillshade-exaggeration': exaggeration,
      'hillshade-highlight-color': 'rgb(255, 255, 228)',
      'hillshade-shadow-color': 'rgb(114, 124, 131)',
    },
  } as unknown as LayerSpecification
}

/** 等高線。文字色はテーマで振り、淡色地図とダーク背景の両方で読めるようにする。 */
export function contourLayers(theme: 'light' | 'dark'): LayerSpecification[] {
  const line = theme === 'dark' ? 'rgb(196, 148, 84)' : 'rgb(184, 129, 51)'
  const text = theme === 'dark' ? 'rgb(222, 180, 120)' : 'rgb(140, 97, 36)'
  const halo = theme === 'dark' ? 'rgba(10,12,16,0.85)' : 'rgba(255,255,255,0.9)'
  return [
    {
      id: CONTOUR_LINE_ID,
      type: 'line',
      source: CONTOUR_SOURCE,
      'source-layer': 'contours',
      minzoom: CONTOUR_MINZOOM,
      paint: {
        'line-color': line,
        'line-width': ['match', ['get', 'level'], 1, 1, 0.5] as never,
        'line-opacity': 0.8,
      },
    },
    {
      id: CONTOUR_TEXT_ID,
      type: 'symbol',
      source: CONTOUR_SOURCE,
      'source-layer': 'contours',
      minzoom: CONTOUR_TEXT_MINZOOM,
      // 主曲線だけに標高を振る。補助曲線にも振ると平野で数字が埋まる。
      filter: ['==', ['get', 'level'], 1] as never,
      layout: {
        'symbol-placement': 'line',
        'text-size': 11,
        'text-field': ['concat', ['number-format', ['get', 'ele'], {}], 'm'] as never,
        // 背景スタイル（地理院最適化ベクトルタイル）の glyphs が持つフォント
        'text-font': ['NotoSansJP-Regular'],
      },
      paint: {
        'text-color': text,
        'text-halo-color': halo,
        'text-halo-width': 1.5,
      },
    },
  ]
}
