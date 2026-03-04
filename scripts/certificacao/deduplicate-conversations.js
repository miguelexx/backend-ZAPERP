#!/usr/bin/env node
/**
 * Script de deduplicação de conversas (rodar manualmente).
 * Mescla conversas duplicadas por (company_id, telefone canônico) e reconcilia LID.
 *
 * Uso: node scripts/certificacao/deduplicate-conversations.js [company_id]
 * Se company_id não informado, processa todas as empresas.
 *
 * Requer: .env com SUPABASE_URL e SUPABASE_SERVICE_KEY
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })
const { createClient } = require('@supabase/supabase-js')
const { phoneKeyBR } = require('../../helpers/phoneHelper')
const { mergeConversasIntoCanonico } = require('../../helpers/conversationSync')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
)

async function deduplicateConversations(companyId = null) {
  const cidFilter = companyId != null ? Number(companyId) : null
  let query = supabase
    .from('conversas')
    .select('id, telefone, chat_lid, ultima_atividade, criado_em, tipo, company_id')
    .neq('status_atendimento', 'fechada')
    .not('telefone', 'is', null)

  if (cidFilter) query = query.eq('company_id', cidFilter)
  const { data: conversas, error } = await query

  if (error) {
    console.error('Erro ao buscar conversas:', error.message)
    process.exit(1)
  }

  const byCompany = new Map()
  for (const c of conversas || []) {
    const cid = c.company_id
    if (!byCompany.has(cid)) byCompany.set(cid, [])
    byCompany.get(cid).push(c)
  }

  let totalMerged = 0
  for (const [cid, list] of byCompany) {
    const individuais = list.filter((c) => !c.tipo || String(c.tipo).toLowerCase() !== 'grupo')
    const byKey = new Map()
    for (const c of individuais) {
      const key = phoneKeyBR(c.telefone) || String(c.telefone || '').replace(/\D/g, '')
      if (!key) continue
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(c)
    }

    for (const [, convList] of byKey) {
      if (convList.length <= 1) continue
      convList.sort((a, b) => {
        const ta = new Date(a.ultima_atividade || a.criado_em || 0).getTime()
        const tb = new Date(b.ultima_atividade || b.criado_em || 0).getTime()
        if (tb !== ta) return tb - ta
        return (b.id || 0) - (a.id || 0)
      })
      const canonical = convList[0]
      const otherIds = convList.slice(1).map((c) => c.id).filter(Boolean)
      if (otherIds.length === 0) continue
      try {
        await mergeConversasIntoCanonico(supabase, cid, canonical.id, otherIds)
        totalMerged += otherIds.length
        console.log(`[company ${cid}] Mescladas ${otherIds.length} conversas → ${canonical.id}`)
      } catch (e) {
        console.warn('Erro ao mesclar:', e?.message || e)
      }
    }

    const lidConvs = individuais.filter((c) => String(c.telefone || '').startsWith('lid:'))
    for (const lidConv of lidConvs) {
      const lidPart = lidConv.telefone ? String(lidConv.telefone).replace(/^lid:/, '').trim() : (lidConv.chat_lid || '')
      if (!lidPart) continue
      const canonPhone = individuais
        .filter((c) => c.id !== lidConv.id && !String(c.telefone || '').startsWith('lid:') && c.chat_lid === lidPart)
        .sort((a, b) => new Date(b.ultima_atividade || 0).getTime() - new Date(a.ultima_atividade || 0).getTime())[0]
      if (canonPhone) {
        try {
          await mergeConversasIntoCanonico(supabase, cid, canonPhone.id, [lidConv.id])
          totalMerged += 1
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', canonPhone.id).eq('company_id', cid)
          console.log(`[company ${cid}] LID ${lidPart} mesclada em conv ${canonPhone.id}`)
        } catch (e) {
          console.warn('LID merge:', e?.message || e)
        }
      }
    }
  }

  return totalMerged
}

const companyId = process.argv[2] || null
deduplicateConversations(companyId)
  .then((n) => {
    console.log(`\n✅ Deduplicação concluída. ${n} conversa(s) mesclada(s).`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
