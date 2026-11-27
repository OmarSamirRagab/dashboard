# Start the NDC case investigator (http://127.0.0.1:8787).
# Secrets are asked for at start and kept only in this process's environment:
# never written to disk, never on a command line, never in shell history.
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\Sheen\ndc-case-investigator\start.ps1
#   ... -Azure            also ask for Azure DevOps settings (Send to team leader)
#   ... -Perf             also ask for the Odeysys test login (Performance page)
#   ... -Port 8787        change the port
param([switch]$Azure, [switch]$Perf, [int]$Port = 8787)

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
    if (-not $env:AZDO_PAT)     { $env:AZDO_PAT = Read-Secret 'Azure DevOps personal access token (Work Items Read & Write, Code Read)' }
    if (-not $env:AZDO_TEAM)    { $env:AZDO_TEAM = Read-Host -Prompt 'Azure DevOps team for the current sprint (Enter = "<project> Team")' }
    if (-not $env:AZDO_TEAM_LEADER) { $env:AZDO_TEAM_LEADER = Read-Host -Prompt 'Team leader e-mail (optional, Enter to skip)' }
}

if ($Perf) {
    if (-not $env:PERF_ADMIN_URL)  { $env:PERF_ADMIN_URL = Read-Host -Prompt 'Local admin URL [http://127.0.0.1:8080/odeysysadmin]'; if (-not $env:PERF_ADMIN_URL) { $env:PERF_ADMIN_URL = 'http://127.0.0.1:8080/odeysysadmin' } }
    if (-not $env:PERF_PORTAL_URL) { $env:PERF_PORTAL_URL = Read-Host -Prompt 'Local portal URL [http://127.0.0.1:8080/odeysysportal]'; if (-not $env:PERF_PORTAL_URL) { $env:PERF_PORTAL_URL = 'http://127.0.0.1:8080/odeysysportal' } }
    if (-not $env:PERF_USER) { $env:PERF_USER = Read-Host -Prompt 'Admin test user (userName)' }
    if (-not $env:PERF_PASS) { $env:PERF_PASS = Read-Secret 'Admin test password' }
    if (-not $env:PERF_PORTAL_AGENCY) { $env:PERF_PORTAL_AGENCY = Read-Host -Prompt 'Portal agency code' }
    if (-not $env:PERF_PORTAL_EMAIL)  { $env:PERF_PORTAL_EMAIL = Read-Host -Prompt 'Portal e-mail' }
    if (-not $env:PERF_PORTAL_PASS)   { $env:PERF_PORTAL_PASS = Read-Secret 'Portal password (Enter = same as admin)'; if (-not $env:PERF_PORTAL_PASS) { $env:PERF_PORTAL_PASS = $env:PERF_PASS } }
    # Local MySQL for sample values (Fill from DB). Use a user with SELECT rights only. Enter at the schema prompt skips it.
    if (-not $env:PERF_DB_NAME) { $env:PERF_DB_NAME = Read-Host -Prompt 'Local MySQL schema for sample values (Enter = skip)' }
    if ($env:PERF_DB_NAME) {
        if (-not $env:PERF_DB_HOST) { $env:PERF_DB_HOST = Read-Host -Prompt 'MySQL host [127.0.0.1]'; if (-not $env:PERF_DB_HOST) { $env:PERF_DB_HOST = '127.0.0.1' } }
        if (-not $env:PERF_DB_PORT) { $env:PERF_DB_PORT = Read-Host -Prompt 'MySQL port [3306]'; if (-not $env:PERF_DB_PORT) { $env:PERF_DB_PORT = '3306' } }
        if (-not $env:PERF_DB_USER) { $env:PERF_DB_USER = Read-Host -Prompt 'MySQL read-only user' }
        if (-not $env:PERF_DB_PASS) { $env:PERF_DB_PASS = Read-Secret 'MySQL password' }
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
