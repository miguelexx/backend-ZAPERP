# Teste completo: Login + JWT + Z-API Connect
# Uso:
#   $env:LOGIN_EMAIL="user@example.com"; $env:LOGIN_SENHA="senha123"; .\test-login-and-zapi.ps1
#   OU: $env:TOKEN="eyJ..."; .\test-login-and-zapi.ps1
#   $env:BASE_URL="http://localhost:3000" (opcional)

$Base = if ($env:BASE_URL) { $env:BASE_URL } else { "http://localhost:3000" }
$env:BASE_URL = $Base

if (-not $env:TOKEN -and (-not $env:LOGIN_EMAIL -or -not $env:LOGIN_SENHA)) {
    Write-Host "Defina: LOGIN_EMAIL e LOGIN_SENHA (para login) OU TOKEN (JWT existente)" -ForegroundColor Red
    Write-Host "Ex: `$env:LOGIN_EMAIL='admin@empresa.com'; `$env:LOGIN_SENHA='senha'; .\test-login-and-zapi.ps1" -ForegroundColor Yellow
    exit 1
}

node "$PSScriptRoot\test-login-and-zapi.js"
exit $LASTEXITCODE
