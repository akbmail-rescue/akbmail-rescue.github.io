# CLAUDE.md — AKB48 Mail レスキューツール

ブラウザ内完結でスクリーン録画動画をメール単位の画像に分割・スティッチする Web ツール。
要件は `docs/requirements.md` を必ず先に読むこと。

## 技術スタック

- Vite + React + TypeScript(SPA、静的ホスティング前提)
- フレーム抽出: WebCodecs API(第一候補)/ ffmpeg.wasm(フォールバック)
- 画像処理: OpenCV.js または自前実装(位相相関は F-4 の注意事項参照)
- OCR: Tesseract.js(jpn+eng)
- 永続化: IndexedDB(処理済み結果のみ)/ ZIP 生成: JSZip
- テスト: Vitest + 合成動画による回帰テスト

## 参照実装(アルゴリズムの正)

- `reference/rescue.py` — フレーム分類・セグメンテーション・重複排除。閾値はここが正。Python 基準 JSON は `scripts/ref_classify.py` / `scripts/ref_select.py` で再生成(`PY=<venv python> npm run fixtures:frames`)
- `reference/stitch.py` — 位相相関スティッチ。棄却条件(resp<0.7, |dx|>12, dy<2)はここが正(resp は 2026-08-26 に 0.05→0.7、合成+実録画で検証済み)
- `reference/synth_gen.py` — 検証用合成動画の生成ロジック。JS 版テストに移植する

移植で数値挙動を変えたくなったら、まず Python 版で変更を検証してから両方を更新する。

## 不変条件(INV)— 違反するコードを書いてはならない

- **INV-1 非送信**: 動画・フレーム・生成画像・OCR結果を外部へ送信する fetch/XHR/WebSocket/beacon を書かない。フォント・wasm 等の静的アセットの取得のみ許可。全アセットはセルフホストし、CDN 直リンクを避ける(オフライン動作 NF-5 のため)
- **INV-2 チャンク処理**: 動画をフルデコードしてフレーム配列に保持しない。常にストリーミング/ウィンドウ処理とし、保持フレームは最大 30 枚
- **INV-3 メモリ上限**: ピーク 1.5GB 以下。キャンバスの成長は ImageBitmap/OffscreenCanvas でタイル管理し、巨大 Uint8Array の再確保連打をしない
- **INV-4 相対座標**: 画面判定・OCR 領域はすべて解像度比(0.0–1.0)で持つ。ピクセル絶対値のハードコード禁止
- **INV-5 回帰テスト**: 分類閾値・棄却条件・fps を変更する PR は、合成回帰テスト(高さ誤差 ≤1%、バンド一致 ≥7/8)と実録画基準(7通+2枚)の両方を通過すること
- **INV-6 UI 文言**: 「本ツールはご自身の端末内でのみ動作し、動画をどこにもアップロードしません」を初回画面に明示。法的前提(要件定義書 §2)に反する機能(共有・クラウド保存)を追加しない
- **INV-7 失敗の可視化**: 分類不能フレームや OCR 失敗は黙って捨てず、`unknown` として出力に含めてユーザーに判断させる

## 開発コマンド

```bash
npm run dev        # 開発サーバー
npm run test       # 単体+回帰テスト
npm run test:regression  # 合成動画スティッチ回帰のみ
npm run build      # 静的ビルド(dist/)
```

## 実装順序(スライス)

