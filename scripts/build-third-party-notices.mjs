// 配布物に同梱する THIRD_PARTY_NOTICES.txt を node_modules のライセンス本文から生成する(F13)。
// 実行: node scripts/build-third-party-notices.mjs → public/THIRD_PARTY_NOTICES.txt(ビルド時に dist へ含まれる)
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 収載対象: package-lock.json の production 依存グラフ全体(推移依存を含む、R2 #9)。固定リストは使わない
function runtimePackages() {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const names = new Set()
  for (const [key, info] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue
    if (info.dev || info.devOptional) continue
    names.add(key.replace(/^.*node_modules\//, ''))
  }
  return [...names].sort()
}
const RUNTIME = runtimePackages()
const EXTRA = [
  { name: 'ffmpeg (ffmpeg.wasm core にコンパイルされた本体)', license: 'GPL-2.0-or-later / LGPL-2.1-or-later(構成による)', url: 'https://ffmpeg.org/legal.html' },
  { name: 'tesseract 言語データ tessdata / tessdata_fast (jpn, eng)', license: 'Apache-2.0', url: 'https://github.com/tesseract-ocr/tessdata' },
]
let out = `AKB48 Mail レスキューツール — 使用しているソフトウェアとライセンス\n本ツール自体は GPL-3.0-or-later(LICENSE)。以下は同梱・利用している第三者ソフトウェアの著作権表示とライセンス本文です。\n\n`
for (const name of RUNTIME) {
  const dir = path.join(ROOT, 'node_modules', name)
  if (!existsSync(dir)) { console.error(`runtime dependency が node_modules に無い: ${name}`); process.exit(1) }
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const lic = readdirSync(dir).find((f) => /^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(f))
  out += `================================================================\n${pkg.name} ${pkg.version} — ${pkg.license ?? '(license 未記載)'}${pkg.homepage ? ` — ${pkg.homepage}` : ''}\n${pkg.author ? `author: ${typeof pkg.author === 'string' ? pkg.author : pkg.author.name}\n` : ''}----------------------------------------------------------------\n`
  if (!lic && !pkg.license) { console.error(`ライセンス情報が無い runtime dependency: ${name}`); process.exit(1) }
  out += lic ? readFileSync(path.join(dir, lic), 'utf8').trim() + '\n\n' : `(ライセンス本文ファイルなし。package.json の license: ${pkg.license})\n\n`
}
console.log(`runtime packages: ${RUNTIME.length}: ${RUNTIME.join(', ')}`)
for (const e of EXTRA) out += `================================================================\n${e.name} — ${e.license} — ${e.url}\n\n`
mkdirSync(path.join(ROOT, 'public'), { recursive: true })
writeFileSync(path.join(ROOT, 'public', 'THIRD_PARTY_NOTICES.txt'), out)
console.log(`public/THIRD_PARTY_NOTICES.txt (${(out.length / 1024).toFixed(0)} KB)`)
