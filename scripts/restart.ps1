# restart.ps1 - restart the ModelDock gateway service.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   powershell -ExecutionPolicy Bypass -File <modeldock>\scripts\restart.ps1
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>\.env (default 4097).
#   2. Stops the process listening on that port (if any).
#   3. Rebuilds the bundle when a source checkout has drifted ahead of it.
#   4. Starts a fresh detached gateway from the built bundle (dist/modeldock.mjs).
#   5. Prints where the gateway started and exits; runtime logs go to modeldock.log.

$ErrorActionPreference = "Stop"
# PowerShell 7 turns any non-zero native exit into a terminating error when
# this preference is enabled. The verifier intentionally returns non-zero to
# let this script print the recovery-safe diagnostic below, so keep its exit
# code observable through $LASTEXITCODE on hosts that expose this setting.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
$stateDir = if ($env:MODELDOCK_STATE_DIR) { [System.IO.Path]::GetFullPath($env:MODELDOCK_STATE_DIR) } else { Join-Path $env:USERPROFILE ".modeldock" }
$forceTakeover = $args -contains "-Force"
$oldPid = 0

# Status lines go to both stdout and stderr. Callers (CI, the model shell, the
# dashboard) sometimes capture only one stream; a hidden launcher must never
# fail silently.
function Write-Status($message) {
  Write-Output $message
  [Console]::Error.WriteLine($message)
}

function Invoke-GatewayVerifier([string[]]$VerifierArgs) {
  try {
    & $nodeExe $verifierEntry @VerifierArgs *> $null
    return $LASTEXITCODE
  } catch {
    # See start-hidden.ps1: an overriding PowerShell host can throw for the
    # verifier's deliberate non-zero result. Preserve the numeric contract.
    if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
    throw
  }
}

# A gateway restart normally has no idea which Codex conversation owns a
# llama.cpp slot. Before this script stops Node, ask the still-running gateway
# to close local admission, drain the active request, and save its hot slots.
# This endpoint was added after the first shipped restart scripts, so a 404 is
# a compatible old-gateway handoff rather than a reason to strand an upgrade.
function Invoke-LocalRestartCheckpoint {
  $keyFile = Join-Path $stateDir "caller-key"
  if (-not (Test-Path -LiteralPath $keyFile)) {
    Write-Status "restart.ps1: no caller key found; local KV checkpoint is unavailable for this restart"
    return $true
  }
  $callerKey = ""
  try { $callerKey = (Get-Content -LiteralPath $keyFile -Raw -ErrorAction Stop).Trim() } catch {}
  if ($callerKey -notmatch '^[A-Za-z0-9_-]{32,}$') {
    Write-Status "restart.ps1: caller key is unavailable; local KV checkpoint is skipped"
    return $true
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/api/local/restart-checkpoint" -Headers @{ "x-modeldock-key" = $callerKey } -ContentType "application/json" -Body "{}" -TimeoutSec 130 -ErrorAction Stop
    $payload = $null
    try { $payload = $response.Content | ConvertFrom-Json } catch {}
    if ($payload -and $payload.managed) {
      Write-Status "restart.ps1: checkpointed $($payload.saved) local session state(s); handing off gateway"
    }
    return $true
  } catch {
    $statusCode = 0
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
    if ($statusCode -eq 404) {
      Write-Status "restart.ps1: installed gateway predates local KV checkpoints; continuing without a hot-state dump"
      return $true
    }
    Write-Status "ERROR: local KV checkpoint failed; leaving the existing gateway running: $($_.Exception.Message)"
    return $false
  }
}

