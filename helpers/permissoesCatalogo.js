/**
 * Catálogo completo de permissões do sistema.
 * Cada permissão pode ser concedida/negada por usuário, sobrescrevendo o padrão do perfil.
 *
 * admin: todas por padrão
 * supervisor: config, ia, dashboard, integracoes, departamentos_ver
 * atendente: clientes, atendimentos (chats)
 */
const PERMISSOES_CATALOGO = [
  // --- CLIENTES ---
  { codigo: 'clientes.ver', nome: 'Ver clientes', descricao: 'Acessar lista e detalhes de clientes', categoria: 'Clientes', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'clientes.criar', nome: 'Criar cliente', descricao: 'Cadastrar novos clientes', categoria: 'Clientes', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'clientes.editar', nome: 'Editar cliente', descricao: 'Alterar dados de clientes', categoria: 'Clientes', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'clientes.excluir', nome: 'Excluir cliente', descricao: 'Remover clientes do sistema', categoria: 'Clientes', perfis: ['admin', 'supervisor'] },

  // --- ATENDIMENTOS / CHATS ---
  { codigo: 'atendimentos.ver', nome: 'Ver atendimentos', descricao: 'Listar e visualizar conversas/chats', categoria: 'Atendimentos', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'atendimentos.assumir', nome: 'Assumir conversa', descricao: 'Assumir e atender conversas', categoria: 'Atendimentos', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'atendimentos.enviar', nome: 'Enviar mensagens', descricao: 'Enviar mensagens em conversas assumidas', categoria: 'Atendimentos', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'atendimentos.encerrar', nome: 'Encerrar conversa', descricao: 'Encerrar ou reabrir conversas', categoria: 'Atendimentos', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'atendimentos.transferir', nome: 'Transferir conversa', descricao: 'Transferir para outro atendente', categoria: 'Atendimentos', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'atendimentos.transferir_setor', nome: 'Transferir setor', descricao: 'Transferir conversa para outro setor/departamento', categoria: 'Atendimentos', perfis: ['admin'] },
  { codigo: 'atendimentos.puxar_fila', nome: 'Puxar da fila', descricao: 'Puxar próxima conversa aberta da fila', categoria: 'Atendimentos', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'atendimentos.tags', nome: 'Gerenciar tags', descricao: 'Adicionar e remover tags em conversas', categoria: 'Atendimentos', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'atendimentos.merge', nome: 'Mesclar duplicatas', descricao: 'Mesclar conversas duplicadas', categoria: 'Atendimentos', perfis: ['admin'] },

  // --- CONFIGURAÇÕES ---
  { codigo: 'config.ver', nome: 'Ver configurações', descricao: 'Acessar painel de configurações', categoria: 'Configurações', perfis: ['admin', 'supervisor'] },
  { codigo: 'config.editar', nome: 'Editar configurações', descricao: 'Alterar dados da empresa e preferências', categoria: 'Configurações', perfis: ['admin', 'supervisor'] },
  { codigo: 'config.whatsapp', nome: 'Configurar WhatsApp', descricao: 'Alterar foto/nome/descrição do perfil WhatsApp', categoria: 'Configurações', perfis: ['admin'] },
  { codigo: 'config.auditoria', nome: 'Auditoria', descricao: 'Visualizar logs de auditoria', categoria: 'Configurações', perfis: ['admin', 'supervisor'] },

  // --- CHATBOT / IA ---
  { codigo: 'ia.ver', nome: 'Ver IA/Chatbot', descricao: 'Acessar configurações do chatbot', categoria: 'IA/Chatbot', perfis: ['admin', 'supervisor'] },
  { codigo: 'ia.editar', nome: 'Editar IA/Chatbot', descricao: 'Alterar regras e fluxos do chatbot', categoria: 'IA/Chatbot', perfis: ['admin', 'supervisor'] },
  { codigo: 'ia.regras', nome: 'Regras de triagem', descricao: 'Configurar regras de triagem por setor', categoria: 'IA/Chatbot', perfis: ['admin', 'supervisor'] },

  // --- DASHBOARD ---
  { codigo: 'dashboard.ver', nome: 'Ver dashboard', descricao: 'Acessar métricas e relatórios', categoria: 'Dashboard', perfis: ['admin', 'supervisor'] },
  { codigo: 'dashboard.departamentos_ver', nome: 'Ver setores', descricao: 'Listar departamentos/setores', categoria: 'Dashboard', perfis: ['admin', 'supervisor'] },
  { codigo: 'dashboard.departamentos_gerenciar', nome: 'Gerenciar setores', descricao: 'Criar, editar e excluir setores', categoria: 'Dashboard', perfis: ['admin'] },
  { codigo: 'dashboard.sla', nome: 'Configurar SLA', descricao: 'Editar configurações de SLA', categoria: 'Dashboard', perfis: ['admin'] },
  { codigo: 'dashboard.respostas_salvas', nome: 'Respostas salvas', descricao: 'Gerenciar respostas rápidas por setor', categoria: 'Dashboard', perfis: ['admin', 'supervisor'] },

  // --- USUÁRIOS ---
  { codigo: 'usuarios.ver', nome: 'Ver usuários', descricao: 'Listar usuários da empresa', categoria: 'Usuários', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'usuarios.criar', nome: 'Criar usuário', descricao: 'Cadastrar novos usuários', categoria: 'Usuários', perfis: ['admin'] },
  { codigo: 'usuarios.editar', nome: 'Editar usuário', descricao: 'Alterar dados e perfil de usuários', categoria: 'Usuários', perfis: ['admin'] },
  { codigo: 'usuarios.excluir', nome: 'Excluir usuário', descricao: 'Remover usuários do sistema', categoria: 'Usuários', perfis: ['admin'] },
  { codigo: 'usuarios.permissoes', nome: 'Gerenciar permissões', descricao: 'Configurar permissões granulares de usuários', categoria: 'Usuários', perfis: ['admin'] },

  // --- INTEGRAÇÕES ---
  { codigo: 'integracoes.ver', nome: 'Ver integrações', descricao: 'Acessar status WhatsApp e QR Code', categoria: 'Integrações', perfis: ['admin', 'supervisor'] },
  { codigo: 'integracoes.editar', nome: 'Editar integrações', descricao: 'Conectar/desconectar instâncias WhatsApp', categoria: 'Integrações', perfis: ['admin', 'supervisor'] },

  // --- TAGS ---
  { codigo: 'tags.ver', nome: 'Ver tags', descricao: 'Listar tags da empresa', categoria: 'Tags', perfis: ['admin', 'supervisor', 'atendente'] },
  { codigo: 'tags.gerenciar', nome: 'Gerenciar tags', descricao: 'Criar, editar e excluir tags', categoria: 'Tags', perfis: ['admin', 'supervisor'] }
]

const PERMISSOES_POR_CODIGO = Object.fromEntries(
  PERMISSOES_CATALOGO.map((p) => [p.codigo, p])
)

/** Retorna se o perfil possui a permissão por padrão */
function perfilTemPermissaoPorPadrao(perfil, codigo) {
  const perm = PERMISSOES_POR_CODIGO[codigo]
  if (!perm) return false
  if (perfil === 'admin') return true
  return (perm.perfis || []).includes(perfil)
}

/** Retorna todas as permissões agrupadas por categoria */
function getCatalogoAgrupado() {
  const byCat = {}
  for (const p of PERMISSOES_CATALOGO) {
    if (!byCat[p.categoria]) byCat[p.categoria] = []
    byCat[p.categoria].push(p)
  }
  return byCat
}

module.exports = {
  PERMISSOES_CATALOGO,
  PERMISSOES_POR_CODIGO,
  perfilTemPermissaoPorPadrao,
  getCatalogoAgrupado
}
