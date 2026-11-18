# Start the NDC case investigator (http://127.0.0.1:8787).
# Secrets are asked for at start and kept only in this process's environment:
# never written to disk, never on a command line, never in shell history.
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\Sheen\ndc-case-investigator\start.ps1
#   ... -Azure            also ask for Azure DevOps settings (Send to team leader)
#   ... -NoDb             don't ask for the UAT database (FAILURE_MESSAGES classification on Booking failures)
#   ... -Port 8787        change the port
# -Db is accepted for compatibility (the UAT database is now asked for by default).
param([switch]$Azure, [switch]$Db, [switch]$NoDb, [int]$Port = 8787)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Read-Secret([string]$prompt) {
    $s = Read-Host -Prompt $prompt -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

if (-not $env:OSD_USER) { $env:OSD_USER = Read-Host -Prompt 'OpenSearch user [ndc-core-user]'; if (-not $env:OSD_USER) { $env:OSD_USER = 'ndc-core-user' } }
if (-not $env:OSD_PASS) { $env:OSD_PASS = Read-Secret 'OpenSearch password' }

if ($Azure) {
    if (-not $env:AZDO_ORG_URL) { $env:AZDO_ORG_URL = Read-Host -Prompt 'Azure DevOps organization URL (https://dev.azure.com/<org>)' }
    if (-not $env:AZDO_PROJECT) { $env:AZDO_PROJECT = Read-Host -Prompt 'Azure DevOps project' }
    if (-not $env:AZDO_PAT)     { $env:AZDO_PAT = Read-Secret 'Azure DevOps personal access token (Work Items Read & Write)' }
    if (-not $env:AZDO_TEAM_LEADER) { $env:AZDO_TEAM_LEADER = Read-Host -Prompt 'Team leader e-mail (optional, Enter to skip)' }
}

# UAT database (FAILURE_MESSAGES classification): asked every start, like OpenSearch.
# Host:port and user are remembered as defaults in data\uat-db.json (no password); Enter at host skips the DB.
if (-not $NoDb -and -not $env:UAT_DB_HOST) {
    $saved = Join-Path $PSScriptRoot 'data\uat-db.json'
    $def = $null; if (Test-Path $saved) { try { $def = Get-Content $saved -Raw | ConvertFrom-Json } catch { $def = $null } }
    $defHp = if ($def -and $def.host) { if ($def.port) { "$($def.host):$($def.port)" } else { $def.host } } else { '192.168.1.71:3306' }
    $defUser = if ($def -and $def.user) { $def.user } else { '' }
    if (-not $env:UAT_DB_NAME) { $env:UAT_DB_NAME = 'wonderdb' }
    while ($true) {
        $hp = Read-Host -Prompt "UAT MySQL host:port [$defHp] (type - to skip)"
        if ($hp -eq '-') { $env:UAT_DB_HOST = $null; Write-Host 'UAT DB skipped: Booking failures will not show classified / unclassified.' -ForegroundColor Yellow; break }
        if (-not $hp) { $hp = $defHp }
        $parts = $hp.Split(':'); $env:UAT_DB_HOST = $parts[0]; $env:UAT_DB_PORT = if ($parts.Length -gt 1) { $parts[1] } else { '3306' }
        $u = Read-Host -Prompt ("UAT database user" + $(if ($defUser) { " [$defUser]" } else { '' })); $env:UAT_DB_USER = if ($u) { $u } else { $defUser }
        $env:UAT_DB_PASS = Read-Secret 'UAT database password'

        Write-Host "Testing connection to $($env:UAT_DB_USER)@$($env:UAT_DB_HOST):$($env:UAT_DB_PORT)/$($env:UAT_DB_NAME) ..." -ForegroundColor Cyan
        node tools\test-db.js
        $ok = ($LASTEXITCODE -eq 0)
        if ($ok) {
            New-Item -ItemType Directory -Force -Path (Split-Path $saved) | Out-Null
            @{ host = $env:UAT_DB_HOST; port = $env:UAT_DB_PORT; user = $env:UAT_DB_USER } | ConvertTo-Json | Set-Content -Path $saved -Encoding UTF8
            break
        }
        $defHp = "$($env:UAT_DB_HOST):$($env:UAT_DB_PORT)"; $defUser = $env:UAT_DB_USER
        $c = Read-Host -Prompt '[R]etry with other details, [S]kip the DB, or [C]ontinue anyway (retries on each Booking failures search)? [R]'
        if ($c -match '^[sS]') { $env:UAT_DB_HOST = $null; $env:UAT_DB_PASS = $null; Write-Host 'UAT DB skipped.' -ForegroundColor Yellow; break }
        if ($c -match '^[cC]') { break }
    }
}

$env:NDC_PORT = "$Port"
Write-Host "Starting on http://127.0.0.1:$Port  (Ctrl+C to stop; restarts automatically if it crashes)" -ForegroundColor Green
while ($true) {
    node server.js
    if ($LASTEXITCODE -eq 0) { break }
    Write-Host "Server stopped with exit code $LASTEXITCODE - restarting in 5 s (Ctrl+C to quit)" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
