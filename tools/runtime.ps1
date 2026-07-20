param(
  [ValidateSet("install", "start", "stop", "status", "uninstall")]
  [string]$Action = "status",
  [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$TaskName = "ModelDockRuntime"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$RunnerPath = Join-Path $PSScriptRoot "run-runtime.ps1"
$LogPath = Join-Path $env:LOCALAPPDATA "ModelDock\runtime.log"
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$StartupPath = Join-Path $StartupDir "ModelDockRuntime.cmd"

function Get-Listener {
  Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Stop-Listener {
  $listener = Get-Listener
  if ($listener) {
    Stop-Process -Id $listener.OwningProcess -Force
  }
}

function Test-RuntimeInstalled {
  return Test-Path -LiteralPath $StartupPath
}

function Start-RuntimeProcess {
  $commandLine = "`"$PowerShellExe`" -NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`" -Port `"$Port`""
  try {
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = $commandLine
      CurrentDirectory = [string]$RepoRoot
    } | Out-Null
  } catch {
    Start-Process -FilePath $PowerShellExe -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $RunnerPath,
      "-Port",
      [string]$Port
    ) -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
  }
}

function Write-Status {
  $listener = Get-Listener
  $runtimeInstalled = Test-RuntimeInstalled
  if ($listener) {
    $process = Get-Process -Id $listener.OwningProcess
    [pscustomobject]@{
      installed = $runtimeInstalled
      listening = $true
      port = $Port
      pid = $process.Id
      process = $process.ProcessName
      path = $process.Path
      url = "http://127.0.0.1:$Port"
      log = $LogPath
      startup = $StartupPath
    } | ConvertTo-Json -Depth 4
  } else {
    [pscustomobject]@{
      installed = $runtimeInstalled
      listening = $false
      port = $Port
      url = "http://127.0.0.1:$Port"
      log = $LogPath
      startup = $StartupPath
    } | ConvertTo-Json -Depth 4
  }
}

if ($Action -eq "install") {
  New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
  $startupText = @"
@echo off
start "ModelDock Runtime" /min "$PowerShellExe" -NoProfile -ExecutionPolicy Bypass -File "$RunnerPath" -Port "$Port"
"@
  Set-Content -LiteralPath $StartupPath -Value $startupText -Encoding ASCII
  Start-RuntimeProcess
  Start-Sleep -Milliseconds 800
  Write-Status
  exit
}

if ($Action -eq "start") {
  Start-RuntimeProcess
  Start-Sleep -Milliseconds 800
  Write-Status
  exit
}

if ($Action -eq "stop") {
  Stop-Listener
  Start-Sleep -Milliseconds 300
  Write-Status
  exit
}

if ($Action -eq "uninstall") {
  Stop-Listener
  Remove-Item -LiteralPath $StartupPath -ErrorAction SilentlyContinue
  Write-Status
  exit
}

Write-Status
