#!/usr/bin/env bash
# Diagnóstico: mídias estão em disco local na VPS?
# Uso na VPS (como o usuário que roda o backend):
#   bash backend/scripts/diagnostico_midias_vps.sh
# Ou, se o processo Node estiver em PM2/systemd, leia UPLOADS_DIR do .env do deploy.

set -euo pipefail

echo "=== ZapERP — diagnóstico de mídias (uploads locais) ==="
echo ""

# Tenta achar .env ao lado do backend
ENV_FILE="${ENV_FILE:-}"
for candidate in ".env" "backend/.env" "../.env"; do
  if [[ -z "$ENV_FILE" && -f "$candidate" ]]; then
    ENV_FILE="$candidate"
  fi
done

UPLOADS_DIR=""
if [[ -n "${ENV_FILE}" && -f "${ENV_FILE}" ]]; then
  UPLOADS_DIR="$(grep -E '^UPLOADS_DIR=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r"' | sed 's/^ *//;s/ *$//')"
  echo "Arquivo .env: ${ENV_FILE}"
else
  echo "Aviso: .env não encontrado (defina ENV_FILE=/caminho/.env)"
fi

if [[ -z "$UPLOADS_DIR" ]]; then
  # Padrão do código: backend/uploads relativo ao app
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
  UPLOADS_DIR="${BACKEND_DIR}/uploads"
  echo "UPLOADS_DIR não definido no .env → padrão do código:"
fi

echo "Pasta de uploads: ${UPLOADS_DIR}"
echo ""

if [[ ! -d "$UPLOADS_DIR" ]]; then
  echo "❌ Pasta NÃO existe. Nenhuma mídia local gravada ainda (ou caminho errado)."
  exit 1
fi

FILE_COUNT=$(find "$UPLOADS_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
DISK_USE=$(du -sh "$UPLOADS_DIR" 2>/dev/null | cut -f1)
INBOUND_COUNT=$(find "$UPLOADS_DIR" -type f -name 'inbound-c*' 2>/dev/null | wc -l | tr -d ' ')

echo "✓ Pasta existe"
echo "  Arquivos totais:     ${FILE_COUNT}"
echo "  Tamanho em disco:    ${DISK_USE}"
echo "  inbound (recebidas): ${INBOUND_COUNT}  (padrão inbound-c{company}-m{id}-*.ext)"
echo ""

if [[ "$FILE_COUNT" -eq 0 ]]; then
  echo "⚠ Pasta vazia: ou não chegou mídia ainda, ou tudo ainda está só com URL https no banco."
else
  echo "Amostra (5 arquivos mais recentes):"
  find "$UPLOADS_DIR" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -5 | while read -r _ path; do
    ls -lh "$path" 2>/dev/null || true
  done
fi

echo ""
echo "--- Risco no deploy ---"
if [[ -n "${ENV_FILE}" ]] && grep -qE '^UPLOADS_DIR=' "${ENV_FILE}"; then
  echo "UPLOADS_DIR está configurado fora do código → deploy NÃO deve apagar SE essa pasta"
  echo "não estiver dentro de /tmp ou da pasta que o CI recria. Confirme que é volume/bind mount."
else
  echo "⚠ UPLOADS_DIR vazio → mídias em backend/uploads dentro do projeto."
  echo "  Deploy que recria a pasta do app APAGA esses arquivos."
  echo "  Recomendado: volume em /var/lib/... e UPLOADS_DIR no .env"
fi

echo ""
echo "Próximo passo: rode o SQL em backend/scripts/diagnostico_midias_banco.sql no Supabase"
echo "para ver quantas mensagens usam /uploads/ (local) vs https:// (remoto)."
