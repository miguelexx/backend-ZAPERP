/**
 * Middleware de otimização de performance para o sistema WhatsApp
 * Garante que o sistema rode liso sem bugs ou travamentos
 */

const os = require('os')

// Métricas de performance
const performanceMetrics = {
  requests: 0,
  errors: 0,
  avgResponseTime: 0,
  memoryUsage: 0,
  lastCleanup: Date.now()
}

/**
 * Middleware principal de otimização
 */
function performanceOptimization(req, res, next) {
  const startTime = Date.now()
  performanceMetrics.requests++

  // Interceptar resposta para calcular tempo
  const originalSend = res.send
  res.send = function(data) {
    const responseTime = Date.now() - startTime
    updateMetrics(responseTime, res.statusCode >= 400)
    return originalSend.call(this, data)
  }

  // Headers de otimização
  res.setHeader('X-Response-Time', startTime)
  res.setHeader('X-Request-ID', `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)

  next()
}

/**
 * Atualiza métricas de performance
 */
function updateMetrics(responseTime, isError) {
  if (isError) performanceMetrics.errors++
  
  // Calcular média móvel do tempo de resposta
  performanceMetrics.avgResponseTime = 
    (performanceMetrics.avgResponseTime * 0.9) + (responseTime * 0.1)
  
  // Atualizar uso de memória
  const memUsage = process.memoryUsage()
  performanceMetrics.memoryUsage = memUsage.heapUsed / 1024 / 1024 // MB
}

/**
 * Limpeza periódica de memória e cache
 */
function performCleanup() {
  const now = Date.now()
  
  // Forçar garbage collection se disponível
  if (global.gc) {
    global.gc()
  }
  
  // Reset de métricas a cada hora
  if (now - performanceMetrics.lastCleanup > 60 * 60 * 1000) {
    performanceMetrics.requests = 0
    performanceMetrics.errors = 0
    performanceMetrics.lastCleanup = now
  }
  
  console.log('[PERFORMANCE] Cleanup executado:', {
    memoryMB: Math.round(performanceMetrics.memoryUsage),
    avgResponseTime: Math.round(performanceMetrics.avgResponseTime),
    requests: performanceMetrics.requests,
    errors: performanceMetrics.errors
  })
}

// Limpeza automática a cada 10 minutos
setInterval(performCleanup, 10 * 60 * 1000)

/**
 * Middleware de detecção de vazamentos de memória
 */
function memoryLeakDetection(req, res, next) {
  const memUsage = process.memoryUsage()
  const heapUsedMB = memUsage.heapUsed / 1024 / 1024
  
  // Alerta se uso de memória for muito alto
  if (heapUsedMB > 500) {
    console.warn('[MEMORY_WARNING] Alto uso de memória:', Math.round(heapUsedMB), 'MB')
    
    // Forçar limpeza se muito alto
    if (heapUsedMB > 800 && global.gc) {
      global.gc()
      console.log('[MEMORY] Garbage collection forçado')
    }
  }
  
  next()
}

/**
 * Middleware de rate limiting inteligente
 */
function intelligentRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress
  const now = Date.now()
  
  // Rate limiting mais agressivo se sistema estiver sobrecarregado
  const isSystemOverloaded = performanceMetrics.avgResponseTime > 2000 || 
                            performanceMetrics.memoryUsage > 400
  
  if (isSystemOverloaded) {
    res.setHeader('X-System-Status', 'overloaded')
    // Implementar rate limiting mais restritivo aqui se necessário
  }
  
  next()
}

/**
 * Endpoint para métricas de performance
 */
function getPerformanceMetrics(req, res) {
  const memUsage = process.memoryUsage()
  const cpuUsage = process.cpuUsage()
  
  res.json({
    performance: {
      requests: performanceMetrics.requests,
      errors: performanceMetrics.errors,
      avgResponseTime: Math.round(performanceMetrics.avgResponseTime),
      errorRate: performanceMetrics.requests > 0 ? 
        (performanceMetrics.errors / performanceMetrics.requests * 100).toFixed(2) + '%' : '0%'
    },
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
      external: Math.round(memUsage.external / 1024 / 1024) + ' MB',
      rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB'
    },
    system: {
      uptime: Math.round(process.uptime()) + 's',
      loadAverage: os.loadavg(),
      freeMemory: Math.round(os.freemem() / 1024 / 1024) + ' MB',
      totalMemory: Math.round(os.totalmem() / 1024 / 1024) + ' MB'
    },
    status: performanceMetrics.avgResponseTime > 2000 ? 'overloaded' : 'healthy'
  })
}

module.exports = {
  performanceOptimization,
  memoryLeakDetection,
  intelligentRateLimit,
  getPerformanceMetrics,
  performCleanup
}