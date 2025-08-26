param(
  [string]$ProjectRoot = "C:\Users\cjnr5\realtime-chat"
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Error "Node.js not found in PATH" }
$envFile = Join-Path $ProjectRoot '.env'
$proc = Start-Process -FilePath $node.Source -ArgumentList "server.js" -WorkingDirectory $ProjectRoot -NoNewWindow -PassThru
Start-Sleep -Seconds 1
$proc | Out-Null

