#!/bin/bash
# ============================================================
# Script de teste: simula webhooks Z-API para certificação
# Uso: ./test-webhooks-curl.sh [BASE_URL] [INSTANCE_ID]
# Ex:  ./test-webhooks-curl.sh https://meu-app.com INSTANCE_A
# ============================================================

BASE_URL="${1:-http://localhost:3000}"
INSTANCE_ID="${2:-}"

if [ -z "$INSTANCE_ID" ]; then
  echo "Uso: $0 BASE_URL INSTANCE_ID"
  echo "INSTANCE_ID deve existir em empresa_zapi.instance_id"
  exit 1
fi

echo "=== Testando webhooks Z-API em $BASE_URL com instanceId=$INSTANCE_ID ==="

# 0. Health
echo ""
echo "--- 0. Health ---"
curl -s "$BASE_URL/webhooks/zapi/health"
echo ""

# 1. ReceivedCallback (mensagem recebida do contato)
echo ""
echo "--- 1. ReceivedCallback (mensagem IN) ---"
MSG_ID_1="cert-test-in-$(date +%s)"
curl -s -X POST "$BASE_URL/webhooks/zapi" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": \"$INSTANCE_ID\",
    \"type\": \"ReceivedCallback\",
    \"phone\": \"5511999999999\",
    \"fromMe\": false,
    \"text\": {\"message\": \"Oi, teste certificação\"},
    \"message\": \"Oi, teste certificação\",
    \"messageId\": \"$MSG_ID_1\",
    \"senderName\": \"Contato Teste\",
    \"senderPhoto\": \"https://example.com/photo.jpg\"
  }"
echo ""

# 2. Idempotência: reenviar mesma mensagem (não deve duplicar)
echo ""
echo "--- 2. Idempotência (mesmo messageId) ---"
curl -s -X POST "$BASE_URL/webhooks/zapi" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": \"$INSTANCE_ID\",
    \"type\": \"ReceivedCallback\",
    \"phone\": \"5511999999999\",
    \"fromMe\": false,
    \"text\": {\"message\": \"Oi duplicado\"},
    \"messageId\": \"$MSG_ID_1\"
  }"
echo " (deve retornar ok sem criar nova mensagem)"

# 3. fromMe (espelhamento: mensagem enviada pelo celular)
# CRÍTICO: "to" = destino (contato) — evita criar conversa duplicada do "meu número"
echo ""
echo "--- 3. fromMe (espelhamento) ---"
MSG_ID_2="cert-test-out-$(date +%s)"
curl -s -X POST "$BASE_URL/webhooks/zapi" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": \"$INSTANCE_ID\",
    \"type\": \"ReceivedCallback\",
    \"phone\": \"5511999999999\",
    \"to\": \"5511999999999\",
    \"fromMe\": true,
    \"text\": {\"message\": \"Resposta do celular\"},
    \"messageId\": \"$MSG_ID_2\",
    \"chatName\": \"Contato Teste\"
  }"
echo ""

# 4. MessageStatusCallback (READ)
echo ""
echo "--- 4. Status READ ---"
sleep 1
curl -s -X POST "$BASE_URL/webhooks/zapi/status" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": \"$INSTANCE_ID\",
    \"ids\": [\"$MSG_ID_1\"],
    \"status\": \"READ\"
  }"
echo ""

# 5. DeliveryCallback (sent)
echo ""
echo "--- 5. DeliveryCallback (sent) ---"
MSG_ID_3="cert-test-delivery-$(date +%s)"
curl -s -X POST "$BASE_URL/webhooks/zapi" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": \"$INSTANCE_ID\",
    \"type\": \"DeliveryCallback\",
    \"messageId\": \"$MSG_ID_3\",
    \"phone\": \"5511999999999\",
    \"fromMe\": true,
    \"status\": \"SENT\"
  }"
echo ""

echo ""
echo "=== Fim dos testes. Verifique: ==="
echo "1. Logs [Z-API-WEBHOOK] no backend"
echo "2. Mensagens em mensagens (sem duplicata de $MSG_ID_1)"
echo "3. Eventos nova_mensagem e status_mensagem no frontend"
