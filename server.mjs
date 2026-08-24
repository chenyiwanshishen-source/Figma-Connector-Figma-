#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";

const HOST = process.env.HOST || "127.0.0.1";
const BASE_PORT = Number(process.env.PORT || 8788);

const sessions = new Set();
const pendingJobs = [];
const jobResults = new Map();
const fallbackSessionId = "local-figma-writer-session";
let activePlugin = null;

const RUN_JS_ONLY = process.env.FIGMA_WRITER_RUN_JS_ONLY !== "0";
const AUTH_TOKEN = process.env.FIGMA_WRITER_TOKEN || "";
const STRICT_SINGLE_PLUGIN = process.env.FIGMA_WRITER_STRICT === "1";
const POLLING_TTL_MS = 10000;
const pollingPlugins = new Map();

function prunePollingPlugins() {
  const now = Date.now();
  for (const [pluginId, info] of pollingPlugins) {
    if (now - info.seenAt > POLLING_TTL_MS) pollingPlugins.delete(pluginId);
  }
}

function primaryPlugin() {
  prunePollingPlugins();
  let primary = null;
  for (const info of pollingPlugins.values()) {
    if (!primary || info.firstSeenAt < primary.firstSeenAt) primary = info;
  }
  return primary;
}

function isAuthorized(req, url) {
  if (!AUTH_TOKEN) return true;
  const header = String(req.headers["authorization"] || "");
  if (header === `Bearer ${AUTH_TOKEN}`) return true;
  return url.searchParams.get("token") === AUTH_TOKEN;
}

function pollingSummary() {
  prunePollingPlugins();
  const plugins = [];
  for (const info of pollingPlugins.values()) {
    plugins.push({
      id: info.id,
      fileName: info.fileName,
      pageName: info.pageName,
      fileUrl: info.fileUrl,
      seenAt: info.seenAt,
    });
  }
  return plugins;
}

function appendMultiPluginWarning(text) {
  prunePollingPlugins();
  if (pollingPlugins.size <= 1) return text;
  const names = [];
  for (const info of pollingPlugins.values()) {
    names.push(info.fileName || info.fileUrl || info.id);
  }
  const target = activePlugin ? activePlugin.fileName || activePlugin.fileUrl || activePlugin.id : "unknown";
  return `${text}\n[warning] ${pollingPlugins.size} plugins are polling (${names.join(" | ")}). This job went to "${target}". Stop extra pollers if that is the wrong file.`;
}

