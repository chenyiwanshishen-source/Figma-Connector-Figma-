# Writable Figma MCP Bridge

> A **universal write-capable bridge** for any MCP-compatible AI client to execute arbitrary JS inside the Figma sandbox — local, no cloud service, bound to localhost by default.
>
> Works with most desktop AI assistants — connect via standard MCP and they can read and write Figma files.

> 🌐 Language: [中文](./README.md) | English

---

## 1. About

Figma Connector is a local MCP server + Figma plugin combo that lets any desktop AI assistant read and write your open Figma files via standard MCP protocol. The entire pipeline runs locally (`127.0.0.1`) with no external API or cloud dependency.

---

## 2. Key features

- **Writable MCP bridge** — exposes `figma_run_js` as a trusted writer entrypoint to MCP clients.
- **Safe writes** — snapshots nodes before each job; on error, auto-rolls-back newly created nodes.
- **Design-system first** — built-in `helpers` (design-system index, component import, variable binding, style application) to avoid hardcoding.
- **Status visibility** — the panel shows "Waiting / Reading / Writing" in real time (blue = writing, green = reading).
- **Aim button** — one-click jump-and-select for any link (auto-fit zoom).
- **Duplicate-link toast** — pasting an existing link shows a bottom toast "This link already exists".
- **Multi-plugin protection** — `GET /health` lists all polling windows; `FIGMA_WRITER_STRICT=1` forces single-window exclusive mode to prevent wrong-file edits.

---

## 3. How it works

```
AI client (Claude / WorkBuddy)
        │  MCP (http://localhost:8788/mcp)
        ▼
Local MCP server (server.mjs)  ── enqueue job
        │
        ▲  poll GET /plugin/job
        │
Figma plugin (code.js, inside sandbox)  ── read/write the open file
        │  POST /plugin/result
        ▼
Local MCP server  ── return result to AI
```

1. The AI calls the server over MCP (`http://localhost:8788/mcp`).
2. The server enqueues the task.
3. The Figma plugin polls `/plugin/job`, picks up the task, and executes it inside Figma (only the **currently open file** is reachable).
4. The plugin posts the result back via `POST /plugin/result`.

> ⚠️ The real read/write boundary is the document currently open in Figma. The link selected in the panel declares "which file I intend to operate on" and reports it to the server/AI; if they diverge, writes still target the open file.

---

## 4. Prerequisites

- **Node.js ≥ 18** is required to run the local MCP server (download from https://nodejs.org).
- **Figma Desktop** (the web app does not support local plugins / dev mode).
- No API key, no OAuth, no internet needed (the server runs on `127.0.0.1` only).

## 5. Quick start

### 1. Start the local server

**Option A — command line (recommended, easier to watch logs)**

```bash
cd writable-figma-mcp-bridge
node server.mjs
```

**Option B — double-click launcher**

- macOS: double-click `start.command`
- Windows: double-click `start.bat`

> The launcher starts `node server.mjs` for you; Node.js must be installed first.

Defaults to `127.0.0.1:8788`, localhost-only; exposes only `figma_run_js`.

### 2. Install the plugin in Figma manually (important)

Figma plugins must be imported from this repo's `manifest.json` manually:

1. Open **Figma Desktop** (officially macOS / Windows).
2. Open any Figma design file.
3. Top menu: `Plugins` → `Development` → `Import plugin from manifest…`.
4. Select this repo's **`manifest.json`** (`writable-figma-mcp-bridge/manifest.json`).
5. Run it from `Plugins` → `Development` → `Writable Figma MCP Bridge`.
6. In the panel click **Start / 开始** so it connects to the local server.

> Once "Start / 开始" is active and the status shows "Waiting…", the plugin is connected. All reads/writes the AI pushes via MCP will then apply to the file you currently have open.

### 3. Configure your MCP client

This server is a long-running HTTP service, so point your MCP client's config at the **Streamable HTTP** endpoint:

```json
{
  "mcpServers": {
    "figma-writer": {
      "type": "http",
      "url": "http://localhost:8788/mcp"
    }
  }
}
```

Add this to your MCP client's configuration file (the exact path varies by client — check your client's MCP documentation).

---

## 6. Feature guide

### Link management
- Paste a Figma file link in the top input and click "Add" to add it to the list.
- Each row can be selected as the active link (reported to the server while polling) and has an Aim button.
- Pasting a duplicate link slides out a red toast at the bottom: "This link already exists".

### Aim button
The crosshair icon on each row: parses `node-id` from the link, switches to the node's page, fits it to the viewport and selects it. If the link points to another file (not found in the open file), it clearly reports "link may point to another file".

### Status indicator
The status dot changes with the task:
- **Gray** "Waiting…" — idle
- **Blue** "AI writing…" — a write operation is detected
- **Green** "AI reading…" — a read operation is detected

### Auto rollback
Before every `figma_run_js`, the bridge snapshots document nodes; on error it removes nodes created by that job and reports the rollback count. Edits to pre-existing nodes are not auto-reverted (use Figma Undo `Cmd/Ctrl+Z`).

---

## 7. Security

| Item | Note |
|---|---|
| No auth by default | When `FIGMA_WRITER_TOKEN` is empty, any local process can hit `/mcp` and run `figma_run_js` (i.e. run arbitrary JS in your open Figma file). |
| Bind address | Defaults to `127.0.0.1` (localhost only). **Never** set `HOST` to `0.0.0.0` and expose it to the public network. |
| Recommendation | On shared/public machines, set `FIGMA_WRITER_TOKEN` so only clients with the token can call. |
| Plugin sandbox | The Figma plugin runs in Figma's sandbox; it cannot read passwords, files, or other apps' credentials on your machine. The risk boundary is limited to the currently open Figma document. |

---

## 8. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `8788` | HTTP port for the MCP server. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback unless you know what you are doing. |
| `FIGMA_WRITER_RUN_JS_ONLY` | `1` | `1` exposes only `figma_run_js`; `0` exposes all legacy tools. |
| `FIGMA_WRITER_TOKEN` | empty | When set, `/mcp` and `/plugin/*` require this token (Bearer header or `?token=`). |
| `FIGMA_WRITER_STRICT` | empty | `1` enables single-plugin exclusive mode to avoid multi-window conflicts. |

---

## 9. Available helpers (inside `figma_run_js`)

`figma_run_js` injects: `figma` (Figma API), `args` (structured args), `helpers` (safe helpers).

- `helpers.loadFont(fontName)`
- `helpers.ensureTextFontLoaded(textNode, fallbackFontName)`
- `helpers.paint(value, theme)` / `helpers.hexToRgb(hex)` / `helpers.rgbToHex(rgb)`
- `helpers.normalizeHex(value, theme)`
- `helpers.findVariable(nameOrKey, resolvedType)`
- `helpers.indexDesignSystem(options)`
- `helpers.cloneReferenceNode(selector, options)`
- `helpers.importComponentByName(nameOrKey, options)`
- `helpers.applyTextStyle(textNode, styleName)`
- `helpers.applyPaintStyle(node, styleName, field)`
- `helpers.bindVariable(node, field, variableName, fallbackValue, resolvedType)`
- `helpers.bindFillVariable(node, variableName, fallbackValue)` / `helpers.bindStrokeVariable(...)`
- `helpers.findNodes(selector)` / `helpers.getNode(id)`
- `helpers.summarizeNode(node, depth)` / `helpers.inspectNodeAppearance(node)`
- `helpers.validateCanvas(options)`

> Avoid optional chaining (`?.`) and nullish coalescing (`??`) inside `figma_run_js` code; the Figma plugin runtime may reject them.

---

## 11. License

MIT License.
