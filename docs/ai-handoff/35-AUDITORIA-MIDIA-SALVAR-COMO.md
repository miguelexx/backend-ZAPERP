# 35 — Auditoria de mídia: "Salvar como…" (2026-10-20)

> Implementado em 2026-10-20. **Não deployado.** Sem migration. Sem variável de ambiente nova.
> Backend: `controllers/mediaProxyController.js`, `helpers/binaryMediaSniffer.js` (novo), `app.js`
> (headers de `/uploads`).
> Frontend (repo `frontend/`): `src/conversa/mediaDownload.js` e `src/conversa/mediaSaveName.js`
> (novos), `MessageMenu.jsx`, `ConversaBubbleShell.jsx`, `MediaViewerOverlay.jsx`,
> `useMediaViewer.js`, `DocumentMessage.jsx`, `conversaViewHelpers.js`, `conversa.css`.

---

## 1. Sintoma relatado

"Não consigo salvar como" na mídia da conversa.

## 2. Causa raiz (CONFIRMADO no código)

**Não existia nenhuma ação de salvar para foto, vídeo, áudio e figurinha.** Só documento tinha
("Abrir" / "Salvar como..." no card, `DocumentMessage.jsx`). E o menu nativo do navegador — que
seria a saída óbvia — **não alcança a mídia**, por três regras que estão corretas e existem para
os gestos do app:

| Regra | Arquivo | Efeito |
|---|---|---|
| `.wa-bubble-img { pointer-events: none }` | `conversa.css` | botão direito no desktop cai no `<button>` pai; o menu do Chrome sai **sem** "Salvar imagem como…" |
| `.wa-messages .wa-bubble * { -webkit-touch-callout: none }` | `conversa.css` | long-press no iOS não abre o menu nativo (de propósito: abre o menu do app / encaminhar) |
| `.wa-mediaViewer-img--zoomable { pointer-events: none }` | `conversa.css` | no lightbox o clique é do stage (zoom/pan), então nem ali havia menu nativo |

`onBubbleContextMenu` (`useMessageGestures.js`) ainda dá `preventDefault()` no `contextmenu` do
mobile. Ou seja: **em nenhuma plataforma havia como salvar foto/vídeo/áudio.** Já estava
registrado no doc 08 do frontend que o menu nativo foi suprimido para o long-press de
encaminhar — faltou a contrapartida (ação explícita de baixar).

Segundo motivo, específico do iOS: o `<a download>` com `blob:` **não grava arquivo** no Safari
do iPhone/iPad (ignora o atributo). Era exatamente o caminho do "Salvar como..." do documento —
o atendente clicava e nada acontecia.

## 3. O que passou a existir

1. **`conversa/mediaSaveName.js`** (puro, sem DOM) — nome do arquivo salvo: nome real do cliente
   ganha a extensão que falta; sem nome real, gera `IMG-/VID-/AUD-/STK-AAAAMMDD-HHMMSS.ext` (padrão
   do próprio WhatsApp). A extensão vem, em ordem, do nome → URL (entende `/media/proxy?url=`) →
   Content-Type do blob → tipo da mensagem. Content-Type que **contradiz** o tipo é descartado
   (ver §4.1).
2. **`conversa/mediaDownload.js`** — busca autenticada (JWT em header, nunca na URL) → se a URL do
   provedor morreu, pede cópia nova (`reprocessar-midia`) → grava. No iOS usa a folha nativa
   (`navigator.share` com `files`), com `<a download>` como fallback em todo o resto. `AbortError`
   (usuário fechou a folha) não vira toast de erro.
3. **Menu da mensagem** ganhou "Salvar como…" para imagem, vídeo, áudio, figurinha e documento —
   oferecido só quando há mídia de verdade (ou quando o backend pode recuperar a cópia).
4. **Visualizador em tela cheia** ganhou o botão de salvar ao lado de imprimir/encaminhar. Funciona
   também para foto de perfil (sem mensagem de origem) e bolha otimista (blob local).