const tools = [
  {
    name: "figma_get_design_tokens",
    description:
      "Read design tokens from the current Figma file via the companion plugin: local variables, local styles, selected-node bindings, and available team-library variables when the file has enabled libraries and permissions allow it.",
    inputSchema: {
      type: "object",
      properties: {
        includeLibraryVariables: {
          type: "boolean",
          description: "Try reading variables from enabled team libraries. Requires manifest permission teamlibrary and libraries enabled in the Figma file.",
          default: true,
        },
        includeSelectedNodeBindings: {
          type: "boolean",
          description: "Include variables/styles bound to the current selection.",
          default: true,
        },
        timeoutMs: { type: "number", default: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_local_styles",
    description:
      "Read local paint, text, effect, and grid styles from the current Figma file via the companion plugin.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", default: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_selected_node_bindings",
    description:
      "Read style IDs, bound variables, and basic design properties for the currently selected Figma nodes.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", default: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_list_library_components",
    description:
      "Search enabled Figma team-library components and component sets from the current file. Use this before reusing design system elements. Requires the Figma plugin manifest teamlibrary permission and the relevant libraries enabled in the file.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional text to match against component name, description, key, or library name.",
        },
        includeComponents: {
          type: "boolean",
          description: "Include standalone components.",
          default: true,
        },
        includeComponentSets: {
          type: "boolean",
          description: "Include component sets / variants.",
          default: true,
        },
        maxItems: {
          type: "number",
          description: "Maximum matches per category.",
          default: 80,
        },
        timeoutMs: { type: "number", default: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_import_component_instance",
    description:
      "Import a library component or component set by key and place an instance on the current Figma page. Use keys returned by figma_list_library_components. Supports x/y placement, parent, alias, and component properties.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Component key. Alias of componentKey." },
        componentKey: { type: "string", description: "Standalone component key." },
        componentSetKey: { type: "string", description: "Component set key. The default variant is instanced when available." },
        variantSetKey: { type: "string", description: "Alias of componentSetKey." },
        name: { type: "string", description: "Optional instance name." },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        parent: { type: "string", description: "Optional parent node id or alias. Defaults to the current page." },
        as: { type: "string", description: "Alias for follow-up operations." },
        alias: { type: "string", description: "Alias for follow-up operations." },
        properties: {
          type: "object",
          description: "Optional instance component properties for variants/text/booleans when supported.",
          additionalProperties: true,
        },
        timeoutMs: { type: "number", default: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_inspect_page",
    description:
      "Inspect the current Figma page and return a compact tree of nodes, bounds, styles, layout properties, and aliases for follow-up operations. Use before editing existing content or finding empty canvas space.",
    inputSchema: {
      type: "object",
      properties: {
        depth: {
          type: "number",
          description: "Maximum child depth to return. Use 1-3 for normal planning.",
          default: 2,
        },
        includeInvisible: {
          type: "boolean",
          description: "Include invisible nodes.",
          default: false,
        },
        maxNodes: {
          type: "number",
          description: "Maximum nodes to return.",
          default: 200,
        },
        timeoutMs: { type: "number", default: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_inspect_selection",
    description:
      "Inspect the current Figma selection and return nodes, bounds, styles, layout properties, and aliases for follow-up operations.",
    inputSchema: {
      type: "object",
      properties: {
        depth: { type: "number", default: 3 },
        includeInvisible: { type: "boolean", default: true },
        maxNodes: { type: "number", default: 200 },
        timeoutMs: { type: "number", default: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_find_nodes",
    description:
      "Find Figma nodes on the current page by name/text substring, text regex, type, id, or alias. Returns compact node metadata for use with figma_apply_operations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive name or text substring to search." },
        nameQuery: { type: "string", description: "Case-insensitive node name substring to search." },
        text: { type: "string", description: "Case-insensitive text characters substring to search." },
        exactText: { type: "string", description: "Exact text characters to search." },
        textRegex: { type: "string", description: "JavaScript regex matched against text node characters, for example \\\\d{4}-\\\\d{2}-\\\\d{2}." },
        scope: { type: "string", description: "Search scope: currentPage, selection, or childrenOf.", default: "currentPage" },
        parent: { type: "string", description: "Parent node id or alias when scope is childrenOf." },
        currentFill: { type: "string", description: "Only match nodes whose first solid fill equals this hex/token color." },
        currentStroke: { type: "string", description: "Only match nodes whose first solid stroke equals this hex/token color." },
        fontSize: { type: "number", description: "Only match text nodes with this font size." },
        fontFamily: { type: "string", description: "Only match text nodes with this font family." },
        hasFillVariable: { type: "boolean", description: "Only match nodes that do or do not have a bound fill variable." },
        hasStrokeVariable: { type: "boolean", description: "Only match nodes that do or do not have a bound stroke variable." },
        type: { type: "string", description: "Optional Figma node type such as FRAME, TEXT, RECTANGLE." },
        id: { type: "string", description: "Optional exact Figma node id." },
        alias: { type: "string", description: "Optional alias previously returned by inspect/apply." },
        maxNodes: { type: "number", default: 50 },
        timeoutMs: { type: "number", default: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_apply_operations",
    description:
      "Apply a safe batch of Figma operations. Supports createFrame, createText, createRectangle, createLine, createEllipse, setFill, setStroke, bindFillVariable, bindStrokeVariable, setText, updateText, setTextStyle, setFontSize, setAutoLayout, move, resize, rename, appendChild, bringToFront, sendToBack, group, delete, select, scrollIntoView. For one node use target, nodeId, id, ref, or targetAlias. For batch edits use targets, targetIds, nodeIds, or ids. To avoid stale IDs, operations can include selector: { scope, parent, type, nameQuery, text, exactText, textRegex, currentFill, currentStroke, fontSize, fontFamily, hasFillVariable, hasStrokeVariable, maxNodes }; the plugin finds matching nodes and applies immediately. Legacy inline query/nameQuery/text/currentFill fields also work. Use aliases like $last, $lastFrame, $selection0, or aliases returned by inspect/apply.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description: "Ordered operation objects. Each object has op plus operation-specific fields.",
          items: { type: "object", additionalProperties: true },
        },
        timeoutMs: { type: "number", default: 30000 },
      },
      required: ["operations"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_run_js",
    description:
      "Single trusted Figma writer entrypoint. Run JavaScript inside the current Figma plugin context, similar to a simplified Use Figma tool. Use this for all reads and writes. The code receives figma, args, and helpers. Prefer helpers.indexDesignSystem(), helpers.cloneReferenceNode(), helpers.importComponentByName(), helpers.applyTextStyle(), helpers.applyPaintStyle(), helpers.bindVariable(), and helpers.validateCanvas() before drawing primitives. Do not pass stale node IDs across tool calls. Avoid optional chaining/nullish syntax for Figma runtime compatibility.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "Async JavaScript function body to run in Figma. Example: const nodes = figma.currentPage.findAll(n => n.type === 'TEXT'); return { count: nodes.length };",
        },
        args: {
          type: "object",
          description: "Optional structured data available to code as args.",
          additionalProperties: true,
        },
        timeoutMs: { type: "number", default: 30000 },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "create_figma_canvas_from_spec",
    description:
      "Create new Figma canvas content from a structured JSON design spec. The top-level spec must contain frames: [{ name, width, height, children }]. Requires the companion Figma plugin to be running. For dark backgrounds, set text nodes' color/fill explicitly, for example #FFFFFF. Put large background rectangles before text nodes, or use frame.background instead of a rectangle.",
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "object",
          description:
            "Design spec containing frames. Supports theme tokens, auto layout containers, text, rectangle, line, ellipse, group, cardGrid, stack, and row nodes. Text nodes support text/characters/content plus color/fill. Rectangles support fill/background. Use frame.background for page backgrounds.",
        },
        timeoutMs: {
          type: "number",
          description: "How long to wait for the Figma plugin to render the spec.",
          default: 30000,
        },
      },
      required: ["spec"],
      additionalProperties: false,
    },
  },
  {
    name: "create_portfolio_overview_page",
    description:
      "Create a portfolio-style overview page using a built-in clean editorial design pattern.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        subtitle: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              number: { type: "string" },
              title: { type: "string" },
              type: { type: "string" },
              keywords: { type: "string" },
            },
            required: ["number", "title"],
            additionalProperties: true,
          },
        },
        timeoutMs: { type: "number", default: 30000 },
        placementMode: {
          type: "string",
          description:
            "Where to place the generated frame: right, below, grid, selection-right, or selection-below.",
          default: "right",
        },
        placementGap: {
          type: "number",
          description: "Gap between existing content and the new generated frame.",
          default: 240,
        },
      },
      required: ["title", "items"],
      additionalProperties: false,
    },
  },
];

