# Start the NDC case investigator (http://127.0.0.1:8787).
# Secrets are asked for at start and kept only in this process's environment:
# never written to disk, never on a command line, never in shell history.
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\Sheen\ndc-case-investigator\start.ps1
#   ... -Azure            also ask for Azure DevOps settings (Send to team leader)
#   ... -Port 8787        change the port
param([switch]$Azure, [int]$Port = 8787)

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

$env:NDC_PORT = "$Port"
Write-Host "Starting on http://127.0.0.1:$Port  (Ctrl+C to stop; restarts automatically if it crashes)" -ForegroundColor Green
while ($true) {
    node server.js
    if ($LASTEXITCODE -eq 0) { break }
    Write-Host "Server stopped with exit code $LASTEXITCODE - restarting in 5 s (Ctrl+C to quit)" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
