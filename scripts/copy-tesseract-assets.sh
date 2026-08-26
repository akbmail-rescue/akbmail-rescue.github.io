#!/usr/bin/env bash
# tesseract.js の worker / core を node_modules から public/ にコピーし、言語データを取得してセルフホストする(INV-1, NF-5)。
# 実行タイミング: npm install 後(postinstall)/ 手動。言語データは既にあればダウンロードしない。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/tesseract public/tesseract-core public/tessdata
cp node_modules/tesseract.js/dist/worker.min.js public/tesseract/
# tesseract.js はブラウザの WASM 機能(SIMD / relaxed SIMD)に応じてコアを選ぶので LSTM 版をすべて置く
cp node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js node_modules/tesseract.js-core/tesseract-core-lstm.wasm \
   node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm \
   node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm \
   public/tesseract-core/
# jpn は標準 tessdata(精度版、約 16MB gz)。tessdata_fast では「渋」などが認識できなかった(2026-08-26 実測)
# eng は数字のみ使うので tessdata_fast で十分
fetch() {
  local l=$1 repo=$2
  if [ ! -s "public/tessdata/$l.traineddata.gz" ]; then
    echo "downloading $l.traineddata ($repo)"
    curl -sL -o "public/tessdata/$l.traineddata" "https://github.com/tesseract-ocr/$repo/raw/main/$l.traineddata"
    gzip -9 "public/tessdata/$l.traineddata"
  fi
}
fetch jpn tessdata
fetch eng tessdata_fast
ls -la public/tesseract public/tesseract-core public/tessdata
