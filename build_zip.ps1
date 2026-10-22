# Script de empaquetado para AWS Lambda
$ErrorActionPreference = "Stop"

Write-Host "Iniciando compilacion TypeScript..." -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) {
    throw "Error en npm run build"
}

$base = $PSScriptRoot
$deployDir = "$base\deploy_temp"
$zipPath = "$base\function.zip"

if (Test-Path $deployDir) {
    Remove-Item -Recurse -Force $deployDir
}
if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
}

Write-Host "Creando directorio temporal: $deployDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $deployDir | Out-Null

Write-Host "Copiando dist y package.json..." -ForegroundColor Cyan
Copy-Item -Recurse -Path "$base\dist" -Destination "$deployDir\dist"
Copy-Item -Path "$base\package.json" -Destination "$deployDir\package.json"

Write-Host "Instalando modulos de produccion..." -ForegroundColor Cyan
Push-Location $deployDir
& npm install --omit=dev --silent
Pop-Location

Write-Host "Comprimiendo a function.zip..." -ForegroundColor Cyan
Compress-Archive -Path "$deployDir\*" -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "Limpiando directorio temporal..." -ForegroundColor Cyan
Remove-Item -Recurse -Force $deployDir

$size = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "Exito: function.zip generado ($size MB)" -ForegroundColor Green
