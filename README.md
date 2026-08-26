# AKB48 Mail レスキューツール

画面収録した動画から、AKB48 Mail のメール本文を 1 通ずつ PNG 画像として保存するブラウザ内完結の Web ツールです。
**動画・画像・文字情報を外部に送信するコードは含まれていません**(`CLAUDE.md` の INV-1)。

- 要件: `docs/requirements.md` / 開発方針: `CLAUDE.md`
- 参照実装(アルゴリズムの正): `reference/rescue.py`, `reference/stitch.py`, `reference/synth_gen.py`
- 実録画サンプル `reference/sample_31s.mp4` / `reference/sample_scroll_24s.mp4` と基準 zip は git に含めていません(オーナーから受領して `reference/` に置く)

## 開発

```bash
npm install            # postinstall で tesseract.js のアセットを public/ に配置(言語データは初回のみ取得)
npm run dev            # http://localhost:5173/
npm run test           # 単体+回帰テスト(フィクスチャが無い回帰テストは skip)
npm run build          # dist/(静的ホスティング用、約 70MB: ffmpeg.wasm / tesseract / 言語データ含む)
```

### 回帰テストのフィクスチャ(Python venv: pillow, imagehash, numpy, scipy, opencv-python-headless)

```bash
PY=/path/to/venv/bin/python npm run fixtures:frames      # 実録画 2 本の 6fps フレームと Python 基準
PY=/path/to/venv/bin/python bash scripts/make-synth-fixtures.sh   # 合成スクロール動画とスティッチ基準
```

### ブラウザ E2E(headless Chromium、playwright-core)

```bash
node scripts/e2e-headless.mjs http://localhost:5173/ <video.mp4> <log> [chrome-path] [outDir]
node scripts/e2e-resume.mjs   http://localhost:5173/ <video.mp4> [chrome-path]
```

## 配布

`vite.config.ts` の `base: './'` により、GitHub Pages / Cloudflare Pages などのサブパス配信でも動作します。
`.github/workflows/pages.yml` は GitHub Pages への配置例です(リポジトリ設定で Pages のソースを "GitHub Actions" にしてください)。

## ライセンスに関する注意

- 本体: MIT(予定)
- 同梱する `@ffmpeg/core`(ffmpeg.wasm)は GPL-2.0 ビルドです。配布形態とライセンス表記はオーナー判断事項(`CLAUDE.md` 参照)
- tesseract.js / tesseract.js-core: Apache-2.0、言語データ(tessdata): Apache-2.0
