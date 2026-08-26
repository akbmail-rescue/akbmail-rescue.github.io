# Codex レビュー結果 R4 — AKB48 Mail レスキューツール

## 指摘

### 1. High — 実パイプラインでは失敗区間の8回試行が保証されず、最大4回で候補が尽きる

- 該当箇所: `src/core/ocrQueue.ts:84-95`, `src/worker/pipeline.worker.ts:69-80`, `tests/unit/ocrQueue.test.ts:41-55`
- 何が起きるか: `maxWaitingPerSeg=3` なので、OCR実行中の1件と待機3件を受け付けた時点で、その区間の後続detailフレームは破棄されます。OCRは直列かつ重いため、デコードが区間を通過するまでに最初の認識が終わらなければ、区間終了後には補充元のフレームがありません。その区間は `maxAttemptsPerSeg=8` でも実際には4回しか試せません。追加テストは各 `offer()` の間でOCRを進めて補充しており、「実際のパイプラインと同じ」というコメントと異なります。40区間テストも各区間1回以上しか要求せず、この欠落を検出しません。
- 直し方: 区間が閉じるまでは最大8候補を軽量配列で保持する、または区間終了時に未試行候補を永続/圧縮バッファへ確定してからOCRへ渡してください。メモリを32MBに固定する必要があるなら、全区間公平性と同時に各区間の試行数を保証できる二段階キューやデコード側backpressureが必要です。テストには「全フレームを同期投入して区間を閉じ、その後OCRを解放する」ケースを追加し、失敗区間の期待試行数を明示してください。

### 2. High — Workerメッセージにジョブ世代がなく、旧Workerの遅延イベントを新ジョブへ帰属できる

- 該当箇所: `src/worker/messages.ts:25`, `src/worker/pipeline.worker.ts:255-262`, `src/App.tsx:131-211`, `src/App.tsx:238-280`
- 何が起きるか: request/responseに `jobId` またはgeneration tokenがありません。ハンドラは受信時点の `jobRef.current` を使って `output` の保存先を決め、`done`/`error` も現在ジョブへ `persistJob()` します。cancel/fatal errorで `workerGen` を更新しても、terminate前にメインスレッドへ配送済みだった旧Workerイベントは識別できません。次ジョブ開始後に旧 `output` が届けば新ジョブのIndexedDB配下へ保存され、旧 `done`/`error` が届けば新ジョブのstatusを完了/エラーへ変更し、`busyRef`も解除します。
- 直し方: `analyze` requestに不変の `jobId` とgeneration tokenを含め、全responseでエコーバックしてください。App側では、そのtokenが現在のactive jobと一致しないメッセージを、副作用を起こす前に破棄します。Workerインスタンスを作るeffect内のローカルgeneration比較だけでも最低限の防御になりますが、保存キーまで含めてjob IDをメッセージ自身から取得する方が堅牢です。

### 3. Medium — `messageerror` は致命エラー扱いされず、処理が10分間ぶら下がる

- 該当箇所: `src/App.tsx:135-145`
- 何が起きるか: `onerror` とWorkerからの `type:'error'` は `fail()` を通りWorkerを再生成しますが、`onmessageerror` はログを1行追加するだけです。メッセージのデシリアライズに失敗した場合、当該 `output`/`done` は失われても `busyRef` とDB statusはrunningのままです。後続キューは進まず、UIの10分無応答自動中止まで待たされます。
- 直し方: `onmessageerror` も `fail()` に統一し、現在ジョブをerrorへ確定してWorkerを再生成してください。第2項の世代検証と組み合わせ、旧Worker由来のerrorは現在ジョブを変更しないようにします。

### 4. Medium — OCRキューの受入判定前に高コストの切り出しを行い、拒否フレームでもcanvas/RGBAを大量生成する

