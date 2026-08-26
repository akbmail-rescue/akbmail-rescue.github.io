#!/usr/bin/env bash
# 合成スクロール動画(reference/synth_gen.py 相当)を生成し、stitch.py の基準値と 6fps フレームを
# tests/fixtures/synth に置く(スティッチ回帰テスト用、INV-5)。
# 使い方: PY=<venv python(pillow, numpy, opencv-python-headless)> bash scripts/make-synth-fixtures.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PY:?PY=<venv python> を指定してください}"
ROOT=$(pwd)
WORK=$(mktemp -d)
"$PY" scripts/synth_gen_local.py "$WORK"
( cd "$WORK" && "$PY" "$ROOT/scripts/stitch_ref.py" synth/scroll.mp4 synth/stitched_154.png 154 && "$PY" "$ROOT/scripts/stitch_ref.py" synth/scroll.mp4 synth/stitched_153.png 153 )
rm -rf tests/fixtures/synth/frames && mkdir -p tests/fixtures/synth/frames
cp "$WORK"/stitch_work/t_*.png tests/fixtures/synth/frames/
cp "$WORK"/synth/ground_truth.png tests/fixtures/synth/
cp "$WORK"/synth/stitched_154.png.pairs.json tests/fixtures/synth/pairs_154.json
cp "$WORK"/synth/stitched_153.png.pairs.json tests/fixtures/synth/pairs_153.json
echo "synth fixtures -> tests/fixtures/synth ($(ls tests/fixtures/synth/frames | wc -l) frames)"
