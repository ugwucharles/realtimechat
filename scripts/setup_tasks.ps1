param(
  [string]$ProjectRoot = "C:\Users\cjnr5\realtime-chat"
)
$ErrorActionPreference = 'Stop'

$serverScript = Join-Path $ProjectRoot 'scripts\start_server.ps1'
$pollerScript = Join-Path $ProjectRoot 'scripts\start_outlook_poller.ps1'

if (-not (Test-Path -LiteralPath $serverScript)) { throw "Missing $serverScript" }
if (-not (Test-Path -LiteralPath $pollerScript)) { throw "Missing $pollerScript" }

$serverCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$serverScript`""
$pollerCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$pollerScript`""

# Create or update scheduled tasks to run at user logon
$tasks = @(
  @{ Name = 'RealtimeChat_Server';  Cmd = $serverCmd },
  @{ Name = 'RealtimeChat_OutlookPoller'; Cmd = $pollerCmd }
)

foreach ($t in $tasks) {
  # Delete if exists (ignore errors)
  try { schtasks.exe /Delete /F /TN $t.Name 2>$null | Out-Null } catch {}
  # Create task to run at user logon
  schtasks.exe /Create /SC ONLOGON /RL LIMITED /TN $t.Name /TR $t.Cmd /F | Out-Null
}

Write-Output 'OK'
