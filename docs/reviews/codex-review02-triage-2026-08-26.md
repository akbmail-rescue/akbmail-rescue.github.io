# Codex レビュー R2 — 精査と是正記録(2026-08-26、内部用)

対象: R2(R1 是正後、コミット 5 件目時点)。9 件すべて妥当と判断し是正。

| # | 重大度 | 是正 |
|---|---|---|
| 1 | High | rename 成功と最終ファイルのサイズ一致を確認してから端末側を削除(PowerShell は `-ErrorAction Stop` + try/catch、bash は `&&` 連鎖) |
| 2 | High | `src/core/ocrQueue.ts`: 区間 8 候補に加え全体 16 候補(≈32MB)の上限。超過は捨てて件数を skipped で可視化。直列実行・先に閉じた区間を優先 |
| 3 | High | `OcrQueue.drain()` は実行中・待ち候補が無くなるまで待つ(後着ジョブも含む)。最終区間で 8 回失敗するテストを追加 |
| 4 | High | `ResultStore.patchJob()`(単一トランザクションで現行レコードに patch、heartbeat/owner を保持)。App の persistJob は patch 方式に変更。巻き戻し防止のテストを追加 |
| 5 | High | `ff.exec(args, EXEC_TIMEOUT_MS=5 分)` でチャンクごとに打ち切り(rc=-1 を明示エラー)。UI は 180 秒で警告、600 秒無応答で自動中止 |
| 6 | Medium | 上限を行数固定からバイト基準(128MB ÷ 幅×4)に変更、`init()` も同じ上限に従う |
| 7 | Medium | `isValidDateTime()` を共通化し `parseTimestamp()`(OCR)と手入力の両方で使用。テスト追加 |
| 8 | Medium | `src/core/naming.ts` に切り出し、分割は 1 通として基底名を共有。3 パートのテスト追加 |
| 9 | Medium | 固定リストを廃止し package-lock の production 依存グラフ全体(推移依存含む)から生成。node_modules 欠落・ライセンス情報欠落は生成失敗 |

残課題: 実ブラウザでの 5 分動画ピークメモリ計測、複数タブ同時処理の E2E、ffmpeg 経路の CI E2E(CI の Chromium は HEVC 不可のため H.264 合成動画のみ)。
