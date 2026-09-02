/**
 * Import de histórico do celular ao abrir uma conversa NOVA pelo inbound (best-effort, fire-and-forget).
 * Extraído verbatim de receberZapi (Fase 5 — doc 24). Puxa até 25 mensagens do provider (UltraMSG),
 * insere as que faltam (idempotência por `whatsapp_id`; ignora placeholders `(mídia)` sem URL) e agenda
 * download de mídia. Roda em `setImmediate` DEPOIS da mensagem atual — não quebrar a ordem "primeira
 * mensagem"/`mensagem_disparada`. Não é o backfill sob demanda (`services/oldMessagesSyncService.js`).
 *
 * O chamador só invoca quando a conversa é nova (`isNewConversation`).
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { extractMessage } = require('./payload')
const { applyWhatsappInstanceFilterOrLegacy } = require('./whatsappIdLookup')
const {
  schedulePersistInboundMediaIfNeeded,
  tipoQualificaPersistencia,
} = require('../../services/inboundMediaPersistenceService')

const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

function scheduleNewConversationHistoryImport({ conversaId, phone, isGroup, companyId, whatsappInstanceId, io }) {
  const provider = getProvider()
  if (!provider || !provider.getChatMessages || !provider.isConfigured) return
  setImmediate(async () => {
    try {
      const history = await provider.getChatMessages(phone, 25, null, { companyId, whatsappInstanceId: whatsappInstanceId || undefined }).catch(() => [])
      if (!Array.isArray(history) || history.length === 0) return

      const ordered = history
        .map((m) => m)
        .sort((a, b) => Number(a?.momment || a?.timestamp || 0) - Number(b?.momment || b?.timestamp || 0))

      for (const m of ordered) {
        const p = { ...(m || {}), isGroup, phone }
        const ex = extractMessage(p)
        const wId = ex.messageId ? String(ex.messageId).trim() : null
        if (!ex.texto) continue
        const placeholder = ex.texto === '(mídia)' && !ex.imageUrl && !ex.documentUrl && !ex.audioUrl && !ex.videoUrl && !ex.stickerUrl && !ex.locationUrl
        if (placeholder) continue
        if (!wId) continue

        const direcaoHistory = ex.fromMe ? 'out' : 'in'
        const insertMsg = {
          conversa_id: conversaId,
          texto: ex.texto,
          direcao: direcaoHistory,
          company_id: companyId,
          ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
          whatsapp_id: wId,
          criado_em: ex.criado_em
        }

        if (ex.fromMe) {
          let existOutQuery = supabase
            .from('mensagens')
            .select('id, criado_em, whatsapp_id')
            .eq('company_id', companyId)
            .eq('conversa_id', conversaId)
            .eq('direcao', 'out')
            .eq('texto', ex.texto)
            .order('id', { ascending: false })
            .limit(1)
          existOutQuery = applyWhatsappInstanceFilterOrLegacy(existOutQuery, whatsappInstanceId)
          const { data: existOut } = await existOutQuery.maybeSingle()
          if (existOut && !existOut.whatsapp_id) {
            const updatePayload = { whatsapp_id: wId }
            const yearExist = existOut.criado_em ? new Date(existOut.criado_em).getFullYear() : 0
            const yearNew = ex.criado_em ? new Date(ex.criado_em).getFullYear() : 0
            if (yearExist < 2020 && yearNew >= 2020) updatePayload.criado_em = ex.criado_em
            await supabase.from('mensagens').update(updatePayload).eq('company_id', companyId).eq('id', existOut.id)
            continue
          }
        }

        if (isGroup && !ex.fromMe) {
          if (ex.senderName) insertMsg.remetente_nome = ex.senderName
          if (ex.participantPhone) insertMsg.remetente_telefone = ex.participantPhone
        }

        if (ex.type === 'image' && ex.imageUrl) {
          insertMsg.tipo = 'imagem'
          insertMsg.url = ex.imageUrl
          insertMsg.nome_arquivo = ex.fileName || 'imagem.jpg'
        } else if ((ex.type === 'document' || ex.type === 'file') && ex.documentUrl) {
          insertMsg.tipo = 'arquivo'
          insertMsg.url = ex.documentUrl
          insertMsg.nome_arquivo = ex.fileName || 'arquivo'
        } else if (ex.type === 'audio' && ex.audioUrl) {
          insertMsg.tipo = 'audio'
          insertMsg.url = ex.audioUrl
          insertMsg.nome_arquivo = ex.fileName || 'audio'
        } else if (ex.type === 'video' && ex.videoUrl) {
          insertMsg.tipo = 'video'
          insertMsg.url = ex.videoUrl
          insertMsg.nome_arquivo = ex.fileName || 'video'
        } else if (ex.type === 'sticker' && ex.stickerUrl) {
          insertMsg.tipo = 'sticker'
          insertMsg.url = ex.stickerUrl
          insertMsg.nome_arquivo = ex.fileName || 'sticker.webp'
        } else if (ex.type === 'location') {
          insertMsg.tipo = 'location'
          if (ex.locationUrl) insertMsg.url = ex.locationUrl
          insertMsg.nome_arquivo = 'localização'
          if (ex.locationMeta && (ex.locationMeta.latitude != null || ex.locationMeta.longitude != null)) {
            insertMsg.location_meta = ex.locationMeta
          }
        }

        const { data: histRow, error: histErr } = await supabase
          .from('mensagens')
          .insert(insertMsg)
          .select(WEBHOOK_MSG_SELECT)
          .single()
        if (histErr && String(histErr.code || '') !== '23505') {
          console.warn('⚠️ Histórico Z-API: falha ao inserir msg:', String(histErr.message || '').slice(0, 120))
        } else if (!histErr && histRow?.id && histRow.url && String(histRow.url).startsWith('https://') && tipoQualificaPersistencia(histRow.tipo)) {
          schedulePersistInboundMediaIfNeeded({
            supabase,
            io,
            company_id: companyId,
            mensagem_id: histRow.id,
            fromMe: !!ex.fromMe,
            departamento_id: null,
          })
        }
      }
    } catch (e) {
      console.warn('⚠️ Histórico Z-API: erro ao importar:', e?.message || e)
    }
  })
}

module.exports = { scheduleNewConversationHistoryImport }
