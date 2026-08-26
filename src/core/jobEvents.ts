/**
 * Worker 応答の世代判定(R4 #2)。応答には依頼時の jobId が付く。
 * 現在のジョブと一致しない応答(中止・エラー後に届いた旧 Worker の遅延イベント)は副作用の前に捨てる。
 */
export function acceptsMessage(msgJobId: string | undefined, activeJobId: string | null): boolean {
  if (!activeJobId) return false
  return msgJobId === activeJobId
}
