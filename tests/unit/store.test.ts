import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { HEARTBEAT_STALE_MS, ResultStore, fingerprintFor, newJobId, type JobRecord } from '../../src/core/store'
import type { OutputItem } from '../../src/worker/messages'

function item(name: string): OutputItem {
  return { kind: 'mail', name, blob: new Blob([name], { type: 'image/png' }), seg: 0, index: 1, t: 0.1, bm: 0.5, hash: 'ff', fromStable: true, width: 10, height: 10, stitched: false, stitchAccepted: 0 }
}
function job(id: string, status: JobRecord['status'] = 'running'): JobRecord {
  return { id, fileName: 'a.mp4', fileSize: 1, lastModified: 2, status, createdAt: 1, updatedAt: 1, segMeta: {} }
}

describe('ResultStore (IndexedDB)', () => {
  let store: ResultStore
  beforeEach(() => {
    store = new ResultStore(new IDBFactory())
  })
  it('fingerprintFor は名前・サイズ・更新時刻の組、newJobId は毎回異なる', () => {
    expect(fingerprintFor({ name: 'x.mp4', size: 3, lastModified: 4 })).toBe('x.mp4|3|4')
    expect(newJobId()).not.toBe(newJobId())
  })
  it('ジョブと出力を保存・復元し、更新時刻順に並ぶ', async () => {
    await store.putJob(job('j1'))
    await new Promise((r) => setTimeout(r, 5)) // updatedAt が同一ミリ秒にならないように
    await store.putJob(job('j2', 'done'))
    await store.putOutput({ key: 'j1/a', jobId: 'j1', seq: 0, item: item('a'), included: true, editedTimestamp: null })
    await store.putOutput({ key: 'j1/b', jobId: 'j1', seq: 1, item: item('b'), included: true, editedTimestamp: null })
    await store.putOutput({ key: 'j2/c', jobId: 'j2', seq: 0, item: item('c'), included: true, editedTimestamp: null })
    const jobs = await store.listJobs()
    expect(jobs.map((j) => j.id)).toEqual(['j2', 'j1'])
    const outs = await store.listOutputs('j1')
    expect(outs.map((o) => o.item.name)).toEqual(['a', 'b'])
    expect(await outs[0].item.blob.text()).toBe('a')
  })
  it('heartbeat が古い running だけ interrupted になり、自タブ所有・生存中の他タブは触らない', async () => {
    const now = 1_000_000
    await store.putJob({ ...job('stale', 'running'), ownerId: 'other', heartbeatAt: now - HEARTBEAT_STALE_MS - 1 })
    await store.putJob({ ...job('alive', 'running'), ownerId: 'other', heartbeatAt: now - 1000 })
    await store.putJob({ ...job('mine', 'running'), ownerId: 'me', heartbeatAt: now - HEARTBEAT_STALE_MS * 5 })
    await store.putJob({ ...job('legacy', 'running') }) // heartbeat 無し(旧データ)→ stale 扱い
    await store.putJob(job('j2', 'done'))
    expect(await store.markInterrupted('me', now)).toBe(2)
    expect((await store.getJob('stale'))!.status).toBe('interrupted')
    expect((await store.getJob('legacy'))!.status).toBe('interrupted')
    expect((await store.getJob('alive'))!.status).toBe('running')
    expect((await store.getJob('mine'))!.status).toBe('running')
    expect((await store.getJob('j2'))!.status).toBe('done')
  })
  it('patchJob は DB 上の新しい heartbeat を巻き戻さない(R2 #4)', async () => {
    await store.putJob({ ...job('j1', 'running'), ownerId: 'me', heartbeatAt: 1 })
    await store.heartbeat('j1', 'me')
    const hb = (await store.getJob('j1'))!.heartbeatAt!
    expect(hb).toBeGreaterThan(1)
    // 古い heartbeat を持つスナップショットからの部分更新
    await store.patchJob('j1', { summaryText: 'x' })
    const after = (await store.getJob('j1'))!
    expect(after.heartbeatAt).toBe(hb)
    expect(after.summaryText).toBe('x')
    // レコードが無ければ fallback を保存
    expect(await store.patchJob('nope', { status: 'done' })).toBeUndefined()
    await store.patchJob('j9', { status: 'done' }, job('j9'))
    expect((await store.getJob('j9'))!.status).toBe('done')
  })
  it('heartbeat は所有者が一致する running だけ更新する', async () => {
    await store.putJob({ ...job('j1', 'running'), ownerId: 'me', heartbeatAt: 1 })
    await store.heartbeat('j1', 'other')
    expect((await store.getJob('j1'))!.heartbeatAt).toBe(1)
    await store.heartbeat('j1', 'me')
    expect((await store.getJob('j1'))!.heartbeatAt).toBeGreaterThan(1)
  })
  it('出力の選択状態・手入力を更新できる', async () => {
    await store.putJob(job('j1'))
    await store.putOutput({ key: 'j1/a', jobId: 'j1', seq: 0, item: item('a'), included: true, editedTimestamp: null })
    await store.updateOutput('j1/a', { included: false, editedTimestamp: '2026-08-25_2259' })
    const [o] = await store.listOutputs('j1')
    expect(o.included).toBe(false)
    expect(o.editedTimestamp).toBe('2026-08-25_2259')
  })
  it('ジョブ削除で出力も消える', async () => {
    await store.putJob(job('j1'))
    await store.putOutput({ key: 'j1/a', jobId: 'j1', seq: 0, item: item('a'), included: true, editedTimestamp: null })
    await store.deleteJob('j1')
    expect(await store.listJobs()).toEqual([])
    expect(await store.listOutputs('j1')).toEqual([])
  })
})
