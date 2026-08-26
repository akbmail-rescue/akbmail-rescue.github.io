<#
AKB48 Mail 自動スクロール録画(Android / Windows PowerShell 版)
- スマホ(USB デバッグ有効)をパソコンにつなぎ、AKB48 Mail で最初のメールを開いてから実行する
- 「画面録画を開始 → ゆっくり上へドラッグ → 待つ」を自動でくり返し、動画をパソコンに保存する
- 端末の外にデータは送らない(adb はパソコンとスマホの間の通信だけ)

使い方(PowerShell):
  .\autoscroll.ps1                       # 既定: 合計 10 分、1 ドラッグ 1.5 秒、待ち 2.5 秒
  .\autoscroll.ps1 -Minutes 30           # 合計 30 分
  .\autoscroll.ps1 -DragSeconds 2 -WaitSeconds 3
途中でやめたいときは Ctrl+C(録画済みの動画はそのまま保存されます)
#>
param(
  [int]$Minutes = 10,          # 合計録画時間(分)。安全のため最大 180
  [double]$DragSeconds = 1.5,  # 1 回のドラッグにかける秒数(ゆっくり = 大きく)
  [double]$WaitSeconds = 2.5,  # ドラッグ後に静止する秒数(ページ切替の読み込み待ち。2 秒以上を推奨)
  [double]$DragRatio = 0.45,   # 1 回に動かす距離(画面の高さに対する割合)
  [string]$OutDir = ".\recordings",
  [string]$Adb = "adb"
)
$ErrorActionPreference = "Stop"
if ($Minutes -gt 180) { $Minutes = 180 }

function Adb { param([string[]]$a) & $Adb @a }

# 1) 接続確認
$devices = (& $Adb devices) -split "`n" | Where-Object { $_ -match "`tdevice$" }
if ($devices.Count -eq 0) {
  Write-Host "スマホが見つかりません。USB ケーブルの接続と「USB デバッグ」の許可(スマホ画面のダイアログで OK)を確認してください。"
  exit 1
}
# 2) 画面サイズ
$size = (& $Adb shell wm size) | Select-String -Pattern "(\d+)x(\d+)" | ForEach-Object { $_.Matches[0] }
$w = [int]$size.Groups[1].Value; $h = [int]$size.Groups[2].Value
$x = [int]($w / 2); $y1 = [int]($h * (0.5 + $DragRatio / 2)); $y2 = [int]($h * (0.5 - $DragRatio / 2))
Write-Host "画面 ${w}x${h}: ($x,$y1) → ($x,$y2) を $DragSeconds 秒かけてドラッグ、$WaitSeconds 秒待機をくり返します(合計 $Minutes 分)"
Write-Host "スマホで AKB48 Mail の最初のメールを開いた状態にしてください。5 秒後に開始します… (中止は Ctrl+C)"
Start-Sleep -Seconds 5

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$deadline = (Get-Date).AddMinutes($Minutes)
$part = 0
$files = @()
try {
  while ((Get-Date) -lt $deadline) {
    $part++
    $remote = "/sdcard/akbmail_${stamp}_$('{0:d3}' -f $part).mp4"
    $files += $remote
    # screenrecord は 1 ファイル最大 3 分。2 分 50 秒ごとに次のファイルへ切り替える
    $seg = [Math]::Min(170, [int](($deadline - (Get-Date)).TotalSeconds))
    if ($seg -lt 10) { break }
    $rec = Start-Process -FilePath $Adb -ArgumentList @("shell", "screenrecord", "--time-limit", "$seg", "--bit-rate", "12000000", $remote) -NoNewWindow -PassThru
    Write-Host "録画 $part 開始 ($seg 秒): $remote"
    $segEnd = (Get-Date).AddSeconds($seg - 1)
    while ((Get-Date) -lt $segEnd) {
      & $Adb shell input swipe $x $y1 $x $y2 ([int]($DragSeconds * 1000)) | Out-Null
      Start-Sleep -Seconds $WaitSeconds
    }
    $rec.WaitForExit()
    Start-Sleep -Seconds 2
  }
} finally {
  Write-Host "録画を止めて動画を取り込みます…"
  & $Adb shell pkill -l2 screenrecord 2>$null | Out-Null
  Start-Sleep -Seconds 3
  foreach ($f in $files) {
    & $Adb pull $f $OutDir 2>$null | Out-Null
    & $Adb shell rm -f $f 2>$null | Out-Null
  }
  Write-Host "保存先: $OutDir"
  Get-ChildItem $OutDir -Filter "akbmail_${stamp}_*.mp4" | ForEach-Object { Write-Host ("  {0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB)) }
  Write-Host "この動画を https://akbmail-rescue.github.io/ に投入してください(複数まとめて可)"
}
