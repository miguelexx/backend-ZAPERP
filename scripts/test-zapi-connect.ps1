# Testes do fluxo Conectar WhatsApp (Z-API)
# Uso: $env:TOKEN="seu_jwt_aqui"; .\test-zapi-connect.ps1

$Base = if ($env:BASE_URL) { $env:BASE_URL } else { "http://localhost:3000" }
$Api = "$Base/api/integrations/zapi"
$Token = $env:TOKEN

if (-not $Token) {
    Write-Host "ERRO: Defina TOKEN com seu JWT. Ex: `$env:TOKEN='eyJ...'; .\test-zapi-connect.ps1" -ForegroundColor Red
    exit 1
}

$Headers = @{
    "Authorization" = "Bearer $Token"
    "Content-Type"  = "application/json"
}

Write-Host "`n=== 1) GET /connect/status ===" -ForegroundColor Cyan
try {
    $r1 = Invoke-RestMethod -Uri "$Api/connect/status" -Headers $Headers -Method Get
    $r1 | ConvertTo-Json -Depth 3
} catch {
    Write-Host "HTTP $($_.Exception.Response.StatusCode.value__)"
    $_.ErrorDetails.Message
}

Write-Host "`n=== 2) POST /connect/qrcode (1ª chamada) ===" -ForegroundColor Cyan
try {
    $r2 = Invoke-RestMethod -Uri "$Api/connect/qrcode" -Headers $Headers -Method Post
    $r2 | ConvertTo-Json -Depth 3
} catch {
    Write-Host "HTTP $($_.Exception.Response.StatusCode.value__)"
    $_.ErrorDetails.Message
}

Write-Host "`n=== 3) POST /connect/qrcode (2ª chamada imediata - deve 429) ===" -ForegroundColor Cyan
try {
    $r3 = Invoke-RestMethod -Uri "$Api/connect/qrcode" -Headers $Headers -Method Post
    $r3 | ConvertTo-Json -Depth 3
} catch {
    Write-Host "HTTP $($_.Exception.Response.StatusCode.value__)"
    $_.ErrorDetails.Message
}

Write-Host "`n=== 4) POST /connect/phone-code com phone inválido (deve 400) ===" -ForegroundColor Cyan
try {
    $r4 = Invoke-RestMethod -Uri "$Api/connect/phone-code" -Headers $Headers -Method Post -Body '{"phone":"123"}'
    $r4 | ConvertTo-Json -Depth 3
} catch {
    Write-Host "HTTP $($_.Exception.Response.StatusCode.value__)"
    $_.ErrorDetails.Message
}

Write-Host "`n=== 5) POST /connect/phone-code com phone válido ===" -ForegroundColor Cyan
try {
    $r5 = Invoke-RestMethod -Uri "$Api/connect/phone-code" -Headers $Headers -Method Post -Body '{"phone":"11999999999"}'
    $r5 | ConvertTo-Json -Depth 3
} catch {
    Write-Host "HTTP $($_.Exception.Response.StatusCode.value__)"
    $_.ErrorDetails.Message
}

Write-Host "`n=== 6) POST /connect/restart ===" -ForegroundColor Cyan
try {
    $r6 = Invoke-RestMethod -Uri "$Api/connect/restart" -Headers $Headers -Method Post
    $r6 | ConvertTo-Json -Depth 3
} catch {
    Write-Host "HTTP $($_.Exception.Response.StatusCode.value__)"
    $_.ErrorDetails.Message
}

Write-Host "`nFim dos testes." -ForegroundColor Green
