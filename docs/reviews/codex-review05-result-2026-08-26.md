# Codex レビュー結果 R5 — AKB48 Mail レスキューツール

## 指摘

### 1. High — 全体上限時の「他区間の末尾退避」で、連続する失敗区間の8回試行は再び失われる

- 該当箇所: `src/core/ocrQueue.ts:90-128`, `tests/unit/ocrQueue.test.ts:41-53`
- 何が起きるか: 単一区間だけなら実行中1件＋待機7件で8回試行できます。しかしOCRが止まった状態で10区間が各8候補を生成すると、待機上限64を超えます。新しい区間の候補を入れるたび、待ちが多い既存区間の「末尾」、つまり時間的に最も新しくOCR品質が改善している可能性の高い候補を捨てます。合計容量上、10区間すべてへ8回分を残すことは不可能で、概ね各区間6〜7候補へ削られます。ヘッダーが無い区間だけでなく「先頭数フレームではヘッダーが安定しない区間」が連続すると、後半の良い候補を優先的に失ってunknown率が上がります。R4の「失敗区間の8回試行を保証」は、全体上限に達しない場合にしか閉じていません。
- 直し方: 仕様を「各区間最大8回、全体飽和時は最低N回」に変更してNを明記するか、8回保証が必須なら64件固定と両立しないことを認め、デコードbackpressureまたはIndexedDB等への退避を導入してください。捨てる場合も末尾固定ではなく、時系列を均等に残すreservoir sampling（例: 先頭・中間・末尾を保持）にし、最新候補を常に失わないようにします。テストはOCRを停止したまま10〜20区間を同期投入し、各区間の残存index分布と最低試行数を検証してください。

### 2. High — 復元のIndexedDB読込み中に次動画を開始でき、復元出力が新ジョブへ混入する

- 該当箇所: `src/App.tsx:274-310`, `src/App.tsx:391-405`
- 何が起きるか: `restoreJob()` は `busyRef` を立てず、`listOutputs()` の完了後にも対象job IDを再確認しません。復元ボタンを押した直後、読込み待ち中にファイル入力またはdropで動画を追加すると、キューeffectが `startFile()` を開始して新しい `jobRef` と画面を作ります。その後、古い `listOutputs(job.id)` が解決すると `setOutputs()` が復元結果で上書きし、処理中の新ジョブ画面・ZIPへ古いジョブの画像が混ざります。Worker応答のjobId判定では、このUI内の非Worker非同期競合は防げません。
- 直し方: `restoreBusy` または単一のUI operation generationを設け、復元中はenqueue/start/deleteを止めてください。少なくともawait後に `jobRef.current?.id === job.id` と復元generationを再確認し、不一致なら作成済みobject URLも含め結果を破棄します。`startFile()` 側で進行中の復元をinvalidateする方法でも構いません。

### 3. Medium — 旧Workerの遅延 `error` イベントだけはjobId判定を通らず、現在ジョブを失敗させられる

- 該当箇所: `src/App.tsx:132-151`
- 何が起きるか: 通常responseは `acceptsMessage()` で保護されましたが、DOMの `w.onerror` と `w.onmessageerror` にはjobIdがなく、無条件に現在の `jobRef` へ `fail()` を適用します。Worker再生成後に旧Workerから既にキュー済みのerror eventが配送されると、次動画または復元中ジョブをerrorへ更新し、`busyRef`を解除してさらにWorkerを再生成します。response世代判定だけでは旧Worker停止順序の穴を閉じられていません。
- 直し方: handler冒頭で `workerRef.current === w` を確認し、古いインスタンスのerror/messageerrorを無視してください。さらにWorker generationをeffect内で捕捉し、`fail(expectedGeneration, ...)` が現generationにだけ作用する形にします。

### 4. Medium — ffmpeg.wasmを同一Workerで2本続けて使うと、固定ディレクトリの再作成・残留状態に衝突する

