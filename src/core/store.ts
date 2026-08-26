/**
 * 処理結果の永続化(NF-4 中断耐性)。IndexedDB に「動画ごとのジョブ」と「出力 PNG」を保存する。
 * 保存するのは処理済み結果(PNG Blob とメタデータ)だけで、動画やフレームは保存しない。
 * すべて端末内(INV-1)。
 *
 * jobs:    { id, fileName, fileSize, lastModified, status, createdAt, updatedAt, summary?, segMeta, path? }
 * outputs: { key: `${jobId}/${name}`, jobId, item: OutputItem(blob 含む), included, editedTimestamp }
 */
import type { OutputItem } from '../worker/messages'

export const DB_NAME = 'akbmail-rescue'
export const DB_VERSION = 1

export interface StoredSegMeta {
  timestamp: string | null
  sender: string | null
  indexStart?: number
  indexEnd?: number
  tStart?: number
  tEnd?: number
}

export interface JobRecord {
  /** ジョブ固有 ID(UUID)。同名ファイルの再投入でも衝突しない */
  id: string
  /** ファイルの識別子(名前|サイズ|更新時刻)。重複検出の目安にだけ使う */
  fingerprint?: string
  /** 処理中のタブの識別子と最終生存時刻。他タブは heartbeat が古い running だけを中断扱いにする */
  ownerId?: string
  heartbeatAt?: number
  /** 永続化に失敗した出力の件数(0 でなければ復元は不完全) */
  persistFailures?: number
  fileName: string
  fileSize: number
  lastModified: number
  status: 'running' | 'done' | 'error' | 'interrupted'
  createdAt: number
  updatedAt: number
  path?: 'webcodecs' | 'ffmpeg.wasm'
  summaryText?: string
  segMeta: Record<number, StoredSegMeta>
  error?: string
}

export interface OutputRecord {
  key: string
  jobId: string
  seq: number
  item: OutputItem
  included: boolean
  editedTimestamp: string | null
}

