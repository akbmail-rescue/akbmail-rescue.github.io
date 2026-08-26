# Codex レビュー結果 R6 — AKB48 Mail レスキューツール

## 指摘

### 1. High — 「飽和時でも各区間最低4回」の要件を、区間数が多い入力では満たせない

- 該当箇所: `src/core/ocrQueue.ts:94-138`, `docs/requirements.md:98`, `tests/unit/ocrQueue.test.ts:115-136`
- 何が起きるか: 全体の待機上限は64件なので、各区間へ待ち3件を保証できるのは最大21区間程度です。自区間の待ちが3未満なら他区間を待ち1まで削る規則により、20区間テストでは各区間3件を維持できますが、60区間テストでは期待値自体が「最低1件」に下がっています。さらに、実行中なのは全体で1件だけなので、待ち1件しかない大半の区間は合計1回しか試行できず、コメントと要件に書かれた「実行中1＋待ち3＝最低4回」にはなりません。65区間以上がOCRより先行すると、全区間が待ち1件の状態で退避元がなくなり、新区間の最初の候補も拒否されます。
- 直し方: 64件固定のままなら、保証を条件付きで正確に定義してください（例: 同時未処理区間が21以下なら最低3候補、64以下なら最低1候補、それ以上は保証なし）。入力数に依存せず最低4回を保証するなら、OCR側のbackpressure、区間ごとの候補のIndexedDB退避、または全体上限の動的拡張が必要です。テストは64・65・100区間を含め、`attempts`まで完走させて要件値を検証してください。

### 2. Medium — ffmpegの後始末に失敗しても成功扱いのcached instanceを保持し、FS残骸を蓄積する

- 該当箇所: `src/core/ffmpegExtract.ts:122-136`
- 何が起きるか: 抽出ループを完了した時点で `ok=true` になります。その後 `listDir(OUT)`、個別delete、`deleteDir(OUT)`、`unmount(MOUNT)`、`deleteDir(MOUNT)`はすべて失敗を握りつぶします。したがってlistDirやunmountが失敗して残骸が残っても `discardCached()` は呼ばれません。一意pathにより直後の名前衝突は避けられますが、同じWASM FS内にWORKERFS mount、File参照、PNG、ディレクトリがジョブごとに残り、長時間・複数動画でメモリを回収できません。INV-3にも影響します。
- 直し方: 処理成功とcleanup成功を別々に追跡し、cleanupの必須操作が1つでも失敗したらcached instanceを破棄してください。特にunmount失敗は入力File参照を保持し得るためfatal cleanup failureとします。`listDir`失敗時は中身を確認できないので、その時点でinstance破棄が安全です。cleanup失敗内容はログへ残してください。

### 3. Medium — HEVC 2本連続E2Eは、2本目を待たず旧「完了」状態で成功できる

- 該当箇所: `scripts/e2e-two.mjs:8-15`
- 何が起きるか: 1本目の終了後、statusは「完了」です。2周目で `setInputFiles()` した直後に `waitForFunction(() => ['完了','エラー'].includes(status))` を実行すると、Reactがキューを取り込み「読み込み中」へ遷移する前の旧「完了」を見て即座に通過できます。その後のpath・outputs・jobsも1本目の値を読めるため、2本目のffmpeg FS lifecycleを一度も通さずE2Eが成功します。
- 直し方: 各投入前に履歴件数またはjob IDを保存し、まずstatusが「読み込み中/解析中」へ変わる、またはcurrentJob IDが変わることを待ってから、その新jobの終端を待ってください。最後に履歴が2件で両方done、ログに `DONE path=ffmpeg.wasm` がjobごとに1件、2本目固有の出力が存在することを検証します。

### 4. Medium — 復元読込み失敗時、空の結果を「完了」と表示したまま残す

- 該当箇所: `src/App.tsx:315-340`
- 何が起きるか: `restoreJob()` はIndexedDBの `listOutputs()` より先に画面をresetし、`jobRef/currentJob/summary/status`を復元対象へ切り替えます。`listOutputs()` がquota、transaction、DB close等で失敗するとcatchはログを追加するだけで、statusは「完了」または「中断(処理済み分を復元)」、currentJobも対象ジョブ、outputsは空のままです。利用者には「出力0件の復元に成功した」のか「DB読込みに失敗した」のか状態欄で区別できず、復元操作の状態一貫性が崩れます。
- 直し方: 出力を先に一時変数へ読み込み、世代確認後に画面状態を一括commitしてください。失敗時は直前の表示を維持するか、明示的な「復元エラー」statusにし、currentJobを切り替えないでください。復元中表示もstatusへ明示すると状態表を単純化できます。

