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
 * 静岡のタイルの配信元。
 *
 * パスは配信側（R2）のキー名で書く。dem2tiles の出力ディレクトリ名とは違うが、
 * 名前を2系統持つと URL の組み立てが env の値で分岐してしまう。dev では
 * vite.config.ts が配信キー名から ../output の実ディレクトリへ読み替える。
 */
const BASE = import.meta.env.VITE_TILES_BASE ?? '/tiles'

/**
 * 静岡の RGB 符号化タイル（terrarium / mapbox）の拡張子。
 *
 * dem2tiles の `TILE_FORMAT` に合わせる。WebP は可逆なので中身は PNG と同じで、
 * 変わるのは URL の拡張子だけ。gsidem は常に PNG なのでここの対象外。
 */
const RGB_EXT = import.meta.env.VITE_TILES_EXT ?? 'png'

/**
 * 山梨のタイルの配信元。
 *
 * R2 には PMTiles で置き、Worker（リポジトリの worker/）が ZXY で返す。Mapterhorn と同じ構成。
 * ZXY のまま上げると 3 種類で 58 万オブジェクトになるため。dev でも本番の Worker を読む。
 */
const YAMANASHI_BASE =
  import.meta.env.VITE_YAMANASHI_TILES_BASE ?? 'https://tiles.shi-works.com/pref-yamanashi'

export const ATTRIBUTION = 'dem2tiles'

export type DemKind = 'terrarium' | 'mapbox' | 'gsidem'
export type RegionKey = 'shizuoka' | 'yamanashi'

