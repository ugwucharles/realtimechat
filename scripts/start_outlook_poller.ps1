param(
  [string]$ProjectRoot = "C:\Users\cjnr5\realtime-chat"
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Error "Node.js not found in PATH" }
$script = Join-Path $ProjectRoot 'scripts\outlook_msa_poller.js'
$proc = Start-Process -FilePath $node.Source -ArgumentList $script -WorkingDirectory $ProjectRoot -NoNewWindow -PassThru
Start-Sleep -Seconds 1
$proc | Out-Null

