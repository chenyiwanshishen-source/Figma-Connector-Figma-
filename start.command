#!/bin/bash
# Double-click to start the Writable Figma MCP server (macOS).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from https://nodejs.org (LTS) and try again."
  echo ""
  read -p "Press Enter to close..."
  exit 1
fi
node server.mjs
echo ""
read -p "Server stopped. Press Enter to close..."
