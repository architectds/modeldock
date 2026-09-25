# restart.ps1 - restart the ModelDock gateway service.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   powershell -ExecutionPolicy Bypass -File <modeldock>\scripts\restart.ps1
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>\.env (default 4097).
#   2. Proves the listener PID belongs to this install, then stops only that PID.
#   3. Rebuilds the bundle when a source checkout has drifted ahead of it.
#   4. Starts a fresh detached gateway from the built bundle (dist/modeldock.mjs).
#   5. Confirms the launched Node PID is alive and runs that bundle, then exits.

$ErrorActionPreference = "Stop"
# PowerShell 7 turns any non-zero native exit into a terminating error when
# this preference is enabled. Keep build-if-stale's exit code observable
# through $LASTEXITCODE on hosts that expose this setting.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
$stateDir = if ($env:MODELDOCK_STATE_DIR) { [System.IO.Path]::GetFullPath($env:MODELDOCK_STATE_DIR) } else { Join-Path $env:USERPROFILE ".modeldock" }
$oldPid = 0

# Status lines go to both stdout and stderr. Callers (CI, the model shell, the
# dashboard) sometimes capture only one stream; a hidden launcher must never
# fail silently.
function Write-Status($message) {
  Write-Output $message
  [Console]::Error.WriteLine($message)
}

function Test-CommandUsesPath([string]$CommandLine, [string]$ExpectedPath) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $expected = [System.IO.Path]::GetFullPath($ExpectedPath)
  $pattern = '(?i)(?:^|[\s"])' + [System.Text.RegularExpressions.Regex]::Escape($expected) + '(?=$|[\s"])'
  return [System.Text.RegularExpressions.Regex]::IsMatch($CommandLine, $pattern)
}

function Wait-LaunchedNode([int]$LauncherPid, [string]$ExpectedServer, [int]$TimeoutMs = 10000) {
  $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $TimeoutMs
  do {
    $children = @()
    try {
      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $LauncherPid" -ErrorAction Stop)
    } catch {
      # A just-created process can be briefly absent from CIM. Retry until the
      # bounded deadline; no file, owner record, or HTTP request is involved.
    }
    foreach ($child in $children) {
      $command = [string]$child.CommandLine
      if ([string]$child.Name -ieq "node.exe" -and
          (Test-CommandUsesPath -CommandLine $command -ExpectedPath $ExpectedServer) -and
          (Get-Process -Id ([int]$child.ProcessId) -ErrorAction SilentlyContinue)) {
        return [int]$child.ProcessId
      }
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline)
  return 0
}

# Seed from the environment before consulting .env, matching restart.sh. This script
# used to ignore $env:MODELDOCK_PORT entirely, so a gateway told to use another port
# by environment restarted against 4097 instead: it stopped whatever unrelated process
# held the default port, then health-checked a port its own gateway was not on.
# scheduleRestart passes the running gateway's environment through for exactly this.
$port = 4097
$envPort = 0
if ($env:MODELDOCK_PORT -and [int]::TryParse($env:MODELDOCK_PORT, [ref]$envPort) -and $envPort -gt 0) {
  $port = $envPort
}
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  if ($line) {
    $parsed = 0
    if ([int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) {
      $port = $parsed
    }
  }
}

# Set once this run has taken the old listener down; the messages below use it
# to distinguish "nothing changed" from "the gateway is down and stayed down".
$stoppedGateway = $false

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $oldPid = $listener.OwningProcess
  # The gateway owns this record and writes its exact PID, port, and install
  # root. It remains readable when Windows hides an elevated process command
  # line from a manual restart. -Force never bypasses this ownership proof.
  $ownerFile = Join-Path $stateDir "owner-$port.json"
  $owner = $null
  try {
    if (Test-Path -LiteralPath $ownerFile) {
      $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
    }
  } catch {
    # The refusal below covers missing or unreadable ownership state.
  }
  $ownerMatches = $false
  if ($owner) {
    try {
      $ownerMatches = [int]$owner.pid -eq [int]$oldPid -and
          [int]$owner.port -eq $port -and
          [System.IO.Path]::GetFullPath([string]$owner.root) -eq [System.IO.Path]::GetFullPath($root)
    } catch {
      $ownerMatches = $false
    }
  }
  if (-not $ownerMatches) {
    Write-Status "ERROR: refusing to stop PID $oldPid on port $port because it is not recorded as this install's gateway."
    exit 2
  }
  $currentListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($currentListener -and $currentListener.OwningProcess -ne $oldPid) {
    Write-Status "ERROR: the listener on port $port changed during ownership verification; refusing to stop it."
    exit 2
  }
  Write-Status "restart.ps1: stopping gateway (PID $oldPid, port $port)"
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
    # Stop-Process is the one step that can strand the machine with no gateway,
    # so it never runs under the script-wide "Stop" preference. An elevated
    # gateway (Codex's Windows sandbox runs elevated) denies access to a
    # non-elevated restart, and that terminating error used to abort the script
    # before the Start-Process below: the old listener stopped or not, no new
    # one started. The updater spawns this script with stdio discarded, so the
    # dashboard just spun "restarting..." for its full 120s timeout with no
    # reason to show. Name the failure instead.
    try {
      Stop-Process -Id $oldPid -Force -ErrorAction Stop
    } catch {
      $stopError = $_.Exception.Message
      if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
        # Still alive, so the port stays held and a second gateway could only
        # fail with EADDRINUSE. Leaving the old one serving is the safe state.
        if ($stopError -match "Access is denied") {
          Write-Status "ERROR: cannot stop PID $oldPid on port ${port}: access is denied."
          Write-Status "The running gateway is elevated, so a non-elevated restart cannot replace it."
          Write-Status "Re-run this script as administrator:"
          Write-Status "  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$PSCommandPath','-Force'"
        } else {
          Write-Status "ERROR: cannot stop PID $oldPid on port ${port}: $stopError"
        }
        Write-Status "The old gateway is still serving on port $port; no new instance was started."
        exit 3
      }
      # Gone despite the error (it exited on its own, or only the status read
      # failed). The port is free, so carry on to the start below.
      Write-Status "restart.ps1: Stop-Process reported '$stopError' but PID $oldPid is gone; continuing"
    }
  } else {
    # The gateway (e.g. the updater process) may have exited between the port
    # probe and here; that is not a failure, just start fresh below.
    Write-Status "restart.ps1: PID $oldPid already exited; continuing"
  }
  # From here the old listener is down and this script owes the machine a
  # running gateway: every later failure path must say so out loud.
  $stoppedGateway = $true
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
  }
} else {
  Write-Status "restart.ps1: no gateway on port $port; starting fresh"
}

