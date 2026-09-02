/**
 * Grupo inbound: resolve os campos do MEMBRO que enviou a mensagem (`remetente_telefone` +
 * `remetente_nome`) para gravar na linha da mensagem do grupo. Extraído verbatim de receberZapi
 * (Fase 5 — doc 24). A mensagem em si é sempre salva no grupo; estes campos identificam o remetente.
 *
 * Ordem: normaliza o telefone do participante → tenta achar o nome no cadastro `clientes` →
 * se não existe, cria via `getOrCreateCliente` (evita duplicata 12×13 dígitos) e agenda sync de
 * nome/foto reais em background (setImmediate, best-effort; `chooseBestName` evita regressão).
 *
 * Retorna `{ remetente_telefone?, remetente_nome? }` para o chamador mesclar no `insertMsg`.
 */

const supabase = require('../../config/supabase')
const { normalizePhoneBR, possiblePhonesBR } = require('../../helpers/phoneHelper')
const { getDisplayName, chooseBestName } = require('../../helpers/contactEnrichment')
const { getOrCreateCliente } = require('../../helpers/conversationSync')
const { selectClienteNomeFoto } = require('../../helpers/clienteNomeColunas')
const { syncUltraMsgContact } = require('../../services/ultramsgSyncContact')
const { clienteTemNomeProtegido } = require('../../helpers/clienteNomeProtecao')

async function resolveGroupSenderFields({ companyId, participantPhone, senderName }) {
  const out = {}
  const pNorm = participantPhone ? (normalizePhoneBR(participantPhone) || String(participantPhone).replace(/\D/g, '')) : ''
  if (pNorm) out.remetente_telefone = pNorm

  // Tenta resolver nome do membro pelo cadastro de clientes (contatos já sincronizados).
  let remetenteNomeFinal = senderName || pNorm || null
  if (pNorm) {
    try {
      const pPhones = possiblePhonesBR(pNorm)
      let qM = supabase.from('clientes').select('id, nome, pushname, telefone').order('id', { ascending: true }).limit(3)
      if (pPhones.length > 0) qM = qM.in('telefone', pPhones)
      else qM = qM.eq('telefone', pNorm)
      qM = qM.eq('company_id', companyId)
      const { data: rowsM } = await qM
      const ex = Array.isArray(rowsM) && rowsM.length > 0 ? rowsM[0] : null
      if (ex) {
        remetenteNomeFinal = getDisplayName(ex) || remetenteNomeFinal
      } else {
        // se não existe no banco, usa getOrCreateCliente para evitar duplicata (mesmo contato 12 vs 13 dígitos)
        if (pNorm) {
          const nomeMin = senderName ? String(senderName).trim() : pNorm
          const { cliente_id: cidGrupo } = await getOrCreateCliente(supabase, companyId, pNorm, {
            nome: nomeMin,
            nomeSource: 'grupo_sender',
            pushname: senderName ? String(senderName).trim() : undefined,
          })
          if (cidGrupo) {
            // sync em background (nome/foto reais) — chooseBestName evita regressão
            setImmediate(async () => {
              try {
                const { data: current } = await selectClienteNomeFoto(supabase, { id: cidGrupo, companyId })
                const sync = await syncUltraMsgContact(pNorm, companyId, { skipPersistence: true }).catch(() => null)
                if (!sync) return
                const up = {}
                const telefoneTail = String(pNorm).replace(/\D/g, '').slice(-6) || null
                if (!clienteTemNomeProtegido(current)) {
                  const { name: bestNome } = chooseBestName(current?.nome, sync.nome, 'syncUltramsg', { fromMe: false, company_id: companyId, telefoneTail })
                  if (bestNome && bestNome !== (current?.nome || '')) up.nome = bestNome
                }
                if (!current?.pushname && sync.pushname) up.pushname = sync.pushname
                if (!current?.foto_perfil && sync.foto_perfil) up.foto_perfil = sync.foto_perfil
                if (Object.keys(up).length > 0) await supabase.from('clientes').update(up).eq('id', cidGrupo)
              } catch (_) {}
            })
          }
        }
      }
    } catch (_) {}
  }
  if (remetenteNomeFinal) out.remetente_nome = String(remetenteNomeFinal).trim()
  return out
}

module.exports = { resolveGroupSenderFields }
