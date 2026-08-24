#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const baseDir = path.join(os.homedir(), "Library", "Application Support", "Claude-3p");

const writerToolPolicy = {
  figma_get_design_tokens: "allow",
  figma_get_local_styles: "allow",
  figma_get_selected_node_bindings: "allow",
  figma_list_library_components: "allow",
  figma_import_component_instance: "allow",
  figma_inspect_page: "allow",
  figma_inspect_selection: "allow",
  figma_find_nodes: "allow",
  figma_apply_operations: "allow",
  figma_run_js: "allow",
  create_figma_canvas_from_spec: "allow",
  create_portfolio_overview_page: "allow",
};

const writerServer = {
  name: "figma-writer",
  url: "http://localhost:8788/mcp",
  transport: "http",
  toolPolicy: writerToolPolicy,
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseServers(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return JSON.parse(value);
  return [];
}

function backupAndWrite(filePath, data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(filePath, `${filePath}.backup-writer-${stamp}`);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`updated ${filePath}`);
}

function updateConfig(filePath, usesEnterpriseConfig) {
  const config = readJson(filePath);
  const target = usesEnterpriseConfig ? { ...(config.enterpriseConfig ?? {}) } : { ...config };
  const servers = parseServers(target.managedMcpServers).filter(
    (server) => server?.name !== writerServer.name,
  );

  target.isLocalDevMcpEnabled = true;
  target.isClaudeCodeForDesktopEnabled = true;
  target.isDesktopExtensionEnabled = true;
  target.isDesktopExtensionDirectoryEnabled = true;
  target.managedMcpServers = JSON.stringify([...servers, writerServer]);

  backupAndWrite(
    filePath,
    usesEnterpriseConfig ? { ...config, enterpriseConfig: target } : target,
  );
}

updateConfig(path.join(baseDir, "claude_desktop_config.json"), true);

const meta = readJson(path.join(baseDir, "configLibrary", "_meta.json"));
if (meta.appliedId) {
  updateConfig(path.join(baseDir, "configLibrary", `${meta.appliedId}.json`), false);
}

console.log("Installed figma-writer connector at http://localhost:8788/mcp");
console.log("Restart Claude after starting the writable MCP server.");
