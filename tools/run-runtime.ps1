param(
  [string]$NodePath = "",
  [string]$Port = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $env:LOCALAPPDATA "ModelDock"
$LogPath = Join-Path $LogDir "runtime.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not $NodePath) {
  $BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $BundledNode) {
    $NodePath = $BundledNode
  } else {
    $NodePath = "node"
  }
}

$env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
$env:MOONSHOT_API_KEY = [Environment]::GetEnvironmentVariable("MOONSHOT_API_KEY", "User")
$env:KIMI_API_KEY = [Environment]::GetEnvironmentVariable("KIMI_API_KEY", "User")
$env:OPENROUTER_API_KEY = [Environment]::GetEnvironmentVariable("OPENROUTER_API_KEY", "User")
$env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "User")
if ($Port) {
  $env:MODELDOCK_PORT = $Port
}

Set-Location $RepoRoot
"[$(Get-Date -Format o)] Starting ModelDock runtime from $RepoRoot" | Out-File -FilePath $LogPath -Encoding utf8 -Append
& $NodePath (Join-Path $RepoRoot "server.mjs") *> $LogPath
