#!/bin/bash
# Teste completo: Login + JWT + Z-API Connect
# Uso:
#   LOGIN_EMAIL=user@example.com LOGIN_SENHA=senha123 ./test-login-and-zapi.sh
#   OU: TOKEN=eyJ... ./test-login-and-zapi.sh
#   BASE_URL=http://localhost:3000 (opcional)

BASE_URL="${BASE_URL:-http://localhost:3000}"
export BASE_URL

if [ -z "$TOKEN" ] && { [ -z "$LOGIN_EMAIL" ] || [ -z "$LOGIN_SENHA" ]; }; then
  echo "Defina: LOGIN_EMAIL e LOGIN_SENHA (para login) OU TOKEN (JWT existente)"
  echo "Ex: LOGIN_EMAIL=admin@empresa.com LOGIN_SENHA=senha ./test-login-and-zapi.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/test-login-and-zapi.js"
exit $?