$log = Join-Path $root "modeldock.log"

# Rotate at startup, one previous generation (same policy as start-hidden.ps1):
# the log is append-only for the life of the process, so a cap on growth can
# only be applied between runs. 32 MB keeps roughly a month of daily use.
if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 32MB)) {
  try {
    Move-Item -LiteralPath $log -Destination "$log.1" -Force
  } catch {
    # Rotation is best-effort: a raced lock must not turn a restart into a
    # failure. Stop-Process already waited for the old listener to exit, so the
    # append-only redirect below uses a fresh handle.
    Write-Status "WARNING: could not rotate modeldock.log: $($_.Exception.Message)"
  }
}

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
  Write-Status "ERROR: node.exe not found; install Node 24+ or re-run the ModelDock installer"
  if ($stoppedGateway) {
    Write-Status "The old gateway was stopped and none could be started: port $port is now DOWN."
  }
  exit 1
}

# A source checkout must never serve a stale bundle - and never silently serve
# the src/ entry users do not have. Rebuild dist when source is newer than the
# bundle, so the gateway runs the same artifact users install. Installed layouts
# have no src/ at all (the self-updater owns dist there), and an applied update
# makes dist newer than src, so this is a no-op for real installs and never
# clobbers an update. A failed rebuild is loud but not fatal: the gateway still
# starts on the best bundle available and the log records exactly what ran.
# Wrapped: with the old listener already stopped, a throw from any probe in
# here would skip the Start-Process below and leave the port dead. A stale
# bundle is a far smaller problem than no gateway, so failures only warn.
try {
  $buildIfStale = Join-Path $root "scripts\build-if-stale.mjs"
  if ((Test-Path -LiteralPath (Join-Path $root "src\server.mjs")) -and (Test-Path -LiteralPath $buildIfStale)) {
    & $nodeExe $buildIfStale
    if ($LASTEXITCODE -ne 0) {
      Write-Status "WARNING: source is newer than dist/modeldock.mjs but the rebuild failed; starting anyway (run npm run build to refresh the bundle before trusting local results)."
    }
  }
} catch {
  Write-Status "WARNING: bundle staleness check failed: $($_.Exception.Message); starting on the existing bundle."
}

# Prefer the built bundle, falling back to the source entry in a git checkout.
# This must match start-hidden.ps1 exactly: the two used to disagree (this script
# preferred src while the launcher preferred dist), so a checkout served one
# version on restart and another at login. dist wins because the self-updater
# writes dist/modeldock.mjs and never touches src - preferring src would leave an
# applied update permanently unused, and the Update button permanently lit.
$server = Join-Path $root "dist\modeldock.mjs"
if (-not (Test-Path -LiteralPath $server)) {
  Write-Status "ERROR: built gateway bundle is missing: $server"
  exit 1
}
try {
  # Quote both paths: an installed layout under a home dir with a space
  # (e.g. "C:\Users\<user>\.modeldock") would otherwise be split by node's
  # CRT into two argv entries and fail with "Cannot find module". cmd.exe does
  # the >> redirection so stdout and stderr share the same log file as the
  # start-hidden launcher (and the "check modeldock.log" guidance).
  # cmd owns the append redirection for the lifetime of Node. Keep its process
  # object so the exact node.exe child can be identified without consulting a
  # mutable owner file or waiting for an HTTP health surface.
  $launcher = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"`"$nodeExe`" `"$server`" >> `"$log`" 2>&1`"" -WorkingDirectory $root -WindowStyle Hidden -PassThru
} catch {
  Write-Status "ERROR: failed to start gateway: $($_.Exception.Message)"
  if ($stoppedGateway) {
    Write-Status "The old gateway was stopped and the replacement did not start: port $port is now DOWN."
    Write-Status "Start it manually:"
    Write-Status "  powershell -NoProfile -ExecutionPolicy Bypass -File '$PSCommandPath' -Force"
  }
  exit 1
}
Write-Status "restart.ps1: launched gateway from $root using $server (logs: $log)"
$newPid = Wait-LaunchedNode -LauncherPid $launcher.Id -ExpectedServer $server
if ($newPid -le 0) {
  Write-Status "ERROR: the launcher did not create a live node.exe for $server."
  if ($stoppedGateway) {
    Write-Status "The old gateway was stopped and no replacement process was handed off."
  }
  exit 1
}
Write-Status "restart.ps1: verified gateway handoff to PID $newPid from $server"
exit 0
