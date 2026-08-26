import { describe, expect, it } from 'vitest'
import { OCR_REGIONS, cleanSender, formatTimestamp, imageFileName, mailFileName, normalizeTimestampInput, parseTimestamp } from '../../src/core/ocr'

describe('parseTimestamp (rescue.py ocr_timestamp の正規表現)', () => {
  it('"2026-08-25 22:59" → 2026-08-25_2259', () => {
    expect(parseTimestamp('2026-08-25 22:59')).toBe('2026-08-25_2259')
    expect(parseTimestamp(' 2026-08-25 22:59\n')).toBe('2026-08-25_2259')
  })
  it('コロン無し・空白無しも許容(rescue.py と同じ)', () => {
    expect(parseTimestamp('2026-08-2522:59')).toBe('2026-08-25_2259')
    expect(parseTimestamp('2026-08-25 2259')).toBe('2026-08-25_2259')
  })
  it('OCR ノイズが前後にあっても抽出する', () => {
    expect(parseTimestamp('-- 2026-08-23 21:07 :')).toBe('2026-08-23_2107')
  })
  it('20xx 以外や欠損は null', () => {
    expect(parseTimestamp('1999-08-25 22:59')).toBeNull()
    expect(parseTimestamp('2026-08-25')).toBeNull()
    expect(parseTimestamp('')).toBeNull()
  })
})

describe('timestamp の表示・手入力', () => {
  it('formatTimestamp', () => {
    expect(formatTimestamp('2026-08-25_2259')).toBe('2026-08-25 22:59')
    expect(formatTimestamp('unknown')).toBe('unknown')
  })
  it('normalizeTimestampInput は複数の書式を受け付け、範囲外は null', () => {
    expect(normalizeTimestampInput('2026-08-25 22:59')).toBe('2026-08-25_2259')
    expect(normalizeTimestampInput('2026-08-25_2259')).toBe('2026-08-25_2259')
    expect(normalizeTimestampInput('2026/8/5 7:03')).toBe('2026-08-05_0703')
    expect(normalizeTimestampInput('2026-13-01 10:00')).toBeNull()
    expect(normalizeTimestampInput('2026-08-25 24:00')).toBeNull()
    expect(normalizeTimestampInput('abc')).toBeNull()
  })
})

describe('cleanSender / ファイル名', () => {
  it('送信者名の整形', () => {
    expect(cleanSender(' 渋 井 美 奈 \n')).toBe('渋井美奈')
    expect(cleanSender('|渋井  美奈|')).toBe('渋井美奈')
    expect(cleanSender('Yuki Kashiwagi')).toBe('Yuki Kashiwagi')
    expect(cleanSender('\n\n')).toBeNull()
  })
  it('mail_<ts>.png / mail_unknown_NN.png / 重複サフィックス / image_NNN.png', () => {
    expect(mailFileName('2026-08-25_2259', 1)).toBe('mail_2026-08-25_2259.png')
    expect(mailFileName(null, 3)).toBe('mail_unknown_03.png')
    expect(mailFileName('2026-08-25_2259', 1, 1)).toBe('mail_2026-08-25_2259_2.png')
    expect(imageFileName(2)).toBe('image_002.png')
  })
  it('OCR 領域は相対座標(INV-4)で、タイムスタンプ領域は rescue.py と同値', () => {
    expect(OCR_REGIONS.timestamp).toEqual({ x0: 0.55, x1: 1.0, y0: 0.13, y1: 0.18 })
    for (const r of Object.values(OCR_REGIONS)) {
      expect(r.x0).toBeGreaterThanOrEqual(0)
      expect(r.x1).toBeLessThanOrEqual(1)
      expect(r.y0).toBeLessThan(r.y1)
    }
  })
})