export interface DemDef {
  key: DemKind
  region: RegionKey
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

export interface Region {
  key: RegionKey
  label: string
  /** 元データ。パネルに出す。 */
  source: string
  /** データのおおよその範囲 [西, 南, 東, 北]。切り替えたときにここへ寄せる。 */
  bounds: [number, number, number, number]
  /**
   * 段彩の既定の標高レンジ（relief.ts の RELIEF_RANGES のキー）。地域を替えたときにこれへ戻す。
   * 静岡は沿岸の低地、山梨は 3,000 m 級の山地で、同じレンジでは片方が一色になる。
   */
  reliefRange: string
  dems: DemDef[]
}

/** 3 種類の定義。ズームと画素数は 0.5m グリッドの dem2tiles 出力で共通。 */
function demDefs(
  region: RegionKey,
  base: string,
  names: Record<DemKind, string>,
  rgbExt: string,
): DemDef[] {
  return [
    {
      key: 'terrarium',
      region,
      label: 'Terrarium',
      tileSize: 512,
      minzoom: 5,
      maxzoom: 17,
      url: `${base}/${names.terrarium}/{z}/{x}/{y}.${rgbExt}`,
    },
    {
      key: 'mapbox',
      region,
      label: 'Mapbox Terrain-RGB',
      tileSize: 512,
      minzoom: 5,
      maxzoom: 17,
      url: `${base}/${names.mapbox}/{z}/{x}/{y}.${rgbExt}`,
    },
    {
      key: 'gsidem',
      region,
      label: '数値PNG（地理院互換）',
      tileSize: 256,
      minzoom: 5,
      maxzoom: 18,
      url: `${base}/${names.gsidem}/{z}/{x}/{y}.png`,
    },
  ]
}

export const REGIONS: Region[] = [
  {
    key: 'shizuoka',
    label: '静岡',
    source: '静岡県 航空レーザ測深（ALB）。沿岸部のみ',
    bounds: [137.4786, 34.588, 138.6521, 35.1231],
    reliefRange: 'lowland',
    dems: demDefs(
      'shizuoka',
      BASE,
      {
        terrarium: 'shizuoka-alb-terrarium',
        mapbox: 'shizuoka-alb-terrain-rgb',
        gsidem: 'shizuoka-alb-dem-png',
      },
      RGB_EXT,
    ),
  },
  {
    key: 'yamanashi',
    label: '山梨',
    source: '山梨県 航空レーザ測量（LP）グリッドデータ。県全域',
    bounds: [138.1778, 35.1671, 139.1364, 35.9736],
    reliefRange: 'all',
    dems: demDefs(
      'yamanashi',
      YAMANASHI_BASE,
      {
        terrarium: 'yamanashi-lp-terrarium',
        mapbox: 'yamanashi-lp-terrain-rgb',
        gsidem: 'yamanashi-lp-dem-png',
      },
      'webp',
    ),
  },
]

/** 最初に開く地域（URL がどの地域も指していないとき）。切替の並び順とは別に決める。 */
export const DEFAULT_REGION: RegionKey = 'yamanashi'

export const regionByKey = (key: string): Region =>
  REGIONS.find((r) => r.key === key) ?? REGIONS.find((r) => r.key === DEFAULT_REGION)!

/** 経緯度を含む地域。どれにも入らなければ undefined。 */
export const regionAt = (lng: number, lat: number): Region | undefined =>
  REGIONS.find(({ bounds: [w, s, e, n] }) => lng >= w && lng <= e && lat >= s && lat <= n)

export const demByKey = (region: RegionKey, key: DemKind): DemDef => {
  const dems = regionByKey(region).dems
  return dems.find((d) => d.key === key) ?? dems[0]!
}

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

/** 地域ごとの gsidem の source 定義と等高線の DemSource。プロトコル登録の副作用つきなので使い回す。 */
const gsiSpecs = new Map<RegionKey, RasterDEMSourceSpecification>()
const demSources = new Map<RegionKey, InstanceType<typeof mlcontour.DemSource>>()

/**
 * 等高線の間隔 [補助, 主曲線]（m）。ズームごと。
 *
 * 静岡は沿岸の低平地なので細かく刻む。山梨は 3,000 m 級の山地で、同じ間隔では
 * 急斜面が線で埋まり描画も追いつかないため粗くする。
 */
const CONTOUR_THRESHOLDS: Record<RegionKey, Record<number, [number, number]>> = {
  shizuoka: { 11: [50, 250], 12: [20, 100], 13: [10, 50], 14: [5, 25] },
  yamanashi: { 11: [100, 500], 12: [50, 250], 13: [20, 100], 14: [10, 50] },
}

/**
 * プロトコルを登録する。地図の生成前に一度だけ呼ぶ。全地域ぶんをまとめて登録する。
 *
 * 数値PNGタイルは `h = (2^16 R + 2^8 G + B) * 0.01`、ただし `x > 2^23` は
 * `(x - 2^24) * 0.01` という2の補数表現をとる。MapLibre の custom エンコーディングは
 * 係数と定数の線形式しか持たないため、この折り返しを表せない。負の標高を含む DEM
 * （海底や水部）では海面下が +167,772 m として解釈されてしまう。
 *
 * そこで maplibre-gl-gsi-terrain の `gsidem://` プロトコルで取得時にデコードし、
 * terrarium に再符号化して渡す。
 */
export function registerDemProtocols(maplibre: MaplibreLike): void {
  for (const region of REGIONS) {
    // useGsiTerrainSource は呼ぶたびに同じ gsidem:// プロトコルを登録し直すが、処理は URL に
    // 依らない（gsidem:// の後ろの URL を取りに行く）ので、地域ごとに呼んでも衝突しない
    const gsidem = demByKey(region.key, 'gsidem')
    gsiSpecs.set(
      region.key,
      useGsiTerrainSource(maplibre.addProtocol as never, {
        tileUrl: absoluteTileUrl(gsidem.url),
        minzoom: gsidem.minzoom,
        maxzoom: gsidem.maxzoom,
        attribution: ATTRIBUTION,
      }),
    )

    // DemSource は DEM タイルを自前の HTTP で取るため MapLibre のプロトコルを経由できない。
    // 等高線はどの表示を選んでいても terrarium タイルから作る。3種類とも同じ DEM が
    // 元なので、等高線の位置は表示中のタイルと一致する。
    const terrarium = demByKey(region.key, 'terrarium')
    const src = new mlcontour.DemSource({
      url: absoluteTileUrl(terrarium.url),
      encoding: 'terrarium',
      // プロトコル名の接頭辞。地域ごとに分けないと後から登録した方に上書きされる
      id: `dem-${region.key}`,
      // 深くすると等高線を細かく刻めるが、生成するセグメント数が跳ね上がり
      // 3D地形と併用したときに描画が追いつかない。
      maxzoom: 14,
      worker: true,
    })
    src.setupMaplibre(maplibre as never)
    demSources.set(region.key, src)
  }
}

export function demSourceSpec(dem: DemDef): RasterDEMSourceSpecification {
  if (dem.key === 'gsidem') {
    const spec = gsiSpecs.get(dem.region)
    if (!spec) throw new Error('registerDemProtocols() を先に呼ぶこと')
    return spec
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

export function contourSourceSpec(region: RegionKey): VectorSourceSpecification {
  const src = demSources.get(region)
  if (!src) throw new Error('registerDemProtocols() を先に呼ぶこと')
  return {
    type: 'vector',
    tiles: [
      src.contourProtocolUrl({
        thresholds: CONTOUR_THRESHOLDS[region],
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

/** MapLibre 5.6 の陰影起伏の算出方法。 */
export type HillshadeMethod = 'igor' | 'standard' | 'basic' | 'combined' | 'multidirectional'

/**
 * 陰影起伏の算出方法。英語の方式名だけでは違いが分からないので、日本語の名前と
 * 1行の説明を付ける。shiwaku/naisui-risk-verification の viewer と同じ定義。
 * 説明は MapLibre スタイル仕様の hillshade-method に沿う（basic / combined / igor は
 * GDAL の gdaldem の既定・-combined・-igor に相当）。
 */
export const HILLSHADE_METHODS: { key: HillshadeMethod; label: string; desc: string }[] = [
  {
    key: 'standard',
    label: '標準（standard・既定）',
    desc: 'MapLibre の従来からの陰影。北北西（335°）から光を当てたような、見慣れた陰影になる。',
  },
  {
    key: 'igor',
    label: 'やわらか（igor）',
    desc: '下に重ねた地図や段彩を邪魔しにくい、控えめな陰影。斜面の明暗が強く出すぎない。',
  },
  {
    key: 'basic',
    label: '基本（basic）',
    desc: '光と斜面の角度だけで明るさを決める単純な陰影（GDAL の gdaldem の既定と同じ計算）。',
  },
  {
    key: 'combined',
    label: '傾斜強調（combined）',
    desc: '傾斜が急なほど暗くなる陰影。平らな所は明るく残るので、崖や段丘の縁が目立つ。',
  },
  {
    key: 'multidirectional',
    label: '多方向・色つき（multidirectional）',
    desc: '西・北西・北・北東の4方向から色の違う光を当てる。斜面がどちらを向いているかが色で分かる。',
  },
]

/** 既定は standard。igor はやわらかすぎて段彩に重ねたとき低地の起伏が読みにくい。 */
export const DEFAULT_HILLSHADE_METHOD: HillshadeMethod = 'standard'

/**
 * 算出方法ごとの paint プリセット。値は Mapterhorn / MapLibre の公式サンプル由来。
 * exaggeration はその方法を選んだときに UI が読み込む初期値で、その後はスライダーが上書きする。
 */
export const HILLSHADE_PRESETS: Record<
  HillshadeMethod,
  { exaggeration: number; paint: Record<string, unknown> }
> = {
  igor: {
    exaggeration: 0.2,
    paint: {
      'hillshade-highlight-color': 'rgb(255, 255, 228)',
      'hillshade-shadow-color': 'rgb(114, 124, 131)',
    },
  },
  standard: {
    exaggeration: 0.5,
    paint: { 'hillshade-shadow-color': '#473B24' },
  },
  basic: { exaggeration: 0.5, paint: {} },
  combined: { exaggeration: 0.5, paint: {} },
  multidirectional: {
    exaggeration: 0.5,
    paint: {
      'hillshade-highlight-color': ['#FF4000', '#FFFF00', '#40FF00', '#00FF80'],
      'hillshade-shadow-color': ['#00BFFF', '#0000FF', '#BF00FF', '#FF0080'],
      'hillshade-illumination-direction': [270, 315, 0, 45],
      'hillshade-illumination-altitude': [30, 30, 30, 30],
    },
  },
}

export function hillshadeLayer(method: HillshadeMethod, exaggeration: number): LayerSpecification {
  return {
    id: HILLSHADE_ID,
    type: 'hillshade',
    source: DEM_SOURCE,
    paint: {
      'hillshade-method': method,
      'hillshade-exaggeration': exaggeration,
      ...HILLSHADE_PRESETS[method].paint,
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
