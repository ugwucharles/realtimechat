param(
  [string]$ProjectRoot = "C:\Users\cjnr5\realtime-chat"
)
$ErrorActionPreference = 'Stop'

function Stop-ByMatch([string]$pattern) {
  $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match $pattern }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
  }
}

# Stop existing server and poller if running
Stop-ByMatch 'server\.js'
Stop-ByMatch 'outlook_msa_poller\.js'

# Start fresh instances
$serverScript = Join-Path $ProjectRoot 'scripts\start_server.ps1'
$pollerScript = Join-Path $ProjectRoot 'scripts\start_outlook_poller.ps1'
if (-not (Test-Path -LiteralPath $serverScript)) { throw "Missing $serverScript" }
if (-not (Test-Path -LiteralPath $pollerScript)) { throw "Missing $pollerScript" }

Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile','-ExecutionPolicy','Bypass','-File', $serverScript) -WorkingDirectory $ProjectRoot | Out-Null
Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile','-ExecutionPolicy','Bypass','-File', $pollerScript) -WorkingDirectory $ProjectRoot | Out-Null

'RESTARTED'
