# ModelDock installer (Windows).
#
# User-side bootstrap: runs BEFORE Node is guaranteed to exist, so it must stay a
# plain PowerShell script (an .mjs installer would need Node already - chicken and egg).
#
#   $installer = Join-Path $env:TEMP "modeldock-install.ps1"
#   Invoke-WebRequest -UseBasicParsing "https://github.com/architectds/modeldock/releases/latest/download/install.ps1" -OutFile $installer
#   powershell -NoProfile -ExecutionPolicy Bypass -File $installer
#
# What it does:
#   1. Use Node >= 24 (a bundled copy under <root>\node wins, then PATH). If none
#      is found, download the latest Node 24 LTS zip from nodejs.org, verify its
#      SHA256 and unpack it under <root>\node so the install is self-contained.
#   2. Lay out the install dir at ~\.modeldock: dist\modeldock.mjs (downloaded from the
#      newest GitHub Release) + scripts\start-hidden.ps1 (hidden launcher used by the
#      dashboard's start-at-login toggle and the one-click updater).
#   3. Start ModelDock hidden (skipped if one is already running) and open the dashboard.
# Tokens are NOT asked for here - the dashboard opens its Settings dialog on first run.
#
# Overrides (optional; used by the mock-install test and mirror deployments):
#   MODELDOCK_ROOT          install directory             (default: ~\.modeldock)
#   MODELDOCK_REPO          GitHub repo                   (default: architectds/modeldock)
#   MODELDOCK_RELEASE_URL   direct asset URL (overrides MODELDOCK_REPO)
#   MODELDOCK_SKILL_BASE_URL  base URL for the content-to-video skill files
#                             (default: raw.githubusercontent.com/<repo>/main/skills/content-to-video)
#   MODELDOCK_CODEX_HOME     Codex home dir (default: ~\.codex; skills land in
#                             <codexHome>\skills\content-to-video)
#   MODELDOCK_PORT          dashboard port                (default: 4097)
#   MODELDOCK_NODE_PATH     absolute path to a node executable to prefer
#   MODELDOCK_FORCE_NODE_DOWNLOAD  set to "1" to always (re)install the bundled node
#   MODELDOCK_NODE_VERSION  pin a Node version, e.g. "24.5.0" (default: latest 24 LTS)
#   MODELDOCK_NODE_BASE_URL mirror of https://nodejs.org/dist (tests/mirrors)
#   MODELDOCK_SKIP_START    set to "1" to lay out files without starting the gateway
#   MODELDOCK_SKIP_OPEN     set to "1" to not open a browser

$ErrorActionPreference = "Stop"
$repo = if ($env:MODELDOCK_REPO) { $env:MODELDOCK_REPO } else { "architectds/modeldock" }
$port = if ($env:MODELDOCK_PORT) { [int]$env:MODELDOCK_PORT } else { 4097 }
$root = if ($env:MODELDOCK_ROOT) { $env:MODELDOCK_ROOT } else { Join-Path $env:USERPROFILE ".modeldock" }
$releaseUrl = if ($env:MODELDOCK_RELEASE_URL) { $env:MODELDOCK_RELEASE_URL } else { "https://github.com/$repo/releases/latest/download/modeldock.mjs" }
$skipOpen = ($env:MODELDOCK_SKIP_OPEN -eq "1")
$skipStart = ($env:MODELDOCK_SKIP_START -eq "1")
$ProgressPreference = "SilentlyContinue"

Write-Host "ModelDock installer" -ForegroundColor Cyan

