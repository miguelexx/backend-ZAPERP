# Teste: POST /webhooks/zapi SEM token (validação via instanceId + empresa_zapi)
# Pré-requisito: instance_id em empresa_zapi.instance_id com ativo=true
#
# Uso: .\scripts\test-webhook-zapi-sem-token.ps1
# ou: $env:BASE_URL="http://localhost:3000"; $env:INSTANCE_ID="3EE81ED18926"; .\scripts\test-webhook-zapi-sem-token.ps1

$BaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { "http://localhost:3000" }
$InstanceId = if ($env:INSTANCE_ID) { $env:INSTANCE_ID } else { "3EE81ED18926" }
$MsgId = "test-msg-" + [int][double]::Parse((Get-Date -UFormat %s))

Write-Host "=== Teste webhook Z-API sem token ===" -ForegroundColor Cyan
Write-Host "URL: $BaseUrl/webhooks/zapi"
Write-Host "InstanceId: $InstanceId"
Write-Host ""

# 1) Health
Write-Host "1) GET /webhooks/zapi/health" -ForegroundColor Yellow
$h = Invoke-RestMethod -Uri "$BaseUrl/webhooks/zapi/health" -Method Get
$h | ConvertTo-Json

# 2) POST ReceivedCallback sem token
Write-Host ""
Write-Host "2) POST /webhooks/zapi (ReceivedCallback, sem token)" -ForegroundColor Yellow
$body = @{
  instanceId = $InstanceId
  type       = "ReceivedCallback"
  phone      = "5511999998888"
  messageId  = $MsgId
  fromMe     = $false
  text       = @{ message = "ou" }
} | ConvertTo-Json

try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/webhooks/zapi" -Method Post -Body $body -ContentType "application/json"
  $r | ConvertTo-Json -Depth 5
  if ($r.ignored) {
    Write-Host ""
    Write-Host "Webhook retornou ignored. Verifique:" -ForegroundColor Yellow
    Write-Host "  - missing_instanceId: instanceId ausente no payload"
    Write-Host "  - instance_not_mapped: $InstanceId nao existe em empresa_zapi.instance_id"
  } else {
    Write-Host ""
    Write-Host "Webhook aceito. Mensagem deve estar em mensagens/conversas." -ForegroundColor Green
  }
} catch {
  Write-Host "Erro: $_" -ForegroundColor Red
}
