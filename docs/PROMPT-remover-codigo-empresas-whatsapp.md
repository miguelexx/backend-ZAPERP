# Prompt — Remover código legado da empresas_whatsapp (API Oficial Meta)

> Contexto: a tabela `empresas_whatsapp` (mapeamento `phone_number_id` da WhatsApp
> Cloud API do Meta) foi dropada pela migration `20260812150000_drop_empresas_whatsapp_legacy.sql`.
> O sistema usa Z-API/UltraMsg (`empresa_zapi`), não a API oficial. Falta remover o código.

Cole como prompt inicial da sessão:

---

Remova o código legado da `empresas_whatsapp` (integração antiga da WhatsApp Cloud API do Meta). A tabela já foi dropada. O envio real é via Z-API/UltraMsg (`empresa_zapi`) — não tocar nisso.

**Remover em `controllers/configController.js`:**
- `exports.getEmpresasWhatsapp`
- `exports.postEmpresasWhatsapp`
- `exports.deleteEmpresasWhatsapp`

**Remover em `routes/configRoutes.js` (linhas ~31–33):**
- `GET /empresas-whatsapp`
- `POST /empresas-whatsapp`
- `DELETE /empresas-whatsapp/:id`

**Ajustar em `controllers/chatController.js` (~6190):**
- Bloco que faz `.from('empresas_whatsapp').select('phone_number_id')` para resolver `phoneId`. Como a tabela não existe mais e o resultado sempre era `null`, remover o bloco e deixar `phoneId = null` (o envio via UltraMsg/Z-API não depende dele). Já está dentro de try/catch, então é seguro.

**Testes/limpeza:**
- `grep -rIn "empresas_whatsapp\|EmpresasWhatsapp\|phone_number_id" --include=*.js controllers services routes` → não deve sobrar nada ativo.
- `npm test` verde.
- Verificar frontend que chamava `/config/empresas-whatsapp`.
