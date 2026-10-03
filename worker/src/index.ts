/**
 * R2 の PMTiles から 1 タイルずつ取り出し、ZXY で返す。
 *
 * Mapterhorn（tiles.mapterhorn.com）と同じ構成。R2 には県・種類ごとに PMTiles を 1 ファイル置き、
 * 利用側には {z}/{x}/{y} の URL を見せる。ZXY のまま上げると山梨だけで 58 万オブジェクトになる。
 *
 *   GET /{dir...}/{name}/{z}/{x}/{y}.{ext}  → R2 の pmtiles/{dir...}/{name}.pmtiles の 1 タイル
 *   GET /{dir...}/{name}.json               → TileJSON
 *
 * 例: /pref-yamanashi/yamanashi-lp-terrarium/12/3620/1610.webp
 *     → pmtiles/pref-yamanashi/yamanashi-lp-terrarium.pmtiles
 *
 * キーの第 1 階層 pmtiles/ は xserver-cleanup の R2-STRUCTURE.md §4 に従う。同じアーカイブは
 * shi-works.com/pmtiles/... からも pmtiles:// でそのまま読める。
 */
import { EtagMismatch, PMTiles, ResolvedValueCache, TileType, type RangeResponse, type Source } from 'pmtiles'

interface Env {
  BUCKET: R2Bucket
  /** R2 のキーの接頭辞。既定は pmtiles/ */
  KEY_PREFIX?: string
}

/** タイルの Cache-Control。生成済みのデータなので長めに置く（Mapterhorn は 7 日）。 */
const TILE_MAX_AGE = 86400

const TILE_PATH = /^\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.([a-z0-9]+)$/
const TILEJSON_PATH = /^\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+)\.json$/

const CONTENT_TYPE: Partial<Record<TileType, [ext: string, type: string]>> = {
  [TileType.Mvt]: ['pbf', 'application/x-protobuf'],
  [TileType.Png]: ['png', 'image/png'],
  [TileType.Jpeg]: ['jpg', 'image/jpeg'],
  [TileType.Webp]: ['webp', 'image/webp'],
  [TileType.Avif]: ['avif', 'image/avif'],
}

class NotFound extends Error {}

/** R2 のオブジェクトを Range で読む PMTiles の Source。 */
class R2Source implements Source {
  constructor(
    private bucket: R2Bucket,
    private key: string,
  ) {}

  getKey(): string {
    return this.key
  }

  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, {
      range: { offset, length },
      onlyIf: etag ? { etagMatches: etag } : undefined,
    })
    if (!obj) throw new NotFound(this.key)
    // onlyIf が外れると本文の無い R2Object が返る。アーカイブが差し替わったということ
    if (!('body' in obj)) throw new EtagMismatch()
    return { data: await obj.arrayBuffer(), etag: obj.etag }
  }
}

// ヘッダとディレクトリはアイソレートが生きている間ここに残る。リクエストごとに R2 を読み直さない
const cache = new ResolvedValueCache(25, undefined)
const archives = new Map<string, PMTiles>()

function archive(env: Env, name: string): PMTiles {
  const key = `${env.KEY_PREFIX ?? 'pmtiles/'}${name}.pmtiles`
  let p = archives.get(key)
  if (!p) {
    p = new PMTiles(new R2Source(env.BUCKET, key), cache)
    archives.set(key, p)
  }
  return p
}

const CORS = { 'Access-Control-Allow-Origin': '*' }

function empty(status: number): Response {
  return new Response(null, { status, headers: CORS })
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  const t = TILE_PATH.exec(url.pathname)
  if (t) {
    const [, name, zs, xs, ys, ext] = t
    const z = Number(zs), x = Number(xs), y = Number(ys)
    if (x >= 2 ** z || y >= 2 ** z) return empty(400)
    const p = archive(env, name!)
    const header = await p.getHeader()
    const ct = CONTENT_TYPE[header.tileType]
    // 拡張子は中身と一致させる。.png で WebP を返すと、拡張子で形式を決める利用側が壊れる
    if (!ct || ct[0] !== ext) return empty(404)
    if (z < header.minZoom || z > header.maxZoom) return empty(404)
    const tile = await p.getZxy(z, x, y)
    // データの無い領域。dem2tiles の ZXY 出力でもファイルが無く 404 になるので合わせる
    if (!tile) return empty(404)
    return new Response(tile.data, {
      headers: {
        ...CORS,
        'Content-Type': ct[1],
        'Cache-Control': `public, max-age=${TILE_MAX_AGE}`,
      },
    })
  }

  const j = TILEJSON_PATH.exec(url.pathname)
  if (j) {
    const name = j[1]!
    const tilejson = await archive(env, name).getTileJson(`${url.origin}/${name}`)
    return Response.json(tilejson, {
      headers: { ...CORS, 'Cache-Control': `public, max-age=${TILE_MAX_AGE}` },
    })
  }

  return empty(404)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' },
      })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return empty(405)

    // R2 を Range で読むと 1 回に 0.2 秒ほど掛かる（ksj-route-search-api issue #4 の実測）。
    // 返したタイルはこのデータセンターの Cache API に置き、2 回目以降は R2 を読まない
    const cacheKey = new Request(request.url, { method: 'GET' })
    const hit = await caches.default.match(cacheKey)
    if (hit) return hit

    let res: Response
    try {
      res = await handle(request, env)
    } catch (e) {
      if (e instanceof NotFound) return empty(404)
      console.error(e)
      return empty(500)
    }
    if (res.status === 200) ctx.waitUntil(caches.default.put(cacheKey, res.clone()))
    return res
  },
} satisfies ExportedHandler<Env>
