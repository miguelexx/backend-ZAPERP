/**
 * Construção PURA do payload de `conversa_atualizada` emitido pelo webhook inbound (lista lateral do
 * chat, estilo WhatsApp Web). Extraído verbatim do emit-tail de receberZapi (Fase 5 — doc 24). Sem I/O:
 * recebe a `convRow` já carregada + o contexto computado e devolve o objeto a emitir.
 *
 * Único dependente externo: `aplicarModoSimplesNoPayload` (transform puro do modo simples).
 * Testado em `tests/webhookRealtimePayload.test.js`.
 */

const { aplicarModoSimplesNoPayload } = require('../../services/atendimentoModoSimplesService')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')

/**
 * Payload do evento `nova_mensagem` (mensagem inserida pelo webhook). `canon` (status canônico) é
 * calculado pelo chamador porque também alimenta o `status_mensagem` do caminho de reconciliação.
 * Nome/foto do contato só entram quando o nome não é um telefone cru (evita "nome" = número).
 */
function buildNovaMensagemPayload({ mensagemSalva, canon, convIdForEmit, fromMe, nomeParaCache, senderName, senderPhoto }) {
  const emitPayload = {
    ...mensagemSalva,
    criado_em: normalizarTimestampSemFusoAmbiguoParaApi(mensagemSalva.criado_em),
    conversa_id: mensagemSalva.conversa_id ?? convIdForEmit,
    status: canon,
    status_mensagem: canon,
    // fromMe e direcao EXPLÍCITOS: garantem que o frontend saiba se deve ou não
    // exibir notificação/som — NUNCA notificar para mensagens enviadas por nós (fromMe=true).
    fromMe,
    direcao: mensagemSalva.direcao ?? (fromMe ? 'out' : 'in'),
  }
  // Incluir nome e foto para o frontend exibir ao adicionar/atualizar conversa na lista
  const nomeContato = (nomeParaCache || senderName || '').toString().trim()
  const fotoContato = (senderPhoto && String(senderPhoto).trim().startsWith('http')) ? String(senderPhoto).trim() : null
  if (nomeContato && !nomeContato.replace(/\D/g, '').match(/^\d{10,15}$/)) {
    emitPayload.senderName = nomeContato
    emitPayload.chatName = nomeContato
  }
  if (fotoContato) {
    emitPayload.senderPhoto = fotoContato
    emitPayload.photo = fotoContato
  }
  return emitPayload
}

function buildConversaAtualizadaPayload({
  convIdForEmit,
  convRow,
  whatsappInstanceId,
  skipChatbotPorCampanha,
  isGroup,
  depId,
  contatoNome,
  fotoPerfil,
  mensagemFoiInseridaPeloWebhook,
  fromMe,
  modoSimplesRecalc,
  emitPayload,
}) {
  const temNotificacaoDiscretaEmAtendimento =
    !fromMe &&
    !isGroup &&
    (convRow?.status_atendimento === 'em_atendimento' ||
      convRow?.status_atendimento === 'aguardando_cliente') &&
    convRow?.atendente_id != null
  const convPayload = aplicarModoSimplesNoPayload(
    {
      id: convIdForEmit,
      whatsapp_instance_id: convRow?.whatsapp_instance_id ?? whatsappInstanceId ?? null,
      ultima_atividade: convRow?.ultima_atividade ?? new Date().toISOString(),
      telefone: convRow?.telefone ?? null,
      atendente_id: convRow?.atendente_id ?? null,
      aguardando_resposta_campanha: convRow?.aguardando_resposta_campanha === true,
      ...(skipChatbotPorCampanha
        ? { lista_realtime: { minha_fila: true, campanhas: true, motivo: 'campanha_respondida' } }
        : {}),
      // Grupos nunca mostram badge "aberta" — não precisam ser assumidos
      exibir_badge_aberta: !isGroup && convRow?.status_atendimento !== 'mensagem_disparada',
      ...(isGroup
        ? { status_atendimento: null, status_atendimento_real: null }
        : {
            status_atendimento: convRow?.status_atendimento ?? null,
            status_atendimento_real: convRow?.status_atendimento ?? null,
            aguardando_cliente_desde: convRow?.aguardando_cliente_desde ?? null,
          }),
      ...(depId != null ? { departamento_id: depId } : {}),
      ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
      ...(fotoPerfil ? { foto_perfil_contato_cache: fotoPerfil, foto_perfil: fotoPerfil } : {}),
      ...(mensagemFoiInseridaPeloWebhook && !fromMe
        ? {
            tem_novas_mensagens: true,
            tem_novas_mensagens_em_atendimento: temNotificacaoDiscretaEmAtendimento,
            lida: false,
          }
        : {}),
    },
    {
      modo_simples_aguardando:
        modoSimplesRecalc?.modo_simples_aguardando ?? convRow?.modo_simples_aguardando ?? null,
      atendimento_modo_simples: modoSimplesRecalc?.atendimento_modo_simples === true,
    },
    modoSimplesRecalc?.atendimento_modo_simples === true
  )
  // ultima_mensagem_preview: preview na lista lateral — direcao correta ('in'/'out') para exibir seta/ícone certo.
  // Para mensagem de contato, incluir tipo e contact_meta para o frontend exibir card em vez do vCard bruto.
  if (mensagemFoiInseridaPeloWebhook && emitPayload) {
    const preview = {
      texto: emitPayload.texto ?? '(mensagem)',
      criado_em: emitPayload.criado_em,
      direcao: emitPayload.direcao ?? (fromMe ? 'out' : 'in'),
      fromMe,
    }
    if (emitPayload.tipo === 'contact' && emitPayload.contact_meta) {
      preview.tipo = 'contact'
      preview.contact_meta = emitPayload.contact_meta
    }
    if (emitPayload.tipo === 'location' && emitPayload.location_meta) {
      preview.tipo = 'location'
      preview.location_meta = emitPayload.location_meta
    }
    convPayload.ultima_mensagem_preview = preview
  }
  // reordenar_suave: true — frontend deve animar o item para o topo em vez de refetch (evita "desce e sobe")
  convPayload.reordenar_suave = true
  return convPayload
}

module.exports = { buildConversaAtualizadaPayload, buildNovaMensagemPayload }
