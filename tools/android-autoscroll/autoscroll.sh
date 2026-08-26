#!/usr/bin/env bash
# AKB48 Mail 自動スクロール録画(Android / macOS・Linux 版)。使い方は autoscroll.ps1 と同じ。
#   ./autoscroll.sh [合計分=10] [ドラッグ秒=1.5] [待ち秒=2.5]
set -u
MINUTES=${1:-10}; DRAG=${2:-1.5}; WAIT=${3:-2.5}; RATIO=0.45; OUT=./recordings; ADB=${ADB:-adb}
[ "$MINUTES" -gt 180 ] && MINUTES=180
if ! $ADB devices | grep -q $'\tdevice$'; then echo "スマホが見つかりません。USB 接続と「USB デバッグ」の許可を確認してください。"; exit 1; fi
read W H < <($ADB shell wm size | grep -oE '[0-9]+x[0-9]+' | head -1 | tr x ' ')
X=$((W/2)); Y1=$(python3 -c "print(int($H*(0.5+$RATIO/2)))"); Y2=$(python3 -c "print(int($H*(0.5-$RATIO/2)))")
MS=$(python3 -c "print(int($DRAG*1000))")
echo "画面 ${W}x${H}: ($X,$Y1)→($X,$Y2) を ${DRAG}s でドラッグ、${WAIT}s 待機(合計 ${MINUTES} 分)。5 秒後に開始(中止は Ctrl+C)"; sleep 5
mkdir -p "$OUT"; STAMP=$(date +%Y%m%d-%H%M%S); END=$(( $(date +%s) + MINUTES*60 )); PART=0; FILES=()
cleanup() { echo "録画を止めて動画を取り込みます…"; $ADB shell pkill -l2 screenrecord >/dev/null 2>&1; sleep 3; for f in "${FILES[@]}"; do $ADB pull "$f" "$OUT" >/dev/null 2>&1; $ADB shell rm -f "$f" >/dev/null 2>&1; done; ls -la "$OUT" | grep "akbmail_${STAMP}"; echo "この動画を https://akbmail-rescue.github.io/ に投入してください"; }
trap cleanup EXIT INT TERM
while [ "$(date +%s)" -lt "$END" ]; do
  PART=$((PART+1)); REMOTE=$(printf '/sdcard/akbmail_%s_%03d.mp4' "$STAMP" "$PART"); FILES+=("$REMOTE")
  SEG=$(( END - $(date +%s) )); [ "$SEG" -gt 170 ] && SEG=170; [ "$SEG" -lt 10 ] && break
  $ADB shell screenrecord --time-limit "$SEG" --bit-rate 12000000 "$REMOTE" & RECPID=$!
  echo "録画 $PART 開始 (${SEG}s): $REMOTE"; SEGEND=$(( $(date +%s) + SEG - 1 ))
  while [ "$(date +%s)" -lt "$SEGEND" ]; do $ADB shell input swipe "$X" "$Y1" "$X" "$Y2" "$MS" >/dev/null 2>&1; sleep "$WAIT"; done
  wait $RECPID 2>/dev/null; sleep 2
done
