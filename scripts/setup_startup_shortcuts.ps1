param(
  [string]$ProjectRoot = "C:\Users\cjnr5\realtime-chat"
)
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$server = Join-Path $ProjectRoot 'scripts\start_server.ps1'
$poller = Join-Path $ProjectRoot 'scripts\start_outlook_poller.ps1'

# Create simple cmd wrappers (shortcuts are harder in pure PS without COM)
$serverCmd = Join-Path $startup 'realtime-chat-server.cmd'
$pollerCmd = Join-Path $startup 'realtime-chat-poller.cmd'

@(
  @{Path=$serverCmd; Target=$server},
  @{Path=$pollerCmd; Target=$poller}
) | ForEach-Object {
  $line = '@echo off' + "`r`n" + 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $_.Target + '"'
  Set-Content -LiteralPath $_.Path -Value $line -Encoding ASCII
}

'OK'
