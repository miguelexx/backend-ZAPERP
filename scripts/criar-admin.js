#!/usr/bin/env node
/**
 * Cria usuário admin no banco (útil quando todos usuários foram excluídos).
 *
 * Uso: node scripts/criar-admin.js
 *      node scripts/criar-admin.js [email] [senha]
 *
 * Env: ADMIN_EMAIL, ADMIN_SENHA — override (ex: ADMIN_EMAIL=admin@empresa.com ADMIN_SENHA=minhasenha node scripts/criar-admin.js)
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const supabase = require('../config/supabase')
const bcrypt = require('bcryptjs')

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.argv[2] || 'admin@admin.com'
const ADMIN_SENHA = process.env.ADMIN_SENHA || process.argv[3] || 'admin123'
const ADMIN_NOME = process.env.ADMIN_NOME || 'Administrador'

async function criarAdmin() {
  console.log('Criando usuário admin...')
  console.log('  Email:', ADMIN_EMAIL)
  console.log('  Empresa: verificando/criando company_id=1')

  const emailNorm = String(ADMIN_EMAIL).trim().toLowerCase()
  if (!emailNorm) {
    console.error('Email inválido.')
    process.exit(1)
  }
  if (ADMIN_SENHA.length < 6) {
    console.error('Senha deve ter no mínimo 6 caracteres.')
    process.exit(1)
  }

  // 1) Garantir que existe empresa (company_id)
  const { data: empresas, error: errEmp } = await supabase
    .from('empresas')
    .select('id')
    .limit(1)
    .order('id', { ascending: true })

  let company_id = 1
  if (errEmp) {
    console.error('Erro ao buscar empresas:', errEmp.message)
    process.exit(1)
  }
  if (!empresas || empresas.length === 0) {
    const { data: novaEmp, error: errInsertEmp } = await supabase
      .from('empresas')
      .insert({ nome: 'Empresa Principal', ativo: true })
      .select('id')
      .single()
    if (errInsertEmp) {
      console.error('Erro ao criar empresa:', errInsertEmp.message)
      process.exit(1)
    }
    company_id = novaEmp.id
    console.log('  Empresa criada com id:', company_id)
  } else {
    company_id = empresas[0].id
    console.log('  Empresa existente id:', company_id)
  }

  // 2) Verificar se email já existe
  const { data: existente } = await supabase
    .from('usuarios')
    .select('id, email')
    .eq('email', emailNorm)
    .maybeSingle()

  if (existente) {
    console.log('Usuário com este email já existe (id=%s). Atualizando senha...', existente.id)
    const hash = await bcrypt.hash(ADMIN_SENHA, 10)
    const { error: errUpd } = await supabase
      .from('usuarios')
      .update({ senha_hash: hash, perfil: 'admin', ativo: true })
      .eq('id', existente.id)
    if (errUpd) {
      console.error('Erro ao atualizar senha:', errUpd.message)
      process.exit(1)
    }
    console.log('Senha atualizada. Faça login com:', emailNorm)
    process.exit(0)
    return
  }

  // 3) Criar admin
  const hash = await bcrypt.hash(ADMIN_SENHA, 10)
  const { data: novo, error } = await supabase
    .from('usuarios')
    .insert({
      nome: ADMIN_NOME,
      email: emailNorm,
      senha_hash: hash,
      perfil: 'admin',
      ativo: true,
      company_id,
    })
    .select('id, nome, email, perfil')
    .single()

  if (error) {
    console.error('Erro ao criar usuário:', error.message)
    process.exit(1)
  }

  console.log('Usuário admin criado com sucesso!')
  console.log('  ID:', novo.id)
  console.log('  Email:', novo.email)
  console.log('  Perfil:', novo.perfil)
  console.log('')
  console.log('Faça login com o email acima e a senha que você definiu.')
  process.exit(0)
}

criarAdmin().catch((e) => {
  console.error(e)
  process.exit(1)
})
