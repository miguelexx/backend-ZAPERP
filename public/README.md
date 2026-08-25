# public/

Arquivos estáticos servidos diretamente pelo Express (app.js).

| Arquivo | URL | Propósito |
|---------|-----|-----------|
| `permissoes.html` | `/permissoes` | Página de referência do catálogo de permissões (admin-only, sem auth HTTP, serve apenas como documentação interna acessível via navegador) |
| `supervisao.html` | `/painel-supervisao` | Painel de supervisão estático em HTML puro (fallback ou referência visual) |
| `ui-overrides.css` | `/ui-overrides.css` | CSS de melhorias visuais injetado no `index.html` do frontend em tempo de execução via app.js. Aplica ajustes de tipografia e legibilidade sem rebuild do frontend. |

Estes arquivos **não são a aplicação principal** — o frontend SPA está em `../frontend/dist/`. O `ui-overrides.css` é injetado automaticamente pelo app.js quando o `frontend/dist/index.html` existe.
