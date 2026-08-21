# Daily retention cleanup for the local ModelDock test sandbox. Wired to the
# Windows scheduled task "ModelDockSandboxCleanup" so stale test fixtures
# older than MODELDOCK_SANDBOX_MAX_AGE_DAYS (default 1) get removed on their
# own instead of piling up on the C: drive.
if (-not $env:MODELDOCK_SANDBOX_DIR) {
  $env:MODELDOCK_SANDBOX_DIR = 'E:\modeldock-sandbox\tmp'
}
& node (Join-Path $PSScriptRoot 'cleanup-sandbox.mjs')
exit $LASTEXITCODE
