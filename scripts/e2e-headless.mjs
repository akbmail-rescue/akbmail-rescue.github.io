// 開発用 E2E: headless Chromium で dev サーバーを開き、動画を投入して分類ログを取得する。
// ネットワークは localhost のみ。外部送信がないことを request 監視で同時に検証する。
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const [, , url, video, outFile, execPath, outDir] = process.argv
import { mkdirSync } from 'node:fs'
const browser = await chromium.launch({
  headless: true,
  executablePath: execPath || undefined,
  args: ['--enable-features=WebCodecs', '--no-sandbox'],
})
const page = await browser.newPage()
const external = []
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()) })
page.on('request', (r) => {
  const u = new URL(r.url())
  if (u.protocol === 'blob:' || u.protocol === 'data:') return
  if (!['localhost', '127.0.0.1'].includes(u.hostname)) external.push(r.url())
})
page.on('console', (m) => console.log('[console]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('worker', (w) => { console.log('[worker started]', w.url()); w.on('console', (m) => console.log('[worker]', m.type(), m.text())) })
await page.goto(url)
await page.setInputFiles('#file', video)
const t0 = Date.now()
await page.waitForFunction(() => ['完了', 'エラー', '未対応'].includes(document.querySelector('#status').textContent), null, { timeout: 600_000 })
const status = await page.textContent('#status')
const log = await page.textContent('#log')
writeFileSync(outFile, log)
console.log(`status=${status} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s external_requests=${external.length}`)
if (external.length) console.log('EXTERNAL:', external)
console.log(await page.textContent('#summary').catch(() => '(no summary)'))
console.log((await page.textContent('#log')).match(/ocr seg=[^\n]*?(?= {2,}\d+ t=|>>>|===|\*\*\*|DONE|$)/g)?.slice(0, 40).join('\n') ?? '')
if (outDir) {
  mkdirSync(outDir, { recursive: true })
  const items = await page.evaluate(async () => {
    const out = []
    for (const a of document.querySelectorAll('#outputs figure a')) {
      const name = a.getAttribute('download')
      const buf = await (await fetch(a.href)).arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
      out.push({ name, b64: btoa(bin) })
    }
    return out
  })
  for (const it of items) writeFileSync(`${outDir}/${it.name}`, Buffer.from(it.b64, 'base64'))
  console.log(`saved ${items.length} outputs to ${outDir}`)
  // ZIP ダウンロード(JSZip)も検証する
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.click('#zip')])
  const zipPath = `${outDir}/${download.suggestedFilename()}`
  await download.saveAs(zipPath)
  console.log(`saved zip: ${zipPath}`)
}
await browser.close()
