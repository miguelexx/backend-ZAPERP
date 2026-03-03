#!/bin/bash
# Testes do fluxo Conectar WhatsApp (Z-API)
# Uso: TOKEN="seu_jwt_aqui" ./test-zapi-connect.sh
# Ou: export TOKEN=... && ./test-zapi-connect.sh

BASE="${BASE_URL:-http://localhost:3000}"
API="${BASE}/api/integrations/zapi"
TOK="${TOKEN:-}"

if [ -z "$TOK" ]; then
  echo "ERRO: Defina TOKEN com seu JWT. Ex: TOKEN=eyJ... ./test-zapi-connect.sh"
  exit 1
fi

AUTH="Authorization: Bearer $TOK"

echo "=== 1) GET /connect/status ==="
curl -s -w "\nHTTP %{http_code}" -H "$AUTH" "$API/connect/status" | tail -20
echo -e "\n"

echo "=== 2) POST /connect/qrcode (1ª chamada) ==="
curl -s -w "\nHTTP %{http_code}" -X POST -H "$AUTH" -H "Content-Type: application/json" "$API/connect/qrcode" | tail -5
echo -e "\n"

echo "=== 3) POST /connect/qrcode (2ª chamada imediata - deve 429) ==="
curl -s -w "\nHTTP %{http_code}" -X POST -H "$AUTH" -H "Content-Type: application/json" "$API/connect/qrcode" | tail -5
echo -e "\n"

echo "=== 4) POST /connect/phone-code com phone inválido (deve 400) ==="
curl -s -w "\nHTTP %{http_code}" -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{"phone":"123"}' "$API/connect/phone-code" | tail -5
echo -e "\n"

echo "=== 5) POST /connect/phone-code com phone válido (10 dígitos) ==="
curl -s -w "\nHTTP %{http_code}" -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{"phone":"11999999999"}' "$API/connect/phone-code" | tail -5
echo -e "\n"

echo "=== 6) POST /connect/restart ==="
curl -s -w "\nHTTP %{http_code}" -X POST -H "$AUTH" -H "Content-Type: application/json" "$API/connect/restart" | tail -5
echo -e "\n"

echo "Fim dos testes."