- 該当箇所: `src/core/ffmpegExtract.ts:28-66`, `src/core/ffmpegExtract.ts:109-116`
- 何が起きるか: `FFmpeg` はmodule-levelの `cached` で再利用されますが、各呼出しで毎回 `/input` と `/out` を `createDir()` します。finallyで行うのは `/input` のunmountだけで、ディレクトリ自体と `/out` は削除しません。Emscripten FSでは既存ディレクトリへのmkdirがエラーになり得るため、同じpipeline Workerで2本目のHEVC/非対応codec動画を処理すると開始時に失敗します。異常終了時に `/out` の一部PNGが残った場合、次回の `listDir()` が前ジョブの画像まで列挙する危険もあります。
- 直し方: FFmpeg load時にディレクトリを一度だけ作るか、呼出しごとに一意なmount/outputパスを使い、finallyで出力ファイル、mount、ディレクトリを確実に除去してください。タイムアウトを含む異常終了後はcached instanceをterminateして `cached=null` にし、汚染状態を再利用しないでください。ffmpeg経路の動画2本連続と、1本目途中失敗後の2本目をE2Eに追加します。

### 5. Medium — 「初回表示後はオフラインでも動作」は実装上保証されない

- 該当箇所: `src/ui/RecordingGuide.tsx:67-72`, `src/core/ocr.ts`, `src/core/ffmpegExtract.ts`
- 何が起きるか: Service Workerや明示的なprecacheがありません。Tesseract worker/core/言語データとffmpeg core/wasmは、ページ初回表示時ではなく解析時に遅延ロードされます。初回表示直後にオフラインへ移行すると、ブラウザcacheへ未取得の資産があり、OCRまたは互換モードが失敗します。HTTP cacheも「一度ページを表示した」だけでは全静的資産のオフライン可用性を保証しません。
- 直し方: 文言を「処理開始後に必要資産の読込みが完了すれば、その処理中は外部送信しない」等へ狭めるか、Service Workerで全必須資産をprecacheし、オフライン再読込みE2Eを追加してください。INV-1の非送信とは別の保証として扱うべきです。

## R4是正の判定

- 単一区間の8候補保持と、切り出し前 `canAccept()`: 閉じています。最初の候補も受理されます。
- 多数区間の公平性: 各区間へ最低1候補を残す性質は改善していますが、連続失敗区間での8回保証と候補品質は閉じていません（指摘1）。
- Worker responseのjobIdエコー: `output`/`done`/`error`を含む通常messageには有効です。active jobがnullなら拒否されるため、削除直後の通常responseも副作用を起こしません。
- Worker error/messageerror: 現Workerでは致命遷移に統一されましたが、旧Workerインスタンス判定がありません（指摘3）。
- 中止直後の次動画: 通常messageはjobIdで隔離され、E2Eも追加されています。ただしテストは実際の旧イベント混入を強制注入していません。
- canvas解放: 中間canvasの0サイズ化と事前判定は閉じています。

## INV-1 / INV-2 / INV-3

- INV-1: 実行時の自動外部送信経路は確認できません。ガイドのGitHubリンクはユーザー操作による遷移であり、自動送信ではありません。
- INV-2: decoded frame/ImageBitmapの既存上限を今回の変更が超える経路は確認できません。OCRのgray配列はこの「枚数」制約とは別管理で妥当です。
- INV-3: stitch tile 128MB、OCR候補約32MBなど個別上限はありますが、FFTのFloat64/complex buffer、canvas backing store、Tesseract、ffmpeg WASM memory、Blob/IndexedDB書込み中コピーを合算したピークはコード上の加算だけでは証明できません。

### 5分動画の最小・再現可能なメモリ測定案

