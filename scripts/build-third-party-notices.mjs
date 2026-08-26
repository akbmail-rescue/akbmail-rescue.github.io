// 配布物に同梱する THIRD_PARTY_NOTICES.txt を node_modules のライセンス本文から生成する(F13)。
// 実行: node scripts/build-third-party-notices.mjs → public/THIRD_PARTY_NOTICES.txt(ビルド時に dist へ含まれる)
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = ['react', 'react-dom', 'scheduler', 'mp4box', 'jszip', 'tesseract.js', 'tesseract.js-core', '@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core']
const EXTRA = [
  { name: 'ffmpeg (ffmpeg.wasm core にコンパイルされた本体)', license: 'GPL-2.0-or-later / LGPL-2.1-or-later(構成による)', url: 'https://ffmpeg.org/legal.html' },
  { name: 'tesseract 言語データ tessdata / tessdata_fast (jpn, eng)', license: 'Apache-2.0', url: 'https://github.com/tesseract-ocr/tessdata' },
]
let out = `AKB48 Mail レスキューツール — 使用しているソフトウェアとライセンス\n本ツール自体は GPL-3.0-or-later(LICENSE)。以下は同梱・利用している第三者ソフトウェアの著作権表示とライセンス本文です。\n\n`
for (const name of RUNTIME) {
  const dir = path.join(ROOT, 'node_modules', name)
  if (!existsSync(dir)) { out += `== ${name}: (node_modules に無し)\n\n`; continue }
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const lic = readdirSync(dir).find((f) => /^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(f))
  out += `================================================================\n${pkg.name} ${pkg.version} — ${pkg.license ?? '(license 未記載)'}${pkg.homepage ? ` — ${pkg.homepage}` : ''}\n${pkg.author ? `author: ${typeof pkg.author === 'string' ? pkg.author : pkg.author.name}\n` : ''}----------------------------------------------------------------\n`
  out += lic ? readFileSync(path.join(dir, lic), 'utf8').trim() + '\n\n' : '(ライセンス本文ファイルなし。package.json の license 欄を参照)\n\n'
}
for (const e of EXTRA) out += `================================================================\n${e.name} — ${e.license} — ${e.url}\n\n`
mkdirSync(path.join(ROOT, 'public'), { recursive: true })
writeFileSync(path.join(ROOT, 'public', 'THIRD_PARTY_NOTICES.txt'), out)
console.log(`public/THIRD_PARTY_NOTICES.txt (${(out.length / 1024).toFixed(0)} KB)`)
