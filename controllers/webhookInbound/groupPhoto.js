/**
 * Callback de atualização de foto de grupo do webhook inbound (UltraMSG).
 * Payload: `{ groupId, groupPhoto }` SEM campos de mensagem/phone — atualiza `conversas.foto_grupo`
 * e emite `conversa_atualizada`. Extraído verbatim do topo de receberZapi (Fase 5, doc 24) sem
 * alteração de comportamento.
 *
 * `handleGroupPhotoOnlyPayload(req, res, company_id)` retorna `true` quando o payload era só de foto
 * de grupo e a resposta HTTP já foi enviada (sempre 200, para o UltraMSG não reentregar um callback
 * cosmético); `false` quando não era esse caso e o pipeline normal deve seguir.
 *
 * Contrato coberto por tests/receberZapiContract.test.js (foto de grupo → 200 com `updated`).
 */

const supabase = require('../../config/supabase')
const { normalizeGroupIdForStorage } = require('../../helpers/phoneHelper')
const { emitirParaUsuariosQuePodemVerConversa } = require('../../services/chat/realtime/chatRealtimeGateway')

async function handleGroupPhotoOnlyPayload(req, res, company_id) {
  const body = req.body || {}
  const rawGroupId = body.groupId != null ? String(body.groupId).trim() : ''
  const rawGroupPhoto = body.groupPhoto != null ? String(body.groupPhoto).trim() : ''
  const hasOnlyGroupPhotoPayload =
    rawGroupId &&
    rawGroupPhoto &&
    !body.phone &&
    !body.text &&
    !body.message &&
    !body.body &&
    !body.image &&
    !body.audio &&
    !body.video &&
    !body.document &&
    !body.sticker

  if (!hasOnlyGroupPhotoPayload) return false

  const groupIdForStorage = normalizeGroupIdForStorage(rawGroupId) || rawGroupId
  try {
    const { data, error } = await supabase
      .from('conversas')
      .update({ foto_grupo: rawGroupPhoto })
      .eq('company_id', company_id)
      .in('telefone', [groupIdForStorage, rawGroupId])
      .select('id')

    if (error) {
      console.error('[Z-API] ❌ Erro ao atualizar foto de grupo via callback groupPhoto:', error)
      // Webhook: sempre 200 para o UltraMsg não reentregar um callback puramente cosmético.
      req.webhookLogData = { ...(req.webhookLogData || {}), status: 'error', error_message: 'group_photo_update_failed' }
      res.status(200).json({ ok: false, error: 'Erro ao atualizar foto de grupo' })
      return true
    }

    const updatedCount = Array.isArray(data) ? data.length : 0
    console.log('[Z-API] ✅ Foto de grupo atualizada via callback groupPhoto:', {
      groupId: rawGroupId,
      storedId: groupIdForStorage,
      updated: updatedCount
    })

    // Emite atualização de conversa para atualizar avatar no front
    if (updatedCount > 0) {
      const io = req.app.get('io')
      if (io) {
        for (const row of data) {
          await emitirParaUsuariosQuePodemVerConversa(io, company_id, row.id, 'conversa_atualizada', {
            id: row.id,
            foto_grupo: rawGroupPhoto
          })
        }
      }
    }

    res.status(200).json({ ok: true, updated: updatedCount })
    return true
  } catch (e) {
    console.error('[Z-API] ❌ Exceção ao processar callback groupPhoto:', e?.message || e)
    // Webhook: sempre 200 para o UltraMsg não reentregar um callback puramente cosmético.
    req.webhookLogData = { ...(req.webhookLogData || {}), status: 'error', error_message: e?.message || 'group_photo_exception' }
    res.status(200).json({ ok: false, error: 'Erro ao processar callback de foto de grupo' })
    return true
  }
}

module.exports = { handleGroupPhotoOnlyPayload }