1. 合成5分動画を固定seed・固定解像度・固定フレーム内容で生成し、WebCodecs経路用とffmpeg経路用を1本ずつCI artifactにする。スティッチが128MB近くまで伸び、OCR64候補、PNG分割、IndexedDB保存を通る内容にする。
2. Vite previewへ `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` をテスト時だけ付与し、Chromiumで `crossOriginIsolated` を成立させる。
3. Playwrightから解析中に `performance.measureUserAgentSpecificMemory()` を2〜5秒間隔で取得する。これはpageとdedicated workerを含むUA推定値を得るため、`performance.memory.usedJSHeapSize`だけよりcanvas/workerを捉えやすい。開始前baseline、解析中peak、完了後値をJSON artifactへ保存する。
4. 補助指標としてLinux CIではChromium親子processのRSS合計を `/proc/<pid>/status` から1秒間隔で採取する。絶対値判定はまずRSS合計 `<1.5GB`、回帰判定はbaseline差と過去基準値の双方を使う。ffmpegはWASM memoryのためRSS側を必須にする。
5. GC時刻によるぶれを抑えるため同一runnerで3回実行し最大値を採用する。失敗時は時系列JSON、処理段階ログ、動画seedをartifact化する。CI runner差が大きければ1.5GBのhard gateは専用Windows/Chrome手元測定に置き、CIは基準比（例: +15%）をgateにする。

## 既存依存だけで行うWorker注入テスト案

React Testing Libraryは不要です。既存のPlaywrightで `page.addInitScript()` を `page.goto()` より前に実行し、`window.Worker`をテスト用FakeWorkerへ差し替えるのが最小です。FakeWorkerは `postMessage({type:'analyze', jobId})` を記録し、テスト側から任意jobIdの `output`/`done`/`error`、さらに旧インスタンスの `ErrorEvent`/`messageerror` を任意順で発火できるようにします。DOMは既存のlocatorで確認できます。

最低限のシナリオ:

1. job A開始→cancel→job B開始→旧Aのoutput/done/errorを注入し、Bの表示・DB status・出力数が不変。
2. job A完了→restore Aの `listOutputs` を遅延→job B開始→restore解決でBへ混入しない。
3. 現Workerのmessageerrorでは現在jobだけがerror、旧Workerのmessageerrorでは何も変わらない。
4. cancel→新Worker生成が確認される前にはBのanalyzeが送られない。

より高速な単体試験にするなら、Appの状態遷移を `jobId/generation/event -> effects` の純粋reducerへ抽出しVitestで全イベント順列を検証し、Playwrightは代表的な2ケースだけにします。

## 未レビュー領域の確認結果

- `stitchCanvas.ts`: source/destination矩形の `drawImage()` 座標は、固定headerのskipと末尾addRowsの意味に一致しています。新たな描画位置ずれは特定しませんでした。タイル確保は1024行単位なので128MBを最大1タイル未満超過し得ますが、通常1290px幅では約5MB以内です。厳密な128MB保証が必要なら最終タイルだけ残行数で確保してください。
- `demux.ts`: mp4boxへのchunk供給、Promiseによる次chunkのbackpressure、`releaseUsedSamples()`の位置に明白な破綻は確認できませんでした。破損box、64bit size、moov末尾の実ファイルvariationはテストが薄いためfuzz/fixture拡充余地があります。
- `ffmpegExtract.ts`: WORKERFSの入力丸ごとcopy回避は妥当ですが、再利用時のFS lifecycleに指摘4があります。
- `RecordingGuide.tsx`: 非送信の説明は一致しますが、オフライン保証に指摘5があります。また「動画の大きさに上限はありません」はブラウザ、mp4boxのoffset精度、保存quota、5分推奨と整合せず、「明示的なファイルサイズ上限は設けていません」程度へ弱める方が正確です。

## 検証

- TypeScript: `tsc --noEmit` PASS。
- Vitest/Vite build: ローカル `node_modules` にRolldownのWindows native optional dependencyとWASM fallbackが欠落しているため起動不能。
- ワークツリーの既存未コミット変更には触れず、本結果ファイルだけを新規作成しました。