5. **`DocumentMessage`** passou a usar o mesmo gravador — ganha iOS e o nome real.

## 4. Bugs de backend encontrados e corrigidos

### 4.1 Vídeo sem extensão era anunciado como `audio/mp4`

`mediaProxyController.resolveContentType` resolvia Content-Type genérico
(`application/octet-stream`, o que o S3 da UltraMSG/Whapi costuma mandar) chamando
`contentTypeFromAudioMagicBytes`. Esse sniffer é **de áudio por contrato** — ele vê `ftyp` no byte
4 e devolve `audio/mp4`, porque no fluxo de persistência só roda para mensagem já classificada
como áudio pelo webhook. No proxy ele rodava para **qualquer** mídia:

- vídeo MP4 recebido sem extensão na URL saía como `audio/mp4`;
- o Chrome ignora o header (usa o próprio demuxer), mas o **Safari/iOS respeita** → vídeo sem
  imagem;
- e o "Salvar como…" gravaria `.m4a` num arquivo de vídeo.

Correção: `helpers/binaryMediaSniffer.js` roda **antes** do sniffer de áudio e devolve tipo apenas
para assinaturas que **não podem ser áudio** (JPEG, PNG, GIF, WebP, BMP, TIFF, PDF, HEIC e MPEG-4
com brand de vídeo: `isom`, `mp42`, `avc1`, `qt  `…). Brands de áudio (`M4A `), OggS, MP3, WAV,
AMR, WebM/Matroska e 3GP retornam `null` → **o caminho do áudio não mudou em nada**.
Regressão: `tests/mediaProxyContentTypeSniff.test.js` (16 casos).

### 4.2 `disposition=attachment` sem `filename` não emitia Content-Disposition

Tanto no `/media/proxy` quanto no `/uploads`, o header só era emitido quando havia nome. Mídia do
WhatsApp quase nunca tem nome — o navegador **exibia** o arquivo em vez de baixar. Agora, sem nome,
sai `attachment` (proxy) / `attachment` com o nome em disco (`/uploads`). `inline` sem nome
continua sem header (exibir não mudou). Regressão: `tests/documentDownloadAudit.test.js`.

## 5. Bug de frontend corrigido de passagem

`resolveDownloadFilename` descartava o nome real quando ele não tinha extensão: "Contrato Social"
+ `/uploads/inbound-c1-m844-7f3a.pdf` salvava (e exibia no card) **`inbound-c1-m844-7f3a.pdf`**.
Agora o nome real permanece e só a extensão vem do arquivo: `Contrato Social.pdf`.

## 6. Resíduos conhecidos (NÃO alterados)

- **Teto de 80 MB do `/media/proxy`** (`MAX_BYTES`): mídia maior responde 413. Reprodução sobrevive
  (a bolha cai para a URL direta); para o download foi adicionada a URL direta como último
  candidato. Subir o teto significa bufferizar mais na memória do processo — decisão do Miguel.
- **WebM/Matroska** continua sem distinguir áudio de vídeo pelos bytes (precisaria parsear tracks);
  segue como `audio/webm`, igual a antes.
- **`/media/proxy` ainda aceita JWT em query** (`?access_token=`) porque `<audio>`/`<img>` não
  mandam header. O download **não** usa esse caminho: busca o binário com header `Authorization`.
  Vulnerabilidade já registrada no `CLAUDE.md` — não ampliar.

## 7. Como testar

```bash
cd backend && npx jest tests/mediaProxyContentTypeSniff.test.js tests/documentDownloadAudit.test.js
cd frontend && npm run test:node
cd frontend && npx playwright test e2e/audit-local-mock.spec.js -g "pode ser salva"
```

O e2e novo (`mídia recebida pode ser salva pelo menu e pelo visualizador`) baixa a imagem de
verdade no Chromium (desktop + viewport mobile) e confere o nome sugerido
(`IMG-AAAAMMDD-HHMMSS.svg`) e que a requisição saiu com `disposition=attachment`.