## R5是正の境界判定

- OCR `canAccept()` / `offer()`: 同一JavaScript call stack内で切り出しとofferが連続する現在の呼出し方では整合しています。自区間がちょうど3の場合は他区間を1まで削る特例へ入らず、他区間に3超がなければ拒否されます。実行中候補は `attempts` に含まれ、`queuedTotal`には含まれません。ただし「各区間最低4回」という説明は多数区間で成立しません（指摘1）。
- 復元ガード: 通常UIではrunning中の復元・削除ボタンはdisabledで、関数側も復元は `busyRef` を確認します。復元中の投入・開始・削除もguardされ、await後の世代確認もあります。通常Worker messageはjobId、旧Worker DOM eventはinstance同一性で隔離されています。新たに確認した抜けはDB読込み失敗時の表示状態です（指摘4）。
- Worker停止順序: cleanupでrefをnullにしてからterminateし、新Worker effectがrefを設定してから後段のqueue effectが動く構造です。通常の中止→次動画に明白な混入経路は確認できませんでした。
- ffmpeg一意path: `callSeq`はWorker lifetime内で単調増加し、現実的な実行回数で衝突しません。UIが1本ずつ送るため通常の並行extractもありません。後始末失敗時のinstance保持だけが残ります（指摘2）。
- stitch最終タイル: 末尾タイルを残行数だけ確保する変更は描画ループと整合しています。

## App.tsx 状態組み合わせ表

| 状態 | busyRef | status | restoring | queue | Worker | 判定 |
|---|---:|---|---:|---:|---|---|
| 待機 | false | 待機中/完了/中断/エラー | false | 0 | idle current | 整合 |
| キュー待ち | false | 終端状態 | false | 1以上 | idle current | effectが次を開始 |
| 開始直後 | true | 読み込み中 | false | 任意 | currentへanalyze送信 | 整合 |
| 解析中 | true | 解析中 | false | 任意 | active | 整合 |
| 正常完了 | false | 完了 | false | 任意 | idle current | DB done更新後、次キューへ |
| Workerエラー | false | エラー | false | 任意 | generation更新中 | instance guard後、再生成して次へ |
| 手動/自動中止 | false | 中断 | false | 任意 | generation更新中 |旧messageはjobId/instanceで拒否 |
| 復元中 | false | 対象jobの終端表示 | true | 原則0 | idle current | 操作guardは有効。ただし失敗時表示が不整合 |
| 復元完了 | false | 対象jobの終端表示 | false | 0 | idle current | 整合 |
| 復元失敗 | false | 完了/中断等のまま | false | 0 | idle current | **不整合（指摘4）** |

`busyRef=true`かつ`restoring=true`となる通常UI経路、または`busyRef=false`かつstatusが読み込み中/解析中の安定状態は確認できませんでした。setState反映までの短い過渡状態はありますが、イベントhandler側のref guardにより通常操作は抑制されます。

## 収束判定

**未収束です。** 記録済み残課題3件（メモリ計測CI、Fake Worker注入テスト、Service Worker事前キャッシュ）以外に、上記4件を確認しました。特に指摘1は要件と実装・テストの保証値が一致しておらず、指摘3によりffmpeg後始末のE2E根拠も現時点では成立しません。

## 記録済み残課題3件の扱い

- 5分動画のメモリ計測CI: 未実装。INV-3は引き続き実測未証明。
- `addInitScript`によるFake Worker注入テスト: 未実装。世代ガードは静的確認のみ。
- Service Worker事前キャッシュ: 未実装。要件注記とガイド文言は現状実装に合わせて修正されています。

## 検証

- TypeScript: `tsc --noEmit` PASS。
- Vitest/Vite build: ローカル `node_modules` のRolldown Windows native optional dependencyおよびWASM fallback欠落により起動不能。
- 既存の未コミット変更には触れず、本結果ファイルだけを新規作成しました。
