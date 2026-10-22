# ==============================================================================
# Script de Pruebas Locales Automatizadas para Servidor MCP MVEVIP (Puerto 6420)
# ==============================================================================
$scriptPath = Join-Path $PSScriptRoot "test_local.js"

if (Get-Command node -ErrorAction SilentlyContinue) {
    & node $scriptPath
} else {
    Write-Host "Node.js no encontrado en PATH. Ejecutando con PowerShell..." -ForegroundColor Yellow
    $ProgressPreference = 'SilentlyContinue'
    
    $BaseUrl = "http://localhost:6420"
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 5
    Write-Host "Healthcheck OK: " ($health | ConvertTo-Json -Compress)
}