const exposedTools = RUN_JS_ONLY ? tools.filter((tool) => tool.name === "figma_run_js") : tools;

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Accept, mcp-session-id",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendSse(res, body, sessionId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "mcp-session-id": sessionId,
  });
  res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function buildPortfolioSpec(args) {
  const items = args.items || [];
  return {
    placement: {
      mode: args.placementMode || "right",
      gap: args.placementGap || 240,
    },
    theme: {
      fonts: {
        body: { family: "Inter", style: "Regular" },
        medium: { family: "Inter", style: "Medium" },
        semibold: { family: "Inter", style: "Semi Bold" },
        bold: { family: "Inter", style: "Bold" },
      },
      colors: {
        canvas: "#F8FAFC",
        surface: "#FFFFFF",
        text: "#0F172A",
        muted: "#64748B",
        subtle: "#94A3B8",
        border: "#E2E8F0",
        accent: "#2563EB",
      },
    },
    frames: [
      {
        name: "Generated / Project Overview",
        width: 1440,
        height: 900,
        background: "$canvas",
        children: [
          {
            type: "row",
            name: "Header",
            x: 96,
            y: 64,
            width: 1248,
            height: 48,
            layout: "horizontal",
            primaryAxisSizing: "FIXED",
            counterAxisSizing: "FIXED",
            primaryAxisAlign: "SPACE_BETWEEN",
            counterAxisAlign: "MIN",
            children: [
              {
                type: "text",
                name: "Page Number",
                text: "03",
                fontSize: 18,
                color: "$subtle",
              },
              {
                type: "text",
                name: "Portfolio Label",
                text: "YOUR NAME · PRODUCT DESIGN\nPORTFOLIO",
                width: 230,
                fontSize: 11,
                lineHeight: 16,
                color: "$subtle",
                align: "right",
              },
            ],
          },
          {
            type: "stack",
            name: "Intro",
            x: 96,
            y: 150,
            width: 680,
            height: 110,
            layout: "vertical",
            gap: 22,
            children: [
              {
                type: "text",
                name: "Title",
                text: args.title,
                width: 680,
                fontSize: 36,
                fontToken: "bold",
                color: "$text",
              },
              {
                type: "text",
                name: "Subtitle",
                text: args.subtitle || "",
                width: 760,
                fontSize: 16,
                lineHeight: 26,
                color: "$muted",
              },
            ],
          },
          {
            type: "cardGrid",
            name: "Project Cards",
            x: 96,
            y: 310,
            columns: 2,
            gap: 28,
            cardWidth: 520,
            cardHeight: 126,
            items,
          },
        ],
      },
    ],
  };
}

