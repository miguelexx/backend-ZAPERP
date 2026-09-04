/**
 * Provider Whapi Cloud (2º provider WhatsApp, opcional por instância; provider='whapi').
 * Fachada estável: implementação em services/providers/whapi/.
 * Espelha o padrão do shim UltraMSG (ver ./ultramsg.js) SEM importar código da UltraMSG.
 * Roteado por getProvider({ provider: 'whapi' }); default/no-arg continua UltraMSG.
 *
 * NÃO usar require('./whapi') dentro do shim (o Node resolveria o próprio whapi.js e ciclaria).
 * Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

module.exports = require('./whapi/index.js')
