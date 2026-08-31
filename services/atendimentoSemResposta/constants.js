const DEFAULT_ALERTA_SEM_RESPOSTA = {
  alerta_sem_resposta_ativo: false,
  tempo_primeiro_alerta_minutos: 1,
  tempo_alerta_critico_minutos: 3,
  tempo_notificar_gestor_minutos: 5,
  notificar_por_whatsapp: false,
  notificar_por_email: false,
  notificar_interno: true,
  reabrir_conversa_automaticamente: true,
  aplicar_tag_automatica: true,
  nome_tag_automatica: 'Reaberta por falta de resposta',
  gestor_notificado_id: null,
  gestor_cliente_id: null,
  gestor_cliente_nome: '',
  responsaveis_notificacao_ids: [],
  telefone_gestor: '',
  horario_comercial_ativo: true,
  timezone: 'America/Sao_Paulo',
}

const TAG_REABERTA_FALTA_RESPOSTA_COR = '#2563eb'

module.exports = {
  DEFAULT_ALERTA_SEM_RESPOSTA,
  TAG_REABERTA_FALTA_RESPOSTA_COR,
}
