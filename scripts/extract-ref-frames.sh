#!/usr/bin/env bash
# reference/rescue.py と同じ条件(ffmpeg fps=6, PNG)でフレームを抽出し、
# tests/regression のパリティテスト用フィクスチャを作る。ローカル処理のみ。
set -euo pipefail
cd "$(dirname "$0")/.."
extract() {
  local src=$1 out=$2
  rm -rf "$out" && mkdir -p "$out"
  ffmpeg -v error -i "$src" -vf fps=6 "$out/f_%05d.png"
  echo "extracted: $(ls "$out" | wc -l) frames  $src -> $out"
}
extract reference/sample_31s.mp4 tests/fixtures/frames
extract reference/sample_scroll_24s.mp4 tests/fixtures/frames_scroll
# Python 基準(分類・pHash・代表選定)の再生成。venv に pillow imagehash numpy scipy が必要
if [ -n "${PY:-}" ]; then
  "$PY" scripts/ref_classify.py tests/fixtures/frames tests/fixtures/sample_31s.ref_frames.json > /dev/null
  "$PY" scripts/ref_classify.py tests/fixtures/frames_scroll tests/fixtures/sample_scroll_24s.ref_frames.json > /dev/null
  "$PY" scripts/ref_select.py tests/fixtures/frames tests/fixtures/sample_31s.ref_select.json
  "$PY" scripts/ref_select.py tests/fixtures/frames_scroll tests/fixtures/sample_scroll_24s.ref_select.json
else
  echo "(PY=<venv python> を指定すると Python 基準 JSON も再生成します)"
fi
