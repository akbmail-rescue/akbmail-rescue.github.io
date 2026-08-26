#!/usr/bin/env bash
# AKB48 Mail 自動スクロール録画(Android / macOS・Linux 版)。使い方は autoscroll.ps1 と同じ。
#   ./autoscroll.sh [合計分=10] [ドラッグ秒=1.5] [待ち秒=2.5]      環境変数 SERIAL=<端末シリアル> で端末指定
# 端末上の録画は、取り込みが成功したことを確認できたものだけ削除する。
set -u
MINUTES=${1:-10}; DRAG=${2:-1.5}; WAIT=${3:-2.5}; RATIO=${RATIO:-0.45}; OUT=${OUT:-./recordings}; ADB=${ADB:-adb}; SERIAL=${SERIAL:-}
num() { python3 -c "import sys; v=float(sys.argv[1]); lo=float(sys.argv[2]); hi=float(sys.argv[3]); sys.exit(0 if lo<=v<=hi else 1)" "$1" "$2" "$3"; }
num "$MINUTES" 1 180 || { echo "合計分は 1〜180"; exit 1; }
num "$DRAG" 0.3 10 || { echo "ドラッグ秒は 0.3〜10"; exit 1; }
num "$WAIT" 0.5 30 || { echo "待ち秒は 0.5〜30"; exit 1; }
num "$RATIO" 0.1 0.8 || { echo "RATIO は 0.1〜0.8"; exit 1; }
mapfile -t DEVS < <($ADB devices | awk 'NR>1 && $2=="device"{print $1}')
[ "${#DEVS[@]}" -eq 0 ] && { echo "スマホが見つかりません。USB 接続と「USB デバッグ」の許可を確認してください。"; exit 1; }
if [ -z "$SERIAL" ]; then
  [ "${#DEVS[@]}" -gt 1 ] && { echo "端末が複数つながっています: ${DEVS[*]} / SERIAL=<シリアル> で指定してください"; exit 1; }
  SERIAL=${DEVS[0]}
fi
A() { "$ADB" -s "$SERIAL" "$@"; }
read -r W H < <(A shell wm size | grep -oE '[0-9]+x[0-9]+' | head -1 | tr x ' ')
[ -z "${W:-}" ] && { echo "画面サイズを取得できませんでした"; exit 1; }
X=$((W/2)); Y1=$(python3 -c "print(int($H*(0.5+$RATIO/2)))"); Y2=$(python3 -c "print(int($H*(0.5-$RATIO/2)))"); MS=$(python3 -c "print(int($DRAG*1000))")
echo "端末 $SERIAL 画面 ${W}x${H}: ($X,$Y1)→($X,$Y2) を ${DRAG}s でドラッグ、${WAIT}s 待機(合計 ${MINUTES} 分)。5 秒後に開始(中止は Ctrl+C)"; sleep 5
mkdir -p "$OUT"; STAMP=$(date +%Y%m%d-%H%M%S); END=$(python3 -c "import time; print(int(time.time()+$MINUTES*60))"); PART=0; FILES=(); RECPID=""
collect() {
  echo "録画を止めて動画を取り込みます…"
  [ -n "$RECPID" ] && kill "$RECPID" 2>/dev/null
  A shell pkill -l2 screenrecord >/dev/null 2>&1; sleep 3
  local kept=()
  for f in "${FILES[@]}"; do
    local name; name=$(basename "$f"); local tmp="$OUT/$name.part"; local final="$OUT/$name"
    local rsize; rsize=$(A shell stat -c %s "$f" 2>/dev/null | tr -d '\r')
    [[ "$rsize" =~ ^[0-9]+$ ]] || continue
    if A pull "$f" "$tmp" >/dev/null 2>&1 && [ -s "$tmp" ] && [ "$(stat -c %s "$tmp" 2>/dev/null || stat -f %z "$tmp")" = "$rsize" ]; then
      mv -f "$tmp" "$final"; A shell rm -f "$f" >/dev/null 2>&1; echo "  取り込み完了 $name"
    else
      rm -f "$tmp"; kept+=("$f"); echo "  取り込み失敗(端末上に残しました): $f"
    fi
  done
  echo "保存先: $OUT"
  if [ "${#kept[@]}" -gt 0 ]; then echo "取り込めなかった動画が端末に残っています。再取り込み:"; for f in "${kept[@]}"; do echo "  $ADB -s $SERIAL pull $f $OUT"; done; fi
  echo "この動画を https://akbmail-rescue.github.io/ に投入してください"
}
on_signal() { trap - EXIT INT TERM; collect; exit 130; }
trap on_signal INT TERM
trap collect EXIT
while [ "$(date +%s)" -lt "$END" ]; do
  PART=$((PART+1)); REMOTE=$(printf '/sdcard/akbmail_%s_%03d.mp4' "$STAMP" "$PART"); FILES+=("$REMOTE")
  SEG=$(( END - $(date +%s) )); [ "$SEG" -gt 170 ] && SEG=170; [ "$SEG" -lt 10 ] && break
  A shell screenrecord --time-limit "$SEG" --bit-rate 12000000 "$REMOTE" & RECPID=$!
  echo "録画 $PART 開始 (${SEG}s): $REMOTE"; SEGEND=$(( $(date +%s) + SEG - 1 ))
  while [ "$(date +%s)" -lt "$SEGEND" ]; do A shell input swipe "$X" "$Y1" "$X" "$Y2" "$MS" >/dev/null 2>&1; sleep "$WAIT"; done
  wait "$RECPID" 2>/dev/null; RECPID=""; sleep 2
done
