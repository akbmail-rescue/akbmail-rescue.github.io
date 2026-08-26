// R5 #4: 同じ Worker で 2 本続けて処理(ffmpeg.wasm 経路を含む)しても FS 状態が衝突しないことを確認する
import { chromium } from 'playwright-core'
const [, , url, video1, video2, execPath] = process.argv
const browser = await chromium.launch({ headless: true, executablePath: execPath || undefined, args: ['--enable-features=WebCodecs', '--no-sandbox'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url)
for (const v of [video1, video2]) {
  await page.setInputFiles('#file', v)
  await page.waitForFunction(() => ['完了', 'エラー'].includes(document.querySelector('#status').textContent), null, { timeout: 900_000 })
  const log = await page.textContent('#log')
  const path = (log.match(/DONE path=(\S+)/) ?? [])[1]
  const outs = await page.locator('#outputs figure').count()
  const errs = (log.match(/ERROR:[^\n]{0,120}/g) ?? []).slice(0, 3)
  console.log(`${v.split('/').pop()}: status=${await page.textContent('#status')} path=${path} outputs=${outs} ${errs.join(' | ')}`)
}
console.log('jobs:', await page.locator('.jobs li .badge').allTextContents())
await browser.close()
