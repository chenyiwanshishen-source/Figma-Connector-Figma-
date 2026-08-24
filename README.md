# Writable Figma MCP Bridge V2

Writable Figma MCP Bridge is a local, no-auth MCP server plus a companion Figma plugin. It is designed to run on `127.0.0.1` / `localhost` and does not require an API key or OAuth token.

1. Claude calls `figma-writer` over MCP at `http://localhost:8788/mcp`.
2. The MCP server queues a render job.
3. The Figma plugin polls the server.
4. The plugin reads or writes the current Figma file through safe operations.

## Security model

- No authentication is required by default.
- The MCP server listens on `127.0.0.1` unless `HOST` is explicitly changed.
- Do not expose this server on `0.0.0.0` or a public network unless you set `FIGMA_WRITER_TOKEN` (see Environment variables).
- The Claude connector installer pre-allows the known writer tools so local use does not require repeated tool approval prompts.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `8788` | HTTP port for the MCP server. |
| `HOST` | `127.0.0.1` | Bind address. Keep it loopback unless you know what you are doing. |
| `FIGMA_WRITER_RUN_JS_ONLY` | `1` | `1` exposes only `figma_run_js`; `0` exposes all legacy tools. |
| `FIGMA_WRITER_TOKEN` | empty | When set, `/mcp` and `/plugin/*` require this token (Bearer header or `?token=`). Enter the same token in the plugin UI token field. |
| `FIGMA_WRITER_STRICT` | empty | `1` enables strict single-plugin mode: only the first polling plugin receives jobs, others are rejected with a reason. |

## Reliability features

