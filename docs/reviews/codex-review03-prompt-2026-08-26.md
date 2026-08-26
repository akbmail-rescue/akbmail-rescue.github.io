# Codex レビュー依頼 R3 — AKB48 Mail レスキューツール(2026-08-26)

## 依頼

添付の 3 パケット(同じフォルダの `akbmail-review-r3-CODE-20260826.md` / `-TESTS-` / `-DOCS-`)を読み、**敵対的な立場で**問題点を挙げてください。
形式は前回と同じ「重大度 / 該当箇所 / 何が起きるか / 直し方」。称賛は不要です。

## 前回(R2)からの変更

R2 の 9 件をすべて是正しました。是正記録は DOCS パケットの `docs/reviews/codex-review02-triage-2026-08-26.md`(R1 は `codex-review01-triage-…`)。主な変更点:

- OCR 待ち行列を `src/core/ocrQueue.ts` に切り出し(区間 8 候補/全体 16 候補、上限時は待ちが多い区間の末尾を退避、直列実行、動的 drain)
- 最終ファイル名の決定を `src/core/naming.ts` に切り出し(分割メールは 1 通扱い)
- `ResultStore.patchJob()`(heartbeat/owner を保持する部分更新)、App の persistJob は patch 方式
- `ffmpeg.exec` にチャンクごとの 5 分タイムアウト、UI は 3 分で警告・10 分無応答で自動中止
- スティッチの上限をバイト基準(128MB ÷ 幅×4)に、`init()` も同じ上限
- OCR 結果の日時に実在検証(`isValidDateTime`)
- 第三者ライセンス表示を package-lock の本番依存グラフ全体から生成
- adb スクリプトは rename 成功と最終サイズ一致を確認してから端末側を削除
- CI: 合成フィクスチャ生成(`stitch_ref.py` は scale/recheck を引数で明示)→ `REQUIRE_FIXTURES=synth` → build → headless E2E(外部送信 0 の検査)→ deploy

## 特に見てほしい点

1. **R2 是正の妥当性**: 上記 9 件が本当に閉じているか。特に `ocrQueue.ts` の退避規則(全体上限時に最多区間の末尾を捨てる)が、区間数が多い長尺動画で「先頭付近の区間だけ日時が取れ、後半が全部 unknown」になる劣化を起こさないか。`drain()` の終了条件に穴が無いか
2. **INV-1(非送信)**: 変更後も外部送信経路が無いこと(`THIRD_PARTY_NOTICES.txt` は同一オリジンの静的ファイル)
3. **INV-2/3**: `FRAME_BUDGET` の合算が実際の保持数と一致しているか(現在フレーム、スティッチ用グレー、OCR 候補の OffscreenCanvas は予算外扱い — それで妥当か)
4. **中止・タイムアウトの整合**: UI の自動中止(Worker terminate)と Worker 内の ffmpeg/Tesseract のタイムアウトが競合したときの状態遷移(IndexedDB の status、UI の表示、次のキュー処理)
5. **IndexedDB**: `patchJob` と `heartbeat` と `markInterrupted` の同時実行、`persistFailures` の扱い、復元時の `ownerId` 表示
6. **テスト**: 新規モジュール(ocrQueue / naming)のテストが仕様を十分に固定しているか。CI の E2E が検証していること・していないこと

## 制約

- レビュー結果は内部利用のみ。パケットの内容を外部に転載しない。
- 修正コードの提案は差分または要点で十分。実装は依頼側で行う。
