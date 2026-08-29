# ModelDock recovery. Without switches it shows the manual menu; the updater
# uses -RollbackOnFailure to supervise a newly deployed version silently.

param(
  [switch]$RollbackOnFailure,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
# Restart failures are inspected through $LASTEXITCODE so this supervisor can
# restore the snapshot. Do not let PowerShell 7 convert them into a throw first.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
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
      $restore = [bool]$entry.existed
      $currentExisted = Test-Path -LiteralPath $target -PathType Leaf
      # File.Replace creates the backup itself when restoring over an existing
      # file. For a deletion rollback we still need an explicit copy because
      # there is no replacement operation to generate one.
      if ($currentExisted -and -not $restore) { Copy-Item -LiteralPath $target -Destination $current -Force }
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
          [System.IO.File]::Replace($item.Stage, $item.Target, $item.Current)
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
  $restartArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $restart)
  if ($Force) { $restartArgs += "-Force" }
  & powershell @restartArgs
  $restartExit = $LASTEXITCODE
  if ($restartExit -ne 0) {
    # A refusal means we never established ownership of the listener. Do not
    # replace a version set while an unrelated process may still be serving.
    if ($restartExit -eq 2 -or $restartExit -eq 3) {
      throw "gateway restart was refused before a replacement could be verified"
    }
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
  # Same resolution as restart.ps1 and caller-key.mjs: the gateway writes the
  # key to ~/.modeldock/caller-key unless MODELDOCK_STATE_DIR redirects it.
  # <root>\caller-key only coincided for installed layouts (root IS
  # ~\.modeldock); on a git checkout the lookup missed, the request went out
  # unauthenticated, and Restore-Native silently fell back to the cruder
  # local-backup path.
  $keyFile = if ($env:MODELDOCK_STATE_DIR) { Join-Path $env:MODELDOCK_STATE_DIR "caller-key" } else { Join-Path $env:USERPROFILE ".modeldock\caller-key" }
  $headers = @{}
  if (Test-Path -LiteralPath $keyFile) {
    $key = (Get-Content -LiteralPath $keyFile -Raw).Trim()
    if ($key) { $headers["x-modeldock-key"] = $key }
  }
  try {
    Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -TimeoutSec 3 | Out-Null
    Write-Output "Codex native route restored through the running gateway."
    return
  } catch {
    Write-Output "Gateway is unavailable; restoring from the local backup."
  }

  $codexHome = if ($env:MODELDOCK_CODEX_HOME) { $env:MODELDOCK_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
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

if ($RollbackOnFailure) {
  try {
    Restart-Gateway
  } catch {
    Write-Error $_.Exception.Message
    exit 1
  }
  exit 0
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
