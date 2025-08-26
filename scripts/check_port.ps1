param(
  [int]$Port = 3000
)
$ErrorActionPreference = 'Stop'
try {
  $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { 'LISTENING' } else { 'FREE' }
} catch {
  'FREE'
}
