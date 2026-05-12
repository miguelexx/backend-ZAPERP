# Prompt Frontend — Mensagem de Localização (Visual Melhorado)

Implemente o componente de localização no chat com **visual profissional**, identificando o tipo (atual vs tempo real) e layout limpo.

---

## Dados do backend

```json
{
  "id": 456,
  "texto": "-20.02893, -48.93106",
  "tipo": "location",
  "url": "https://www.google.com/maps?q=-20.02893,-48.93106",
  "direcao": "in | out",
  "criado_em": "2025-03-23T14:30:00.000Z",
  "status": "sent | delivered | read",
  "nome_arquivo": "localização"
}
```

- **`tipo`**: `'location'` — sempre verificar antes de renderizar
- **`url`**: Link para Google Maps (`https://www.google.com/maps?q=LAT,LNG`)
- **`texto`**: Endereço + coordenadas ou só coordenadas — **não exibir raw**; tratar e formatar

---

## Regras de implementação

### 1. Identificação do tipo

| Tipo | Condição | Label |
|------|----------|-------|
| **Localização atual** | `texto` contém só números/coordenadas OU `location_live` ausente/false | "Localização atual" |
| **Localização em tempo real** | `msg.location_live === true` (futuro backend) | "Localização em tempo real" |

Enquanto o backend não enviar `location_live`, usar como "Localização atual".

### 2. Formatação das coordenadas

- Se `texto` for só coordenadas (ex: `-20.02893, -48.93106`), extrair lat/lng e formatar com máx. 5 decimais
- Nunca exibir números com 10+ casas decimais
- Separe lat e lng visualmente (ex.: em linhas ou com vírgula + espaço)

### 3. Layout do card (estilo WhatsApp)

```
┌─────────────────────────────────────┐
│ [Ícone]  Localização atual          │  ← Badge/tag pequeno
├─────────────────────────────────────┤
│ 📍                                  │
│ Rua ABC, 123 • Bairro               │  ← Endereço se houver
│ -20.02893, -48.93106                │  ← Coordenadas formatadas
│                                     │
│ [🔗 Abrir no mapa →]                │  ← Botão/link destacado
├─────────────────────────────────────┤
│ 12:01                    ✓✓         │  ← Hora + status
└─────────────────────────────────────┘
```

### 4. Componente React (exemplo)

```tsx
function MessageLocation({ msg }: { msg: Mensagem }) {
  const { texto, url, criado_em, status, direcao } = msg
  const isLive = msg.location_live === true
  const mapUrl = url || `https://www.google.com/maps/search/${encodeURIComponent(texto || 'localização')}`

  // Extrair endereço vs coords (texto pode ser "Endereço • (lat, lng)" ou só "lat, lng")
  const hasAddress = texto && texto.includes('•') && !/^-?\d+\.?\d*,\s*-?\d+\.?\d*$/.test(texto.trim())
  const displayText = hasAddress ? texto : (texto || 'Ver localização')
  const coordsOnly = texto?.match(/\(?(-?\d+\.?\d*),\s*(-?\d+\.?\d*)\)?/) 
    ? `📍 ${texto.replace(/^\(|\)$/g, '').trim()}` 
    : null

  return (
    <div className={`message-bubble message-bubble--${direcao}`}>
      <div className="location-card">
        <span className="location-badge">
          {isLive ? '🟢 Em tempo real' : '📍 Localização atual'}
        </span>
        <div className="location-content">
          {hasAddress && <p className="location-address">{displayText}</p>}
          {coordsOnly && <p className="location-coords">{coordsOnly}</p>}
          <a
            href={mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="location-cta"
          >
            Abrir no mapa →
          </a>
        </div>
        <div className="message-footer">
          <span className="message-time">{formatTime(criado_em)}</span>
          <StatusIcon status={status} />
        </div>
      </div>
    </div>
  )
}
```

### 5. CSS (referência)

```css
.location-card {
  padding: 12px;
  border-radius: 8px;
  background: var(--bubble-bg);
  max-width: 280px;
}
.location-badge {
  font-size: 11px;
  color: var(--muted);
  display: block;
  margin-bottom: 8px;
}
.location-address { font-size: 14px; margin: 0 0 4px; }
.location-coords { font-size: 12px; opacity: 0.9; margin: 0 0 8px; }
.location-cta {
  display: inline-block;
  color: var(--primary);
  font-size: 13px;
  text-decoration: none;
  font-weight: 500;
}
.location-cta:hover { text-decoration: underline; }
```

---

## Checklist

- [ ] `msg.tipo === 'location'` renderiza card de localização
- [ ] Badge: "Localização atual" (ou "Em tempo real" se `location_live`)
- [ ] Coordenadas com no máx. 5–6 decimais
- [ ] Link "Abrir no mapa" abre Google Maps em nova aba
- [ ] Layout em card, não texto solto
- [ ] Hora + ticks de status no rodapé
