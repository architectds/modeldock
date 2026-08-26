# Start the ModelDock gateway hidden (no console window) with the package root as the
# working directory. Used by the autostart Run key entry and by dashboard.bat.
# Prefers the built single-file bundle (dist/modeldock.mjs), rebuilding it first when a
# source checkout has drifted ahead; falls back to the source entry in a git checkout.
$ErrorActionPreference = "Stop"
# See restart.ps1: a failed preflight verifier is an expected branch, not a
# terminating PowerShell error. Its numeric exit code decides whether to launch.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Invoke-GatewayVerifier([string[]]$VerifierArgs, [switch]$Quiet) {
  try {
    if ($Quiet) { & $nodeExe $verifierEntry @VerifierArgs *> $null }
    else { & $nodeExe $verifierEntry @VerifierArgs }
    return $LASTEXITCODE
  } catch {
    # PowerShell 7 can still surface a non-zero native exit as an exception in
    # a host that overrides PSNativeCommandUseErrorActionPreference. The exit
    # code is the verifier contract; only rethrow a genuine PowerShell failure.
    if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
    throw
  }
}
$root = Split-Path -Parent $PSScriptRoot
$bundle = Join-Path $root "dist\modeldock.mjs"
$server = Join-Path $root "src\server.mjs"
if (Test-Path -LiteralPath $bundle) { $server = $bundle }
$verifier = Join-Path $root "scripts\gateway-verifier.mjs"
if (Test-Path -LiteralPath $verifier) {
    $verifierEntry = $verifier
} else {
    # The old updater deploys the new bundle before this script but cannot
    # download a helper it does not yet know. Use the bundled verifier for
    # that one migration; fresh installs always have the standalone helper.
    Write-Output "WARNING: gateway verifier helper is missing; using the newly deployed bundle verifier for this migration."
    $verifierEntry = $server
}
$envFile = Join-Path $root ".env"
$port = 4097
$envPort = 0
if ($env:MODELDOCK_PORT -and [int]::TryParse($env:MODELDOCK_PORT, [ref]$envPort) -and $envPort -gt 0) { $port = $envPort }
if (Test-Path -LiteralPath $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  $parsed = 0
  if ($line -and [int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) { $port = $parsed }
}
$stateDir = if ($env:MODELDOCK_STATE_DIR) { [System.IO.Path]::GetFullPath($env:MODELDOCK_STATE_DIR) } else { Join-Path $env:USERPROFILE ".modeldock" }

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

# A source checkout must never serve a stale bundle - and never silently serve the
# src/ entry users do not have. Rebuild dist when source is newer than the bundle, so
# the gateway runs the same artifact users install. Installed layouts have no src/ at
# all (the self-updater owns dist there), and an applied update makes dist newer than
# src, so this is a no-op for real installs and never clobbers an update. A failed
# rebuild is loud but not fatal: the gateway still starts on the best bundle available.
$buildIfStale = Join-Path $root "scripts\build-if-stale.mjs"
if ((Test-Path -LiteralPath (Join-Path $root "src\server.mjs")) -and (Test-Path -LiteralPath $buildIfStale)) {
    & $nodeExe $buildIfStale
    if ($LASTEXITCODE -ne 0) {
        Write-Output "WARNING: source is newer than dist/modeldock.mjs but the rebuild failed; starting anyway (run npm run build to refresh the bundle before trusting local results)."
    }
}
# Re-pick after the potential rebuild so a freshly built bundle wins over src.
if (Test-Path -LiteralPath $bundle) { $server = $bundle }

# A correctly running gateway without a provider deliberately reports 503 from
# /healthz, so use the shared status/owner verifier rather than treating that
# normal setup state as down. It also prevents a second hidden launch from
# masking a foreign listener as our gateway.
$preflightExit = Invoke-GatewayVerifier -VerifierArgs @("--verify-gateway", "--root", $root, "--port", "$port", "--state-dir", $stateDir, "--timeout-ms", "500") -Quiet
if ($preflightExit -eq 0) { exit 0 }

# Log instead of discarding: a hidden start that dies (node missing, port taken, bad
# bundle) is otherwise completely silent. cmd.exe does the redirection so Start-Process
# stays on the ShellExecute path - its -RedirectStandard* parameters switch to
# CreateProcess with handle inheritance, which leaves the caller's pipes open and hangs
# any parent waiting for them to close. cmd /c strips the first/last quote when the
# command starts with a quoted program path, so wrap the whole command in one extra
# pair of quotes (the ""prog" args" form).
$log = Join-Path $root "modeldock.log"
$verifyTimeoutMs = 60000
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
$startedAfterMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"`"$nodeExe`" `"$server`" >> `"$log`" 2>&1`"" -WorkingDirectory $root -WindowStyle Hidden
$verifyExit = Invoke-GatewayVerifier -VerifierArgs @("--verify-gateway", "--root", $root, "--port", "$port", "--state-dir", $stateDir, "--started-after-ms", "$startedAfterMs", "--timeout-ms", "$verifyTimeoutMs") -Quiet
if ($verifyExit -ne 0) {
  Write-Output "ERROR: Gateway did not verify after hidden start. Check $log."
  exit 1
}
