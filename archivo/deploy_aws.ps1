# ==============================================================================
# Script de Despliegue en AWS Lambda para Servidor MCP MVEVIP
# Perfil AWS: marketingvip
# ==============================================================================
param(
    [string]$Profile = "marketingvip",
    [string]$Region = "us-west-2",
    [string]$FunctionName = "mvevip-mcp-server"
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "🚀 DESPLIEGUE AWS LAMBDA - SERVIDOR REMOTE MCP MVEVIP" -ForegroundColor Cyan
Write-Host "   Perfil AWS:    $Profile" -ForegroundColor Cyan
Write-Host "   Región AWS:    $Region" -ForegroundColor Cyan
Write-Host "   Función:       $FunctionName" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Verificar credenciales de AWS CLI
Write-Host "`n[1/5] Verificando credenciales de AWS CLI..." -ForegroundColor Yellow
try {
    $identityJson = aws sts get-caller-identity --profile $Profile --output json | ConvertFrom-Json
    Write-Host "  ✅ Conectado a AWS como:" $identityJson.Arn -ForegroundColor Green
    Write-Host "  ✅ Account ID:" $identityJson.Account -ForegroundColor Green
} catch {
    Write-Host "  ❌ Error validando credenciales de AWS CLI para el perfil '$Profile': $_" -ForegroundColor Red
    exit 1
}

# 2. Compilar y empaquetar código
Write-Host "`n[2/5] Generando paquete ZIP..." -ForegroundColor Yellow
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build_zip.ps1")
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ Error durante la generación del ZIP." -ForegroundColor Red
    exit 1
}

$zipPath = Join-Path $PSScriptRoot "function.zip"
if (-not (Test-Path $zipPath)) {
    Write-Host "  ❌ No se encontró function.zip" -ForegroundColor Red
    exit 1
}

# 3. Comprobar si la función Lambda ya existe o crearla
Write-Host "`n[3/5] Verificando función Lambda '$FunctionName' en $Region..." -ForegroundColor Yellow
$funcExists = $false
try {
    $funcInfo = aws lambda get-function --function-name $FunctionName --region $Region --profile $Profile --output json 2>$null | ConvertFrom-Json
    if ($funcInfo) {
        $funcExists = $true
    }
} catch {
    $funcExists = $false
}

if ($funcExists) {
    Write-Host "  🔄 Actualizando código de la función existente..." -ForegroundColor Cyan
    aws lambda update-function-code `
        --function-name $FunctionName `
        --zip-file "fileb://$zipPath" `
        --region $Region `
        --profile $Profile `
        --output json | Out-Null
    Write-Host "  ✅ Código de la función actualizado exitosamente." -ForegroundColor Green
} else {
    Write-Host "  ℹ️ La función no existe en AWS Lambda. Se requiere un IAM Role para crearla." -ForegroundColor Yellow
    Write-Host "     Por favor crea la función '$FunctionName' en la consola AWS con runtime Node.js 20.x," -ForegroundColor Yellow
    Write-Host "     handler 'dist/lambda.handler', y luego vuelve a ejecutar este script para subir el código." -ForegroundColor Yellow
    exit 0
}

# 4. Asegurar Function URL en modo BUFFERED
Write-Host "`n[4/5] Verificando Function URL en AWS Lambda..." -ForegroundColor Yellow
$functionUrl = $null
try {
    $urlConfig = aws lambda get-function-url-config --function-name $FunctionName --region $Region --profile $Profile --output json 2>$null | ConvertFrom-Json
    if ($urlConfig -and $urlConfig.FunctionUrl) {
        $functionUrl = $urlConfig.FunctionUrl
    }
} catch {
    $functionUrl = $null
}

if (-not $functionUrl) {
    Write-Host "  ➕ Creando Function URL pública en modo BUFFERED..." -ForegroundColor Cyan
    $newUrlConfig = aws lambda create-function-url-config `
        --function-name $FunctionName `
        --auth-type NONE `
        --invoke-mode BUFFERED `
        --cors '{"AllowOrigins":["*"],"AllowMethods":["*"],"AllowHeaders":["*"],"ExposeHeaders":["*"]}' `
        --region $Region `
        --profile $Profile `
        --output json | ConvertFrom-Json
    
    $functionUrl = $newUrlConfig.FunctionUrl

    # Agregar permisos para invocación pública sin auth AWS IAM
    aws lambda add-permission `
        --function-name $FunctionName `
        --statement-id "FunctionURLAllowPublicAccess" `
        --action "lambda:InvokeFunctionUrl" `
        --principal "*" `
        --function-url-auth-type "NONE" `
        --region $Region `
        --profile $Profile 2>$null | Out-Null
}

Write-Host "  ✅ Function URL activa: $functionUrl" -ForegroundColor Green

# 5. Resumen final para Claude
$claudeUrl = "${functionUrl}mcp"
Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "🎉 DESPLIEGUE FINALIZADO EXITOSAMENTE" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Para conectar en Claude.ai Web o Claude Desktop:" -ForegroundColor White
Write-Host "1. Ve a: Personalizar > Conectores > Agregar conector personalizado" -ForegroundColor White
Write-Host "2. URL del Conector: $claudeUrl" -ForegroundColor Cyan
Write-Host "3. Haz clic en Conectar." -ForegroundColor White
Write-Host "4. Se abrirá la pantalla de MVEVIP pidiendo tu Clave Corporativa." -ForegroundColor White
Write-Host "   (Configurada en MCP_ACCESS_KEY)" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Green
