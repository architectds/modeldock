# restart.ps1 - restart the ModelDock gateway service.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   powershell -ExecutionPolicy Bypass -File <modeldock>\scripts\restart.ps1
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>\.env (default 4097).
#   2. Stops the process listening on that port (if any).
#   3. Starts a fresh detached `node src/server.mjs` from the project root.
#   4. Waits for /healthz and reports the result.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

# Status lines go to both stdout and stderr. Callers (CI, the model shell, the
# dashboard) sometimes capture only one stream; a hidden launcher must never
# fail silently.
function Write-Status($message) {
  Write-Output $message
  [Console]::Error.WriteLine($message)
}

$port = 4097
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  if ($line) {
    $parsed = 0
    if ([int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) {
      $port = $parsed
    }
  }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $oldPid = $listener.OwningProcess
  # Ownership guard: the gateway records {pid, root} per port in
  # ~/.modeldock/owner-<port>.json. If the recorded owner is a *different*
  # checkout, killing it would swap live traffic onto this checkout's code -
  # exactly the lookalike-instance mixup we have hit before. Refuse unless -Force.
  # Must match ownerFilePath() in src/instance-owner.mjs, including the
  # MODELDOCK_STATE_DIR redirect, or the guard reads a file the gateway never wrote.
  $stateDir = if ($env:MODELDOCK_STATE_DIR) { $env:MODELDOCK_STATE_DIR } else { Join-Path $env:USERPROFILE ".modeldock" }
  $ownerFile = Join-Path $stateDir "owner-$port.json"
  $forceTakeover = $args -contains "-Force"
  if (-not $forceTakeover) {
    $owned = $false
    try {
      if (-not (Test-Path -LiteralPath $ownerFile)) { throw "owner record is missing" }
      $owner = Get-Content $ownerFile -Raw | ConvertFrom-Json
      $ownerRoot = [System.IO.Path]::GetFullPath([string]$owner.root)
      $thisRoot = [System.IO.Path]::GetFullPath($root)
      if ([int]$owner.pid -ne [int]$oldPid -or [int]$owner.port -ne $port -or $ownerRoot -ne $thisRoot) {
        throw "owner record does not match this listener and install root"
      }
      $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction Stop
      $commandLine = [string]$processInfo.CommandLine
      $sourceEntry = [System.IO.Path]::GetFullPath((Join-Path $root "src\server.mjs"))
      $bundleEntry = [System.IO.Path]::GetFullPath((Join-Path $root "dist\modeldock.mjs"))
      $owned = $commandLine.IndexOf($sourceEntry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          $commandLine.IndexOf($bundleEntry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      if (-not $owned) { throw "listener command does not run this ModelDock install" }
    } catch {
      Write-Status "ERROR: refusing to stop PID $oldPid on port $port because ownership could not be verified: $($_.Exception.Message)"
      Write-Status "Re-run with -Force to take the port over deliberately."
      exit 2
    }
  }
  $currentListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($currentListener -and $currentListener.OwningProcess -ne $oldPid -and (-not $forceTakeover)) {
    Write-Status "ERROR: the listener on port $port changed during ownership verification; refusing to stop it."
    exit 2
  }
  Write-Status "restart.ps1: stopping gateway (PID $oldPid, port $port)"
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $oldPid -Force
  } else {
    # The gateway (e.g. the updater process) may have exited between the port
    # probe and here; that is not a failure, just start fresh below.
    Write-Status "restart.ps1: PID $oldPid already exited; continuing"
  }
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
  }
} else {
  Write-Status "restart.ps1: no gateway on port $port; starting fresh"
}

$log = Join-Path $root "modeldock.log"

# The old gateway's stdout/stderr handles can linger for a moment after
# Stop-Process. Wait for the log to become writable BEFORE rotating: an
# in-place Move-Item on a still-locked file fails, and that failure used to
# abort the restart. If it stays locked, fall back to a per-run log file so
# the redirect never races the dying process's file handles.
function Test-WritableFile($file) {
  try {
    $probe = [System.IO.File]::Open($file, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $probe.Close()
    return $true
  } catch {
    return $false
  }
}
$logsReady = $false
for ($i = 0; $i -lt 20; $i += 1) {
  if (Test-WritableFile $log) {
    $logsReady = $true
    break
  }
  Start-Sleep -Milliseconds 250
}
if (-not $logsReady) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $log = Join-Path $root "modeldock-$stamp.log"
  Write-Status "WARNING: modeldock.log was still locked; using per-run log ($log)"
} elseif ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 32MB)) {
  # Rotate at startup, one previous generation (same policy as start-hidden.ps1):
  # the log is append-only for the life of the process, so a cap on growth can
  # only be applied between runs. 32 MB keeps roughly a month of daily use.
  try {
    Move-Item -LiteralPath $log -Destination "$log.1" -Force
  } catch {
    # Rotation is best-effort now that the lock wait passed; a raced lock must
    # not turn a restart into a failure.
    Write-Status "WARNING: could not rotate modeldock.log: $($_.Exception.Message)"
  }
}

# Prefer an explicit path, then a bundled Node under <root>\node (the installer
# downloads Node 22 LTS there when none is on PATH), then PATH.
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
  Write-Status "ERROR: node.exe not found; install Node 22+ or re-run the ModelDock installer"
  exit 1
}

# Prefer src/server.mjs (git checkout: restart the code being edited); fall back
# to the built bundle (installed layout ships dist/modeldock.mjs only). Mirrors
# the server-selection in start-hidden.ps1.
$server = Join-Path $root "src\server.mjs"
if (-not (Test-Path -LiteralPath $server)) { $server = Join-Path $root "dist\modeldock.mjs" }

try {
  # Quote both paths: an installed layout under a home dir with a space
  # (e.g. "C:\Users\Chen Bao\.modeldock") would otherwise be split by node's
  # CRT into two argv entries and fail with "Cannot find module". cmd.exe does
  # the >> redirection so stdout and stderr share the same log file as the
  # start-hidden launcher (and the "check modeldock.log" guidance).
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"`"$nodeExe`" `"$server`" >> `"$log`" 2>&1`"" -WorkingDirectory $root -WindowStyle Hidden
} catch {
  Write-Status "ERROR: failed to start gateway: $($_.Exception.Message)"
  exit 1
}
Write-Status "restart.ps1: started gateway from $root (logs: $log)"

for ($i = 0; $i -lt 40; $i += 1) {
  Start-Sleep -Milliseconds 250
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2 -UseBasicParsing | Out-Null
    Write-Status "restart.ps1: gateway healthy at http://127.0.0.1:$port"
    exit 0
  } catch {
    # A returned HTTP status (e.g. 503 before a token is configured) still proves
    # the gateway is up and listening - only a connection failure means it is not.
    if ($_.Exception.Response) {
      Write-Status "restart.ps1: gateway up at http://127.0.0.1:$port (awaiting token)"
      exit 0
    }
    # Otherwise still booting / connection refused; keep polling.
  }
}

Write-Status "ERROR: gateway did not become healthy within 10s"
if (Test-Path $log) {
  $tail = Get-Content $log -Tail 10 -ErrorAction SilentlyContinue
  if ($tail) { $tail | ForEach-Object { [Console]::Error.WriteLine($_) } }
}
exit 1
