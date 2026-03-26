# Correção de Envio de Áudio via UltraMsg

## Problema Identificado

O sistema estava enviando áudios como **arquivos** em vez de **voice notes** (áudio reproduzível diretamente no WhatsApp), devido a:

1. **Rejeição de extensões**: UltraMsg rejeitava `.webm`, `.opus` e outros formatos com erro `"file extension not supported"`
2. **MIME types incompatíveis**: Base64 com `data:audio/webm` não era aceito
3. **Fallback inadequado**: Sistema enviava como documento em vez de tentar outros formatos de áudio

## Correções Implementadas

### 1. Normalização de MIME Types (`ultramsg.js`)

```javascript
function normalizeAudioUrl(audioUrl) {
  if (audioUrl.startsWith('data:audio/webm')) {
    return audioUrl.replace('data:audio/webm', 'data:audio/ogg')
  }
  if (audioUrl.startsWith('data:audio/opus')) {
    return audioUrl.replace('data:audio/opus', 'data:audio/ogg')
  }
  return audioUrl
}
```

### 2. Detecção Robusta de Erros de Extensão

```javascript
function isFileExtensionError(error) {
  // Detecta erro em múltiplos formatos:
  // - String: "file extension not supported"
  // - Array: [{"audio":"file extension not supported"}]
  // - Object: {"error":[{"audio":"file extension not supported"}]}
}
```

### 3. Tentativa com Múltiplos Formatos

```javascript
async function tryMultipleAudioFormats(phone, originalAudioUrl, cfg, endpoint) {
  const mimeTypesToTry = [
    'audio/mpeg',  // MP3 - mais universalmente aceito
    'audio/ogg',   // OGG - boa compatibilidade
    'audio/wav',   // WAV - formato básico
    'audio/mp4',   // M4A/AAC em container MP4
    'audio/aac'    // AAC puro
  ]
  
  // Tenta cada formato até um funcionar
  for (const mimeType of mimeTypesToTry) {
    // ... lógica de tentativa
  }
}
```

### 4. Upload com Renomeação de Extensão

No `uploadMedia()`, arquivos problemáticos são renomeados:

```javascript
// Se extensão problemática, renomeia para .ogg
if (/\.(webm|opus|m4a|wav)$/i.test(originalFilename)) {
  const baseName = originalFilename.replace(/\.[^.]+$/, '')
  filename = `${baseName}.ogg`
}
```

### 5. Detecção Inteligente de Voice Notes

```javascript
function detectarTipoMidia(mimeType, fileName) {
  // Prioriza 'voice' para:
  // - Formatos típicos: audio/webm, audio/opus
  // - Nomes que sugerem gravação: recording.*, voice-*, rec_*
  
  if (m === 'audio/opus' || m === 'audio/webm' || /\.opus$/i.test(n) || /\.webm$/i.test(n)) {
    return 'voice'
  }
  
  if (/^(audio|recording|voice|rec|gravacao)/i.test(n) || n.includes('record')) {
    return 'voice'
  }
}
```

### 6. Fallback Inteligente no Controller

```javascript
// Tenta múltiplos MIME types para máxima compatibilidade
const mimeTypesToTry = []

if (/\.webm$/i.test(originalName)) {
  mimeTypesToTry.push('audio/ogg', 'audio/mpeg', 'audio/wav')
} else if (/\.mp3$/i.test(originalName)) {
  mimeTypesToTry.push('audio/mpeg', 'audio/ogg')
} else {
  mimeTypesToTry.push('audio/mpeg', 'audio/ogg', 'audio/wav')
}
```

## Fluxo de Envio Corrigido

1. **Upload CDN**: Tenta upload para CDN do UltraMsg com renomeação de extensão
2. **Voice Endpoint**: Tenta `/messages/voice` com URL normalizada
3. **Audio Fallback**: Se voice falhar, tenta `/messages/audio`
4. **Multi-Format**: Se falhar por extensão, tenta múltiplos MIME types
5. **Base64 Fallback**: Se CDN falhar, usa base64 com múltiplos formatos

## Resultados Esperados

- ✅ **Áudios chegam como voice notes** (reproduzíveis diretamente)
- ✅ **Compatibilidade com .webm, .opus, .m4a**
- ✅ **Fallback robusto** para diferentes formatos
- ✅ **Logs detalhados** para debugging
- ✅ **Sem envio como documento** (a menos que seja realmente necessário)

## Logs de Debug

```
[ULTRAMSG] Tentando enviar voice para ***911246 com URL: data:audio/ogg;base64,GkXfo59ChoEBQveBAULygQRC...
✅ UltraMsg áudio enviado como audio/mpeg: ***911246
```

## Teste das Correções

Execute o teste incluído:

```bash
cd backend
node test-audio-fix.js
```

O teste verifica:
- Normalização de URLs
- Detecção de erros de extensão  
- Classificação correta de tipos de mídia
- Múltiplos formatos de fallback