/** ファイルの識別子(内容は読まない。名前・サイズ・更新時刻の組)。重複検出の目安 */
export function fingerprintFor(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

/** ジョブ ID(UUID)。crypto.randomUUID が無い環境では時刻+乱数 */
export function newJobId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 互換用(旧名) */
export const jobIdFor = fingerprintFor

/** running の heartbeat がこれより古ければ、そのタブは死んだとみなす */
export const HEARTBEAT_STALE_MS = 60_000

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB error'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export class ResultStore {
  private dbp: Promise<IDBDatabase> | null = null

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  static available(): boolean {
    return typeof indexedDB !== 'undefined'
  }

  private open(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const r = this.factory.open(DB_NAME, DB_VERSION)
        r.onupgradeneeded = () => {
          const db = r.result
          if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' })
          if (!db.objectStoreNames.contains('outputs')) {
            const os = db.createObjectStore('outputs', { keyPath: 'key' })
            os.createIndex('jobId', 'jobId', { unique: false })
          }
        }
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'))
        r.onblocked = () => reject(new Error('IndexedDB open blocked'))
      })
    }
    return this.dbp
  }

  async listJobs(): Promise<JobRecord[]> {
    const db = await this.open()
    const tx = db.transaction('jobs', 'readonly')
    const all = await req(tx.objectStore('jobs').getAll())
    return (all as JobRecord[]).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }

  async getJob(id: string): Promise<JobRecord | undefined> {
    const db = await this.open()
    const tx = db.transaction('jobs', 'readonly')
    return (await req(tx.objectStore('jobs').get(id))) as JobRecord | undefined
  }

  async putJob(job: JobRecord): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('jobs', 'readwrite')
    tx.objectStore('jobs').put({ ...job, updatedAt: Date.now() })
    await done(tx)
  }

  /**
   * ジョブの部分更新。DB 上の現行レコードに patch を重ねる(単一トランザクション)。
   * heartbeatAt / ownerId は patch に含まれない限り DB の値を保持する(古い値で巻き戻さない、R2 #4)。
   * レコードが無ければ fallback を保存する
   */
  async patchJob(id: string, patch: Partial<JobRecord>, fallback?: JobRecord): Promise<JobRecord | undefined> {
    const db = await this.open()
    const tx = db.transaction('jobs', 'readwrite')
    const os = tx.objectStore('jobs')
    const cur = (await req(os.get(id))) as JobRecord | undefined
    const base = cur ?? fallback
    if (!base) {
      await done(tx)
      return undefined
    }
    const next: JobRecord = { ...base, ...patch, updatedAt: Date.now() }
    os.put(next)
    await done(tx)
    return next
  }

  /**
   * 実行中のまま残っているジョブ(前回タブが落ちた等)を interrupted にする。
   * 他タブで現に処理中のもの(heartbeat が新しい、または自タブ所有)は触らない。
   */
  async markInterrupted(selfOwnerId: string, now = Date.now()): Promise<number> {
    const jobs = await this.listJobs()
    let n = 0
    for (const j of jobs) {
      if (j.status !== 'running' || j.ownerId === selfOwnerId) continue
      const stale = !j.heartbeatAt || now - j.heartbeatAt > HEARTBEAT_STALE_MS
      if (!stale) continue
      // 単一トランザクション内で所有者と heartbeat を再確認してから更新する
      const db = await this.open()
      const tx = db.transaction('jobs', 'readwrite')
      const os = tx.objectStore('jobs')
      const cur = (await req(os.get(j.id))) as JobRecord | undefined
      if (cur && cur.status === 'running' && (!cur.heartbeatAt || now - cur.heartbeatAt > HEARTBEAT_STALE_MS)) {
        os.put({ ...cur, status: 'interrupted', updatedAt: now })
        n++
      }
      await done(tx)
    }
    return n
  }

  /** 処理中ジョブの生存時刻だけを更新(所有者が一致するときのみ) */
  async heartbeat(id: string, ownerId: string): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('jobs', 'readwrite')
    const os = tx.objectStore('jobs')
    const cur = (await req(os.get(id))) as JobRecord | undefined
    if (cur && cur.ownerId === ownerId && cur.status === 'running') os.put({ ...cur, heartbeatAt: Date.now() })
    await done(tx)
  }

  /** 保存領域の見積もり(未対応環境では null) */
  static async estimate(): Promise<{ usage: number; quota: number } | null> {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
      const e = await navigator.storage.estimate()
      return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
    } catch {
      return null
    }
  }

  async putOutput(rec: OutputRecord): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('outputs', 'readwrite')
    tx.objectStore('outputs').put(rec)
    await done(tx)
  }

  async listOutputs(jobId: string): Promise<OutputRecord[]> {
    const db = await this.open()
    const tx = db.transaction('outputs', 'readonly')
    const all = await req(tx.objectStore('outputs').index('jobId').getAll(jobId))
    return (all as OutputRecord[]).sort((a, b) => a.seq - b.seq)
  }

  /** 出力の選択状態・手入力日時だけを更新 */
  async updateOutput(key: string, patch: Partial<Pick<OutputRecord, 'included' | 'editedTimestamp'>>): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('outputs', 'readwrite')
    const os = tx.objectStore('outputs')
    const cur = (await req(os.get(key))) as OutputRecord | undefined
    if (cur) os.put({ ...cur, ...patch })
    await done(tx)
  }

  async deleteJob(id: string): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(['jobs', 'outputs'], 'readwrite')
    tx.objectStore('jobs').delete(id)
    const idx = tx.objectStore('outputs').index('jobId')
    const keys = await req(idx.getAllKeys(id))
    for (const k of keys) tx.objectStore('outputs').delete(k)
    await done(tx)
  }

  async clear(): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(['jobs', 'outputs'], 'readwrite')
    tx.objectStore('jobs').clear()
    tx.objectStore('outputs').clear()
    await done(tx)
  }
}
