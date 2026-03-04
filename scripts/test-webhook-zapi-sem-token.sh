#!/bin/bash
# Teste: POST /webhooks/zapi SEM token (validação via instanceId + empresa_zapi)
# Pré-requisito: instance_id em empresa_zapi.instance_id com ativo=true
#
# Uso: BASE_URL=http://localhost:3000 INSTANCE_ID=3EE81ED18926... ./scripts/test-webhook-zapi-sem-token.sh

BASE="${BASE_URL:-http://localhost:3000}"
INSTANCE_ID="${INSTANCE_ID:-3EE81ED18926}"

echo "=== Teste webhook Z-API sem token ==="
echo "URL: $BASE/webhooks/zapi"
echo "InstanceId: $INSTANCE_ID"
echo ""

# 1) Health (GET público)
echo "1) GET /webhooks/zapi/health"
curl -s -w "\nHTTP %{http_code}\n" "$BASE/webhooks/zapi/health"
echo ""

# 2) POST ReceivedCallback SEM token no query
echo ""
echo "2) POST /webhooks/zapi (ReceivedCallback, sem token)"
RES=$(curl -s -w "\n%{http_code}" -X POST "$BASE/webhooks/zapi" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "'"$INSTANCE_ID"'",
    "type": "ReceivedCallback",
    "phone": "5511999998888",
    "messageId": "test-msg-'$(date +%s)'",
    "fromMe": false,
    "text": { "message": "ou" }
  }')
BODY=$(echo "$RES" | head -n -1)
CODE=$(echo "$RES" | tail -1)
echo "$BODY"
echo "HTTP $CODE"

if [ "$CODE" = "200" ]; then
  if echo "$BODY" | grep -q '"ignored"'; then
    echo ""
    echo "⚠️ Webhook retornou ignored. Verifique:"
    echo "   - missing_instanceId: instanceId ausente no payload"
    echo "   - instance_not_mapped: $INSTANCE_ID não existe em empresa_zapi.instance_id"
    echo ""
    echo "Execute: SELECT company_id, instance_id FROM empresa_zapi WHERE ativo=true;"
  else
    echo ""
    echo "✅ Webhook aceito. Mensagem deve estar em mensagens/conversas."
  fi
else
  echo ""
  echo "❌ Esperado HTTP 200 (com ok:true ou ignored). Recebido: $CODE"
fi

echo ""
echo "3) Verificar logs: não deve aparecer [WEBHOOK_REJECTED] Token ausente para /webhooks/zapi"
