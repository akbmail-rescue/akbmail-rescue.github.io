// R5 #4: 同じ Worker で 2 本続けて処理(ffmpeg.wasm 経路を含む)しても FS 状態が衝突しないことを確認する
import { chromium } from 'playwright-core'
const [, , url, video1, video2, execPath] = process.argv
const browser = await chromium.launch({ headless: true, executablePath: execPath || undefined, args: ['--enable-features=WebCodecs', '--no-sandbox'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url)
let ok = true
for (const [i, v] of [video1, video2].entries()) {
  const jobsBefore = await page.locator('.jobs li').count()
  await page.setInputFiles('#file', v)
  // 旧「完了」を拾わないよう、まず新ジョブが始まった(履歴が増え、状態が読み込み中/解析中になった)ことを待つ(R6 #3)
  await page.waitForFunction((n) => document.querySelectorAll('.jobs li').length > n && /読み込み中|解析中/.test(document.querySelector('#status').textContent), jobsBefore, { timeout: 60_000 })
  await page.waitForFunction(() => ['完了', 'エラー'].includes(document.querySelector('#status').textContent), null, { timeout: 900_000 })
  const log = await page.textContent('#log')
  const path = (log.match(/DONE path=(\S+)/) ?? [])[1]
  const outs = await page.locator('#outputs figure').count()
  const errs = (log.match(/ERROR:[^\n]{0,120}/g) ?? []).slice(0, 3)
  const status = await page.textContent('#status')
  if (status !== '完了' || outs === 0) ok = false
  console.log(`${i + 1}: ${v.split('/').pop()}: status=${status} path=${path} outputs=${outs} ${errs.join(' | ')}`)
}
const badges = await page.locator('.jobs li .badge').allTextContents()
console.log('jobs:', badges)
if (badges.length !== 2 || badges.some((b) => b !== '完了')) ok = false
console.log(ok ? 'TWO-VIDEO E2E: PASS' : 'TWO-VIDEO E2E: FAIL')
if (!ok) process.exitCode = 1
await browser.close()
