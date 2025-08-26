$ErrorActionPreference = 'Stop'
try {
  $p = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match 'outlook_msa_poller\.js' } | Select-Object -First 1
  if ($p) { 'RUNNING' } else { 'NOT_RUNNING' }
} catch {
  'NOT_RUNNING'
}
