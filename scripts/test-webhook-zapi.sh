#!/bin/bash
# Teste real: POST no webhook simulando payload Z-API com instanceId
# Confirma que company_id é resolvido via empresa_zapi
#
# Uso:
#   BASE_URL=https://api.zaperp.com INSTANCE_ID=seu_instance_id ./scripts/test-webhook-zapi.sh
#   ou para local: BASE_URL=http://localhost:3000 INSTANCE_ID=3EE81ED189267279CB31EA4E62592653 ./scripts/test-webhook-zapi.sh

BASE="${BASE_URL:-http://localhost:3000}"
INSTANCE_ID="${INSTANCE_ID:-}"

if [ -z "$INSTANCE_ID" ]; then
  echo "ERRO: Defina INSTANCE_ID (deve existir em empresa_zapi.instance_id)"
  echo "Ex: INSTANCE_ID=3EE81ED189267279CB31EA4E62592653 BASE_URL=http://localhost:3000 ./scripts/test-webhook-zapi.sh"
  exit 1
fi

echo "=== 1) Health check ==="
curl -s -w "\nHTTP %{http_code}\n" "$BASE/webhooks/zapi/health"
echo ""

echo ""
echo "=== 2) POST webhook mensagens ( ReceivedCallback ) ==="
RES=$(curl -s -w "\n%{http_code}" -X POST "$BASE/webhooks/zapi" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": \"$INSTANCE_ID\",
    \"type\": \"ReceivedCallback\",
    \"phone\": \"5511999999999\",
    \"fromMe\": false,
    \"text\": {\"message\": \"teste script\"},
    \"messageId\": \"test-$(date +%s)\"
  }")
HTTP=$(echo "$RES" | tail -1)
BODY=$(echo "$RES" | sed '$d')
echo "HTTP $HTTP"
echo "$BODY" | head -5
echo ""

echo "Verifique no log do backend: [Z-API-WEBHOOK] com instanceIdResolved e companyIdResolved"
echo "Se companyIdResolved=not_mapped, o instance_id não está em empresa_zapi."
