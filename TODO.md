# Auditoria produção WhatsApp (UltraMsg/ZapERP) — TODO

## 1) Mapeamento e diagnóstico
- [x] Ler arquivos críticos solicitados
- [x] Consolidar fluxo ponta-a-ponta (webhook → conversa → mensagem → mídia → socket → frontend)
- [x] Listar riscos reais por criticidade (quebra produção / duplicação / perda / performance)

## 2) Correções conservadoras e seguras
- [ ] Corrigir apenas bugs reais sem quebrar contratos (rotas/API/frontend)
- [ ] Garantir idempotência e evitar duplicação de mensagens/socket
- [ ] Ajustar pontos de mídia persistida com segurança
- [ ] Ajustar contadores/listagem para consistência em escala

## 3) Validação técnica
- [ ] Revisar rotas e middleware de segurança
- [ ] Revisar compatibilidade de payload/socket com frontend atual
- [ ] Rodar checagem básica (lint/teste/comando viável no projeto)

## 4) Entrega
- [ ] Entregar relatório final (fluxo + problemas + correções)
- [ ] Veredito final: APROVADO / NÃO APROVADO para produção
