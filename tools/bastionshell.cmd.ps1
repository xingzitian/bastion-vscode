# 不开 VS Code：一条命令起终端
#
# 用法（在仓库根目录）：
#   .\tools\bastionshell.cmd xzt
#
# 它会：起 `node out\cli\main.js serve <档案>` → 等日志里出现网页终端地址 →
#      用默认浏览器打开（真终端：能敲命令、能看 AI 的输出）→ 关掉这个窗口即结束会话。
#
# 需要：Node ≥ 22（开发者机器本来就有）。不需要安装任何运行时，也不打包 Electron。

param([Parameter(Mandatory = $true)][string]$Profile)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '没找到 node（要求 ≥ 22）：https://nodejs.org/' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path 'out\cli\main.js')) {
  Write-Host '还没编译：先跑 npm run compile' -ForegroundColor Yellow
  exit 1
}

# stderr 里既有日志也有我们要抓的地址；stdout 是远端字节流（直接透到窗口）
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = "out\cli\main.js serve $Profile"
$psi.WorkingDirectory = $repo
$psi.RedirectStandardError = $true
$psi.RedirectStandardOutput = $false
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$opened = $false
$deadline = (Get-Date).AddSeconds(40)

try {
  while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
    $line = $proc.StandardError.ReadLine()
    if ($null -eq $line) { continue }
    Write-Output $line
    if (-not $opened -and $line -match '(http://127\.0\.0\.1:\d+/term\?token=\S+)') {
      $url = $Matches[1]
      Write-Output "在浏览器里打开：$url"
      Start-Process $url
      $opened = $true
    }
  }
  Write-Output '会话结束。'
} finally {
  if (-not $proc.HasExited) { $proc.Kill() }
}
