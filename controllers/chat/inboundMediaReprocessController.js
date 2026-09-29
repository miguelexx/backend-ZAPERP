/**
 * Reprocesso manual da CÓPIA de mídia INBOUND (UltraMSG/Whapi -> /uploads).
 *
 * Diferente do retry-media (controllers/chat/retryController.js), que REENVIA uma mídia nossa que o
 * provedor não confirmou. Aqui o alvo é uma mídia RECEBIDA cuja cópia para /uploads ainda não
 * aconteceu — a bolha mostra "Áudio indisponível". O usuário clica em "tentar de novo" e este
 * endpoint força uma nova cópia (`force:true`), ignorando inclusive o estado `falha_definitiva`
 * (que o scheduler já teria desistido de tentar). Se o link remoto ainda estiver vivo, a mídia é
 * persistida em /uploads e o próprio `persistInboundMediaToUploads` emite `nova_mensagem` — a bolha
 * se cura sozinha pelo caminho já existente. Se o link expirou de vez, devolvemos `definitivo:true`
 * para o frontend parar de oferecer o botão e mostrar "expirou no WhatsApp".
 *
 * Nada do fluxo automático é tocado: reusa o serviço existente com a flag `force` que já existia.
 */

const supabase = require('../../config/supabase')
const {
  tipoQualificaPersistencia,
  persistInboundMediaToUploads,
} = require('../../services/inboundMediaPersistenceService')

/** Motivos de falha que NÃO adianta insistir: a mídia sumiu do provedor ou não é copiável. */
const MOTIVOS_DEFINITIVOS = new Set([
  'sem_url_remota',
  'url_invalida',
  'tipo_nao_qualifica',
])

/** Lock por processo: evita duas recópias concorrentes disparadas por cliques repetidos. */
const _reprocessosEmAndamento = new Set()

exports.reprocessarMidiaInbound = async (req, res) => {
  const company_id = Number(req.user?.company_id)
  const conversa_id = Number(req.params?.id)
  const mensagem_id = Number(req.params?.mensagem_id ?? req.params?.mensagemId)

  if (!Number.isFinite(company_id) || company_id <= 0) {
    return res.status(400).json({ error: 'company_id inválido na sessão' })
  }
  if (
    !Number.isSafeInteger(conversa_id) || conversa_id <= 0 ||
    !Number.isSafeInteger(mensagem_id) || mensagem_id <= 0
  ) {
    return res.status(400).json({ error: 'Identificadores inválidos' })
  }

  const { data: mensagem, error: errMsg } = await supabase
    .from('mensagens')
    .select('id, conversa_id, company_id, direcao, tipo, url')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('id', mensagem_id)
    .maybeSingle()

  if (errMsg) {
    return res.status(500).json({ error: 'Erro ao carregar mensagem' })
  }
  if (!mensagem) {
    return res.status(404).json({ error: 'Mensagem não encontrada nesta conversa' })
  }

  // Só mídia recebida se reprocessa aqui; mídia nossa que falhou no envio usa retry-media.
  if (String(mensagem.direcao || '').toLowerCase() === 'out') {
    return res.status(400).json({ error: 'Mídia enviada não é reprocessada por aqui.' })
  }
  if (!tipoQualificaPersistencia(mensagem.tipo)) {
    return res.status(400).json({ error: 'Mensagem não é uma mídia copiável.', definitivo: true })
  }

  const urlAtual = String(mensagem.url || '').trim()
  // Já está em /uploads: outra tentativa (ou o scheduler) resolveu. Nada a fazer — devolve a URL boa.
  if (urlAtual.startsWith('/uploads/')) {
    return res.json({ ok: true, url: urlAtual, status: 'concluida', ja_persistido: true })
  }

  const lockKey = `${company_id}:${mensagem_id}`
  if (_reprocessosEmAndamento.has(lockKey)) {
    return res.status(409).json({ error: 'Já existe um reprocesso em andamento para esta mídia.' })
  }
  _reprocessosEmAndamento.add(lockKey)

  try {
    const io = req.app?.get('io') || null
    const resultado = await persistInboundMediaToUploads({
      supabase,
      io,
      company_id,
      mensagem_id,
      fromMe: false,
      force: true,
    })

    // Relê a URL após a tentativa: em sucesso ela já aponta para /uploads.
    let urlFinal = urlAtual
    try {
      const { data: depois } = await supabase
        .from('mensagens')
        .select('url')
        .eq('company_id', company_id)
        .eq('id', mensagem_id)
        .maybeSingle()
      if (depois?.url) urlFinal = String(depois.url).trim()
    } catch (_) { /* melhor esforço; usa a URL anterior */ }

    if (urlFinal.startsWith('/uploads/')) {
      return res.json({ ok: true, url: urlFinal, status: 'concluida' })
    }
    if (resultado?.ok) {
      // ok sem trocar a URL (ex.: 'ja_persistido' que outra instância gravou): trata como resolvido.
      return res.json({ ok: true, url: urlFinal, status: 'concluida' })
    }

    // Falhou: decide se o frontend deve parar de oferecer o botão ("expirou"). Um link expirado
    // (HTTP 404/410 do provedor) já chega aqui com tipo 'definitiva' via classificarStatusHttp.
    const motivo = String(resultado?.motivo || resultado?.ignorado || 'desconhecido')
    const definitivo =
      resultado?.tipo === 'definitiva' ||
      MOTIVOS_DEFINITIVOS.has(motivo)

    return res.status(200).json({
      ok: false,
      definitivo,
      motivo,
      // 'lock'/'em_execucao'/allowlist são transitórios: o frontend mantém o botão de tentar de novo.
    })
  } catch (e) {
    console.warn('[inboundMediaReprocess] falha inesperada:', {
      mensagem_id, company_id, erro: e?.message || String(e),
    })
    return res.status(500).json({ ok: false, error: 'Falha ao reprocessar a mídia' })
  } finally {
    _reprocessosEmAndamento.delete(lockKey)
  }
}