function enqueueJob(toolName, spec) {
  const id = crypto.randomUUID();
  const targetPluginId = activePlugin?.id || null;
  pendingJobs.push({ id, toolName, spec, createdAt: Date.now(), targetPluginId });
  return id;
}

function waitForJob(id, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (jobResults.has(id)) {
        const result = jobResults.get(id);
        jobResults.delete(id);
        clearInterval(interval);
        resolve(result);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        resolve({
          ok: false,
          message:
            "Timed out waiting for the Figma plugin. Make sure the Writable Figma MCP plugin is open in Figma.",
        });
      }
    }, 100);
  });
}

async function handleMcp(req, res) {
  const message = await readBody(req);
  const id = message?.id ?? null;

  if (typeof message?.method === "string" && message.method.startsWith("notifications/")) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (message?.method === "initialize") {
    const sessionId = crypto.randomUUID();
    sessions.add(sessionId);
    sendSse(
      res,
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "Writable Figma MCP", version: "0.1.0" },
        },
      },
      sessionId,
    );
    return;
  }

  let sessionId = req.headers["mcp-session-id"] || fallbackSessionId;
  if (!sessions.has(sessionId)) sessions.add(sessionId);

  if (message?.method === "tools/list") {
    sendSse(res, { jsonrpc: "2.0", id, result: { tools: exposedTools } }, sessionId);
    return;
  }

  if (message?.method === "tools/call") {
    const { name, arguments: args = {} } = message.params || {};
    if (RUN_JS_ONLY && name !== "figma_run_js") {
      sendSse(
        res,
        {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "figma-writer is currently in run-js-only mode. Use figma_run_js for all Figma writes.",
              },
            ],
            isError: true,
          },
        },
        sessionId,
      );
      return;
    }
    if (
      [
        "figma_get_design_tokens",
        "figma_get_local_styles",
        "figma_get_selected_node_bindings",
        "figma_list_library_components",
        "figma_import_component_instance",
        "figma_inspect_page",
        "figma_inspect_selection",
        "figma_find_nodes",
        "figma_apply_operations",
        "figma_run_js",
      ].includes(name)
    ) {
      const jobId = enqueueJob(name, args);
      const result = await waitForJob(jobId, args.timeoutMs || 30000);
      let resultText;
      if (result.ok) {
        resultText = JSON.stringify(result.data || {}, null, 2);
      } else {
        resultText = `Figma operation failed: ${result.message}`;
        if (result.stack) resultText += `\nStack:\n${String(result.stack).slice(0, 800)}`;
      }
      resultText = appendMultiPluginWarning(resultText);
      sendSse(
        res,
        {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: resultText }],
            isError: !result.ok,
          },
        },
        sessionId,
      );
      return;
    }

    let spec = args.spec;
    if (name === "create_portfolio_overview_page") {
      spec = buildPortfolioSpec(args);
    }
    if (!spec) {
      sendSse(
        res,
        {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing spec" },
        },
        sessionId,
      );
      return;
    }

    const jobId = enqueueJob(name, spec);
    const result = await waitForJob(jobId, args.timeoutMs || 30000);
    let renderText;
    if (result.ok) {
      renderText = `Created Figma content. ${result.message || ""}`;
    } else {
      renderText = `Figma render failed: ${result.message}`;
      if (result.stack) renderText += `\nStack:\n${String(result.stack).slice(0, 800)}`;
    }
    renderText = appendMultiPluginWarning(renderText);
    sendSse(
      res,
      {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: renderText }],
          isError: !result.ok,
        },
      },
      sessionId,
    );
    return;
  }

  sendSse(
    res,
    {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported method: ${message?.method}` },
    },
    sessionId,
  );
}

async function handlePlugin(req, res, pathname, url) {
  if (!isAuthorized(req, url)) {
    sendJson(res, 401, { ok: false, message: "Unauthorized: the server requires FIGMA_WRITER_TOKEN. Enter it in the plugin UI token field." });
    return;
  }

  if (req.method === "GET" && pathname === "/plugin/job") {
    const pluginId = url.searchParams.get("pluginId") || "";
    if (pluginId) {
      prunePollingPlugins();
      const existing = pollingPlugins.get(pluginId);
      const info = {
        id: pluginId,
        fileName: url.searchParams.get("fileName") || "",
        pageName: url.searchParams.get("pageName") || "",
        fileUrl: url.searchParams.get("fileUrl") || (existing ? existing.fileUrl : ""),
        firstSeenAt: existing ? existing.firstSeenAt : Date.now(),
        seenAt: Date.now(),
      };
      pollingPlugins.set(pluginId, info);
      activePlugin = info;
    }

    if (STRICT_SINGLE_PLUGIN) {
      const primary = primaryPlugin();
      if (primary && pluginId && primary.id !== pluginId) {
        sendJson(res, 200, {
          rejected: true,
          reason: `Strict mode: the queue is owned by the plugin in "${primary.fileName || primary.fileUrl || primary.id}". Stop polling there first.`,
        });
        return;
      }
    }

    let jobIndex = -1;
    for (let i = 0; i < pendingJobs.length; i += 1) {
      const job = pendingJobs[i];
      if (!job.targetPluginId || !pluginId || job.targetPluginId === pluginId) {
        jobIndex = i;
        break;
      }
    }

    const job = jobIndex >= 0 ? pendingJobs.splice(jobIndex, 1)[0] : null;
    sendJson(res, 200, job);
    return;
  }

  if (req.method === "POST" && pathname === "/plugin/result") {
    const body = await readBody(req);
    if (body?.id) jobResults.set(body.id, body);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/plugin/clear") {
    pendingJobs.length = 0;
    jobResults.clear();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      pendingJobs: pendingJobs.length,
      results: jobResults.size,
      activePlugin,
      pollingPlugins: pollingSummary(),
      strictSinglePlugin: STRICT_SINGLE_PLUGIN,
      authRequired: Boolean(AUTH_TOKEN),
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const url = new URL(req.url || "/", `http://${HOST}:${BASE_PORT}`);
    if (url.pathname === "/mcp") {
      if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(405, { Allow: "POST, OPTIONS" });
        res.end();
        return;
      }
      if (!isAuthorized(req, url)) {
        sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: set the correct FIGMA_WRITER_TOKEN." } });
        return;
      }
      await handleMcp(req, res);
      return;
    }
    await handlePlugin(req, res, url.pathname, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

function tryListen(port) {
  const onError = (error) => {
    if (error.code === "EADDRINUSE" && port < BASE_PORT + 50) {
      console.log(`Port ${port} is in use, trying ${port + 1} ...`);
      server.removeListener("listening", onListening);
      tryListen(port + 1);
    } else {
      console.error(`Failed to start server: ${error.message}`);
      process.exit(1);
    }
  };
  const onListening = () => {
    server.removeListener("error", onError);
    console.log(`Writable Figma MCP server listening on http://${HOST}:${port}`);
    console.log(`MCP endpoint: http://${HOST}:${port}/mcp`);
    if (port !== BASE_PORT) console.log(`Note: default port ${BASE_PORT} was busy, using ${port} instead. Enter this URL in the plugin's server field.`);
    if (AUTH_TOKEN) console.log("Auth token required (FIGMA_WRITER_TOKEN is set).");
    if (STRICT_SINGLE_PLUGIN) console.log("Strict single-plugin mode enabled (FIGMA_WRITER_STRICT=1).");
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, HOST);
}

tryListen(BASE_PORT);