1. **S-1**: 動画→フレーム抽出(WebCodecs)+フレーム分類のポート。実録画 31 秒サンプルで 7 セグメント検出を確認。**完了(2026-08-26)**。HEVC を WebCodecs で復号できない環境(Windows Chrome で実確認)向けの ffmpeg.wasm フォールバックは S-5 から前倒しして S-1 に含めた(`src/core/ffmpegExtract.ts`、WORKERFS マウント+3 秒チャンク)
2. **S-2**: セグメンテーション+代表フレーム選定+重複排除。PNG 出力まで。**完了(2026-08-26)**。pHash は `src/core/resample.ts`(Pillow 互換リサンプル)+`src/core/phash.ts` で imagehash.phash とビット一致(331 フレームで検証)。選定は `src/core/select.ts`(ストリーミング、保持画像 ≤ 候補 2 枚+保留 image)。ファイル名は暫定 `mail_NN_segS_tT.png`(OCR 名は S-4)
3. **S-3**: 位相相関スティッチのポート+合成回帰テスト整備。**完了(2026-08-26)**。`fft.ts`(Stockham 混合基数)+`phaseCorrelate.ts`(cv2 移植。窓は √(wr·wc) — OpenCV は createHanningWindow の末尾で sqrt を掛ける)+`stitch.ts`(stitch.py+固定ヘッダー自動推定)+`stitchCanvas.ts`(タイル管理)。合成回帰: cv2 と 35 対一致・高さ 4736 一致・0.055 版 8/8。実録画では区間ごとに detail フレームをスティッチし、採用があれば代表フレームの代わりに出力
4. **S-4**: OCR メタデータ+プレビュー UI+ZIP 出力。**完了(2026-08-26)**。`src/core/ocr.ts`(tesseract.js、worker/core/tessdata は `scripts/copy-tesseract-assets.sh` で public/ にセルフホスト。jpn は標準 tessdata — fast 版では「渋」が読めない)。区間ごとに detail フレームを順に試し、日時が取れたら停止(上限 8 回)。31 秒版の出力名は基準 zip と完全一致。UI: 除外チェック・日時手入力・JSZip で ZIP(PNG+metadata.json)
5. **S-5**: IndexedDB 中断復帰、性能チューニング、録画ガイドページ。**完了(2026-08-26)**。性能: 半スペクトル(Hermitian)+実数ペア詰め FFT で 0.96→0.36 秒/フレーム(Node)、ブラウザ 0.47 秒(数値不変、cv2 パリティ維持)。画素完全一致フレームは FFT 省略。中断復帰: `src/core/store.ts`(IndexedDB: jobs/outputs、出力 PNG を届くたびに保存、起動時に running→interrupted)。本番 UI: `src/App.tsx` + `src/ui/`(録画ガイド §5、複数動画の順次処理、進捗/残り時間、履歴から復元・削除、除外・日時手入力、ZIP)。相関は 1/2 縮小+曖昧域 [0.55,0.85) は原寸再判定(Python で先に検証: 合成 8/8・実録画 38 対中 37 対一致、stitch.py にも同規則を反映)→ ブラウザ 0.23 秒/フレーム。未実施: Worker 並列・ウェイトリスト URL(§11、オーナーから受領後)

各スライス完了時に実録画サンプルでの結果画像を目視確認し、要件 §9 の精度目標に照らす。

## 既知の未検証リスク(実装時に前提にしない)

- 性能: 5 分動画(1800 フレーム)で約 7 分(負荷平均 5 の devcontainer 計測、1/2 縮小相関)。さらに必要なら WASM/SIMD 化
- 録画末尾のコントロールセンター等が detail と判定され unknown メールとして出ることがある(UI で除外可能、INV-7)

- iOS ラバーバンド(末端バウンス)の負方向変位 — 棄却条件で吸収できる想定だが実録画未確認
- 実アプリの固定ヘッダー高さの機種差 — S-3 で自動推定を実装(採用対の行差分から上端の不変行数を推定、応答 ≥0.8 の対のみ、最小値追跡)。iPhone 15 Pro Max 実測: ステータスバー 153px+戻るボタン行 195px。未解決: 送信者ヘッダーが本文と別速度で縮む(collapsing header)ため先頭付近に二重描画が残る/ページ切替アニメーション(応答 0.5〜0.6)が「巨大な dy」として採用され末尾に白帯が入る — 2026-08-26 オーナー承認で resp<0.7 棄却+new_part のみ継ぎ足しに変更し解消
- OCR: 差出人名は tesseract の jpn が文字間に空白を入れるため CJK 間の空白を詰めて保存(「渋井美奈」)。ヘッダーが映らない区間(スクロール途中から始まる/短い区間)は unknown → UI で手入力
- HEVC 録画のブラウザ別デコード可否 — Windows Chrome(GPU に HEVC 復号なし)で不可を実確認。ffmpeg.wasm へ自動フォールバック済み(約 6〜7 倍の実時間、24 秒動画で 160 秒)。`@ffmpeg/core` は GPL-2.0 ビルドのため配布ライセンス(MIT 予定)との整合はオーナー判断事項
