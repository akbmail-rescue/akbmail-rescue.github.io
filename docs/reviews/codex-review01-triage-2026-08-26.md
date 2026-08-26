# Codex レビュー R1 — 精査と是正記録(2026-08-26、内部用)

対象: R1 パケット(コミット 902f280 時点)。指摘 14 件すべて妥当と判断し是正した。INV-1 に直接経路なしとの確認は当方の E2E(外部リクエスト 0)と一致。

| # | 重大度 | 判定 | 是正 |
|---|---|---|---|
| 1 | Critical | 妥当 | adb pull の終了コード・ローカルサイズ・端末側サイズ一致を確認してから rename→削除。失敗時は端末に残し再取り込みコマンドを表示(`tools/android-autoscroll/*`) |
| 2 | High | 妥当 | `TiledCanvasCompositor` に区間上限 `MAX_STITCH_ROWS=24000`(約 125MB)。超過分は捨てて `TRUNCATED` として skipped 通知(INV-7)。PNG パートは 8000 行(約 40MB)に縮小。実ブラウザのピークメモリ計測は残課題 |
| 3 | High | 妥当 | `FRAME_BUDGET`(decoder open 12+queue 8、selector best 2+pending 4、current 1、stitch prev 1 = 28 ≤ 30)を `regions.ts` で一元化し、decoder 起動時に合計を検査。selector 保留上限 20→4 |
| 4 | High | 妥当 | OCR 切り出しを区間ごとの有界キュー(≤8 枚)に貯め、失敗したら次を認識。E2E で `attempt=2,3…` が出ることを確認 |
| 5 | High | 妥当 | IndexedDB 失敗をログ・画面に表示、ジョブに `persistFailures` を記録し履歴にも表示。起動時に `navigator.storage.estimate()` で空き 500MB 未満なら警告 |
| 6 | High | 妥当 | ジョブ ID を UUID 化(ファイル識別子は `fingerprint` に分離)。`ownerId`+`heartbeatAt`(10 秒ごと更新)を持ち、他タブは heartbeat が 60 秒以上古い running だけを単一トランザクション内で再確認して中断扱い |
| 7 | High | 妥当 | OCR 認識に 60 秒タイムアウト(超過時はワーカー破棄→再生成)。UI に「中止」ボタン(Worker を terminate して再生成、ジョブは interrupted)と 180 秒無応答の警告。ffmpeg exec 自体のタイムアウトは未実装(中止ボタンで対応) |
| 8 | Medium | 妥当 | createWorker の promise を保持し、タイムアウト後に解決した場合は即 terminate |
| 9 | Medium | 妥当 | INT/TERM は trap 解除→collect→exit 130、通常終了は EXIT で 1 回だけ。録画 PID と端末 serial を明示 |
| 10 | Medium | 妥当 | 端末が 1 台でなければ serial 指定を要求し `adb -s` を常用。各パラメータに上下限 |
| 11 | Medium | 妥当 | `REQUIRE_FIXTURES` 環境変数で欠落を fail 化。CI は Python で合成フィクスチャを生成し `REQUIRE_FIXTURES=synth` で実行。実録画(samples)は動画非同梱のため CI 外(ローカルで実行) |
| 12 | Medium | 妥当(一部) | demux の想定外入力テスト(非 MP4・空・壊れた box・映像なし)を追加。CI に合成動画のブラウザ E2E(WebCodecs 経路・外部送信 0 の検査)を追加。ffmpeg 経路・quota 注入・複数タブ・長時間メモリ試験は残課題 |
| 13 | Medium | 妥当 | `scripts/build-third-party-notices.mjs` で node_modules のライセンス本文から `THIRD_PARTY_NOTICES.txt` を生成(prebuild)、フッターからリンク |
| 14 | Low | 妥当 | 存在しない日付を UTC 構築の逆検証で拒否 |

残課題(次回レビューで確認): 実ブラウザでの 5 分動画ピークメモリ計測、ffmpeg exec のタイムアウト、複数タブ同時処理の E2E。