# 1. Node >= 24. Prefer an explicit path, then a bundled Node (installed here on a
#    previous run, or by the download step below), then a PATH node. When nothing
#    suitable exists, download the latest Node 24 LTS zip, verify its SHA256 and
#    unpack it under <root>\node - the launcher and restart script resolve the same
#    bundled-first way, so the installed layout stays self-contained.
$nodeExe = $null
$systemNodeVersion = $null
$managedNodeUpgrade = $false
$nodeMigrationNeeded = $false
$explicitNodeWasManaged = $false
$nodeDownloaded = $false
if ($env:MODELDOCK_NODE_PATH -and (Test-Path -LiteralPath $env:MODELDOCK_NODE_PATH)) {
    try {
        $v = (& $env:MODELDOCK_NODE_PATH --version) 2>$null
        if ($v -match "^v(\d+)\." -and [int]$Matches[1] -ge 24) { $nodeExe = $env:MODELDOCK_NODE_PATH }
    } catch {}
    $explicitNode = [System.IO.Path]::GetFullPath($env:MODELDOCK_NODE_PATH)
    $managedNodeRoot = [System.IO.Path]::GetFullPath((Join-Path $root "node")) + [System.IO.Path]::DirectorySeparatorChar
    $explicitNodeWasManaged = $explicitNode.StartsWith($managedNodeRoot, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $nodeExe -and $explicitNodeWasManaged) {
        $managedNodeUpgrade = $true
        $nodeMigrationNeeded = $true
    } elseif (-not $nodeExe) {
        throw "MODELDOCK_NODE_PATH must point to Node.js 24 or newer: $($env:MODELDOCK_NODE_PATH)"
    }
}
$bundledDirs = @(Get-ChildItem -LiteralPath (Join-Path $root "node") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "^v\d+\.\d+\.\d+$" })
if (@($bundledDirs | Where-Object { $_.Name -match "^v(\d+)\." -and [int]$Matches[1] -lt 24 }).Count -gt 0) {
    # Do not leave an old bundled runtime behind an external Node 24 path: the
    # login launcher is bundled-first and would otherwise select Node 22 later.
    $nodeMigrationNeeded = $true
    $managedNodeUpgrade = $true
    $nodeExe = $null
}
if (-not $nodeExe -and (-not $env:MODELDOCK_NODE_PATH -or $explicitNodeWasManaged -or $managedNodeUpgrade)) {
    $bestDir = @($bundledDirs |
        Where-Object { $_.Name -match "^v(\d+)\.\d+\.\d+$" -and [int]$Matches[1] -ge 24 } |
        Sort-Object @{ Expression = {
                if ($_.Name -match "^v(\d+)\.(\d+)\.(\d+)$") { [long]$Matches[1] * 1000000 + [long]$Matches[2] * 1000 + [long]$Matches[3] } else { -1 }
            }; Descending = $true } |
        Select-Object -First 1)
    if ($bestDir -and (Test-Path -LiteralPath (Join-Path $bestDir.FullName "node.exe"))) {
        $nodeExe = Join-Path $bestDir.FullName "node.exe"
    }
    if ($bundledDirs.Count -gt 0 -and -not $nodeExe) { $managedNodeUpgrade = $true }
}
if (-not $nodeExe -and -not $managedNodeUpgrade) {
    try {
        $v = (& node --version) 2>$null
        if ($v -match "^v(\d+)\." -and [int]$Matches[1] -ge 24) {
            $systemNodeVersion = $v
            $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        }
    } catch {}
}
if ($env:MODELDOCK_FORCE_NODE_DOWNLOAD -eq "1") { $nodeExe = $null }
if (-not $nodeExe) {
    try {
        $nodeBase = if ($env:MODELDOCK_NODE_BASE_URL) { $env:MODELDOCK_NODE_BASE_URL } else { "https://nodejs.org/dist" }
        $nodeVer = $env:MODELDOCK_NODE_VERSION
        if ($nodeVer -and -not $nodeVer.StartsWith("v")) { $nodeVer = "v" + $nodeVer }
        if (-not $nodeVer) {
            Write-Host "  resolving latest Node 24 LTS..."
            $index = Invoke-RestMethod -Uri "$nodeBase/index.json" -TimeoutSec 30
            foreach ($entry in $index) {
                if ($entry.lts -and $entry.version -match "^v24\.\d+\.\d+$") { $nodeVer = $entry.version; break }
            }
        }
        if (-not $nodeVer -or $nodeVer -notmatch "^v\d+\.\d+\.\d+$") {
            throw "Could not resolve a Node 24 LTS version from $nodeBase/index.json (set MODELDOCK_NODE_VERSION to pin one)"
        }
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
        $zipName = "node-$nodeVer-win-$arch.zip"
        $stageDir = Join-Path $root "node\.tmp-$nodeVer"
        $targetDir = Join-Path $root "node\$nodeVer"
        New-Item -ItemType Directory -Force $stageDir | Out-Null
        try {
            Write-Host ("  downloading {0} ..." -f $zipName)
            Invoke-WebRequest -UseBasicParsing -Uri "$nodeBase/$nodeVer/$zipName" -OutFile (Join-Path $stageDir $zipName)
            Write-Host "  verifying SHA256..."
            $shas = (Invoke-WebRequest -UseBasicParsing -Uri "$nodeBase/$nodeVer/SHASUMS256.txt" -TimeoutSec 30).Content
            $expected = $null
            foreach ($line in ($shas -split "`r?`n")) {
                if ($line -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($zipName))\s*$") { $expected = $Matches[1]; break }
            }
            if (-not $expected) { throw "SHA256 for $zipName not found in SHASUMS256.txt" }
              # Get-FileHash is unavailable in some PowerShell environments (e.g.
              # GitHub Actions runners), so compute the digest with .NET directly.
              $hasher = [System.Security.Cryptography.SHA256]::Create()
              $actual = [System.BitConverter]::ToString(
                $hasher.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path $stageDir $zipName)))
              ).Replace("-", "").ToLowerInvariant()
              if ($actual -ne $expected.ToLowerInvariant()) { throw "SHA256 mismatch for $zipName (expected $expected)" }
            Write-Host "  extracting..."
            Expand-Archive -LiteralPath (Join-Path $stageDir $zipName) -DestinationPath $stageDir -Force
            $extracted = Join-Path $stageDir "node-$nodeVer-win-$arch"
            if (-not (Test-Path -LiteralPath (Join-Path $extracted "node.exe"))) { throw "Extracted archive is missing node.exe" }
            if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
            Move-Item -LiteralPath $extracted -Destination $targetDir
            $nodeExe = Join-Path $targetDir "node.exe"
            $nodeDownloaded = $true
            $nodeMigrationNeeded = $true
            Write-Host ("  bundled node {0} installed at {1}" -f $nodeVer, $targetDir)
        } finally {
            Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Host ""
        Write-Host ("Could not download Node automatically: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
        $nodeExe = $null
    }
}
$env:MODELDOCK_NODE_PATH = $nodeExe
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
    Write-Host ""
    Write-Host "Node.js 24 or newer is required but could not be installed automatically." -ForegroundColor Yellow
    Write-Host "Install the LTS version from https://nodejs.org , reopen your terminal,"
    Write-Host "then run this installer again."
    if (-not $skipOpen) { Start-Process "https://nodejs.org" }
    exit 1
}
if ($systemNodeVersion) { Write-Host "  node $systemNodeVersion - OK" }
else { Write-Host "  node $nodeExe - OK" }

