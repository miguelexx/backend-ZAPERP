# Teste real: POST no webhook simulando payload Z-API com instanceId
# Uso: $env:BASE_URL="http://localhost:3000"; $env:INSTANCE_ID="seu_instance_id"; .\scripts\test-webhook-zapi.ps1

$Base = if ($env:BASE_URL) { $env:BASE_URL.TrimEnd('/') } else { "http://localhost:3000" }
$InstanceId = $env:INSTANCE_ID

if (-not $InstanceId) {
  Write-Host "ERRO: Defina INSTANCE_ID (deve existir em empresa_zapi.instance_id)" -ForegroundColor Red
  Write-Host "Ex: `$env:INSTANCE_ID='3EE81ED189267279CB31EA4E62592653'; `$env:BASE_URL='http://localhost:3000'; .\scripts\test-webhook-zapi.ps1"
  exit 1
}

Write-Host "`n=== 1) Health check ===" -ForegroundColor Cyan
try {
  $h = Invoke-RestMethod -Uri "$Base/webhooks/zapi/health" -Method Get
  Write-Host ($h | ConvertTo-Json)
} catch { Write-Host "Falha: $_" }

Write-Host "`n=== 2) POST webhook ReceivedCallback ===" -ForegroundColor Cyan
$body = @{
  instanceId = $InstanceId
  type = "ReceivedCallback"
  phone = "5511999999999"
  fromMe = $false
  text = @{ message = "teste script" }
  messageId = "test-$(Get-Date -UFormat %s)"
} | ConvertTo-Json -Depth 5
try {
  $r = Invoke-RestMethod -Uri "$Base/webhooks/zapi" -Method Post -Body $body -ContentType "application/json"
  Write-Host ($r | ConvertTo-Json)
} catch { Write-Host "Falha: $_" }

Write-Host "`nVerifique no log do backend: [Z-API-WEBHOOK] com instanceIdResolved e companyIdResolved" -ForegroundColor Yellow
