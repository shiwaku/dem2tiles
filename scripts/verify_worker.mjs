// Worker（tiles.shi-works.com）が返すタイルを ZXY ディレクトリとバイト単位で突き合わせる。
//
//   node scripts/verify_worker.mjs <URL の接頭辞> <ZXY ディレクトリ> <拡張子> [深いズームの抜き取り枚数]
//
//   node scripts/verify_worker.mjs \
//     https://tiles.shi-works.com/pref-yamanashi/yamanashi-lp-terrarium output-yamanashi/terrarium webp 2000
//
// 抜き取り枚数を渡すと、z12 以下は全部、z13 以上はその枚数だけ無作為に選ぶ。省くと全部。
// 山梨を全部取ると約 50 GB の通信になる。
// あわせて、東隣のタイルがディレクトリに無ければ Worker も 404 を返すことを確かめる。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [base, dir, ext, sampleN] = process.argv.slice(2)
if (!base || !dir || !ext) {
  console.error('usage: verify_worker.mjs <base-url> <zxy-dir> <ext> [sample]')
  process.exit(2)
}

const tiles = []
for (const z of readdirSync(dir).filter((d) => /^\d+$/.test(d)))
  for (const x of readdirSync(join(dir, z)))
    for (const f of readdirSync(join(dir, z, x)))
      if (f.endsWith('.' + ext)) tiles.push([+z, +x, +f.split('.')[0]])

const low = tiles.filter(([z]) => z <= 12)
const high = tiles.filter(([z]) => z > 12)
for (let k = high.length - 1; k > 0; k--) {
  const r = Math.floor(Math.random() * (k + 1))
  ;[high[k], high[r]] = [high[r], high[k]]
}
const picked = [...low, ...high.slice(0, sampleN === undefined ? high.length : Number(sampleN))]

let ok = 0, bad = 0, gone = 0, unexpected = 0
const check = async ([z, x, y]) => {
  const r = await fetch(`${base}/${z}/${x}/${y}.${ext}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (r.status === 200 && buf.equals(readFileSync(join(dir, `${z}`, `${x}`, `${y}.${ext}`)))) ok++
  else {
    bad++
    if (bad <= 5) console.log('MISMATCH', z, x, y, r.status)
  }
  if (!existsSync(join(dir, `${z}`, `${x + 1}`, `${y}.${ext}`))) {
    const n = await fetch(`${base}/${z}/${x + 1}/${y}.${ext}`)
    await n.arrayBuffer()
    if (n.status === 404) gone++
    else {
      unexpected++
      console.log('EXPECTED 404', z, x + 1, y, n.status)
    }
  }
}

// 16 本並列。Node は localhost を IPv6 で引くので、ローカルの wrangler dev には 127.0.0.1 を渡すこと
let i = 0
await Promise.all(
  Array.from({ length: 16 }, async () => {
    while (i < picked.length) await check(picked[i++])
  }),
)
console.log(`tiles=${picked.length} of ${tiles.length} ok=${ok} mismatch=${bad} empty-neighbour-404=${gone} unexpected=${unexpected}`)
process.exit(bad || unexpected ? 1 : 0)
