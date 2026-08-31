/**
 * Provider UltraMSG (WhatsApp via conexão QR Code).
 * Envio via REST; recebimento via webhook POST /webhooks/ultramsg.
 *
 * Fachada estável: implementação em services/providers/ultramsg/
 * Callers e jest.mock devem continuar apontando para este path.
 *
 * Multi-tenant: credenciais via whatsapp_instances (comentários antigos falam empresa_zapi).
 * Quatro APIs de JID — não unificar. Ver docs/ai-handoff/21-ULTRAMSG-PROVIDER-MODULARIZACAO.md
 */

module.exports = require('./ultramsg/index.js')
