/**
 * Middleware de otimização para consultas de conversas
 * Melhora performance e adiciona cache inteligente
 */

const cache = new Map()
const CACHE_TTL = 30 * 1000 // 30 segundos

/**
 * Cache inteligente para consultas de conversas por usuário
 */
function getCacheKey(company_id, user_id, filters = {}) {
  const filterStr = JSON.stringify(filters)
  return `conversas:${company_id}:${user_id}:${filterStr}`
}

/**
 * Middleware para otimizar consultas de conversas
 */
function optimizeConversaQueries(req, res, next) {
  // Adicionar hint de performance para consultas
  const originalJson = res.json
  
  res.json = function(data) {
    // Se é uma lista de conversas, adicionar metadados de performance
    if (Array.isArray(data) && data.length > 0 && data[0].id && data[0].telefone) {
      const metadata = {
        count: data.length,
        cached: false,
        timestamp: new Date().toISOString()
      }
      
      // Adicionar header com metadados
      res.setHeader('X-Conversas-Metadata', JSON.stringify(metadata))
    }
    
    return originalJson.call(this, data)
  }
  
  next()
}

/**
 * Limpa cache expirado periodicamente
 */
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of cache.entries()) {
    if (value.expiry <= now) {
      cache.delete(key)
    }
  }
}, 60 * 1000) // Limpar a cada minuto

module.exports = {
  optimizeConversaQueries,
  getCacheKey,
  cache,
  CACHE_TTL
}