# The dashboard updater uses this mode to migrate the managed runtime without
# touching the installed bundle. After the old bridge restarts on Node 24, the
# updater performs its normal verified atomic deployment directly to latest.
if ($env:MODELDOCK_RUNTIME_ONLY -eq "1") {
    if ($skipStart) {
        Write-Host "  Node runtime migration complete; gateway restart skipped."
    } else {
        $runtimeRestart = Join-Path $root "scripts\restart.ps1"
        if (-not (Test-Path -LiteralPath $runtimeRestart)) { throw "restart.ps1 is missing from $root" }
        Write-Host "  restarting ModelDock on the migrated Node runtime..."
        & powershell -NoProfile -ExecutionPolicy Bypass -File $runtimeRestart -Force
        if ($LASTEXITCODE -ne 0) { throw "ModelDock restart failed after the Node runtime migration" }
    }
    if ($env:MODELDOCK_INSTALLER_TEMP) {
        Remove-Item -LiteralPath $env:MODELDOCK_INSTALLER_TEMP -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

# 2. Install layout
New-Item -ItemType Directory -Force (Join-Path $root "dist") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $root "scripts") | Out-Null

$bundle = Join-Path $root "dist\modeldock.mjs"
Write-Host "  downloading latest release bundle..."
Invoke-WebRequest -UseBasicParsing -Uri $releaseUrl -OutFile $bundle
Write-Host ("  saved {0} ({1:N1} MB)" -f $bundle, ((Get-Item $bundle).Length / 1MB))
$bridgeUrl = if ($env:MODELDOCK_BRIDGE_URL) { $env:MODELDOCK_BRIDGE_URL } else { "https://github.com/$repo/releases/latest/download/mcp-standalone.mjs" }
$bridge = Join-Path $root "dist\mcp-standalone.mjs"
Write-Host "  downloading MCP stdio bridge..."
Invoke-WebRequest -UseBasicParsing -Uri $bridgeUrl -OutFile $bridge
Write-Host ("  saved {0} ({1:N2} MB)" -f $bridge, ((Get-Item $bridge).Length / 1MB))

# Integrity: releases publish a SHA256SUMS covering every asset. Verify the two
# files we just downloaded against it and refuse to leave a corrupt install
# behind. MODELDOCK_SUMS_URL redirects the lookup (mock-install tests).
$sumsUrl = if ($env:MODELDOCK_SUMS_URL) { $env:MODELDOCK_SUMS_URL } else { "https://github.com/$repo/releases/latest/download/SHA256SUMS" }
function Assert-Downloaded([string]$file, [string]$name) {
  # GitHub serves release assets without a text extension as
  # application/octet-stream, and Windows PowerShell 5.1 then exposes .Content
  # as a byte[] instead of a string. Normalize to UTF-8 text before matching,
  # or every checksum lookup would fail with "no entry" against the real feed.
  $sumsResponse = Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl -TimeoutSec 60
  $sumsText = if ($sumsResponse.Content -is [byte[]]) {
    [System.Text.Encoding]::UTF8.GetString([byte[]]$sumsResponse.Content)
  } else {
    [string]$sumsResponse.Content
  }
  $line = ($sumsText -split "`r?`n") | Where-Object { $_ -match "(?i)^[0-9a-f]{64}\s+\*?$([regex]::Escape($name))\s*$" } | Select-Object -First 1
  if (-not $line) {
    Remove-Item -LiteralPath $file -Force
    throw "SHA256SUMS has no entry for $name; refusing to keep an unverified download"
  }
  $expected = ($line -split '\s+')[0].ToLowerInvariant()
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $actual = [System.BitConverter]::ToString(
      $hasher.ComputeHash([System.IO.File]::ReadAllBytes($file))
    ).Replace("-", "").ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
  if ($actual -ne $expected) {
    Remove-Item -LiteralPath $file -Force
    throw "Checksum mismatch for $name (expected $expected, got $actual)"
  }
}
Assert-Downloaded $bundle "modeldock.mjs"
Assert-Downloaded $bridge "mcp-standalone.mjs"
Write-Host "  release assets verified against SHA256SUMS"

# Hidden launcher (same content as the repo's scripts/start-hidden.ps1). Written by the
# installer so a single-file download still gets autostart + self-update restarts.
$launcher = Join-Path $root "scripts\start-hidden.ps1"
@'
# Start the ModelDock gateway hidden (no console window) with the package root as the
# working directory. Used by the autostart Run key entry and by dashboard.bat.
# Prefers the built single-file bundle (dist/modeldock.mjs), rebuilding it first when a
# source checkout has drifted ahead; falls back to the source entry in a git checkout.
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
'@ | Out-File -FilePath $launcher -Encoding ascii

# Restart script (same content as the repo's scripts/restart.ps1). Written by the
# installer so the model-facing "Restarting the gateway" instruction baked into the
# catalog resolves to a real file in the installed layout.
$restart = Join-Path $root "scripts\restart.ps1"
@'
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

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

# Status lines go to both stdout and stderr. Callers (CI, the model shell, the
# dashboard) sometimes capture only one stream; a hidden launcher must never
# fail silently.
function Write-Status($message) {
  Write-Output $message
  [Console]::Error.WriteLine($message)
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
  exit 1
}

# A source checkout must never serve a stale bundle - and never silently serve
# the src/ entry users do not have. Rebuild dist when source is newer than the
# bundle, so the gateway runs the same artifact users install. Installed layouts
# have no src/ at all (the self-updater owns dist there), and an applied update
# makes dist newer than src, so this is a no-op for real installs and never
# clobbers an update. A failed rebuild is loud but not fatal: the gateway still
# starts on the best bundle available and the log records exactly what ran.
$buildIfStale = Join-Path $root "scripts\build-if-stale.mjs"
if ((Test-Path -LiteralPath (Join-Path $root "src\server.mjs")) -and (Test-Path -LiteralPath $buildIfStale)) {
  & $nodeExe $buildIfStale
  if ($LASTEXITCODE -ne 0) {
    Write-Status "WARNING: source is newer than dist/modeldock.mjs but the rebuild failed; starting anyway (run npm run build to refresh the bundle before trusting local results)."
  }
}

# Prefer the built bundle, falling back to the source entry in a git checkout.
# This must match start-hidden.ps1 exactly: the two used to disagree (this script
# preferred src while the launcher preferred dist), so a checkout served one
# version on restart and another at login. dist wins because the self-updater
# writes dist/modeldock.mjs and never touches src - preferring src would leave an
# applied update permanently unused, and the Update button permanently lit.
$server = Join-Path $root "dist\modeldock.mjs"
if (-not (Test-Path -LiteralPath $server)) { $server = Join-Path $root "src\server.mjs" }

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
Write-Status "restart.ps1: started gateway from $root using $server (logs: $log)"
exit 0
'@ | Out-File -FilePath $restart -Encoding ascii

# Manual recovery menu: restart the gateway or restore the native Codex route.
$recover = Join-Path $root "scripts\recover.ps1"
@'
# ModelDock manual recovery menu.
# Choose gateway restart or restore the last native Codex configuration.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
# Seed from the environment before consulting .env, matching recover.sh and
# restart.ps1. Reading only .env meant a gateway told to use another port by
# environment was recovered against 4097 instead - acting on whatever unrelated
# process happened to hold the default port.
$port = 4097
$envPort = 0
if ($env:MODELDOCK_PORT -and [int]::TryParse($env:MODELDOCK_PORT, [ref]$envPort) -and $envPort -gt 0) {
  $port = $envPort
}
$envFile = Join-Path $root ".env"
if (Test-Path -LiteralPath $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  $parsed = 0
  if ($line -and [int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) {
    $port = $parsed
  }
}

# Start-at-login repair: when a start-at-login decision was recorded (the mark
# exists) but the Run key is gone - registry cleanup, or an earlier toggle-off that
# deleted the key - re-write the login entry before restarting the gateway.
# By design autostart is a re-asserted default: the gateway re-enables it on every
# version change (see initAutostartDefault), and this repair restores it on every
# recover run as well. A toggle-off is therefore NOT permanent across a recover or
# an update - to keep it off, turn it off again afterward. Only a missing mark (no
# decision ever recorded) is left untouched.
$autostartKeyName = if ($env:MODELDOCK_AUTOSTART_KEY) { $env:MODELDOCK_AUTOSTART_KEY } else { "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" }
$autostartValueName = if ($env:MODELDOCK_AUTOSTART_NAME) { $env:MODELDOCK_AUTOSTART_NAME } else { "ModelDock" }
$autostartStateDir = if ($env:MODELDOCK_STATE_DIR) { $env:MODELDOCK_STATE_DIR } else { $root }
$autostartMark = Join-Path $autostartStateDir "autostart-initialized"

function Repair-Autostart {
  if (-not (Test-Path -LiteralPath $autostartMark)) { return }
  $subKey = $autostartKeyName
  if ($subKey -like "HKEY_CURRENT_USER\*") { $subKey = $subKey.Substring("HKEY_CURRENT_USER\".Length) }
  elseif ($subKey -like "HKCU\*") { $subKey = $subKey.Substring("HKCU\".Length) }
  $runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey)
  try {
    if ($runKey -and ($null -ne $runKey.GetValue($autostartValueName, $null))) {
      Write-Output "  start at login: OK"
      return
    }
  } finally { if ($runKey) { $runKey.Close() } }
  $launcher = Join-Path $root "scripts\start-hidden.ps1"
  if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Warning "  start at login: launcher missing ($launcher); not repairing"
    return
  }
  $runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
  try {
    $runCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
    $runKey.SetValue($autostartValueName, $runCommand, [Microsoft.Win32.RegistryValueKind]::String)
    Write-Output "  start at login was missing - re-enabled"
  } finally { if ($runKey) { $runKey.Close() } }
}

function Restore-PreviousUpdate {
  $rollbackRoot = Join-Path $root ".modeldock-rollback"
  $marker = Join-Path $rollbackRoot "current"
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
  $name = [System.IO.File]::ReadAllText($marker).Trim()
  if (-not $name -or [System.IO.Path]::GetFileName($name) -ne $name) { throw "invalid update rollback marker" }
  $rollbackDir = Join-Path $rollbackRoot $name
  $manifestPath = Join-Path $rollbackDir "manifest.json"
  $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  $rootPrefix = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  $rollbackPrefix = [System.IO.Path]::GetFullPath($rollbackDir).TrimEnd('\') + '\'
  $prepared = @()
  $applied = 0
  try {
    foreach ($entry in $manifest.files) {
      $relative = ([string]$entry.path).Replace('/', '\')
      $target = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
      if (-not $target.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "rollback path escaped install root: $relative"
      }
      $stage = "$target.rollback-stage-$PID"
      $current = "$target.rollback-current-$PID"
      Remove-Item -LiteralPath $stage, $current -Force -ErrorAction SilentlyContinue
      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
      $currentExisted = Test-Path -LiteralPath $target -PathType Leaf
      if ($currentExisted) { Copy-Item -LiteralPath $target -Destination $current -Force }
      $restore = [bool]$entry.existed
      if ($restore) {
        $source = [System.IO.Path]::GetFullPath((Join-Path $rollbackDir $relative))
        if (-not $source.StartsWith($rollbackPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $source -PathType Leaf)) {
          throw "rollback file is missing: $relative"
        }
        Copy-Item -LiteralPath $source -Destination $stage -Force
      }
      $prepared += [pscustomobject]@{ Target = $target; Stage = $stage; Current = $current; CurrentExisted = $currentExisted; Restore = $restore }
    }
    foreach ($item in $prepared) {
      if ($item.Restore) {
        if (Test-Path -LiteralPath $item.Target -PathType Leaf) {
          [System.IO.File]::Replace($item.Stage, $item.Target, $null)
        } else {
          Move-Item -LiteralPath $item.Stage -Destination $item.Target
        }
      } elseif (Test-Path -LiteralPath $item.Target) {
        Remove-Item -LiteralPath $item.Target -Force
      }
      $applied += 1
    }
  } catch {
    for ($index = $applied - 1; $index -ge 0; $index -= 1) {
      $item = $prepared[$index]
      if ($item.CurrentExisted) { Copy-Item -LiteralPath $item.Current -Destination $item.Target -Force }
      else { Remove-Item -LiteralPath $item.Target -Force -ErrorAction SilentlyContinue }
    }
    throw
  } finally {
    foreach ($item in $prepared) {
      Remove-Item -LiteralPath $item.Stage, $item.Current -Force -ErrorAction SilentlyContinue
    }
  }
  return $true
}

function Restart-Gateway {
  Repair-Autostart
  $restart = Join-Path $root "scripts\restart.ps1"
  if (-not (Test-Path -LiteralPath $restart)) {
    throw "restart.ps1 is missing from $root"
  }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $restart
  if ($LASTEXITCODE -ne 0) {
    # A bundle and its bridge/lifecycle helpers are one versioned unit. Restore
    # the complete snapshot transactionally before retrying the old restart.
    if (Restore-PreviousUpdate) {
      Write-Output "New installed version did not become healthy; restored the complete previous version set."
      & powershell -NoProfile -ExecutionPolicy Bypass -File $restart
      if ($LASTEXITCODE -eq 0) { return }
    }
    throw "gateway restart failed"
  }
}

function Restore-Native {
  $uri = "http://127.0.0.1:$port/api/config/disable"
  try {
    Invoke-RestMethod -Method Post -Uri $uri -TimeoutSec 3 | Out-Null
    Write-Output "Codex native route restored through the running gateway."
    return
  } catch {
    Write-Output "Gateway is unavailable; restoring from the local backup."
  }

  $codexHome = if ($env:MODELDOCK_CODEX_HOME) { $env:MODELDOCK_CODEX_HOME } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
  $statePath = Join-Path $codexHome "modeldock\config-switch-state.json"
  if (-not (Test-Path -LiteralPath $statePath)) { throw "ModelDock switch state was not found: $statePath" }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if (-not $state.enabled) {
    Write-Output "Codex is already on the native route."
    return
  }
  $backup = [System.IO.Path]::GetFullPath([string]$state.backupPath)
  if (-not (Test-Path -LiteralPath $backup)) { throw "ModelDock backup is missing: $backup" }
  $config = Join-Path $codexHome "config.toml"
  if (Test-Path -LiteralPath $config) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -LiteralPath $config -Destination "$config.native-recovery-$stamp.bak"
    if (-not $state.originalExisted) { Remove-Item -LiteralPath $config -Force }
    else { Copy-Item -LiteralPath $backup -Destination $config -Force }
  } elseif ($state.originalExisted) {
    Copy-Item -LiteralPath $backup -Destination $config -Force
  }
  # Rebuild the state as a fresh ordered map: Windows PowerShell 5.1 throws when a
  # property that ConvertFrom-Json did not create (here lastBackupPath) is set via
  # dot assignment, so copy the existing keys and override the ones we change.
  $out = [ordered]@{}
  foreach ($p in $state.PSObject.Properties) { $out[$p.Name] = $p.Value }
  $out['enabled'] = $false
  $out['restartRequired'] = $true
  $out['lastBackupPath'] = $backup
  $out['changedAt'] = (Get-Date).ToUniversalTime().ToString("o")
  $tmp = "$statePath.$PID.tmp"
  # Write UTF-8 without a BOM: the gateway reads this file with Node's utf8 and a
  # BOM would make JSON.parse fail (Set-Content -Encoding utf8 emits a BOM on 5.1).
  [System.IO.File]::WriteAllText($tmp, ($out | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $statePath -Force
  Write-Output "Codex native route restored from $backup"
  Write-Output "Fully quit and restart Codex."
}

Write-Output ""
Write-Output "ModelDock manual recovery"
Write-Output "1. Restart ModelDock gateway"
Write-Output "2. Restore Codex native route"
Write-Output "Q. Quit"
$choice = (Read-Host "Choose 1, 2, or Q").Trim().ToUpperInvariant()
try {
  if ($choice -eq "1") { Restart-Gateway }
  elseif ($choice -eq "2") { Restore-Native }
  elseif ($choice -eq "Q" -or $choice -eq "") { exit 0 }
  else { throw "Unknown choice: $choice" }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
'@ | Out-File -FilePath $recover -Encoding ascii

# 2.5. Install the content-to-video skill into the Codex skills directory.
# The skill is small (18 text files, ~0.1 MB) and ships as source in the repo,
# so the installer mirrors the same files from GitHub raw instead of bundling
# an archive. The skill is additive: a download failure warns and continues,
# it never fails the install.
$codexHome = if ($env:MODELDOCK_CODEX_HOME) { $env:MODELDOCK_CODEX_HOME } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$skillBase = if ($env:MODELDOCK_SKILL_BASE_URL) { $env:MODELDOCK_SKILL_BASE_URL } else { "https://raw.githubusercontent.com/$repo/main/skills/content-to-video" }
$skillDest = Join-Path $codexHome "skills\content-to-video"
$skillFiles = @(
    "SKILL.md",
    "agents/openai.yaml",
    "references/beat-sync.md",
    "references/classification.md",
    "references/hyperframes.md",
    "references/methodology.md",
    "references/pipeline.md",
    "references/pipelines.md",
    "references/quality.md",
    "references/sound-design.md",
    "references/sprites.md",
    "references/tech-stack.md",
    "scripts/build_film.py",
    "scripts/classify.mjs",
    "scripts/preview-scenes.mjs",
    "scripts/qa-frames.mjs",
    "scripts/render-clip.mjs",
    "scripts/static-server-range.mjs"
)
try {
    New-Item -ItemType Directory -Force $skillDest | Out-Null
    foreach ($rel in $skillFiles) {
        $dest = Join-Path $skillDest ($rel -replace "/", "\")
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$skillBase/$rel" -OutFile $dest -TimeoutSec 20
        } catch {
            Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
            Write-Warning "  could not download skill file $rel : $($_.Exception.Message)"
        }
    }
    Write-Host "  content-to-video skill installed to $skillDest"
} catch {
    Write-Warning "  could not install content-to-video skill: $($_.Exception.Message)"
}

# 3. Enable login autostart on a first install. The gateway also has this
#    safeguard, but doing it here makes the install result deterministic even
#    when the first background start is delayed or fails. The marker preserves
#    an explicit user choice across later reinstalls. Tests redirect the registry
#    key and state dir through MODELDOCK_AUTOSTART_KEY / _NAME and
#    MODELDOCK_STATE_DIR so mock installs never touch the real login entry.
$autostartKeyName = if ($env:MODELDOCK_AUTOSTART_KEY) { $env:MODELDOCK_AUTOSTART_KEY } else { "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" }
$autostartValueName = if ($env:MODELDOCK_AUTOSTART_NAME) { $env:MODELDOCK_AUTOSTART_NAME } else { "ModelDock" }
$stateDir = if ($env:MODELDOCK_STATE_DIR) { $env:MODELDOCK_STATE_DIR } else { $root }
$autostartMark = Join-Path $stateDir "autostart-initialized"
if (-not $skipStart -and -not (Test-Path -LiteralPath $autostartMark)) {
    try {
        # .NET registry APIs take the subkey path below a base hive, not the
        # "HKCU\"-prefixed form reg.exe accepts.
        $subKey = $autostartKeyName
        if ($subKey -like "HKEY_CURRENT_USER\*") { $subKey = $subKey.Substring("HKEY_CURRENT_USER\".Length) }
        elseif ($subKey -like "HKCU\*") { $subKey = $subKey.Substring("HKCU\".Length) }
        $runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
        try {
            $runCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
            $runKey.SetValue($autostartValueName, $runCommand, [Microsoft.Win32.RegistryValueKind]::String)
        } finally {
            if ($runKey) { $runKey.Close() }
        }
        New-Item -ItemType Directory -Force $stateDir | Out-Null
        [System.IO.File]::WriteAllText($autostartMark, "$([DateTime]::UtcNow.ToString('o'))`n", [System.Text.Encoding]::ASCII)
        Write-Host "  start at login enabled (default)"
    } catch {
        Write-Warning ("Could not enable start at login during install: {0}" -f $_.Exception.Message)
    }
}

# 4. Start (unless already running) and open the dashboard. MODELDOCK_SKIP_START=1
#    skips the launch entirely (used by the install mock test, which feeds the
#    installer a fake node.exe that Windows cannot execute).
if ($skipStart) {
    Write-Host "  MODELDOCK_SKIP_START=1 - not starting the gateway."
} else {
    $running = $false
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
        $running = $true
    } catch {
        # /healthz answers 503 until a token is configured - that still means running
        if ($_.Exception.Response) { $running = $true }
    }
    if ($running -and ($nodeDownloaded -or $nodeMigrationNeeded)) {
        Write-Host "  restarting ModelDock on the new Node runtime..."
        & powershell -NoProfile -ExecutionPolicy Bypass -File $restart -Force
    } elseif ($running) {
        Write-Host "  ModelDock is already running on port $port - keeping it."
    } else {
        Write-Host "  starting ModelDock in the background..."
        & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
        Start-Sleep -Seconds 3
    }
}

Write-Host ""
Write-Host "Done. Dashboard: http://127.0.0.1:$port" -ForegroundColor Green
Write-Host "First run: paste your API token into the Settings dialog that opens automatically."
Write-Host "Start at login is enabled by default; you can turn it off in Settings."
if (-not $skipOpen) { Start-Process "http://127.0.0.1:$port/?settings=1" }
