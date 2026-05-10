# ===========================================================
# totalas — NAS 자동 백업
# 실행:  매일 새벽 (Windows 작업스케줄러 등록 권장)
# 출력:  \\192.168.0.249\data\rental-backup-YYYYMMDD-vN\
#   ├─ README.md            (백업 메타)
#   ├─ rental_customers.json
#   ├─ rental_contracts.json
#   ├─ rental_printers.json
#   ├─ rental_counters.json
#   ├─ rental_meetings.json
#   ├─ rental_archive.json
#   ├─ rental_prices.json
#   ├─ rental_customer_attachments.json
#   └─ files/               (Storage rental-files 전체 미러)
# ===========================================================

param(
  [string]$EnvFile = "$PSScriptRoot\..\.env",
  [string]$NasRoot = '\\192.168.0.249\data',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# .env 로드
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$') {
      Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
    }
  }
}

$SUPA_URL = $env:SUPABASE_URL
$SERVICE  = $env:SUPABASE_SERVICE_ROLE
if (-not $SUPA_URL -or -not $SERVICE) {
  Write-Error "환경변수 SUPABASE_URL / SUPABASE_SERVICE_ROLE 가 설정되지 않았습니다.  .env 파일 또는 시스템 환경변수에 추가하세요."
  exit 1
}

# 백업 폴더 결정 (rental-backup-YYYYMMDD-vN)
$today = Get-Date -Format 'yyyyMMdd'
$existing = @(Get-ChildItem -Path $NasRoot -Directory -Filter "rental-backup-$today-v*" -ErrorAction SilentlyContinue)
$nextV = if ($existing.Count) { ($existing | ForEach-Object { [int]($_.Name -replace '.*-v','') } | Measure-Object -Maximum).Maximum + 1 } else { 1 }
$backupDir = Join-Path $NasRoot "rental-backup-$today-v$nextV"

Write-Host "[+] 백업 대상: $backupDir"
if ($DryRun) { Write-Host '[!] DRY RUN — 실제 쓰기 없음'; exit 0 }
New-Item -ItemType Directory -Path $backupDir | Out-Null
New-Item -ItemType Directory -Path "$backupDir\files" | Out-Null

# REST 호출 helper
$headers = @{
  apikey          = $SERVICE
  Authorization   = "Bearer $SERVICE"
  Accept          = 'application/json'
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

$summary = @{}
foreach ($t in $tables) {
  Write-Host "  - $t ..." -NoNewline
  $url = "$SUPA_URL/rest/v1/$t`?select=*"
  try {
    $rows = Invoke-RestMethod -Uri $url -Headers $headers -Method GET
    $rowCount = if ($rows) { @($rows).Count } else { 0 }
    $rows | ConvertTo-Json -Depth 8 | Out-File -FilePath "$backupDir\$t.json" -Encoding utf8
    $summary[$t] = $rowCount
    Write-Host " $rowCount건"
  } catch {
    Write-Warning "  실패: $($_.Exception.Message)"
    $summary[$t] = "ERROR: $($_.Exception.Message)"
  }
}

# Storage 미러 — rental-files
Write-Host "[+] Storage rental-files 다운로드..."
$storageBase = "$SUPA_URL/storage/v1"
function Download-Folder([string]$prefix, [string]$destLocal) {
  $listUrl = "$storageBase/object/list/rental-files"
  $body = @{ prefix = $prefix; limit = 1000; offset = 0 } | ConvertTo-Json
  try {
    $items = Invoke-RestMethod -Uri $listUrl -Headers $headers -Method POST -Body $body -ContentType 'application/json'
  } catch {
    Write-Warning "list 실패 ($prefix): $($_.Exception.Message)"
    return
  }
  if (-not (Test-Path $destLocal)) { New-Item -ItemType Directory -Path $destLocal | Out-Null }
  foreach ($obj in $items) {
    if ($obj.id -eq $null -and $obj.name) {
      # 폴더인 경우 (id null), 재귀
      Download-Folder "$prefix$($obj.name)/" (Join-Path $destLocal $obj.name)
    } else {
      $remotePath = "$prefix$($obj.name)"
      $dlUrl = "$storageBase/object/rental-files/$remotePath"
      $dst = Join-Path $destLocal $obj.name
      try {
        Invoke-WebRequest -Uri $dlUrl -Headers $headers -OutFile $dst | Out-Null
      } catch {
        Write-Warning "  다운로드 실패: $remotePath — $($_.Exception.Message)"
      }
    }
  }
}
Download-Folder '' "$backupDir\files"

# README 작성
$readme = @"
# rental-backup-$today-v$nextV

생성: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
출처: $SUPA_URL  (Supabase REST API service_role 인증)

## 테이블 행 수
$(foreach ($k in $summary.Keys) { "- ``$k`` : $($summary[$k])" } | Out-String)

## 복원
1. ``*.json`` 을 새 Supabase 프로젝트에 INSERT (psql \copy 또는 supabase CLI 사용)
2. ``files/`` 를 새 bucket ``rental-files`` 에 업로드 (supabase storage cp 또는 대시보드)
3. 동일 RLS 정책 적용 (``supabase/migrations/20260511_init_rental.sql`` 참고)
"@
$readme | Out-File -FilePath "$backupDir\README.md" -Encoding utf8

Write-Host ""
Write-Host "[OK] 백업 완료: $backupDir"
foreach ($k in $summary.Keys) { Write-Host "  $k : $($summary[$k])" }
