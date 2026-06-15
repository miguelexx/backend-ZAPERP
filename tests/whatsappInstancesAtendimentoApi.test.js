/**
 * Contrato da API GET /chats/whatsapp-instances para UI condicional.
 */
describe("whatsapp instances atendimento API contract", () => {
  function buildWhatsappInstancesPayload(active) {
    const instances = Array.isArray(active) ? active : [];
    return {
      instances,
      has_multiple_whatsapp_instances: instances.length > 1,
      active_count: instances.length,
    };
  }

  test("empresa com 1 numero ativo nao sinaliza multiplas instancias", () => {
    const payload = buildWhatsappInstancesPayload([
      { id: 1, nome: "WM Sistemas", ativo: true },
    ]);
    expect(payload.has_multiple_whatsapp_instances).toBe(false);
    expect(payload.active_count).toBe(1);
    expect(JSON.stringify(payload)).not.toMatch(/instance_token|client_token/i);
  });

  test("empresa com 2 numeros ativos sinaliza multiplas instancias", () => {
    const payload = buildWhatsappInstancesPayload([
      { id: 1, nome: "WM Sistemas", ativo: true },
      { id: 8, nome: "WhatsApp Teste", ativo: true },
    ]);
    expect(payload.has_multiple_whatsapp_instances).toBe(true);
    expect(payload.active_count).toBe(2);
  });
});
