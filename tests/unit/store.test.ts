import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { ResultStore, jobIdFor, type JobRecord } from '../../src/core/store'
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
  it('jobIdFor は名前・サイズ・更新時刻の組', () => {
    expect(jobIdFor({ name: 'x.mp4', size: 3, lastModified: 4 })).toBe('x.mp4|3|4')
  })
  it('ジョブと出力を保存・復元し、更新時刻順に並ぶ', async () => {
    await store.putJob(job('j1'))
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
  it('running のまま残ったジョブは interrupted になる', async () => {
    await store.putJob(job('j1', 'running'))
    await store.putJob(job('j2', 'done'))
    expect(await store.markInterrupted()).toBe(1)
    expect((await store.getJob('j1'))!.status).toBe('interrupted')
    expect((await store.getJob('j2'))!.status).toBe('done')
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
