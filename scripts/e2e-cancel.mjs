// R4 #2/#5: 中止 → すぐ次の動画 を投入しても、旧 Worker のイベントが新ジョブに混入しないことを確認する
import { chromium } from 'playwright-core'
const [, , url, video1, video2, execPath] = process.argv
const browser = await chromium.launch({ headless: true, executablePath: execPath || undefined, args: ['--enable-features=WebCodecs', '--no-sandbox'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url)
await page.setInputFiles('#file', video1)
// 出力が 1 件以上出た時点で中止
await page.waitForFunction(() => document.querySelectorAll('#outputs figure').length >= 1, null, { timeout: 600_000 })
await page.click('button:has-text("中止")')
await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('中断'), null, { timeout: 30_000 })
console.log('cancelled at outputs', await page.locator('#outputs figure').count(), 'status', await page.textContent('#status'))
// すぐ次の動画
await page.setInputFiles('#file', video2)
await page.waitForFunction(() => ['完了', 'エラー'].includes(document.querySelector('#status').textContent), null, { timeout: 600_000 })
const names = await page.locator('#outputs figure').evaluateAll((els) => els.map((e) => e.getAttribute('data-final')))
const log = await page.textContent('#log')
const stale = (log.match(/ignored stale worker message/g) ?? []).length
console.log('second job status', await page.textContent('#status'), 'outputs', names.length, 'stale-ignored', stale)
console.log(names.join(' '))
const rows = await page.locator('.jobs li').allTextContents()
console.log('jobs:', rows)
await browser.close()
