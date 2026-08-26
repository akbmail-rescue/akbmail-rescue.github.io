# Codex レビュー依頼 R5 — AKB48 Mail レスキューツール(2026-08-26)

## 依頼

添付の 3 パケット(同じフォルダの `akbmail-review-r5-CODE-20260826.md` / `-TESTS-` / `-DOCS-`)を読み、**敵対的な立場で**問題点を挙げてください。
形式はこれまでと同じ「重大度 / 該当箇所 / 何が起きるか / 直し方」。称賛は不要です。
結果の全文は `docs/reviews/codex-review05-result-2026-08-26.md` として保存してください。

## 前回(R4)からの変更

R4 の 5 件を是正しました(DOCS パケットの `docs/reviews/codex-review04-triage-2026-08-26.md`)。

- `src/core/ocrQueue.ts`: 区間ごとの待ち上限を 8(= 試行上限)に、全体上限到達時は「他区間で待ちが最も多い区間の末尾」だけを退避。`canAccept(seg, index)` を追加し、Worker は切り出し前に判定
- `src/worker/messages.ts` / `pipeline.worker.ts`: 依頼に `jobId`、全応答にエコーバック。`src/core/jobEvents.ts` の `acceptsMessage()` で UI が世代の違う応答を捨てる
- `src/App.tsx`: `onmessageerror` を `fail()` に統一(ジョブ error + Worker 再生成)
- `src/core/frameGray.ts`: 切り出しの中間 canvas を即 0 サイズ化
- テスト: 区間閉鎖後の 8 回試行、`canAccept` 整合、世代判定。E2E `scripts/e2e-cancel.mjs`(中止 → 直後に次の動画)

## 特に見てほしい点

1. R4 是正が閉じているか。特に「他区間の末尾だけ退避」の規則で、長尺の失敗区間が連続すると(例: ヘッダーの映らないメールが 10 通続く)何が起きるか
2. `jobId` の世代判定の抜け: `jobRef.current` が null の瞬間(削除直後・復元中)の応答、復元(`restoreJob`)中に処理中ジョブの応答が届く経路、`queue` の次動画開始と旧 Worker terminate の順序
3. INV-3 の実証方法: この構成で「5 分動画でピーク 1.5GB 以下」を CI か手元で再現性をもって測る最小の方法(提案で可)
4. 残課題として記録した「React 内部の Worker 注入テスト」を、既存の依存だけ(React Testing Library なし)で行う現実的な方法があれば提案
5. これまでのレビューで一度も触れられていない領域(例: `stitchCanvas.ts` の描画 API 呼び出し、`demux.ts` の mp4box 連携、`ffmpegExtract.ts` の WORKERFS、`RecordingGuide.tsx` の文言の正確性)で問題があれば

## 制約

- レビュー結果は内部利用のみ。パケットの内容を外部に転載しない。
- 修正コードの提案は差分または要点で十分。実装は依頼側で行う。
