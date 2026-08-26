// 外部 AI レビュー(Codex 等)用パケット生成。実装・テスト・設計・参照実装を 1 つの Markdown に束ねる。
// 使い方: node scripts/build-review-packet.mjs --round 1 [--date YYYYMMDD]
// 出力: akbmail-review-r<N>-{CODE,TESTS,DOCS}-<date>.md(repo 直下、gitignore 対象)。
// 収載しないもの: フィクスチャの大きな JSON、動画・画像、node_modules、public/ のアセット、検証ログ(メール内容を含む)。
// 秘密情報は本プロジェクトには存在しない前提だが、鍵らしき文字列を機械的に検査して検出時は生成しない。
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const round = Number(opt('round', '1'))
const date = opt('date', new Date().toISOString().slice(0, 10).replace(/-/g, ''))
const CAP = 900_000 // 1 パケットの上限バイト

const SETS = {
  CODE: [
    { p: 'src', ext: ['.ts', '.tsx', '.css'], label: '実装' },
    { p: 'vite.config.ts', label: '設定' },
    { p: 'package.json', label: '設定' },
    { p: 'tsconfig.app.json', label: '設定' },
    { p: '.github/workflows/pages.yml', label: '配布' },
    { p: 'scripts', ext: ['.mjs', '.sh', '.py'], label: 'スクリプト' },
    { p: 'tools', ext: ['.ps1', '.sh', '.md'], label: '録画自動化ツール' },
  ],
  TESTS: [{ p: 'tests', ext: ['.ts'], label: 'テスト' }],
  DOCS: [
    { p: 'CLAUDE.md', label: '開発方針・不変条件' },
    { p: 'docs/requirements.md', label: '要件定義書' },
    { p: 'README.md', label: 'README' },
    { p: 'docs/reviews', ext: ['.md'], label: 'レビュー記録(依頼文・是正記録)' },
    { p: 'reference', ext: ['.py'], label: '参照実装(アルゴリズムの正)' },
  ],
}
const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,})/

function walk(p, ext) {
  const abs = path.join(ROOT, p)
  if (!existsSync(abs)) return []
  if (statSync(abs).isFile()) return [p]
  const out = []
  for (const f of readdirSync(abs).sort()) {
    const rel = path.join(p, f)
    const st = statSync(path.join(ROOT, rel))
    if (st.isDirectory()) out.push(...walk(rel, ext))
    else if (!ext || ext.includes(path.extname(f))) out.push(rel)
  }
  return out
}
const lang = (f) => ({ '.ts': 'ts', '.tsx': 'tsx', '.css': 'css', '.mjs': 'js', '.sh': 'bash', '.py': 'python', '.ps1': 'powershell', '.md': 'md', '.json': 'json', '.yml': 'yaml' })[path.extname(f)] ?? ''
const sha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()

for (const [kind, targets] of Object.entries(SETS)) {
  let body = `# AKB48 Mail レスキューツール レビューパケット R${round} / ${kind} (${date})\n\n対象コミット: ${sha}\n\n`
  let total = 0
  const dropped = []
  for (const t of targets) {
    for (const f of walk(t.p, t.ext)) {
      const text = readFileSync(path.join(ROOT, f), 'utf8')
      if (SECRET_RE.test(text)) { console.error(`秘密らしき値を検出: ${f}`); process.exit(1) }
      const chunk = `\n\n## ${f}(${t.label})\n\n\`\`\`${lang(f)}\n${text}\n\`\`\`\n`
      if (total + chunk.length > CAP) { dropped.push(f); continue }
      body += chunk
      total += chunk.length
    }
  }
  if (dropped.length) body += `\n\n---\n上限のため省略: ${dropped.join(', ')}\n`
  const out = path.join(ROOT, `akbmail-review-r${round}-${kind}-${date}.md`)
  writeFileSync(out, body)
  console.log(`${kind.padEnd(5)} ${(total / 1024).toFixed(0).padStart(5)} KB  ${path.basename(out)}${dropped.length ? `  (省略 ${dropped.length})` : ''}`)
}
