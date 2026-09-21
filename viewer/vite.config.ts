import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** dem2tiles の出力ディレクトリ。viewer/ から見た相対位置。 */
const TILE_DIR = '../output'

/**
 * 配信側（R2）のキー名 → dem2tiles の出力ディレクトリ名。
 *
 * コードはどちらの環境でも配信キー名で URL を組む。dev はここで実体へ読み替える。
 */
const KEY_TO_DIR: Record<string, string> = {
  'shizuoka-alb-terrarium': 'terrarium',
  'shizuoka-alb-terrain-rgb': 'mapbox',
  'shizuoka-alb-dem-png': 'gsidem',
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
}

/**
 * 開発サーバで `../output` を `/tiles` として配る。
 *
 * タイルは Vite の root の外にあり、publicDir に置くとビルド成果物に
 * 数千ファイルを取り込んでしまう。dev のときだけミドルウェアで読む。
 * 本番は配信側で同じパスにタイルを置くか、VITE_TILES_BASE で差し替える。
 */
function serveTiles(): Plugin {
  return {
    name: 'dem2tiles-serve-tiles',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/tiles', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!)
        // 親ディレクトリへ抜ける経路を弾く
        if (normalize(rel).includes('..')) {
          res.statusCode = 400
          res.end()
          return
        }
        const [, first, ...rest] = rel.split('/')
        const dir = KEY_TO_DIR[first ?? '']
        if (!dir) return next()
        const file = join(server.config.root, TILE_DIR, dir, ...rest)
        try {
          if (!statSync(file).isFile()) return next()
        } catch {
          // タイルが無いのは正常（データの無い領域）。404 を返す。
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig(({ command }) => ({
  // GitHub Pages はリポジトリ名のサブパスで配る。
  base: command === 'build' ? '/dem2tiles/' : '/',
  plugins: [serveTiles()],
  build: {
    // maplibre-contour が最上位 await を含むため ES2022 が必要
    target: 'es2022',
  },
  server: {
    port: 5176,
    strictPort: true,
    // Windows 上のファイルを WSL 側から見る構成ではファイル変更イベントが
    // 届かず、dev サーバが古い結果を返し続ける。ポーリングで検知する。
    watch: { usePolling: true, interval: 300 },
  },
}))
