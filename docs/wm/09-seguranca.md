# Segurança

## IMPLEMENTADO

Worker autentica HTTP e upgrade WSS por Bearer token; backend calcula SHA-256
e exige sincronizador ativo. Somente token_hash está no schema cloud.
CNPJ e codigo_erp não são credenciais. APIs do Assistente exigem credencial
própria do consumidor e resolvem contato ativo. Queries operacionais usam parâmetros; a IA
não recebe endpoint de SQL livre. Escrita de orçamento passa por contrato,
revalidação local, transação e idempotência na API.

O provisionamento gera randomBytes(32) nativo, prefixo wm_sync_ e base64url:
256 bits de entropia. Apenas SHA-256 hexadecimal entra no INSERT; token puro é
retornado somente na emissão. Nunca é recuperado por identidade/consulta.
Erros SQL são sanitizados. CLI exige terminal interativo e não usa console.log
para o token; o técnico deve evitar gravação/transcrição do terminal.
Empresa precisa existir; provisionar novamente é recusado, inclusive se inativo.

## IMPLEMENTADO — administração da Etapa 4

Backend administrativo reutiliza provisionamento seguro e emite token apenas
na criação/rotação. Usuários PostgreSQL, senha scrypt, sessão persistente com expiração,
cookie HttpOnly/Secure em produção/SameSite=Strict, CSRF e limite de login.
Admin não aceita Bearer n8n/ZapERP/Worker. Todas as rotas exceto login usam middleware
central. Logout revoga só a sessão atual no banco; restart não invalida sessões válidas.
Token aleatório de 256 bits somente no cookie; SHA-256 em admin_sessoes, CSRF derivado
por HMAC do token da sessão, sem secret de assinatura no ambiente. Desativação e
troca de senha revogam todas as sessões do usuário; último ativo é protegido.
Operações de identidade têm lock e bloqueio após provisionamento. Contatos são
alterados somente pelo par contatoId/sincronizadorId validado no repository.
Respostas no-store; SELECTs administrativos não retornam token/hash. Erros de
persistência administrativos/provisionamento são sanitizados, sem log de parâmetros.

Comparação CNPJ cloud/local está implementada no Worker e bloqueia sincronização,
WSS e orçamento até confirmação. Estado é por processo, não revogação contínua.
Autenticação existente não distingue token inválido de inativo (ambos 401).
Falha de rede/timeout é API_INDISPONIVEL, nunca CNPJ divergente.
Rotação/revogação exige invalidar autenticação e tratar sockets existentes:
rotas administrativas de desativação/rotação agora encerram o WSS previamente
autenticado nesta instância. Alteração manual no banco não dispara essa capacidade.

## Regras permanentes

Não versionar senha, token, connection string real ou CNPJ/identificação real
de cliente na documentação. Exemplos são placeholders ou fixtures claramente
fictícias. Não registrar credenciais; revisar exceções e logs antes de publicação.
Não reutilizar N8N_API_TOKEN, ZAPERP_API_TOKEN ou token de Worker como credencial administrativa.
HTTPS/WSS é requisito de produção; TLS efetivo do proxy não foi auditado.

Backend resolve empresa/sincronizador e valida associação dos dados. Contratos
não devem ganhar IDs arbitrários para contornar isolamento. Confirmação humana
no canal não substitui validação local, autorização ou idempotência.

A identidade cruzada foi implementada na Etapa 3; sessão administrativa e
revogação local de conexão na Etapa 4. Criptografia local **DEFINIDA / A IMPLEMENTAR**
no Configurador; ele deverá preservar permissões/configuração e não enviar secrets
em argumentos. Sessões administrativas persistem; limites de login e realtime
distribuídos **FUTURO**, sem Redis/pub-sub.
Admin/realtime requerem instância única. Revogação não desfaz escrita ERP já enviada.
[Política completa da Etapa 4](13-etapa4-backend-administrativo.md).
[Segurança local](../../wm-sincronizador/docs/07-seguranca-local.md).

## Credenciais dos consumidores externos

- N8N_API_TOKEN: exclusivo do n8n/WhatsApp.
- ZAPERP_API_TOKEN: exclusivo do backend ZapERP, nunca do navegador.
- Ambos vêm de secret/environment da API, exigem string não vazia e valores
  diferentes. Não são persistidos no PostgreSQL nem emitidos por endpoints.
- O middleware único em /api/v1/assistente exige Bearer e calcula SHA-256 em
  memória, comparando ambos os digests de 32 bytes com timingSafeEqual, sem
  short-circuit para a primeira credencial. Nenhum token/digest é logado.
- request.consumidorAssistente identifica internamente n8n/zaperp, apenas para
  futura auditoria. Não vem do body/header de identificação e não seleciona tenant.
- Telefone autorizado continua resolvendo contexto pelo módulo existente.
  Esses consumidores são confiáveis para informar o telefone; o Bearer não prova
  a origem WhatsApp de uma mensagem nem restringe uma credencial a uma única empresa.
- Tokens de Worker permanecem no mecanismo próprio, sem consulta ao seu hash
  para autenticar um consumidor. Não usar token de Worker nessas variáveis.

O middleware anterior removia o prefixo sem exigi-lo. Agora token puro, Basic e
Bearer malformado são recusados com o mesmo 401 TOKEN_ASSISTENTE_INVALIDO,
sem expor credencial ou detalhes. Clientes corretos com Bearer continuam compatíveis.