- **Error stacks**: failures from `figma_run_js` include the JavaScript stack, including line numbers in the submitted code.
- **Automatic rollback**: before each `figma_run_js` job the bridge snapshots all node ids in the document. If the job throws, every node created by that job is removed automatically and the error message reports how many nodes were rolled back. Pass `rollback: false` in the tool arguments to disable this for a specific job. Note: rollback removes newly created nodes only; edits to pre-existing nodes are not reverted (use Figma's Undo for those).
- **File identity**: paste the Figma file URL into the plugin UI field. `GET /health` then reports exactly which file the polling plugin is attached to, which removes ambiguity when two files have the same name.
- **Multi-plugin warning**: when more than one plugin window is polling, every tool result is annotated with a warning naming all pollers and the plugin that received the job.

## Run the server

```bash
cd writable-figma-mcp-bridge
node server.mjs
```

By default the server is in run-js-only mode and exposes only `figma_run_js` to Claude. To expose all legacy tools for debugging:

```bash
FIGMA_WRITER_RUN_JS_ONLY=0 node server.mjs
```

## Install the Figma plugin

In Figma Desktop:

1. Open a Figma design file.
2. Go to `Plugins -> Development -> Import plugin from manifest...`.
3. Choose this repository's `manifest.json`.
4. Run `Plugins -> Development -> Writable Figma MCP Bridge V2`.
5. Click `Start polling`.

## Install the Claude 3P connector

```bash
cd writable-figma-mcp-bridge
node install_claude_3p_connector.mjs
```

Then fully quit and reopen Claude.

## Test prompt

Ask Claude:

```text
Use figma-writer figma_run_js to inspect the current design system with helpers.indexDesignSystem(), then return the first 10 local components, text styles, paint styles, and variables. Do not modify the file.
```

## Exposed tool

The default server mode exposes only one tool to Claude:

- `figma_run_js`: advanced trusted executor, similar to a simplified `Use Figma`; run JS in the Figma plugin context.

## Recommended workflow

Use `figma_run_js` for reads and writes. Keep lookup, mutation, and validation in one Figma-side pass so Claude does not pass stale node IDs between tools.

Recommended order for design-system work:

1. `helpers.indexDesignSystem()` to inspect local components, component sets, variables, and styles.
2. `helpers.cloneReferenceNode()` when a similar good-looking module already exists in the file.
3. `helpers.importComponentByName()` when a library/local component should be used.
4. `helpers.applyTextStyle()`, `helpers.applyPaintStyle()`, and `helpers.bindVariable()` instead of hardcoded font/color/spacing.
5. `helpers.validateCanvas()` before reporting success.

`figma_run_js` receives:

- `figma`: Figma Plugin API global
- `args`: optional structured arguments from the MCP call
- `helpers`: safe helpers exposed by this bridge

Available helpers:

- `helpers.loadFont(fontName)`
- `helpers.ensureTextFontLoaded(textNode, fallbackFontName)`
- `helpers.paint(value, theme)`
- `helpers.hexToRgb(hex)`
- `helpers.rgbToHex(rgb)`
- `helpers.normalizeHex(value, theme)`
- `helpers.findVariable(nameOrKey, resolvedType)`
- `helpers.indexDesignSystem(options)`
- `helpers.cloneReferenceNode(selector, options)`
- `helpers.importComponentByName(nameOrKey, options)`
- `helpers.applyTextStyle(textNode, styleName)`
- `helpers.applyPaintStyle(node, styleName, field)`
- `helpers.bindVariable(node, field, variableName, fallbackValue, resolvedType)`
- `helpers.bindFillVariable(node, variableName, fallbackValue)`
- `helpers.bindStrokeVariable(node, variableName, fallbackValue)`
- `helpers.findNodes(selector)`
- `helpers.getNode(id)`
- `helpers.summarizeNode(node, depth)`
- `helpers.inspectNodeAppearance(node)`
- `helpers.validateCanvas(options)`

Example: update selected text and boxes in one pass:

```json
{
  "code": "const selection = figma.currentPage.selection;\\nconst dateRe = /\\\\d{4}-\\\\d{2}-\\\\d{2}/;\\nlet dateCount = 0;\\nlet bodyCount = 0;\\nlet boxCount = 0;\\nfor (const node of figma.currentPage.findAll()) {\\n  if (node.type === 'TEXT') {\\n    await helpers.ensureTextFontLoaded(node);\\n    if (dateRe.test(node.characters)) {\\n      node.fontSize = 12;\\n      dateCount += 1;\\n    } else if (node.fontSize === 14) {\\n      await helpers.bindFillVariable(node, '中性色/文本/正文标题强调01', '#1A1C24');\\n      bodyCount += 1;\\n    }\\n  }\\n  if ('paddingLeft' in node && node.name.indexOf('盒子') >= 0) {\\n    node.paddingLeft = 4; node.paddingRight = 4; node.paddingTop = 4; node.paddingBottom = 4;\\n    boxCount += 1;\\n  }\\n}\\nreturn { dateCount, bodyCount, boxCount };",
  "timeoutMs": 30000
}
```

Avoid optional chaining (`?.`) and nullish coalescing (`??`) in `figma_run_js` code because Figma's plugin runtime may reject them.

Design-system first example:

```json
{
  "code": "const ds = await helpers.indexDesignSystem({ query: 'Button', maxItems: 20 });\\nconst button = await helpers.importComponentByName('Button', { x: 2400, y: 120, properties: args.properties || {} });\\nconst validation = helpers.validateCanvas({ scope: 'selection' });\\nreturn { ds, button, validation };",
  "args": {
    "properties": {
      "Type": "Primary"
    }
  },
  "timeoutMs": 30000
}
```

Clone-reference example:

```json
{
  "code": "const clone = await helpers.cloneReferenceNode({ nameQuery: '表格', type: 'FRAME', maxNodes: 1 }, { placement: 'right', gap: 160, name: 'Generated / Table' });\\nreturn { clone, validation: helpers.validateCanvas({ scope: 'selection' }) };",
  "timeoutMs": 30000
}
```

Style and token example:

```json
{
  "code": "let changed = 0;\\nconst nodes = await helpers.findNodes({ scope: 'selection', type: 'TEXT', maxNodes: 100 });\\nfor (let i = 0; i < nodes.length; i += 1) {\\n  await helpers.ensureTextFontLoaded(nodes[i]);\\n  await helpers.applyTextStyle(nodes[i], '正文/Regular');\\n  await helpers.bindVariable(nodes[i], 'fills', '中性色/文本/正文标题强调01', '#1A1C24', 'COLOR');\\n  changed += 1;\\n}\\nreturn { changed, validation: helpers.validateCanvas({ scope: 'selection' }) };",
  "timeoutMs": 30000
}
```

Polling safety:

- Every plugin window now registers a unique session.
- New jobs are routed to the currently active polling plugin window.
- `GET /health` lists every polling plugin (id, file name, page, file URL) so you can see conflicts at a glance.
- If edits target the wrong file, stop polling in extra plugin windows and keep only the intended Figma file polling, or start the server with `FIGMA_WRITER_STRICT=1`.

The Figma file must have the relevant libraries enabled. If `helpers.indexDesignSystem()` cannot see library components or variables, enable the library from Figma Assets/Libraries first, then run the plugin again.

## Legacy tools

The source still contains older JSON-spec and operation tools for emergency debugging, but the server hides them by default. Keep the default `node server.mjs` mode for daily use so Claude only sees `figma_run_js`.

To temporarily expose the older tools:

```bash
FIGMA_WRITER_RUN_JS_ONLY=0 node server.mjs
```
