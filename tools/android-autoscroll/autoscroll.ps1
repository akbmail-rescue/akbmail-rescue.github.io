<#
AKB48 Mail 自動スクロール録画(Android / Windows PowerShell 版)
- スマホ(USB デバッグ有効)をパソコンにつなぎ、AKB48 Mail で最初のメールを開いてから実行する
- 「画面録画を開始 → ゆっくり上へドラッグ → 待つ」を自動でくり返し、動画をパソコンに保存する
- 端末の外にデータは送らない(adb はパソコンとスマホの間の通信だけ)
- 端末上の録画は、パソコンへの取り込みが成功したことを確認できたものだけ削除する

使い方(PowerShell):
  .\autoscroll.ps1                       # 既定: 合計 10 分、1 ドラッグ 1.5 秒、待ち 2.5 秒
  .\autoscroll.ps1 -Minutes 30           # 合計 30 分
  .\autoscroll.ps1 -DragSeconds 2 -WaitSeconds 3
  .\autoscroll.ps1 -Serial XXXXXXXX      # 複数台つないでいるときは端末のシリアルを指定
途中でやめたいときは Ctrl+C(録画済みの動画はそのまま取り込まれます)
#>
param(
  [double]$Minutes = 10,       # 合計録画時間(分)。1〜180
  [double]$DragSeconds = 1.5,  # 1 回のドラッグにかける秒数(ゆっくり = 大きく)。0.3〜10
  [double]$WaitSeconds = 2.5,  # ドラッグ後に静止する秒数(ページ切替の読み込み待ち。2 秒以上を推奨)。0.5〜30
  [double]$DragRatio = 0.45,   # 1 回に動かす距離(画面の高さに対する割合)。0.1〜0.8
  [string]$OutDir = ".\recordings",
  [string]$Serial = "",        # 端末シリアル(adb devices の左列)。1 台だけなら省略可
  [string]$Adb = "adb"
)
$ErrorActionPreference = "Continue"

function Fail($msg) { Write-Host $msg; exit 1 }
if ($Minutes -lt 1 -or $Minutes -gt 180) { Fail "Minutes は 1〜180 の範囲で指定してください" }
if ($DragSeconds -lt 0.3 -or $DragSeconds -gt 10) { Fail "DragSeconds は 0.3〜10 の範囲で指定してください" }
if ($WaitSeconds -lt 0.5 -or $WaitSeconds -gt 30) { Fail "WaitSeconds は 0.5〜30 の範囲で指定してください" }
if ($DragRatio -lt 0.1 -or $DragRatio -gt 0.8) { Fail "DragRatio は 0.1〜0.8 の範囲で指定してください" }

# 1) 接続確認(ちょうど 1 台、または -Serial で指定)
$lines = (& $Adb devices) 2>$null
$devices = @($lines | Where-Object { $_ -match "^(\S+)\s+device$" } | ForEach-Object { $Matches[1] })
if ($devices.Count -eq 0) { Fail "スマホが見つかりません。USB ケーブルの接続と「USB デバッグ」の許可(スマホ画面のダイアログで OK)を確認してください。" }
if ($Serial -eq "") {
  if ($devices.Count -gt 1) { Fail ("端末が複数つながっています: " + ($devices -join ", ") + " / -Serial <シリアル> で 1 台を指定してください") }
  $Serial = $devices[0]
} elseif ($devices -notcontains $Serial) { Fail "指定したシリアル $Serial の端末が見つかりません: $($devices -join ', ')" }
function A { param([string[]]$a) & $Adb -s $Serial @a }

# 2) 画面サイズ
$sizeLine = (A shell wm size) | Select-String -Pattern "(\d+)x(\d+)" | Select-Object -First 1
if (-not $sizeLine) { Fail "画面サイズを取得できませんでした" }
$w = [int]$sizeLine.Matches[0].Groups[1].Value; $h = [int]$sizeLine.Matches[0].Groups[2].Value
$x = [int]($w / 2); $y1 = [int]($h * (0.5 + $DragRatio / 2)); $y2 = [int]($h * (0.5 - $DragRatio / 2))
Write-Host "端末 $Serial 画面 ${w}x${h}: ($x,$y1) → ($x,$y2) を $DragSeconds 秒かけてドラッグ、$WaitSeconds 秒待機をくり返します(合計 $Minutes 分)"
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
    $rec = Start-Process -FilePath $Adb -ArgumentList @("-s", $Serial, "shell", "screenrecord", "--time-limit", "$seg", "--bit-rate", "12000000", $remote) -NoNewWindow -PassThru
    Write-Host "録画 $part 開始 ($seg 秒): $remote"
    $segEnd = (Get-Date).AddSeconds($seg - 1)
    while ((Get-Date) -lt $segEnd) {
      A shell input swipe $x $y1 $x $y2 ([int]($DragSeconds * 1000)) | Out-Null
      Start-Sleep -Seconds $WaitSeconds
    }
    $rec.WaitForExit()
    Start-Sleep -Seconds 2
  }
} finally {
  Write-Host "録画を止めて動画を取り込みます…"
  A shell pkill -l2 screenrecord 2>$null | Out-Null
  Start-Sleep -Seconds 3
  $kept = @()
  foreach ($f in $files) {
    $name = Split-Path $f -Leaf
    $tmp = Join-Path $OutDir ("$name.part")
    $final = Join-Path $OutDir $name
    $remoteSize = (A shell stat -c %s $f 2>$null | Select-Object -First 1)
    if (-not $remoteSize -or $remoteSize -notmatch "^\d+$") { continue }   # 端末側に無い(録画されなかった)
    A pull $f $tmp 2>$null | Out-Null
    $ok = ($LASTEXITCODE -eq 0) -and (Test-Path $tmp) -and ((Get-Item $tmp).Length -gt 0) -and ((Get-Item $tmp).Length -eq [int64]$remoteSize)
    $moved = $false
    if ($ok) {
      try {
        Move-Item -Force -ErrorAction Stop $tmp $final
        $moved = (Test-Path $final) -and ((Get-Item $final).Length -eq [int64]$remoteSize)
      } catch { $moved = $false }
    }
    if ($moved) {
      A shell rm -f $f 2>$null | Out-Null
      Write-Host ("  取り込み完了 {0}  {1:N1} MB" -f $name, ((Get-Item $final).Length / 1MB))
    } else {
      if (Test-Path $tmp) { Remove-Item -Force $tmp }
      $kept += $f
      Write-Host "  取り込み失敗(端末上に残しました): $f"
    }
  }
  Write-Host "保存先: $OutDir"
  if ($kept.Count -gt 0) {
    Write-Host "取り込めなかった動画が端末に残っています。USB を確認して、次のコマンドで再取り込みしてください:"
    foreach ($f in $kept) { Write-Host "  $Adb -s $Serial pull $f $OutDir" }
  }
  Write-Host "この動画を https://akbmail-rescue.github.io/ に投入してください(複数まとめて可)"
}
