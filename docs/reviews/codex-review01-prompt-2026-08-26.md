# Codex レビュー依頼 R1 — AKB48 Mail レスキューツール(2026-08-26)

## 依頼

添付の 3 パケット(同じフォルダにある `akbmail-review-r1-CODE-20260826.md` / `-TESTS-` / `-DOCS-`)を読み、
**敵対的な立場で**問題点を挙げてください。称賛は不要です。指摘は「重大度 / 該当箇所(ファイル:行または関数名)/ 何が起きるか / 直し方」の形式で。

## プロジェクト概要

AKB48 Mail アプリ版のサービス終了に伴い、ファンが自分の画面収録動画からメール本文を PNG として保存するブラウザ内完結ツール(Vite + React + TS)。
公開: https://akbmail-rescue.github.io/(GitHub Pages、GPL-3.0)。`DOCS` パケットの `CLAUDE.md`(不変条件 INV-1〜7)と `docs/requirements.md`(§2 法的前提)が最優先の制約。

## 特に見てほしい点(優先順)

1. **INV-1(非送信)の完全性**: 動画・フレーム・生成画像・OCR 結果・メタデータを外部に送る経路が 1 つも無いこと。fetch/XHR/WebSocket/beacon/Worker からの通信、`URL.createObjectURL` の扱い、サードパーティ(mp4box / ffmpeg.wasm / tesseract.js / JSZip)が独自に通信していないか(コアの読み込みは同一オリジンの静的ファイルのみ許可)。
2. **INV-2/3(メモリ)**: デコード済みフレームの保持数(上限 30)と、ピーク 1.5GB 以下。特に `src/core/decoder.ts` のバックプレッシャ、`src/core/select.ts` の候補保持、`src/core/stitchCanvas.ts` のタイル、`src/core/ffmpegExtract.ts` の WORKERFS と PNG チャンク、`src/core/stitch.ts` の Float64 スペクトル(1 フレーム約 30MB)。5 分動画(1800 フレーム)で破綻しないか。
3. **参照実装との一致**: `reference/rescue.py` / `stitch.py` と TS の差(分類閾値、pHash、代表選定・重複排除の順序、位相相関の丸め、偶数丸め、固定行推定など TS 独自の追加部分の妥当性)。
4. **堅牢性**: 想定外入力(MP4 でない、映像トラック無し、極端に短い/長い動画、解像度違い、Android 録画、モノクロ、途中で壊れたファイル)での挙動。例外がユーザーに見えるか(INV-7)。無限待ち・ハングの可能性(`decoder.feed` の待機、OCR の `Promise.race`、ffmpeg exec)。
5. **IndexedDB 復元**: 二重処理・キー衝突(同名ファイル)・容量超過時の失敗の扱い、`markInterrupted` の競合。
6. **ライセンス/配布**: GPL-3.0 と同梱物(ffmpeg.wasm GPL、tesseract Apache-2.0、mp4box BSD、JSZip)の整合、表記の不足。
7. **テストの穴**: `tests/` で守られていない重要経路(Worker、ffmpeg 経路、UI)と、回帰テストの skip 条件が誤って常に skip にならないか。
8. Android 自動録画スクリプト(`tools/android-autoscroll/`)の安全性(暴走・停止・ファイル回収)。

## 制約

- レビュー結果は内部利用のみ。パケットの内容を外部に転載しない。
- 修正コードの提案は差分または要点で十分。実装は依頼側で行う。
