# Start the ModelDock gateway hidden (no console window) with the package root as the
# working directory. Used by the autostart Run key entry and by dashboard.bat.
# Prefers the built single-file bundle (dist/modeldock.mjs); falls back to the source
# entry in a git checkout.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bundle = Join-Path $root "dist\modeldock.mjs"
$server = Join-Path $root "src\server.mjs"
if (Test-Path -LiteralPath $bundle) { $server = $bundle }

# Prefer an explicit path, then a bundled Node under <root>\node (the installer
# downloads Node 24 LTS there when none is on PATH), then PATH.
$nodeExe = $null
if ($env:MODELDOCK_NODE_PATH -and (Test-Path -LiteralPath $env:MODELDOCK_NODE_PATH)) { $nodeExe = $env:MODELDOCK_NODE_PATH }
if (-not $nodeExe) {
    $bestDir = @(Get-ChildItem -LiteralPath (Join-Path $root "node") -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^v\d+\.\d+\.\d+$" } |
        Sort-Object @{ Expression = {
                if ($_.Name -match "^v(\d+)\.(\d+)\.(\d+)$") { [long]$Matches[1] * 1000000 + [long]$Matches[2] * 1000 + [long]$Matches[3] } else { -1 }
            }; Descending = $true } |
        Select-Object -First 1)
    if ($bestDir -and (Test-Path -LiteralPath (Join-Path $bestDir.FullName "node.exe"))) {
        $nodeExe = Join-Path $bestDir.FullName "node.exe"
    }
}
if (-not $nodeExe) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeExe) {
    Write-Output "ERROR: node.exe not found; install Node 24+ or re-run the ModelDock installer"
    exit 1
}

# Log instead of discarding: a hidden start that dies (node missing, port taken, bad
# bundle) is otherwise completely silent. cmd.exe does the redirection so Start-Process
# stays on the ShellExecute path - its -RedirectStandard* parameters switch to
# CreateProcess with handle inheritance, which leaves the caller's pipes open and hangs
# any parent waiting for them to close. cmd /c strips the first/last quote when the
# command starts with a quoted program path, so wrap the whole command in one extra
# pair of quotes (the ""prog" args" form).
$log = Join-Path $root "modeldock.log"
# Rotate at startup, one previous generation (like codex-router's log-rotation):
# the log is append-only for the life of the process, so a cap on growth can only
# be applied between runs. 32 MB keeps roughly a month of daily use. Rotation is
# best-effort: a previous gateway whose handles have not released must not fail
# this hidden start.
if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 32MB)) {
  try {
    Move-Item -LiteralPath $log -Destination "$log.1" -Force
  } catch {
    Write-Output "WARNING: could not rotate modeldock.log: $($_.Exception.Message)"
  }
}
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"`"$nodeExe`" `"$server`" >> `"$log`" 2>&1`"" -WorkingDirectory $root -WindowStyle Hidden
