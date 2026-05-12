# IA analítica — correção de UX do card de resposta (frontend)

Este repositório contém principalmente o **backend**. O contrato `POST /api/ai/ask` foi enriquecido com metadados para o front renderizar período real, hierarquia e “ver mais” sem depender só do markdown da `answer`.

## Novos campos úteis em `data` (e espelhados em `data.analitica_ui`)

| Campo | Descrição |
|--------|-----------|
| `recorte_temporal` | Datas **reais** das mensagens: `primeiro_data_exibicao`, `ultimo_data_exibicao`, `fuso`, `pode_usar_hoje_no_texto`, `instrucao_temporal_obrigatoria`, `texto_cabecalho_ui`. |
| `mensagens_compactas` | Lista deduplicada (até 80) para lista/evidências mais limpa. |
| `mensagens[].flags` | `peso_resumo` (0–3), `provavel_automatica`, `eh_midia`, `sinal_baixo_valor_informativo`. |
| `mensagens[].tipo`, `url`, `nome_arquivo` | Mídia / anexo. |
| `orientacao_resumo_ia` | Texto curto para o UI exibir como “dica de leitura” opcional. |
| `conversas_envolvidas` | Até 8 conversas: `id`, `status_atendimento`, `tipo`, `atendente_id`, `usuario_id`. |
| `analitica_ui.recorte_mensagens` | Igual a `recorte_temporal` (cópia para um único objeto UI). |
| `analitica_ui.texto_cabecalho_periodo` | Cabeçalho pronto: *“Análise de N mensagem(ns) — dd/mm … → …”*. |
| `analitica_ui.evidencias_colapso_inicial` | Número sugerido de linhas antes de “Ver mais” (padrão **6**). |

**Regra de ouro:** mostrar sempre `analitica_ui.texto_cabecalho_periodo` ou `recorte_temporal.texto_cabecalho_ui` **acima** do markdown da `answer`, para o utilizador nunca confundir “hoje” no texto com o período real.

## Layout recomendado (largura + hierarquia)

1. **Container** da resposta: `max-width: min(960px, 100%)` (ou 100% até 1100px em dashboards largos), `margin-inline: auto`, padding generoso.
2. **Card**: `border-radius: 12px`, sombra suave, `background` coerente com o tema (claro/escuro).
3. **Cabeçalho do período** (destaque): tipografia menor que o título mas com **peso semibold** + ícone de calendário; cor secundária.
4. **Corpo da resposta** (`answer` em Markdown): `prose` (Tailwind) ou equivalente — `line-height: 1.55`, `font-size: 15–16px`, **evitar** `max-width` estreito no parágrafo interno.
5. **Evidências**: grid em desktop `display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;` — em mobile uma coluna.
6. **Colapso**: renderizar só as primeiras `analitica_ui.evidencias_colapso_inicial` mensagens com `peso_resumo >= 1` (ou todas com peso >= 2 primeiro); botão **“Ver mais evidências”** expande o restante.
7. **Separador visual** entre “Mensagens automáticas / roteiro” e “Conteúdo principal”: agrupar por `flags.provavel_automatica` (accordion fechado por defeito).

## CSS de referência (copiar para o bundle do front)

```css
.ia-analitica-wrap {
  width: 100%;
  max-width: min(1040px, 100%);
  margin: 0 auto;
  padding: 0 16px 24px;
}

.ia-analitica-card {
  border-radius: 14px;
  padding: 20px 24px 24px;
  box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
}

.ia-analitica-periodo {
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--ia-muted, #64748b);
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--ia-periodo-bg, rgba(59, 130, 246, 0.08));
  border: 1px solid var(--ia-periodo-border, rgba(59, 130, 246, 0.2));
}

.ia-analitica-answer {
  font-size: 0.95rem;
  line-height: 1.6;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.ia-analitica-answer h2,
.ia-analitica-answer h3 {
  margin-top: 1.25em;
  margin-bottom: 0.5em;
}

.ia-analitica-evidencias {
  margin-top: 20px;
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.ia-analitica-msg {
  border-radius: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ia-border, #e2e8f0);
  font-size: 0.8125rem;
}

.ia-analitica-msg--auto {
  opacity: 0.85;
  border-style: dashed;
}

.ia-analitica-msg--midia {
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.06);
}

.ia-analitica-ver-mais {
  margin-top: 12px;
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
  color: var(--ia-accent, #2563eb);
}
```

## Caso das imagens (13/04 e 14/04 vs “hoje”)

**Causa raiz:** o modelo inferia “hoje” a partir da pergunta ou do dia corrente do administrador, **sem** amarrar às datas em `criado_em`.

**Backend:** `recorte_temporal` + instruções rígidas no prompt + `sanearLinguagemTemporalIndevida` se ainda aparecer “hoje”/“ontem” indevido.

**Frontend:** mostrar sempre o bloco **período real**; opcionalmente, se `answer` contiver “hoje” e `pode_usar_hoje_no_texto === false`, pode ocultar ou mostrar aviso — o backend já anexa correção, mas o cabeçalho evita a confusão.

## Checklist de implementação no SPA

- [ ] Largura mínima do card ≥ conteúdo legível (ver `.ia-analitica-wrap`).
- [ ] Cabeçalho com `texto_cabecalho_periodo` ou `recorte_temporal`.
- [ ] Lista de evidências em grid + “Ver mais”.
- [ ] Mensagens com `flags.provavel_automatica` em secção secundária ou accordion.
- [ ] Mídias: exibir `nome_arquivo` ou ícone + link `url` quando existir.
