import { describe, expect, it } from 'vitest'
import { acceptsMessage } from '../../src/core/jobEvents'

describe('acceptsMessage (Worker 応答の世代判定)', () => {
  it('現在ジョブと同じ jobId の応答だけ受け入れる', () => {
    expect(acceptsMessage('A', 'A')).toBe(true)
    expect(acceptsMessage('A', 'B')).toBe(false)
    expect(acceptsMessage(undefined, 'B')).toBe(false)
    expect(acceptsMessage('A', null)).toBe(false)
  })
})
