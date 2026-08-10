# End-to-end release verification against the REAL GitHub feed, not the mock
# server. It runs exactly what a user runs: downloads install.ps1 from the main
# branch (the same URL as the one-line bootstrap), installs the latest release
# assets into a throwaway root, boots the gateway, checks /healthz, lists the
# MCP tools through the installed stdio bridge, restarts through the installed
# restart.ps1, then tears everything down.
#
# This deliberately runs under Windows PowerShell 5.1 (powershell.exe), because
# that is what most Windows users bootstrap with: GitHub serves extension-less
# release assets as application/octet-stream, and 5.1 exposes .Content as
# byte[] there, which the installer's checksum matching must handle. The mock
# install test served SHA256SUMS as text/plain and hid that bug; this verifier
# must not.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-release-install.ps1

$ErrorActionPreference = "Stop"

$work = Join-Path $env:TEMP ("modeldock-release-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null

$root = Join-Path $work "install-root"
$stateDir = Join-Path $work "state"
$codexHome = Join-Path $work "codex-home"
$upstreamPortFile = Join-Path $work "probe-upstream.port"
$upstreamLog = Join-Path $work "probe-upstream.log"
$upstreamErrorLog = Join-Path $work "probe-upstream.error.log"
$upstreamProcess = $null
New-Item -ItemType Directory -Force -Path $root, $stateDir, $codexHome | Out-Null

# Default to the real port when free; otherwise a random high port so the
# verification never collides with a live gateway on this machine.
$port = 4097
if (Get-NetTCPConnection -LocalPort 4097 -State Listen -ErrorAction SilentlyContinue) {
  $port = 4200 + (Get-Random -Minimum 0 -Maximum 500)
}

$autostartName = "ModelDockReleaseVerify"
$autostartKey = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"

$env:MODELDOCK_ROOT = $root
$env:MODELDOCK_PORT = "$port"
$env:MODELDOCK_STATE_DIR = $stateDir
$env:MODELDOCK_SKIP_OPEN = "1"
$env:MODELDOCK_CODEX_HOME = $codexHome
$env:MODELDOCK_AUTOSTART_KEY = $autostartKey
$env:MODELDOCK_AUTOSTART_NAME = $autostartName
# A fresh install has no provider token, and /healthz intentionally returns 503
# in that state. Use a disposable test token so the first-start check verifies
# the actual launch path without contacting a real provider.
$env:OPENCODE_GO_TOKEN = "release-verify-probe-token"
# The release probe asserts the full six-tool surface (recall_memory /
# store_memory included). Published bundles before the memory-default-on change
# keep the vault opt-in, so pin it on explicitly here; it is a no-op for bundles
# that already default the vault on. The vault itself stays inside the
# throwaway work dir.
$env:MODELDOCK_MEMORY = "1"
$env:MODELDOCK_MEMORY_DIR = Join-Path $work "memory"

function Write-Step($message) {
  Write-Output "verify: $message"
}

function Stop-TestGateway {
  # Read the latest owner record (restart writes a new one) and only kill a
  # process whose owner root is inside this test's work dir.
  $ownerFile = Join-Path $stateDir "owner-$port.json"
  if (Test-Path $ownerFile) {
    try {
      $owner = Get-Content $ownerFile -Raw | ConvertFrom-Json
      if ($owner.root -and $owner.pid) {
        $ownerFull = [System.IO.Path]::GetFullPath($owner.root)
        $workFull = [System.IO.Path]::GetFullPath($work)
        if ($ownerFull.StartsWith($workFull)) {
          Stop-Process -Id $owner.pid -Force -ErrorAction SilentlyContinue
        }
      }
    } catch { }
  }
}

function Stop-ProbeUpstream {
  if ($script:upstreamProcess -and -not $script:upstreamProcess.HasExited) {
    Stop-Process -Id $script:upstreamProcess.Id -Force -ErrorAction SilentlyContinue
  }
}

function Gateway-LogTail {
  $log = Join-Path $root "modeldock.log"
  if (-not (Test-Path $log)) { return "(no gateway log at $log)" }
  try {
    return ((Get-Content -LiteralPath $log -Tail 30) -join "`n")
  } catch {
    return "(could not read gateway log: $($_.Exception.Message))"
  }
}

try {
  $installer = Join-Path $work "install.ps1"
  $installerUrl = "https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1"
  Write-Step "downloading installer from $installerUrl"
  Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $installer -TimeoutSec 60

  Write-Step "running installer (port $port)"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
  if ($LASTEXITCODE -ne 0) { throw "installer exited $LASTEXITCODE" }

  # The restart script reads the port from <root>\.env, not from the
  # environment, so a non-default test port must be pinned there.
  [System.IO.File]::WriteAllText(
    (Join-Path $root ".env"),
    "MODELDOCK_PORT=$port`r`nMODELDOCK_MEMORY=1`r`n",
    (New-Object System.Text.UTF8Encoding($false))
  )

  $healthUrl = "http://127.0.0.1:$port/healthz"
  Write-Step "waiting for gateway at $healthUrl"
  $healthy = $false
  for ($i = 0; $i -lt 40; $i += 1) {
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5
      if ($health.Content -match '"ok"\s*:\s*true') { $healthy = $true; break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $healthy) {
    throw "gateway did not become healthy at $healthUrl`n$(Gateway-LogTail)"
  }
  Write-Step "gateway healthy"

  # The installer enables start-at-login by default; assert the Run key entry
  # points back at this test install, then remove it during cleanup.
  $runValue = reg.exe query $autostartKey /v $autostartName 2>$null
  if ($LASTEXITCODE -ne 0 -or -not ($runValue -match [regex]::Escape($root))) {
    throw "autostart Run key missing or not pointing at the test install"
  }
  Write-Step "autostart Run key present and correct"

  # The installer mirrors the content-to-video skill into the Codex home.
  if (-not (Test-Path (Join-Path $codexHome "skills\content-to-video\SKILL.md"))) {
    throw "content-to-video skill was not installed"
  }
  Write-Step "content-to-video skill installed"

  $bridge = Join-Path $root "dist\mcp-standalone.mjs"
  $probe = Join-Path $PSScriptRoot "mcp-probe.cjs"
  Write-Step "probing MCP tools through the installed bridge"
  $probeOut = & node $probe $bridge "http://127.0.0.1:$port" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "MCP probe failed: $probeOut" }
  Write-Step $probeOut

  Write-Step "restarting through the installed restart.ps1"
  # restart.ps1 reports status on stdout and stderr by design (so CI and hidden
  # launchers both see it); capture stderr as text here instead of letting
  # $ErrorActionPreference = "Stop" turn it into a terminating error.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $restartOut = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\restart.ps1") 2>&1 | ForEach-Object { "$_" })
  $restartExit = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  $restartText = ($restartOut -join "`n").Trim()
  Write-Step $restartText
  if ($restartExit -ne 0) { throw "restart.ps1 exited $restartExit`n$restartText" }

  $healthy = $false
  for ($i = 0; $i -lt 40; $i += 1) {
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5
      if ($health.Content -match '"ok"\s*:\s*true') { $healthy = $true; break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $healthy) {
    throw "gateway did not recover after restart`n$(Gateway-LogTail)"
  }
  Write-Step "gateway healthy after restart"

  # Point the installed gateway at a local deterministic Responses upstream.
  # This keeps the release test offline from the provider while exercising the
  # real installed relay, caller-key, metrics, and restart path.
  $streamProbe = Join-Path $PSScriptRoot "stream-probe.cjs"
  if (-not (Test-Path $streamProbe)) {
    throw "stream probe is missing from the checkout"
  }
  Write-Step "starting local Responses stream probe upstream"
  $script:upstreamProcess = Start-Process -FilePath "node.exe" `
    -ArgumentList @($streamProbe, "upstream", "--portfile", $upstreamPortFile) `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $upstreamLog -RedirectStandardError $upstreamErrorLog
  $upstreamPort = $null
  for ($i = 0; $i -lt 40; $i += 1) {
    if (Test-Path $upstreamPortFile) {
      $upstreamPort = (Get-Content $upstreamPortFile -Raw).Trim()
      if ($upstreamPort -match "^\d+$") { break }
    }
    if ($script:upstreamProcess.HasExited) { throw "stream probe upstream exited early" }
    Start-Sleep -Milliseconds 250
  }
  if (-not $upstreamPort) { throw "stream probe upstream did not publish a port" }
  Write-Step "stream probe upstream listening on $upstreamPort"
  [System.IO.File]::AppendAllText(
    (Join-Path $root ".env"),
    "MODELDOCK_UPSTREAM_BASE_URL=http://127.0.0.1:$upstreamPort`r`nOPENCODE_GO_TOKEN=probe-token`r`n",
    (New-Object System.Text.UTF8Encoding($false))
  )

  Write-Step "restarting with the local stream probe upstream"
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $restartOut = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\restart.ps1") 2>&1 | ForEach-Object { "$_" })
  $restartExit = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  $restartText = ($restartOut -join "`n").Trim()
  Write-Step $restartText
  if ($restartExit -ne 0) { throw "restart.ps1 exited $restartExit`n$restartText" }

  $healthy = $false
  for ($i = 0; $i -lt 40; $i += 1) {
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5
      if ($health.Content -match '"ok"\s*:\s*true') { $healthy = $true; break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $healthy) {
    throw "gateway did not become healthy after stream-probe restart`n$(Gateway-LogTail)"
  }
  Write-Step "gateway healthy with stream probe upstream"

  Write-Step "verifying completed stream closes cleanly"
  $streamOut = & node $streamProbe client --gateway "http://127.0.0.1:$port" --keyfile (Join-Path $stateDir "caller-key") 2>&1
  if ($LASTEXITCODE -ne 0) { throw "stream probe failed: $streamOut" }
  Write-Step $streamOut
  Write-Step "RELEASE_INSTALL_VERIFY_OK"
} finally {
  Stop-ProbeUpstream
  Stop-TestGateway
  reg.exe delete $autostartKey /v $autostartName /f 2>$null | Out-Null
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
