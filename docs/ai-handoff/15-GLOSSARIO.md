# Glossário do backend ZapERP

> Análise: 2026-08-23 · `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a`.

| Termo | Significado no código |
|---|---|
| ACK | Confirmação do provider sobre mensagem outbound; UltraMSG usa `pending/server/device/read/played`. |
| atendimento | Período/registro de responsabilidade e movimentação de uma conversa. |
| atendente / supervisor / admin | Perfis crescentes de operação; algumas ações usam permissão granular, muitas usam perfil. |
| `company_id` | Chave do tenant/empresa. Deve vir de identidade confiável. |
| conversa | Thread com contato/grupo em uma instância WhatsApp; possui fila, setor, atendente, estado e não lidos. |
| departamento/setor | Unidade de fila/visibilidade; usuários e grupos podem ser vinculados. |
| direção inbound/outbound | Mensagem recebida do cliente / enviada pelo sistema ou usuário. |
| `client_temp_id` | ID criado pelo cliente HTTP para deduplicar envio manual e reconciliar resposta. |
| `referenceId` | Correlação enviada ao UltraMSG: `crm-<mensagem>` ou `disp-<fila>`. |
| `whatsapp_id` / provider id | Identificador externo rastreável da mensagem. Número curto interno não é aceito como id real. |
| instância default | Instância ativa escolhida quando ação pode omitir seleção; em produção fallbacks são restritos. |
| LID | Identificador alternativo WhatsApp que não deve ser tratado como telefone real. |
| modo simples | Modelo de pendência derivado da última mensagem, sem necessariamente assumir atendimento. |
| aguardando cliente/atendente/pagamento | Estados operacionais da conversa, manuais ou automáticos. |
| URA/triagem | Menu/regras automáticas de entrada, horário e redirecionamento. |
| mensagem interna | Nota/mensagem visível a operadores autorizados, não enviada ao WhatsApp. |
| room/sala | Canal Socket.IO `empresa_*`, `usuario_*`, `departamento_*`, `conversa_*` ou `internal_user_*`. |
| RLS | Row Level Security do PostgreSQL; existe em migrations, mas service role do backend a ignora. |
| R2 | Object storage S3-compatible opcional para mídia, com rollout/mirror/retenção. |
| mirror | Cópia assíncrona de mídia local para R2. |
| reconciliação | Determinação posterior do resultado de mensagem pendente/incerta usando ids/ACK/evidências. |
| opt-in / opt-out | Consentimento / descadastro. Em Disparo, comando exato cria exclusão e status terminal. |
| campanha | Configuração de Disparo com destinatários, instâncias, variações, limites e revisão. |
| execução | Snapshot/rodada de uma campanha confirmada. |
| item da fila | Unidade destinatário+variação+instância processada pelo worker. |
| lease | Reserva temporária persistente de item por worker; expiração permite recuperação controlada. |
| `incerta` | Provider pode ter aceitado, mas não há confirmação suficiente; não reenvia automaticamente. |
| dry-run | Simulação que não chama UltraMSG. Default de Disparo. |
| allowlist | Telefones/empresas autorizados em teste; lista vazia de telefones no worker não é bloqueio por si só. |
| webhook | Callback server-to-server da UltraMSG para inbound/ACK; protegido por token e instância. |
| fromMe | Eco de mensagem originada pela própria conta WhatsApp; deve reconciliar outbound, não duplicar inbound. |
| stale | Trabalho/lock sem heartbeat dentro do prazo, candidato a recuperação. |
| Etapa 8/9 | Evoluções do módulo Disparo: opt-out/respostas/reconciliação/relatórios e, no repositório, auditoria/lease/health (Etapa 9 commitada; aplicação no banco = `PENDENTE DE VALIDAÇÃO`). |
| legado Z-API/CRM | Nomes, aliases ou fallbacks preservados após migração para UltraMSG/CRM externo; existência no banco real não é garantida. |