function Release-LocalRestartCheckpoint {
  $keyFile = Join-Path $stateDir "caller-key"
  if (-not (Test-Path -LiteralPath $keyFile)) { return }
  $callerKey = ""
  try { $callerKey = (Get-Content -LiteralPath $keyFile -Raw -ErrorAction Stop).Trim() } catch {}
  if ($callerKey -notmatch '^[A-Za-z0-9_-]{32,}$') { return }
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/api/local/restart-checkpoint/release" -Headers @{ "x-modeldock-key" = $callerKey } -ContentType "application/json" -Body "{}" -TimeoutSec 5 -ErrorAction Stop | Out-Null
  } catch {
    # The old gateway may already be gone. The runtime's short handoff timer is
    # also a backstop, so a failed best-effort release is never a restart error.
  }
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
  # Ownership guard: the gateway records {pid, root} per port in
  # ~/.modeldock/owner-<port>.json. If the recorded owner is a *different*
  # checkout, killing it would swap live traffic onto this checkout's code -
  # exactly the lookalike-instance mixup we have hit before. Refuse unless -Force.
  # Must match ownerFilePath() in src/instance-owner.mjs, including the
  # MODELDOCK_STATE_DIR redirect, or the guard reads a file the gateway never wrote.
  $ownerFile = Join-Path $stateDir "owner-$port.json"
  if (-not $forceTakeover) {
    # The listener command line is the ground truth: a listener that provably
    # runs this install's gateway is ours no matter what the owner record says.
    # The record can go stale (crash, manual start, a second instance dying
    # with EADDRINUSE), and blocking the restart on that stale file leaves the
    # old process serving forever. Windows can also return an empty command
    # line for elevated processes, so when it is unreadable we fall back to the
    # owner record matching this exact listener.
    $listenerCommand = ""
    try {
      $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction Stop
      $listenerCommand = [string]$processInfo.CommandLine
    } catch {
      # Treat an unreadable command line as unknown; the owner record decides.
      $listenerCommand = ""
    }
    $sourceEntry = [System.IO.Path]::GetFullPath((Join-Path $root "src\server.mjs"))
    $bundleEntry = [System.IO.Path]::GetFullPath((Join-Path $root "dist\modeldock.mjs"))
    $listenerIsOurs = -not [string]::IsNullOrWhiteSpace($listenerCommand) -and
        ($listenerCommand.IndexOf($sourceEntry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
         $listenerCommand.IndexOf($bundleEntry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)

    $owner = $null
    try {
      if (Test-Path -LiteralPath $ownerFile) { $owner = Get-Content $ownerFile -Raw | ConvertFrom-Json }
    } catch {
      # Missing or unreadable record; refusal below explains the state.
    }

    $recordMatchesListener = $false
    if ($owner) {
      $ownerRoot = [System.IO.Path]::GetFullPath([string]$owner.root)
      $thisRoot = [System.IO.Path]::GetFullPath($root)
      $recordMatchesListener = [int]$owner.pid -eq [int]$oldPid -and [int]$owner.port -eq $port -and $ownerRoot -eq $thisRoot
    }

    if (-not $listenerIsOurs -and $recordMatchesListener -and [string]::IsNullOrWhiteSpace($listenerCommand)) {
      Write-Status "WARNING: listener command line could not be read; trusting owner record PID $oldPid on port $port."
      $listenerIsOurs = $true
    }

    if (-not $listenerIsOurs) {
      if ($owner) {
        $ownerAlive = $false
        if (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue) { $ownerAlive = $true }
        if ($ownerAlive -and [int]$owner.pid -ne [int]$oldPid) {
          Write-Status "ERROR: refusing to stop PID $oldPid on port $port because port $port is recorded as owned by live PID $($owner.pid) (root: $($owner.root))."
          Write-Status "Re-run with -Force to take the port over deliberately."
          exit 2
        }
      }
      Write-Status "ERROR: refusing to stop PID $oldPid on port $port because ownership could not be verified: the listener is not a ModelDock gateway from this install and the owner record is missing or stale."
      Write-Status "Re-run with -Force to take the port over deliberately."
      exit 2
    }
  }
  $currentListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($currentListener -and $currentListener.OwningProcess -ne $oldPid -and (-not $forceTakeover)) {
    Write-Status "ERROR: the listener on port $port changed during ownership verification; refusing to stop it."
    exit 2
  }
  # Write-Status deliberately emits human-readable lines on stdout as well as
  # stderr, so inspect the explicit Boolean result instead of PowerShell's
  # truthiness for the mixed output collection.
  if (@(Invoke-LocalRestartCheckpoint) -contains $false) {
    exit 4
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
        Release-LocalRestartCheckpoint
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
if (-not (Test-Path -LiteralPath $server)) { $server = Join-Path $root "src\server.mjs" }
$verifyTimeoutMs = 60000
$verifier = Join-Path $root "scripts\gateway-verifier.mjs"
if (Test-Path -LiteralPath $verifier) {
  $verifierEntry = $verifier
} else {
  # The 0.3.31 updater did not know this helper asset. Its first upgrade
  # deploys the new bundle before these scripts, so use the bundled copy for
  # this one migration only; later releases deploy the standalone helper.
  Write-Status "WARNING: gateway verifier helper is missing; using the newly deployed bundle verifier for this migration."
  $verifierEntry = $server
}

try {
  # Quote both paths: an installed layout under a home dir with a space
  # (e.g. "C:\Users\<user>\.modeldock") would otherwise be split by node's
  # CRT into two argv entries and fail with "Cannot find module". cmd.exe does
  # the >> redirection so stdout and stderr share the same log file as the
  # start-hidden launcher (and the "check modeldock.log" guidance).
  # Record the handoff boundary before the child is launched. The verifier
  # refuses a stale owner record or the listener from the process we just
  # stopped, so a previous healthy gateway cannot make this restart look good.
  $startedAfterMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"`"$nodeExe`" `"$server`" >> `"$log`" 2>&1`"" -WorkingDirectory $root -WindowStyle Hidden
} catch {
  Write-Status "ERROR: failed to start gateway: $($_.Exception.Message)"
  if ($stoppedGateway) {
    Write-Status "The old gateway was stopped and the replacement did not start: port $port is now DOWN."
    Write-Status "Start it manually:"
    Write-Status "  powershell -NoProfile -ExecutionPolicy Bypass -File '$PSCommandPath' -Force"
  }
  exit 1
}
Write-Status "restart.ps1: started gateway from $root using $server; verifying readiness (logs: $log)"
$verifyArgs = @(
  "--verify-gateway",
  "--root", $root,
  "--port", "$port",
  "--state-dir", $stateDir,
  "--started-after-ms", "$startedAfterMs",
  "--timeout-ms", "$verifyTimeoutMs"
)
if ($oldPid -gt 0) { $verifyArgs += @("--previous-pid", "$oldPid") }
$verifyExit = Invoke-GatewayVerifier -VerifierArgs $verifyArgs
if ($verifyExit -ne 0) {
  Write-Status "ERROR: Gateway did not verify after restart. The replacement may have exited; check $log."
  if ($stoppedGateway) {
    Write-Status "The old gateway was stopped and no verified replacement is serving on port $port."
  }
  exit 1
}
Write-Status "restart.ps1: verified gateway from $root (logs: $log)"
exit 0
