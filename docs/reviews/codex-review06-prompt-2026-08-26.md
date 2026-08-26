# Codex レビュー依頼 R6 — AKB48 Mail レスキューツール(2026-08-26)

## 依頼

添付の 3 パケット(同じフォルダの `akbmail-review-r6-CODE-20260826.md` / `-TESTS-` / `-DOCS-`)を読み、**敵対的な立場で**問題点を挙げてください。
形式はこれまでと同じ「重大度 / 該当箇所 / 何が起きるか / 直し方」。称賛は不要です。
結果の全文は `docs/reviews/codex-review06-result-2026-08-26.md` として保存してください。

## 前回(R5)からの変更

R5 の 5 件+補足を是正しました(DOCS パケットの `docs/reviews/codex-review05-triage-2026-08-26.md`)。

- `src/core/ocrQueue.ts`: 飽和時の退避は「他区間の中間候補」(先頭・最新を保持)。退避元は待ち >3 の区間を優先し、自区間が 3 未満のときだけ他区間を 1 まで削る。`waitingIndices()` を追加し 20/60 区間の分布テスト
- `src/App.tsx`: `restoring` 状態と復元世代(復元中は投入・開始・削除を無効化、完了時に再確認)。Worker の全ハンドラで `workerRef.current === w` を確認、cleanup で `workerRef` を null にしてから terminate
- `src/core/ffmpegExtract.ts`: 呼び出しごとに `/input_N` `/out_N`、finally で出力・ディレクトリ・マウントを除去、異常終了時は cached を terminate
- `src/core/stitchCanvas.ts`: 最終タイルを上限までの残り行数で確保
- `src/ui/RecordingGuide.tsx` / `docs/requirements.md`: オフライン・サイズ上限の文言、F-5 の飽和時仕様、NF-5 注記
- E2E: `scripts/e2e-two.mjs`(HEVC 2 本連続、ffmpeg.wasm 経路)

R5 の提案(メモリ計測 CI、`addInitScript` の Fake Worker 注入テスト、Service Worker 事前キャッシュ)は採用予定の残課題として未実装です。

## 特に見てほしい点

1. R5 是正が閉じているか。特に退避規則の境界(自区間がちょうど 3、他区間がすべて 3、実行中の候補の扱い)と `canAccept` / `offer` の整合
2. 復元ガードの抜け: `restoring` 中の Worker からの応答(前ジョブが running のまま復元ボタンが押せる経路は無いか)、`deleteJob` の `confirm` 中に到着する応答
3. `ffmpegExtract` の後始末: `listDir` 失敗時、`unmount` 失敗時、`callSeq` の単調増加でパスが衝突しないか、`discardCached` と並行呼び出し
4. これまでの 5 回で是正した箇所に**新たに入り込んだ**不具合(退行)が無いか。特に App.tsx は差分が積み重なっているので、状態(`busyRef` / `status` / `restoring` / `queue` / `workerGen`)の組み合わせ表で矛盾を探してほしい
5. 収束判定: 残っている指摘が「残課題として記録済みの 3 件」以外に無ければ、その旨を明記してほしい

## 制約

- レビュー結果は内部利用のみ。パケットの内容を外部に転載しない。
- 修正コードの提案は差分または要点で十分。実装は依頼側で行う。
