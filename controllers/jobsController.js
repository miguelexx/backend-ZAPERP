/**
 * Jobs para cron (timeout inatividade, etc.)
 * Protegido por header X-Cron-Secret === process.env.CRON_SECRET
 */
const supabase = require('../config/supabase')

function checkCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET
  const provided = req.headers['x-cron-secret']
  if (!secret || secret !== provided) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

/** POST /jobs/timeout-inatividade — fecha/reabre conversas inativas */
exports.timeoutInatividade = async (req, res) => {
  try {
    const { data: empresas } = await supabase
      .from('empresas')
      .select('id, timeout_inatividade_min')
      .gt('timeout_inatividade_min', 0)

    if (!empresas || empresas.length === 0) {
      return res.json({ ok: true, processadas: 0, mensagem: 'Nenhuma empresa com timeout configurado' })
    }

    let totalProcessadas = 0

    for (const emp of empresas) {
      const min = Number(emp.timeout_inatividade_min) || 0
      if (min <= 0) continue

      // Conversas em_atendimento onde última msg do cliente foi há mais de X min
      const { data: conversas } = await supabase
        .from('conversas')
        .select('id, atendente_id')
        .eq('company_id', emp.id)
        .eq('status_atendimento', 'em_atendimento')
        .not('atendente_id', 'is', null)

      if (!conversas?.length) continue

      const conversaIds = conversas.map((c) => c.id)

      const { data: ultimasMsg } = await supabase
        .from('mensagens')
        .select('conversa_id, criado_em, direcao')
        .in('conversa_id', conversaIds)
        .order('criado_em', { ascending: false })

      const ultimaPorConversa = {}
      ;(ultimasMsg || []).forEach((m) => {
        if (!ultimaPorConversa[m.conversa_id]) ultimaPorConversa[m.conversa_id] = m
      })

      const limite = new Date(Date.now() - min * 60 * 1000)

      for (const conv of conversas) {
        const ultima = ultimaPorConversa[conv.id]
        if (!ultima) continue
        // Só consideramos inativo se a ÚLTIMA mensagem foi do cliente (in)
        if (ultima.direcao !== 'in') continue
        if (new Date(ultima.criado_em) > limite) continue

        const { error } = await supabase
          .from('conversas')
          .update({
            status_atendimento: 'aberta',
            atendente_id: null,
            atendente_atribuido_em: null
          })
          .eq('id', conv.id)
          .eq('company_id', emp.id)

        if (!error) {
          totalProcessadas++
          await supabase.from('historico_atendimentos').insert({
            conversa_id: conv.id,
            usuario_id: null,
            acao: 'timeout_inatividade',
            observacao: `Conversa reaberta automaticamente após ${min} min sem resposta do atendente`
          })
        }
      }
    }

    return res.json({ ok: true, processadas: totalProcessadas })
  } catch (err) {
    console.error('timeoutInatividade:', err)
    return res.status(500).json({ error: err.message })
  }
}

exports.checkCronSecret = checkCronSecret
