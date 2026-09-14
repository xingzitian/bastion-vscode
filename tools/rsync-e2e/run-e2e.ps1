# One command to run the rsync-bridge end-to-end test (needs the local test rig).
#
#   powershell -ExecutionPolicy Bypass -File tools/rsync-e2e/run-e2e.ps1
#
# Set up the rig once (WSL allows -u root, no admin needed):
#   wsl -u root -d Ubuntu -- bash /mnt/c/<path-to-repo>/tools/rsync-e2e/setup-wsl.sh
#
# NOTE: ASCII only on purpose -- Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1
# as ANSI, which turns any non-ASCII text into mojibake (and can break the script).
#
# This runs the SAME runBridge the extension uses (TCP loopback + shim + inject + filter
# + teardown); only the session channel is swapped for an ssh2 shell channel.

param(
  [int]$Port = 2222,
  [switch]$Heavy
)

$ErrorActionPreference = 'Stop'
# script sits at <repo>/tools/rsync-e2e/ -> two levels up is the repo root
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

$key = Join-Path $env:LOCALAPPDATA "Temp\bastion-e2e\id_ed25519_$Port"
if (-not (Test-Path $key)) {
  Write-Host "!! test-rig key not found ($key) -- run tools/rsync-e2e/setup-wsl.sh $Port in WSL first" -ForegroundColor Red
  exit 1
}

$env:BASTION_E2E_SSH = "127.0.0.1:$Port"
$env:BASTION_E2E_USER = 'bastiontest'
$env:BASTION_E2E_KEY = $key
$env:BASTION_E2E_REMOTE_DIR = '/tmp/bastion-e2e/dst'
if ($Heavy) { $env:BASTION_E2E_HEAVY = '1' } else { Remove-Item Env:\BASTION_E2E_HEAVY -ErrorAction SilentlyContinue }

Write-Host "=== compile ===" -ForegroundColor Cyan
npx tsc -p ./
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "=== e2e on port $Port (heavy=$($Heavy.IsPresent)) ===" -ForegroundColor Cyan
node --test "out/test/rsyncE2E.test.js" "out/test/rsyncE2EMatrix.test.js"
exit $LASTEXITCODE
