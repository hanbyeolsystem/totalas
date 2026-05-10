# ==========================================================
# totalas - NAS auto backup
# Run: daily via Windows Task Scheduler
# Output: \\192.168.0.249\data\rental-backup-YYYYMMDD-vN\
#   - README.md
#   - rental_*.json (Supabase tables dump)
#   - files/  (Supabase Storage rental-files mirror)
# ==========================================================

param(
  [string]$EnvFile = "$PSScriptRoot\..\.env",
  [string]$NasRoot = '\\192.168.0.249\data',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Load .env
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$') {
      Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
    }
  }
}

$SUPA_URL = $env:SUPABASE_URL
# Support both old (SUPABASE_SERVICE_ROLE) and new (SUPABASE_SECRET_KEY) names
$SECRET   = if ($env:SUPABASE_SECRET_KEY) { $env:SUPABASE_SECRET_KEY } else { $env:SUPABASE_SERVICE_ROLE }
if (-not $SUPA_URL -or -not $SECRET) {
  Write-Error "SUPABASE_URL / SUPABASE_SECRET_KEY not set. Add them to .env or system environment."
  exit 1
}

# Determine backup folder name (rental-backup-YYYYMMDD-vN)
$today = Get-Date -Format 'yyyyMMdd'
$existing = @(Get-ChildItem -Path $NasRoot -Directory -Filter "rental-backup-$today-v*" -ErrorAction SilentlyContinue)
$nextV = if ($existing.Count) {
  ($existing | ForEach-Object { [int]($_.Name -replace '.*-v','') } | Measure-Object -Maximum).Maximum + 1
} else { 1 }
$backupDir = Join-Path $NasRoot "rental-backup-$today-v$nextV"

Write-Host "[+] Backup target: $backupDir"
if ($DryRun) { Write-Host '[!] DRY RUN - no writes'; exit 0 }
New-Item -ItemType Directory -Path $backupDir | Out-Null
New-Item -ItemType Directory -Path "$backupDir\files" | Out-Null

$headers = @{
  apikey        = $SECRET
  Authorization = "Bearer $SECRET"
  Accept        = 'application/json'
}

$tables = @(
  'rental_customers',
  'rental_printers',
  'rental_counters',
  'rental_contracts',
  'rental_meetings',
  'rental_archive',
  'rental_prices',
  'rental_customer_attachments'
)

$summary = [ordered]@{}
foreach ($t in $tables) {
  Write-Host "  - $t ..." -NoNewline
  $url = "$SUPA_URL/rest/v1/$t" + "?select=*"
  try {
    $rows = Invoke-RestMethod -Uri $url -Headers $headers -Method GET
    $rowCount = if ($rows) { @($rows).Count } else { 0 }
    $rows | ConvertTo-Json -Depth 8 | Out-File -FilePath "$backupDir\$t.json" -Encoding utf8
    $summary[$t] = $rowCount
    Write-Host " $rowCount rows"
  } catch {
    $errMsg = $_.Exception.Message
    Write-Warning "  fail: $errMsg"
    $summary[$t] = "ERROR: $errMsg"
  }
}

# Storage mirror
Write-Host "[+] Storage rental-files download..."
$storageBase = "$SUPA_URL/storage/v1"
function Download-Folder([string]$prefix, [string]$destLocal) {
  $listUrl = "$storageBase/object/list/rental-files"
  $body = @{ prefix = $prefix; limit = 1000; offset = 0 } | ConvertTo-Json
  try {
    $items = Invoke-RestMethod -Uri $listUrl -Headers $headers -Method POST -Body $body -ContentType 'application/json'
  } catch {
    Write-Warning "list fail ($prefix): $($_.Exception.Message)"
    return
  }
  if (-not (Test-Path $destLocal)) { New-Item -ItemType Directory -Path $destLocal | Out-Null }
  foreach ($obj in $items) {
    if ($null -eq $obj.id -and $obj.name) {
      Download-Folder "$prefix$($obj.name)/" (Join-Path $destLocal $obj.name)
    } else {
      $remotePath = "$prefix$($obj.name)"
      $dlUrl = "$storageBase/object/rental-files/$remotePath"
      $dst = Join-Path $destLocal $obj.name
      try {
        Invoke-WebRequest -Uri $dlUrl -Headers $headers -OutFile $dst | Out-Null
      } catch {
        Write-Warning "  download fail: $remotePath"
      }
    }
  }
}
Download-Folder '' "$backupDir\files"

# README
$readmeLines = @()
$readmeLines += "# rental-backup-$today-v$nextV"
$readmeLines += ""
$readmeLines += "Created: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$readmeLines += "Source:  $SUPA_URL  (Supabase REST API, secret key auth)"
$readmeLines += ""
$readmeLines += "## Table row counts"
foreach ($k in $summary.Keys) {
  $readmeLines += ('- ' + $k + ': ' + $summary[$k])
}
$readmeLines += ""
$readmeLines += "## Restore"
$readmeLines += "1. Apply schema: supabase/migrations/20260511_init_rental.sql"
$readmeLines += "2. INSERT json files via psql or supabase CLI"
$readmeLines += "3. Upload files/ to bucket rental-files"
$readmeLines -join "`r`n" | Out-File -FilePath "$backupDir\README.md" -Encoding utf8

Write-Host ""
Write-Host "[OK] Backup complete: $backupDir"
foreach ($k in $summary.Keys) {
  Write-Host ("  " + $k + " : " + $summary[$k])
}
