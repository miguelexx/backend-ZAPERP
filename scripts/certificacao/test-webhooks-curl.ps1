# ============================================================
# Script PowerShell: simula webhooks Z-API para certificação
# Uso: .\test-webhooks-curl.ps1 -BaseUrl "http://localhost:3000" -InstanceId "INSTANCE_A"
# ============================================================

param(
  [string]$BaseUrl = "http://localhost:3000",
  [Parameter(Mandatory=$true)]
  [string]$InstanceId
)

$ErrorActionPreference = "Stop"

Write-Host "=== Testando webhooks Z-API em $BaseUrl com instanceId=$InstanceId ===" -ForegroundColor Cyan

# 0. Health
Write-Host "`n--- 0. Health ---" -ForegroundColor Yellow
Invoke-RestMethod -Uri "$BaseUrl/webhooks/zapi/health" -Method Get

# 1. ReceivedCallback
Write-Host "`n--- 1. ReceivedCallback (mensagem IN) ---" -ForegroundColor Yellow
$msgId1 = "cert-test-in-$(Get-Date -Format 'yyyyMMddHHmmss')"
$body1 = @{
  instanceId = $InstanceId
  type = "ReceivedCallback"
  phone = "5511999999999"
  fromMe = $false
  text = @{ message = "Oi, teste certificação" }
  message = "Oi, teste certificação"
  messageId = $msgId1
  senderName = "Contato Teste"
  senderPhoto = "https://example.com/photo.jpg"
} | ConvertTo-Json -Depth 3

Invoke-RestMethod -Uri "$BaseUrl/webhooks/zapi" -Method Post -Body $body1 -ContentType "application/json"

# 2. Idempotência
Write-Host "`n--- 2. Idempotência ---" -ForegroundColor Yellow
$body2 = @{
  instanceId = $InstanceId
  type = "ReceivedCallback"
  phone = "5511999999999"
  fromMe = $false
  text = @{ message = "Oi duplicado" }
  messageId = $msgId1
} | ConvertTo-Json -Depth 3

Invoke-RestMethod -Uri "$BaseUrl/webhooks/zapi" -Method Post -Body $body2 -ContentType "application/json"

# 3. fromMe
Write-Host "`n--- 3. fromMe (espelhamento) ---" -ForegroundColor Yellow
$msgId2 = "cert-test-out-$(Get-Date -Format 'yyyyMMddHHmmss')"
$body3 = @{
  instanceId = $InstanceId
  type = "ReceivedCallback"
  phone = "5511999999999"
  fromMe = $true
  text = @{ message = "Resposta do celular" }
  messageId = $msgId2
  chatName = "Contato Teste"
} | ConvertTo-Json -Depth 3

Invoke-RestMethod -Uri "$BaseUrl/webhooks/zapi" -Method Post -Body $body3 -ContentType "application/json"

# 4. Status READ
Write-Host "`n--- 4. Status READ ---" -ForegroundColor Yellow
Start-Sleep -Seconds 1
$body4 = @{
  instanceId = $InstanceId
  ids = @($msgId1)
  status = "READ"
} | ConvertTo-Json

Invoke-RestMethod -Uri "$BaseUrl/webhooks/zapi/status" -Method Post -Body $body4 -ContentType "application/json"

Write-Host "`n=== Fim dos testes ===" -ForegroundColor Green