- 該当箇所: `src/worker/pipeline.worker.ts:69-79`, `src/core/frameGray.ts:46-80`, `src/core/ocrQueue.ts:84-104`
- 何が起きるか: `minSpacing`、区間待ち上限、全体上限の判定は `offer()` 内ですが、呼出側はその前にtimestamp/sender双方の `cropGrayUpscaledArray()` を完了しています。この関数は元cropのRGBA `ImageData`、small canvas、2倍canvas、そのRGBA読出し、gray配列を作ります。待ち3件で飽和した失敗区間の後続detailフレームでも毎回これらを生成します。保持キューは約32MBに制限されても、長尺動画でGC待ちのcanvas/native backing storeと一時配列が膨らみ、INV-3のメモリ上限を保証できません。
- 直し方: `canOffer(seg,index)` のような画像生成前の予約APIを設け、spacing/区間上限/全体上限を通った場合だけcropしてください。予約後の生成失敗を取り消すAPIも必要です。少なくともsmall/big canvasを明示的に0サイズ化し、拒否が続く長尺入力でJS heapとcanvas backing memoryのピークを計測してください。

### 5. Medium — 新しい状態遷移と世代交代を検証するUIテストがない

- 該当箇所: `tests/unit/ocrQueue.test.ts`, `tests/unit/store.test.ts`, `scripts/e2e-headless.mjs`, `scripts/e2e-resume.mjs`
- 何が起きるか: OCR単体テストはキュー内部の通常動作を確認しますが、区間終了後に補充不能となる実際のproducer/consumer速度差を固定していません。Workerの旧 `output`/`done` 混入、`onmessageerror`、cancel直後の次ジョブ、fatal error直後の次ジョブ、非同期DB更新の順序を検証するAppテストもありません。現在最も危険な未網羅箇所は「旧Workerイベントが新ジョブのoutput/statusを変更しないこと」です。
- 直し方: Workerを注入可能にして世代A/Bを手動制御し、Aをcancel後にAの `output`/`done`/`error` を発火してもBとDBが不変であることをテストしてください。加えて、全候補投入後にOCRを解放する区間テスト、messageerror後の再生成、cancel/error/complete各経路でUI・`busyRef`・DB statusが一致する統合テストを追加してください。

## 重点項目の判定

- R3 OCR公平性: 40区間へ最低1回の機会を与える点は改善しましたが、失敗区間の8回試行は閉じていません。`minSpacing` の最初の候補は `lastIndex=-Infinity` のため弾かれません。
- R3 OCRエラー継続: 単発エラー後の継続は実装されています。正常なrecognize完了で連続エラー数もリセットされます。
- Worker再生成: 異常Workerの使い回しは改善しましたが、世代識別がないため遅延メッセージ混入は未解決です。`messageerror` 経路も未統一です。
- INV-1: 変更された実行時経路に外部送信は確認できません。同一オリジンのTesseract/ffmpeg/notice資産を使う構造も維持されています。
- INV-2: グレー配列とOCR canvasはdecoded `VideoFrame`/`ImageBitmap` ではないため30枚制約の対象外とする整理は妥当です。既存 `FRAME_BUDGET` はencoded chunkやグレー保持も名称上混在しており厳密な実保持数ではありませんが、変更によるdecoded frame超過は確認できません。
- INV-3: 定常保持されるOCR候補は約32MBに制限されました。一方、第4項の拒否前allocationとcanvas native memoryが未計測なので、長時間入力で1.5GB未満という不変条件はまだ実証されていません。
- 中止/エラー/復元: 通常のcancel、Workerからのerror、doneではDB更新対象は呼出時のjob IDに概ね固定されます。しかしメッセージ自体がジョブに紐付かないため、世代境界ではUI・`busyRef`・DB statusの一貫性を保証できません。
- IndexedDB: R3で変更されたstale閾値5分は誤中断確率を下げますが、生存確認方式そのものは変わっていません。今回の差分から新たなtransaction競合は確認できません。

## 検証

- TypeScript: `tsc --noEmit` PASS。
- Vitest: 起動不能。ローカル `node_modules` にRolldownのWindows native optional dependencyがなく、さらにWASM fallback (`@rolldown/binding-wasm32-wasi`) も欠落しているためです。
- Vite build: 同じRolldown binding依存のため未実行です。
- ワークツリーにはレビュー開始前から別ファイルの未コミット変更があり、本レビューでは変更していません。本ファイルだけを新規作成しました。
