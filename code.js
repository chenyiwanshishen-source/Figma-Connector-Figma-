console.log("[Writable Figma MCP Bridge] starting");
const pluginSessionId = `figma-writer-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
figma.showUI(__html__, { width: 420, height: 420 });
figma.ui.postMessage({
  type: "bridge-info",
  pluginId: pluginSessionId,
  fileName: figma.root.name,
  pageName: figma.currentPage.name,
  ok: true,
  message: "Bridge UI loaded. Click Start polling when ready.",
});

const loadedFonts = new Set();
const nodeAliases = {};

const fontAliases = {
  inter: "Inter",
  "noto sans sc": "Noto Sans SC",
  "noto sans jp": "Noto Sans JP",
};

const fontStyleAliases = {
  regular: "Regular",
  normal: "Regular",
  medium: "Medium",
  semibold: "Semi Bold",
  "semi bold": "Semi Bold",
  bold: "Bold",
};

const defaultTheme = {
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
};

function valueOr(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

function firstValue(values, fallback) {
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== undefined && values[i] !== null && values[i] !== "") return values[i];
  }
  return fallback;
}

function mergeObjects(base, override) {
  const merged = {};
  for (const key in base || {}) merged[key] = base[key];
  for (const key in override || {}) merged[key] = override[key];
  return merged;
}

function normalizeFont(font = {}) {
  const familyKey = String(font.family || font.fontFamily || "Inter").toLowerCase();
  const styleKey = String(font.style || font.fontStyle || "Regular").toLowerCase();
  return {
    family: fontAliases[familyKey] || font.family || font.fontFamily || "Inter",
    style: fontStyleAliases[styleKey] || font.style || font.fontStyle || "Regular",
  };
}

function fontFromItem(item, theme) {
  if (item.fontToken && theme.fonts && theme.fonts[item.fontToken]) {
    return normalizeFont(theme.fonts[item.fontToken]);
  }
  if (item.font) return normalizeFont(item.font);
  if (item.fontFamily || item.fontStyle) return normalizeFont(item);
  if (item.fontWeight === "bold") return normalizeFont(theme.fonts.bold);
  if (item.fontWeight === "semibold") return normalizeFont(theme.fonts.semibold);
  if (item.fontWeight === "medium") return normalizeFont(theme.fonts.medium);
  return normalizeFont(theme.fonts.body);
}

async function loadFont(fontName) {
  const key = `${fontName.family}:::${fontName.style}`;
  if (loadedFonts.has(key)) return fontName;
  try {
    await figma.loadFontAsync(fontName);
    loadedFonts.add(key);
    return fontName;
  } catch (_error) {
    const fallback = { family: "Inter", style: "Regular" };
    const fallbackKey = `${fallback.family}:::${fallback.style}`;
    if (!loadedFonts.has(fallbackKey)) {
      await figma.loadFontAsync(fallback);
      loadedFonts.add(fallbackKey);
    }
    return fallback;
  }
}

async function ensureTextFontLoaded(node, fallbackFontName) {
  if (!node || node.type !== "TEXT") return;
  if (node.fontName && node.fontName !== figma.mixed) {
    await loadFont(node.fontName);
    return;
  }
  await loadFont(fallbackFontName || { family: "Inter", style: "Regular" });
}

function hexToRgb(hex) {
  const value = String(hex || "#FFFFFF").replace("#", "");
  const full = value.length === 3
    ? value.split("").map((char) => char + char).join("")
    : value;
  const number = parseInt(full, 16);
  return {
    r: ((number >> 16) & 255) / 255,
    g: ((number >> 8) & 255) / 255,
    b: (number & 255) / 255,
  };
}

function rgbToHex(rgb) {
  if (!rgb || typeof rgb !== "object") return "";
  const r = Math.round((rgb.r || 0) * 255).toString(16).padStart(2, "0");
  const g = Math.round((rgb.g || 0) * 255).toString(16).padStart(2, "0");
  const b = Math.round((rgb.b || 0) * 255).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`.toUpperCase();
}

function normalizeHex(value, theme) {
  if (!value) return "";
  const resolved = color(value, theme || defaultTheme);
  if (resolved && typeof resolved === "object" && typeof resolved.r === "number") return rgbToHex(resolved);
  if (String(resolved).charAt(0) !== "#") return String(resolved).toUpperCase();
  const rgb = hexToRgb(resolved);
  return rgbToHex(rgb);
}

function extractPaintValue(value) {
  if (Array.isArray(value) && value.length) return extractPaintValue(value[0]);
  if (value && typeof value === "object") {
    if (value.type === "SOLID" && value.color) return value;
    if (value.hex) return value.hex;
    if (value.value) return value.value;
    if (value.color) return value.color;
  }
  return value;
}

function color(value, theme) {
  value = extractPaintValue(value);
  if (!value) return "#FFFFFF";
  if (value && typeof value === "object" && typeof value.r === "number") return value;
  if (String(value).startsWith("$")) {
    return theme.colors && theme.colors[String(value).slice(1)] || "#FFFFFF";
  }
  return value;
}

function paint(value, theme, opacity = 1) {
  const resolved = color(value, theme);
  const rgb = resolved && typeof resolved === "object" ? resolved : hexToRgb(resolved);
  return { type: "SOLID", color: rgb, opacity };
}

function box(value, fallback = 0) {
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }
  if (Array.isArray(value)) {
    if (value.length === 2) {
      return { top: value[0], right: value[1], bottom: value[0], left: value[1] };
    }
    if (value.length === 4) {
      return { top: value[0], right: value[1], bottom: value[2], left: value[3] };
    }
  }
  if (value && typeof value === "object") {
    return {
      top: valueOr(value.top, fallback),
      right: valueOr(value.right, fallback),
      bottom: valueOr(value.bottom, fallback),
      left: valueOr(value.left, fallback),
    };
  }
  return { top: fallback, right: fallback, bottom: fallback, left: fallback };
}

function setPosition(node, item) {
  if (typeof item.x === "number") node.x = item.x;
  if (typeof item.y === "number") node.y = item.y;
}

function setSize(node, item, fallbackWidth = 100, fallbackHeight = 100) {
  const width = typeof item.width === "number" ? item.width : fallbackWidth;
  const height = typeof item.height === "number" ? item.height : fallbackHeight;
  node.resize(width, height);
}

function applyLayout(frame, item) {
  if (!item.layout) return;
  const layout = String(item.layout).toLowerCase();
  frame.layoutMode = layout === "horizontal" ? "HORIZONTAL" : "VERTICAL";
  frame.itemSpacing = valueOr(item.gap, valueOr(item.itemSpacing, 0));
  const padding = box(item.padding, 0);
  frame.paddingTop = padding.top;
  frame.paddingRight = padding.right;
  frame.paddingBottom = padding.bottom;
  frame.paddingLeft = padding.left;
  frame.primaryAxisSizingMode = item.primaryAxisSizing || item.primaryAxisSizingMode || "AUTO";
  frame.counterAxisSizingMode = item.counterAxisSizing || item.counterAxisSizingMode || "AUTO";
  frame.primaryAxisAlignItems = item.primaryAxisAlign || "MIN";
  frame.counterAxisAlignItems = item.counterAxisAlign || "MIN";
}

function applyAutoLayoutChild(node, item) {
  if (item.layoutGrow !== undefined) node.layoutGrow = item.layoutGrow;
  if (item.layoutAlign) node.layoutAlign = item.layoutAlign;
}

function bringTextToFront(node) {
  if (!node || !node.children) return;
  for (const child of node.children) bringTextToFront(child);
  for (const child of node.children) {
    if (child.type === "TEXT" && child.bringToFront) child.bringToFront();
  }
}

function applyVisualFrameProps(frame, item, theme) {
  frame.name = item.name || item.type || "Frame";
  frame.cornerRadius = item.radius || item.cornerRadius || 0;
  frame.clipsContent = valueOr(item.clipsContent, false);
  frame.fills = [paint(item.background || item.fill || "$surface", theme, item.opacity || 1)];
  if (item.stroke || item.border) {
    frame.strokes = [paint(item.stroke || item.border, theme)];
    frame.strokeWeight = item.strokeWeight || 1;
  }
  if (item.effects) frame.effects = item.effects;
}

function getNodeBounds(node) {
  return {
    x: node.x || 0,
    y: node.y || 0,
    width: node.width || 0,
    height: node.height || 0,
    right: (node.x || 0) + (node.width || 0),
    bottom: (node.y || 0) + (node.height || 0),
  };
}

function combineBounds(nodes) {
  if (!nodes.length) return null;
  const bounds = nodes.map(getNodeBounds);
  let left = bounds[0].x;
  let top = bounds[0].y;
  let right = bounds[0].right;
  let bottom = bounds[0].bottom;
  for (let i = 1; i < bounds.length; i += 1) {
    left = Math.min(left, bounds[i].x);
    top = Math.min(top, bounds[i].y);
    right = Math.max(right, bounds[i].right);
    bottom = Math.max(bottom, bounds[i].bottom);
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    right,
    bottom,
  };
}

function getPlacementAnchor(mode) {
  if (mode === "selection-right" || mode === "selection-below") {
    return combineBounds(figma.currentPage.selection);
  }
  return combineBounds(figma.currentPage.children);
}

function createPlacementState(spec) {
  const placement = spec.placement || {};
  const mode = placement.mode || "right";
  const gap = valueOr(placement.gap, 240);
  const anchor = getPlacementAnchor(mode);
  const startX = placement.x;
  const startY = placement.y;
  return {
    mode,
    gap,
    columns: placement.columns || 3,
    cursorX: typeof startX === "number" ? startX : anchor ? anchor.right + gap : figma.viewport.center.x,
    cursorY: typeof startY === "number" ? startY : anchor ? anchor.y : figma.viewport.center.y,
    originX: typeof startX === "number" ? startX : anchor ? anchor.right + gap : figma.viewport.center.x,
    originY: typeof startY === "number" ? startY : anchor ? anchor.y : figma.viewport.center.y,
    index: 0,
    rowHeight: 0,
    anchor,
  };
}

function placeFrame(frame, frameSpec, placementState) {
  if (typeof frameSpec.x === "number" || typeof frameSpec.y === "number") {
    frame.x = typeof frameSpec.x === "number" ? frameSpec.x : placementState.cursorX;
    frame.y = typeof frameSpec.y === "number" ? frameSpec.y : placementState.cursorY;
    return;
  }

  const mode = placementState.mode;
  if (mode === "below" || mode === "selection-below") {
    const anchor = placementState.anchor;
    frame.x = placementState.originX || (anchor ? anchor.x : figma.viewport.center.x);
    frame.y = placementState.cursorY;
    placementState.cursorY += frame.height + placementState.gap;
    return;
  }

  if (mode === "grid") {
    const column = placementState.index % placementState.columns;
    if (column === 0 && placementState.index > 0) {
      placementState.cursorX = placementState.originX;
      placementState.cursorY += placementState.rowHeight + placementState.gap;
      placementState.rowHeight = 0;
    }
    frame.x = placementState.cursorX;
    frame.y = placementState.cursorY;
    placementState.cursorX += frame.width + placementState.gap;
    placementState.rowHeight = Math.max(placementState.rowHeight, frame.height);
    placementState.index += 1;
    return;
  }

  frame.x = placementState.cursorX;
  frame.y = placementState.cursorY;
  placementState.cursorX += frame.width + placementState.gap;
}

async function createText(item, parent, theme) {
  const node = figma.createText();
  node.name = item.name || "Text";
  node.fontName = await loadFont(fontFromItem(item, theme));
  node.characters = String(firstValue([item.text, item.characters, item.content, item.label, item.value], ""));
  node.fontSize = item.fontSize || item.size || 16;
  node.lineHeight = item.lineHeight
    ? { unit: "PIXELS", value: item.lineHeight }
    : { unit: "AUTO" };
  node.letterSpacing = item.letterSpacing
    ? { unit: "PIXELS", value: item.letterSpacing }
    : { unit: "PIXELS", value: 0 };
  node.fills = [paint(firstValue([item.color, item.fill, item.fills, item.textColor], "$text"), theme)];
  if (item.align) node.textAlignHorizontal = String(item.align).toUpperCase();
  node.textAutoResize = item.textAutoResize || (item.width ? "HEIGHT" : "WIDTH_AND_HEIGHT");
  if (item.width || item.height) {
    node.resize(item.width || Math.max(80, node.width), item.height || Math.max(24, node.height));
  }
  setPosition(node, item);
  parent.appendChild(node);
  applyAutoLayoutChild(node, item);
  return node;
}

function createRectangle(item, parent, theme) {
  const node = figma.createRectangle();
  node.name = item.name || "Rectangle";
  setSize(node, item);
  setPosition(node, item);
  node.cornerRadius = item.radius || item.cornerRadius || 0;
  node.fills = [paint(item.fill || item.background || "$surface", theme, item.opacity || 1)];
  if (item.stroke || item.border) {
    node.strokes = [paint(item.stroke || item.border, theme)];
    node.strokeWeight = item.strokeWeight || 1;
  }
  parent.appendChild(node);
  applyAutoLayoutChild(node, item);
  return node;
}

function createLine(item, parent, theme) {
  const node = figma.createLine();
  node.name = item.name || "Line";
  node.resize(item.width || 100, 0);
  node.x = item.x || 0;
  node.y = item.y || 0;
  node.strokes = [paint(item.stroke || "$border", theme)];
  node.strokeWeight = item.strokeWeight || 1;
  parent.appendChild(node);
  return node;
}

function createEllipse(item, parent, theme) {
  const node = figma.createEllipse();
  node.name = item.name || "Ellipse";
  setSize(node, item, item.size || 80, item.size || 80);
  setPosition(node, item);
  node.fills = [paint(item.fill || item.background || "$surface", theme, item.opacity || 1)];
  if (item.stroke || item.border) {
    node.strokes = [paint(item.stroke || item.border, theme)];
    node.strokeWeight = item.strokeWeight || 1;
  }
  parent.appendChild(node);
  applyAutoLayoutChild(node, item);
  return node;
}

async function createContainer(item, parent, theme) {
  const frame = figma.createFrame();
  setSize(frame, item, item.layout ? 1 : 300, item.layout ? 1 : 200);
  setPosition(frame, item);
  applyVisualFrameProps(frame, item, theme);
  applyLayout(frame, item);
  parent.appendChild(frame);
  applyAutoLayoutChild(frame, item);
  for (const child of item.children || []) await createNode(child, frame, theme);
  return frame;
}

async function createGroup(item, parent, theme) {
  const frameSpec = mergeObjects(item, {
    type: "frame",
    name: item.name || "Group",
    background: item.background || "#FFFFFF00",
  });
  const tempFrame = await createContainer(
    frameSpec,
    parent,
    theme,
  );
  tempFrame.fills = item.background || item.fill ? tempFrame.fills : [];
  return tempFrame;
}

async function createCard(item, parent, x, y, width, height, theme) {
  return createContainer(
    {
      type: "frame",
      name: item.title || "Card",
      x,
      y,
      width,
      height,
      radius: 4,
      background: "$surface",
      stroke: "$border",
      children: [
        {
          type: "text",
          name: "Number",
          text: item.number || "",
          x: 28,
          y: 26,
          width: 48,
          height: 24,
          fontSize: 18,
          fontToken: "bold",
          color: "$accent",
        },
        {
          type: "text",
          name: "Title",
          text: item.title || "",
          x: 86,
          y: 24,
          width: width - 120,
          height: 28,
          fontSize: 18,
          fontToken: "bold",
          color: "$text",
        },
        {
          type: "text",
          name: "Type",
          text: item.type || "",
          x: 86,
          y: 58,
          width: width - 120,
          height: 22,
          fontSize: 13,
          color: "$muted",
        },
        {
          type: "text",
          name: "Keywords",
          text: item.keywords || "",
          x: 86,
          y: 82,
          width: width - 120,
          height: 30,
          fontSize: 12,
          lineHeight: 18,
          color: "$muted",
        },
      ],
    },
    parent,
    theme,
  );
}

async function createCardGrid(item, parent, theme) {
  const columns = item.columns || 2;
  const gap = item.gap || 24;
  const cardWidth = item.cardWidth || 360;
  const cardHeight = item.cardHeight || 120;
  const items = item.items || [];
  for (let i = 0; i < items.length; i += 1) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    await createCard(
      items[i],
      parent,
      (item.x || 0) + col * (cardWidth + gap),
      (item.y || 0) + row * (cardHeight + gap),
      cardWidth,
      cardHeight,
      theme,
    );
  }
}

async function createNode(item, parent, theme) {
  if (item.type === "text") return createText(item, parent, theme);
  if (item.type === "rectangle") return createRectangle(item, parent, theme);
  if (item.type === "line") return createLine(item, parent, theme);
  if (item.type === "ellipse") return createEllipse(item, parent, theme);
  if (item.type === "cardGrid") return createCardGrid(item, parent, theme);
  if (item.type === "group") return createGroup(item, parent, theme);
  if (["frame", "section", "stack", "row"].includes(item.type)) {
    return createContainer(item, parent, theme);
  }
  return null;
}

function mergeTheme(theme) {
  return {
    fonts: mergeObjects(defaultTheme.fonts, theme && theme.fonts || {}),
    colors: mergeObjects(defaultTheme.colors, theme && theme.colors || {}),
  };
}

function serializeBoundVariables(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const key in value) {
    const item = value[key];
    if (!item || typeof item !== "object") {
      result[key] = item;
    } else if (item.id || item.type) {
      result[key] = {
        id: item.id || "",
        type: item.type || "",
      };
    } else {
      result[key] = serializeBoundVariables(item);
    }
  }
  return result;
}

function serializeColorStop(stop) {
  if (!stop) return null;
  const colorValue = stop.color ? rgbToHex(stop.color) : "";
  return {
    position: stop.position,
    hex: colorValue,
    color: stop.color || null,
    opacity: stop.color && stop.color.a !== undefined ? stop.color.a : 1,
  };
}

function serializeSinglePaint(paintValue) {
  if (!paintValue || typeof paintValue !== "object") return paintValue;
  const result = {
    type: paintValue.type || "UNKNOWN",
    visible: paintValue.visible !== false,
    opacity: paintValue.opacity === undefined ? 1 : paintValue.opacity,
    blendMode: paintValue.blendMode || "NORMAL",
  };
  if (paintValue.type === "SOLID" && paintValue.color) {
    result.hex = rgbToHex(paintValue.color);
    result.color = paintValue.color;
  }
  if (String(paintValue.type || "").indexOf("GRADIENT") === 0) {
    result.gradientType = paintValue.type;
    result.stops = [];
    const stops = paintValue.gradientStops || [];
    for (let i = 0; i < stops.length; i += 1) {
      const serializedStop = serializeColorStop(stops[i]);
      if (serializedStop) result.stops.push(serializedStop);
    }
  }
  if (paintValue.type === "IMAGE") {
    result.imageHash = paintValue.imageHash || "";
    result.scaleMode = paintValue.scaleMode || "";
  }
  if (paintValue.boundVariables) result.boundVariables = serializeBoundVariables(paintValue.boundVariables);
  return result;
}

function serializePaintValue(value) {
  if (value === figma.mixed) return "MIXED";
  if (Array.isArray(value)) {
    const result = [];
    for (let i = 0; i < value.length; i += 1) result.push(serializeSinglePaint(value[i]));
    return result;
  }
  return serializeSinglePaint(value);
}

function serializeVariableValue(value) {
  if (!value || typeof value !== "object") return value;
  if (value.type && value.id) return { type: value.type, id: value.id };
  const serialized = {};
  for (const key in value) {
    const item = value[key];
    if (typeof item !== "function") serialized[key] = item;
  }
  return serialized;
}

function serializeVariableSummary(variable) {
  return {
    id: variable.id,
    key: variable.key,
    name: variable.name,
    remote: variable.remote,
    variableCollectionId: variable.variableCollectionId,
    resolvedType: variable.resolvedType,
    scopes: variable.scopes,
    description: variable.description || "",
  };
}

function serializeStyle(style) {
  return {
    id: style.id,
    key: style.key,
    name: style.name,
    type: style.type,
    remote: style.remote,
    description: style.description || "",
  };
}

function serializeComponentNode(node) {
  return {
    id: node.id,
    key: node.key || "",
    name: node.name,
    type: node.type,
    description: node.description || "",
    remote: node.remote === true,
  };
}

function itemMatchesQuery(item, query) {
  if (!query) return true;
  const q = String(query).toLowerCase();
  return (
    String(item.id || "").toLowerCase() === q ||
    String(item.key || "").toLowerCase() === q ||
    String(item.name || "").toLowerCase().indexOf(q) >= 0 ||
    String(item.description || "").toLowerCase().indexOf(q) >= 0 ||
    String(item.libraryName || "").toLowerCase().indexOf(q) >= 0
  );
}

function limitList(list, maxItems) {
  const max = Math.max(1, Math.min(valueOr(maxItems, 80), 500));
  return {
    items: list.slice(0, max),
    total: list.length,
    truncated: list.length > max,
  };
}

function serializeNodeBinding(node) {
  const result = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };
  if ("boundVariables" in node) result.boundVariables = node.boundVariables;
  if ("fillStyleId" in node) result.fillStyleId = node.fillStyleId;
  if ("strokeStyleId" in node) result.strokeStyleId = node.strokeStyleId;
  if ("textStyleId" in node) result.textStyleId = node.textStyleId;
  if ("effectStyleId" in node) result.effectStyleId = node.effectStyleId;
  if ("gridStyleId" in node) result.gridStyleId = node.gridStyleId;
  if ("fills" in node) result.fills = serializePaintValue(node.fills);
  if ("strokes" in node) result.strokes = serializePaintValue(node.strokes);
  if ("fontName" in node) result.fontName = node.fontName;
  if ("fontSize" in node) result.fontSize = node.fontSize;
  if ("lineHeight" in node) result.lineHeight = node.lineHeight;
  return result;
}

function summarizeNode(node, depth, includeInvisible, maxState) {
  if (!node || maxState.count >= maxState.maxNodes) return null;
  if (!includeInvisible && node.visible === false) return null;
  maxState.count += 1;
  const bounds = getNodeBounds(node);
  const summary = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  if ("layoutMode" in node) summary.layoutMode = node.layoutMode;
  if ("itemSpacing" in node) summary.itemSpacing = node.itemSpacing;
  if ("fills" in node) summary.fills = serializePaintValue(node.fills);
  if ("strokes" in node) summary.strokes = serializePaintValue(node.strokes);
  if ("fillStyleId" in node) summary.fillStyleId = node.fillStyleId;
  if ("strokeStyleId" in node) summary.strokeStyleId = node.strokeStyleId;
  if ("textStyleId" in node) summary.textStyleId = node.textStyleId;
  if ("boundVariables" in node) summary.boundVariables = serializeBoundVariables(node.boundVariables);
  if ("characters" in node) summary.characters = node.characters;
  if ("fontSize" in node) summary.fontSize = node.fontSize;
  if ("fontName" in node) summary.fontName = node.fontName;
  if ("cornerRadius" in node) summary.cornerRadius = node.cornerRadius;
  if (nodeAliases[node.id]) summary.alias = nodeAliases[node.id];
  if (depth > 0 && node.children && node.children.length) {
    summary.children = [];
    for (let i = 0; i < node.children.length; i += 1) {
      const child = summarizeNode(node.children[i], depth - 1, includeInvisible, maxState);
      if (child) summary.children.push(child);
      if (maxState.count >= maxState.maxNodes) break;
    }
  }
  return summary;
}

function rememberNode(node, alias) {
  if (!node) return;
  nodeAliases.$last = node.id;
  nodeAliases[node.id] = alias || nodeAliases[node.id] || node.name || node.id;
  if (node.type === "FRAME" || node.type === "SECTION" || node.type === "COMPONENT") {
    nodeAliases.$lastFrame = node.id;
  }
  if (alias) nodeAliases[alias] = node.id;
}

function refreshSelectionAliases() {
  const selection = figma.currentPage.selection || [];
  for (let i = 0; i < selection.length; i += 1) {
    nodeAliases[`$selection${i}`] = selection[i].id;
  }
}

async function getNodeById(id) {
  if (!id) return null;
  if (id === "$page") return figma.currentPage;
  const resolvedId = nodeAliases[id] || id;
  if (resolvedId === "$page") return figma.currentPage;
  if (figma.getNodeByIdAsync) return await figma.getNodeByIdAsync(resolvedId);
  return figma.getNodeById(resolvedId);
}

async function requireNode(ref, label) {
  const node = await getNodeById(ref);
  if (!node) throw new Error(`Node not found for ${label || "ref"}: ${ref}`);
  return node;
}

function canAppend(node) {
  return node && node.appendChild;
}

async function resolveParent(ref) {
  if (!ref || ref === "$page") return figma.currentPage;
  const parent = await requireNode(ref, "parent");
  if (!canAppend(parent)) throw new Error(`Node cannot contain children: ${ref}`);
  return parent;
}

function serializePage(args) {
  refreshSelectionAliases();
  const depth = valueOr(args.depth, 2);
  const maxState = { count: 0, maxNodes: valueOr(args.maxNodes, 200) };
  const roots = [];
  const children = figma.currentPage.children || [];
  for (let i = 0; i < children.length; i += 1) {
    const node = summarizeNode(children[i], depth, args.includeInvisible === true, maxState);
    if (node) roots.push(node);
    if (maxState.count >= maxState.maxNodes) break;
  }
  return {
    page: {
      id: figma.currentPage.id,
      name: figma.currentPage.name,
      childCount: children.length,
    },
    aliases: nodeAliases,
    nodes: roots,
    truncated: maxState.count >= maxState.maxNodes,
  };
}

function serializeSelection(args) {
  refreshSelectionAliases();
  const depth = valueOr(args.depth, 3);
  const maxState = { count: 0, maxNodes: valueOr(args.maxNodes, 200) };
  const selection = figma.currentPage.selection || [];
  const nodes = [];
  for (let i = 0; i < selection.length; i += 1) {
    const node = summarizeNode(selection[i], depth, args.includeInvisible !== false, maxState);
    if (node) nodes.push(node);
  }
  return { aliases: nodeAliases, nodes, selectionCount: selection.length };
}

function getFirstSolidPaintHex(node, field, theme) {
  if (!node || !(field in node)) return "";
  const paints = node[field];
  if (!Array.isArray(paints) || !paints.length) return "";
  for (let i = 0; i < paints.length; i += 1) {
    const item = paints[i];
    if (item && item.type === "SOLID" && item.color) return rgbToHex(item.color);
  }
  return "";
}

function nodeHasBoundPaintVariable(node, field) {
  if (!node || !node.boundVariables) return false;
  const bound = node.boundVariables;
  if (field === "fills") return !!bound.fills || !!bound.fill || !!bound.color;
  if (field === "strokes") return !!bound.strokes || !!bound.stroke || !!bound.color;
  return false;
}

function getSelector(operation) {
  return mergeObjects(operation || {}, operation && operation.selector || {});
}

function nodeMatchesSelector(root, selector, theme) {
  const query = selector.query ? String(selector.query).toLowerCase() : "";
  const nameQuery = selector.nameQuery ? String(selector.nameQuery).toLowerCase() : "";
  const textQuery = firstValue([selector.text, selector.characters, selector.content], null);
  const loweredTextQuery = textQuery ? String(textQuery).toLowerCase() : "";
  const exactText = selector.exactText !== undefined && selector.exactText !== null ? String(selector.exactText) : "";
  const textRegex = selector.textRegex ? String(selector.textRegex) : "";
  const type = selector.type ? String(selector.type).toUpperCase() : "";
  const name = String(root.name || "").toLowerCase();
  const characters = root.type === "TEXT" && root.characters ? String(root.characters) : "";
  const loweredCharacters = characters.toLowerCase();
  const searchable = `${name}\n${loweredCharacters}`;
  let matchesRegex = true;
  if (textRegex) {
    try {
      matchesRegex = new RegExp(textRegex).test(characters);
    } catch (_error) {
      matchesRegex = false;
    }
  }
  const matchesQuery = !query || searchable.indexOf(query) >= 0;
  const matchesName = !nameQuery || name.indexOf(nameQuery) >= 0;
  const matchesText = !loweredTextQuery || loweredCharacters.indexOf(loweredTextQuery) >= 0;
  const matchesExactText = !exactText || characters === exactText;
  const matchesType = !type || root.type === type;
  const matchesFontSize = selector.fontSize === undefined || selector.fontSize === null || root.fontSize === selector.fontSize;
  const fontFamily = selector.fontFamily ? String(selector.fontFamily).toLowerCase() : "";
  const matchesFontFamily =
    !fontFamily ||
    (root.fontName &&
      root.fontName !== figma.mixed &&
      String(root.fontName.family || "").toLowerCase() === fontFamily);

  const currentFill = firstValue([selector.currentFill, selector.fillFrom, selector.fromFill], null);
  const matchesCurrentFill =
    !currentFill || getFirstSolidPaintHex(root, "fills", theme) === normalizeHex(currentFill, theme);

  const currentStroke = firstValue([selector.currentStroke, selector.strokeFrom, selector.fromStroke], null);
  const matchesCurrentStroke =
    !currentStroke || getFirstSolidPaintHex(root, "strokes", theme) === normalizeHex(currentStroke, theme);

  const matchesFillVariable =
    selector.hasFillVariable === undefined ||
    selector.hasFillVariable === null ||
    nodeHasBoundPaintVariable(root, "fills") === !!selector.hasFillVariable;

  const matchesStrokeVariable =
    selector.hasStrokeVariable === undefined ||
    selector.hasStrokeVariable === null ||
    nodeHasBoundPaintVariable(root, "strokes") === !!selector.hasStrokeVariable;

  const includeInvisible = selector.includeInvisible === true;
  const matchesVisible = includeInvisible || root.visible !== false;

  return (
    matchesVisible &&
    matchesQuery &&
    matchesName &&
    matchesText &&
    matchesExactText &&
    matchesRegex &&
    matchesType &&
    matchesFontSize &&
    matchesFontFamily &&
    matchesCurrentFill &&
    matchesCurrentStroke &&
    matchesFillVariable &&
    matchesStrokeVariable
  );
}

function collectMatchingNodes(root, args, result, theme) {
  const selector = getSelector(args || {});
  if (!root || result.length >= valueOr(selector.maxNodes, 50)) return;
  if (nodeMatchesSelector(root, selector, theme || defaultTheme)) result.push(root);
  if (root.children) {
    for (let i = 0; i < root.children.length; i += 1) {
      collectMatchingNodes(root.children[i], selector, result, theme || defaultTheme);
      if (result.length >= valueOr(selector.maxNodes, 50)) break;
    }
  }
}

async function getSelectorRoots(selector) {
  selector = selector || {};
  const scope = selector.scope || "currentPage";
  if (scope === "selection") return figma.currentPage.selection || [];
  if (scope === "childrenOf" || selector.parent) {
    const parent = await requireNode(selector.parent || selector.childrenOf, "selector.parent");
    return parent.children || [];
  }
  return figma.currentPage.children || [];
}

async function findNodesBySelector(selector, theme) {
  const matches = [];
  const roots = await getSelectorRoots(selector);
  const maxNodes = valueOr(selector.maxNodes, 50);
  for (let i = 0; i < roots.length; i += 1) {
    collectMatchingNodes(roots[i], selector, matches, theme || defaultTheme);
    if (matches.length >= maxNodes) break;
  }
  return matches;
}

async function findNodes(args) {
  refreshSelectionAliases();
  if (args.id || args.alias) {
    const node = await getNodeById(args.id || args.alias);
    return {
      nodes: node ? [summarizeNode(node, 1, true, { count: 0, maxNodes: 1 })] : [],
      aliases: nodeAliases,
    };
  }
  const matches = await findNodesBySelector(getSelector(args || {}), defaultTheme);
  const nodes = [];
  for (let i = 0; i < matches.length; i += 1) {
    const summary = summarizeNode(matches[i], 1, true, { count: 0, maxNodes: 1 });
    if (summary) nodes.push(summary);
  }
  return { nodes, aliases: nodeAliases };
}

async function readLocalVariables() {
  if (!figma.variables) {
    return { collections: [], variables: [], warning: "figma.variables API is unavailable." };
  }

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const serializedCollections = [];
  const serializedVariables = [];

  for (let i = 0; i < collections.length; i += 1) {
    const collection = collections[i];
    serializedCollections.push({
      id: collection.id,
      key: collection.key,
      name: collection.name,
      remote: collection.remote,
      defaultModeId: collection.defaultModeId,
      modes: collection.modes,
      variableIds: collection.variableIds,
    });
  }

  for (let i = 0; i < variables.length; i += 1) {
    const variable = variables[i];
    const valuesByMode = {};
    const rawValuesByMode = variable.valuesByMode || {};
    for (const modeId in rawValuesByMode) {
      valuesByMode[modeId] = serializeVariableValue(rawValuesByMode[modeId]);
    }
    serializedVariables.push({
      id: variable.id,
      key: variable.key,
      name: variable.name,
      remote: variable.remote,
      variableCollectionId: variable.variableCollectionId,
      resolvedType: variable.resolvedType,
      scopes: variable.scopes,
      description: variable.description || "",
      valuesByMode,
    });
  }

  return { collections: serializedCollections, variables: serializedVariables };
}

async function readLocalStyles() {
  const paintStyles = figma.getLocalPaintStylesAsync
    ? await figma.getLocalPaintStylesAsync()
    : figma.getLocalPaintStyles();
  const textStyles = figma.getLocalTextStylesAsync
    ? await figma.getLocalTextStylesAsync()
    : figma.getLocalTextStyles();
  const effectStyles = figma.getLocalEffectStylesAsync
    ? await figma.getLocalEffectStylesAsync()
    : figma.getLocalEffectStyles();
  const gridStyles = figma.getLocalGridStylesAsync
    ? await figma.getLocalGridStylesAsync()
    : figma.getLocalGridStyles();

  return {
    paintStyles: paintStyles.map(serializeStyle),
    textStyles: textStyles.map(serializeStyle),
    effectStyles: effectStyles.map(serializeStyle),
    gridStyles: gridStyles.map(serializeStyle),
  };
}

async function readLibraryVariables(includeLibraryVariables) {
  if (!includeLibraryVariables) return { collections: [], skipped: true };
  if (!figma.teamLibrary) {
    return {
      collections: [],
      warning: "figma.teamLibrary is unavailable. Ensure manifest permissions include teamlibrary.",
    };
  }

  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    const collectionResults = [];
    const maxCollections = Math.min(collections.length, 40);

    for (let i = 0; i < maxCollections; i += 1) {
      const collection = collections[i];
      try {
        const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key);
        const serializedVariables = [];
        const maxVariables = Math.min(variables.length, 300);
        for (let j = 0; j < maxVariables; j += 1) {
          const variable = variables[j];
          serializedVariables.push({
            key: variable.key,
            name: variable.name,
            resolvedType: variable.resolvedType,
          });
        }
        collectionResults.push({
          key: collection.key,
          name: collection.name,
          libraryName: collection.libraryName,
          variables: serializedVariables,
          truncated: variables.length > maxVariables,
        });
      } catch (error) {
        collectionResults.push({
          key: collection.key,
          name: collection.name,
          libraryName: collection.libraryName,
          error: error.message,
        });
      }
    }

    return {
      collections: collectionResults,
      truncated: collections.length > maxCollections,
    };
  } catch (error) {
    return {
      collections: [],
      warning:
        "Team library variables could not be read. Enable the relevant libraries in this file and re-import the plugin manifest if permissions changed.",
      error: error.message,
    };
  }
}

function variableMatches(variable, query) {
  if (!variable || !query) return false;
  const q = String(query).toLowerCase();
  return (
    String(variable.id || "").toLowerCase() === q ||
    String(variable.key || "").toLowerCase() === q ||
    String(variable.name || "").toLowerCase() === q ||
    String(variable.name || "").toLowerCase().indexOf(q) >= 0
  );
}

async function findLocalVariable(query, resolvedType) {
  if (!figma.variables || !query) return null;
  const variables = await figma.variables.getLocalVariablesAsync(resolvedType || undefined);
  for (let i = 0; i < variables.length; i += 1) {
    if (variableMatches(variables[i], query)) return variables[i];
  }
  return null;
}

async function findLibraryVariable(query, resolvedType) {
  if (!figma.teamLibrary || !figma.variables || !query) return null;
  if (!figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync) return null;
  if (!figma.teamLibrary.getVariablesInLibraryCollectionAsync) return null;
  if (!figma.variables.importVariableByKeyAsync) return null;

  const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  for (let i = 0; i < collections.length; i += 1) {
    const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collections[i].key);
    for (let j = 0; j < variables.length; j += 1) {
      const variable = variables[j];
      if (resolvedType && variable.resolvedType !== resolvedType) continue;
      if (variableMatches(variable, query)) {
        return await figma.variables.importVariableByKeyAsync(variable.key);
      }
    }
  }
  return null;
}

async function resolveVariable(args, resolvedType) {
  args = args || {};
  const query = firstValue([
    args.variable,
    args.variableName,
    args.variablePath,
    args.variableKey,
    args.key,
    args.name,
  ], null);
  if (!query) throw new Error("Variable operation requires variable, variableName, variablePath, variableKey, key, or name.");

  let variable = await findLocalVariable(query, resolvedType);
  if (!variable) variable = await findLibraryVariable(query, resolvedType);
  if (!variable) throw new Error(`Variable not found: ${query}. Enable the library in this file or use figma_get_design_tokens first.`);
  return variable;
}

function matchesLibraryQuery(item, query) {
  if (!query) return true;
  const q = String(query).toLowerCase();
  const name = String(item.name || "").toLowerCase();
  const description = String(item.description || "").toLowerCase();
  const libraryName = String(item.libraryName || "").toLowerCase();
  const key = String(item.key || "").toLowerCase();
  return (
    name.indexOf(q) >= 0 ||
    description.indexOf(q) >= 0 ||
    libraryName.indexOf(q) >= 0 ||
    key.indexOf(q) >= 0
  );
}

function serializeLibraryItem(item, type) {
  return {
    key: item.key,
    name: item.name,
    description: item.description || "",
    libraryName: item.libraryName || "",
    type,
  };
}

async function listLibraryComponents(args) {
  if (!figma.teamLibrary) {
    return {
      components: [],
      componentSets: [],
      warning: "figma.teamLibrary is unavailable. Re-import the plugin manifest and ensure it includes teamlibrary permission.",
    };
  }

  const query = args && args.query ? args.query : "";
  const maxItems = Math.max(1, Math.min(valueOr(args && args.maxItems, 80), 500));
  const includeComponents = !args || args.includeComponents !== false;
  const includeComponentSets = !args || args.includeComponentSets !== false;
  const result = {
    components: [],
    componentSets: [],
    warnings: [],
  };

  if (includeComponents && figma.teamLibrary.getAvailableComponentsAsync) {
    try {
      const components = await figma.teamLibrary.getAvailableComponentsAsync();
      for (let i = 0; i < components.length && result.components.length < maxItems; i += 1) {
        if (matchesLibraryQuery(components[i], query)) {
          result.components.push(serializeLibraryItem(components[i], "component"));
        }
      }
      result.componentsTruncated = components.length > result.components.length;
    } catch (error) {
      result.warnings.push(`Could not read library components: ${error.message}`);
    }
  } else if (includeComponents) {
    result.warnings.push("getAvailableComponentsAsync is not available in this Figma runtime.");
  }

  if (includeComponentSets && figma.teamLibrary.getAvailableComponentSetsAsync) {
    try {
      const componentSets = await figma.teamLibrary.getAvailableComponentSetsAsync();
      for (let j = 0; j < componentSets.length && result.componentSets.length < maxItems; j += 1) {
        if (matchesLibraryQuery(componentSets[j], query)) {
          result.componentSets.push(serializeLibraryItem(componentSets[j], "componentSet"));
        }
      }
      result.componentSetsTruncated = componentSets.length > result.componentSets.length;
    } catch (error) {
      result.warnings.push(`Could not read library component sets: ${error.message}`);
    }
  } else if (includeComponentSets) {
    result.warnings.push("getAvailableComponentSetsAsync is not available in this Figma runtime.");
  }

  return result;
}

async function importComponentInstance(args) {
  args = args || {};
  const componentKey = firstValue([args.componentKey, args.key], null);
  const componentSetKey = firstValue([args.componentSetKey, args.variantSetKey], null);
  if (!componentKey && !componentSetKey) {
    throw new Error("figma_import_component_instance requires key, componentKey, or componentSetKey.");
  }

  let component = null;
  let source = null;
  if (componentSetKey) {
    if (!figma.importComponentSetByKeyAsync) {
      throw new Error("importComponentSetByKeyAsync is not available in this Figma runtime.");
    }
    const componentSet = await figma.importComponentSetByKeyAsync(componentSetKey);
    source = componentSet;
    if (componentSet.defaultVariant) {
      component = componentSet.defaultVariant;
    } else if (componentSet.children && componentSet.children.length) {
      component = componentSet.children[0];
    }
  } else {
    if (!figma.importComponentByKeyAsync) {
      throw new Error("importComponentByKeyAsync is not available in this Figma runtime.");
    }
    component = await figma.importComponentByKeyAsync(componentKey);
    source = component;
  }

  if (!component || !component.createInstance) {
    throw new Error("Imported library item could not create an instance.");
  }

  const parent = await resolveParent(args.parent);
  const instance = component.createInstance();
  instance.name = args.name || instance.name || component.name || "Library Instance";
  if (typeof args.x === "number") instance.x = args.x;
  if (typeof args.y === "number") instance.y = args.y;
  if (args.width && args.height && instance.resize) instance.resize(args.width, args.height);
  parent.appendChild(instance);

  if (args.properties && instance.setProperties) {
    instance.setProperties(args.properties);
  }

  rememberNode(instance, args.as || args.alias);
  figma.currentPage.selection = [instance];
  figma.viewport.scrollAndZoomIntoView([instance]);
  return {
    imported: true,
    source: source ? {
      id: source.id,
      key: source.key,
      name: source.name,
      type: source.type,
    } : null,
    instance: summarizeNode(instance, 1, true, { count: 0, maxNodes: 1 }),
    alias: args.as || args.alias || nodeAliases[instance.id],
  };
}

async function getLocalComponentsIndex(query, maxItems) {
  const all = figma.root.findAll(function (node) {
    return node.type === "COMPONENT" || node.type === "COMPONENT_SET";
  });
  const components = [];
  const componentSets = [];
  for (let i = 0; i < all.length; i += 1) {
    const item = serializeComponentNode(all[i]);
    if (!itemMatchesQuery(item, query)) continue;
    if (all[i].type === "COMPONENT_SET") componentSets.push(item);
    else components.push(item);
  }
  return {
    components: limitList(components, maxItems),
    componentSets: limitList(componentSets, maxItems),
  };
}

async function indexDesignSystem(args) {
  args = args || {};
  const maxItems = args.maxItems || 80;
  const query = args.query || "";
  const localComponents = await getLocalComponentsIndex(query, maxItems);
  const localStyles = await readLocalStyles();
  const localVariables = await readLocalVariables();
  const result = {
    page: {
      id: figma.currentPage.id,
      name: figma.currentPage.name,
    },
    localComponents,
    localStyles: {
      paintStyles: limitList(localStyles.paintStyles.filter(function (item) {
        return itemMatchesQuery(item, query);
      }), maxItems),
      textStyles: limitList(localStyles.textStyles.filter(function (item) {
        return itemMatchesQuery(item, query);
      }), maxItems),
      effectStyles: limitList(localStyles.effectStyles.filter(function (item) {
        return itemMatchesQuery(item, query);
      }), maxItems),
      gridStyles: limitList(localStyles.gridStyles.filter(function (item) {
        return itemMatchesQuery(item, query);
      }), maxItems),
    },
    localVariables: {
      collections: limitList(localVariables.collections.filter(function (item) {
        return itemMatchesQuery(item, query);
      }), maxItems),
      variables: limitList(localVariables.variables.filter(function (item) {
        return itemMatchesQuery(item, query);
      }), maxItems),
    },
  };

  if (args.includeLibraryComponents !== false) {
    result.libraryComponents = await listLibraryComponents({
      query,
      maxItems,
      includeComponents: args.includeComponents !== false,
      includeComponentSets: args.includeComponentSets !== false,
    });
  }
  if (args.includeLibraryVariables === true) {
    result.libraryVariables = await readLibraryVariables(true);
  }
  return result;
}

function choosePlacement(sourceNode, node, options) {
  options = options || {};
  if (typeof options.x === "number") node.x = options.x;
  if (typeof options.y === "number") node.y = options.y;
  if (typeof options.x === "number" || typeof options.y === "number") return;
  const gap = valueOr(options.gap, 80);
  const placement = options.placement || "right";
  const bounds = getNodeBounds(sourceNode);
  if (placement === "below") {
    node.x = bounds.x;
    node.y = bounds.y + bounds.height + gap;
  } else if (placement === "same") {
    node.x = bounds.x;
    node.y = bounds.y;
  } else {
    node.x = bounds.x + bounds.width + gap;
    node.y = bounds.y;
  }
}

async function cloneReferenceNode(selector, options) {
  selector = selector || {};
  options = options || {};
  const matches = await findNodesBySelector(selector, defaultTheme);
  if (!matches.length) {
    throw new Error("cloneReferenceNode matched 0 nodes. Use nameQuery, query, type, text, or select a reference node first.");
  }
  const source = matches[0];
  if (!source.clone) throw new Error(`Node cannot be cloned: ${source.name}`);
  const clone = source.clone();
  const parent = options.parent ? await resolveParent(options.parent) : figma.currentPage;
  parent.appendChild(clone);
  clone.name = options.name || `Clone / ${source.name}`;
  choosePlacement(source, clone, options);
  rememberNode(clone, options.as || options.alias);
  if (options.select !== false) {
    figma.currentPage.selection = [clone];
    figma.viewport.scrollAndZoomIntoView([clone]);
  }
  return {
    source: summarizeNode(source, 1, true, { count: 0, maxNodes: 1 }),
    clone: summarizeNode(clone, 2, true, { count: 0, maxNodes: 24 }),
  };
}

function findLocalComponentNode(query, includeSets) {
  if (!query) return null;
  const all = figma.root.findAll(function (node) {
    return node.type === "COMPONENT" || (includeSets !== false && node.type === "COMPONENT_SET");
  });
  let looseMatch = null;
  for (let i = 0; i < all.length; i += 1) {
    const item = serializeComponentNode(all[i]);
    const q = String(query).toLowerCase();
    if (String(item.id || "").toLowerCase() === q || String(item.key || "").toLowerCase() === q || String(item.name || "").toLowerCase() === q) {
      return all[i];
    }
    if (!looseMatch && itemMatchesQuery(item, query)) looseMatch = all[i];
  }
  return looseMatch;
}

async function findLibraryComponentItem(query, includeSets) {
  if (!figma.teamLibrary || !query) return null;
  const q = String(query).toLowerCase();
  if (includeSets !== false && figma.teamLibrary.getAvailableComponentSetsAsync) {
    const sets = await figma.teamLibrary.getAvailableComponentSetsAsync();
    let looseSet = null;
    for (let i = 0; i < sets.length; i += 1) {
      if (String(sets[i].key || "").toLowerCase() === q || String(sets[i].name || "").toLowerCase() === q) {
        return { type: "COMPONENT_SET", item: sets[i] };
      }
      if (!looseSet && itemMatchesQuery(sets[i], query)) looseSet = sets[i];
    }
    if (looseSet) return { type: "COMPONENT_SET", item: looseSet };
  }
  if (figma.teamLibrary.getAvailableComponentsAsync) {
    const components = await figma.teamLibrary.getAvailableComponentsAsync();
    let looseComponent = null;
    for (let j = 0; j < components.length; j += 1) {
      if (String(components[j].key || "").toLowerCase() === q || String(components[j].name || "").toLowerCase() === q) {
        return { type: "COMPONENT", item: components[j] };
      }
      if (!looseComponent && itemMatchesQuery(components[j], query)) looseComponent = components[j];
    }
    if (looseComponent) return { type: "COMPONENT", item: looseComponent };
  }
  return null;
}

function componentFromSet(componentSet, preferredName) {
  if (!componentSet) return null;
  if (preferredName && componentSet.children) {
    const q = String(preferredName).toLowerCase();
    for (let i = 0; i < componentSet.children.length; i += 1) {
      if (String(componentSet.children[i].name || "").toLowerCase().indexOf(q) >= 0) return componentSet.children[i];
    }
  }
  if (componentSet.defaultVariant) return componentSet.defaultVariant;
  if (componentSet.children && componentSet.children.length) return componentSet.children[0];
  return null;
}

async function importComponentByName(query, options) {
  options = options || {};
  query = query || options.query || options.name || options.componentName;
  if (!query) throw new Error("importComponentByName requires a component name, key, or query.");

  let source = findLocalComponentNode(query, options.includeComponentSets !== false);
  let importedFromLibrary = false;
  if (!source) {
    const libraryItem = await findLibraryComponentItem(query, options.includeComponentSets !== false);
    if (libraryItem && libraryItem.type === "COMPONENT_SET") {
      if (!figma.importComponentSetByKeyAsync) throw new Error("importComponentSetByKeyAsync is unavailable.");
      source = await figma.importComponentSetByKeyAsync(libraryItem.item.key);
      importedFromLibrary = true;
    } else if (libraryItem) {
      if (!figma.importComponentByKeyAsync) throw new Error("importComponentByKeyAsync is unavailable.");
      source = await figma.importComponentByKeyAsync(libraryItem.item.key);
      importedFromLibrary = true;
    }
  }
  if (!source) throw new Error(`Component not found: ${query}`);

  const component = source.type === "COMPONENT_SET" ? componentFromSet(source, options.variantName) : source;
  if (!component || !component.createInstance) throw new Error(`Matched item cannot create an instance: ${source.name}`);
  const parent = options.parent ? await resolveParent(options.parent) : figma.currentPage;
  const instance = component.createInstance();
  parent.appendChild(instance);
  if (options.name) instance.name = options.name;
  if (options.properties && instance.setProperties) instance.setProperties(options.properties);
  if (typeof options.width === "number" && typeof options.height === "number" && instance.resize) instance.resize(options.width, options.height);
  choosePlacement(source, instance, options);
  rememberNode(instance, options.as || options.alias);
  if (options.select !== false) {
    figma.currentPage.selection = [instance];
    figma.viewport.scrollAndZoomIntoView([instance]);
  }
  return {
    importedFromLibrary,
    source: serializeComponentNode(source),
    instance: summarizeNode(instance, 2, true, { count: 0, maxNodes: 24 }),
  };
}

async function findLocalStyleByName(kind, query) {
  const styles = await readLocalStyles();
  const list = kind === "text"
    ? styles.textStyles
    : kind === "effect"
      ? styles.effectStyles
      : kind === "grid"
        ? styles.gridStyles
        : styles.paintStyles;
  let looseMatch = null;
  const q = String(query || "").toLowerCase();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (String(item.id || "").toLowerCase() === q || String(item.key || "").toLowerCase() === q || String(item.name || "").toLowerCase() === q) {
      return item;
    }
    if (!looseMatch && itemMatchesQuery(item, query)) looseMatch = item;
  }
  return looseMatch;
}

async function applyTextStyle(node, styleName) {
  if (!node || node.type !== "TEXT") throw new Error("applyTextStyle target must be a TEXT node.");
  const style = await findLocalStyleByName("text", styleName);
  if (!style) throw new Error(`Text style not found: ${styleName}`);
  await ensureTextFontLoaded(node);
  node.textStyleId = style.id;
  return style;
}

async function applyPaintStyle(node, styleName, field) {
  field = field || "fills";
  if (!node || !(field in node)) throw new Error(`applyPaintStyle target does not support ${field}.`);
  const style = await findLocalStyleByName("paint", styleName);
  if (!style) throw new Error(`Paint style not found: ${styleName}`);
  if (field === "strokes") node.strokeStyleId = style.id;
  else node.fillStyleId = style.id;
  return style;
}

async function bindVariable(node, field, variableName, fallbackValue, resolvedType) {
  if (!node) throw new Error("bindVariable requires a node.");
  if (field === "fills" || field === "fill") return await bindPaintVariable(node, "fills", { variableName }, fallbackValue, defaultTheme);
  if (field === "strokes" || field === "stroke") return await bindPaintVariable(node, "strokes", { variableName }, fallbackValue, defaultTheme);
  if (!figma.variables) throw new Error("Figma variables API is unavailable.");
  const variable = await resolveVariable({ variableName }, resolvedType);
  if (!node.setBoundVariable) throw new Error(`Node does not support setBoundVariable: ${node.name}`);
  if (fallbackValue !== undefined && fallbackValue !== null && field in node) {
    try {
      node[field] = fallbackValue;
    } catch (_error) {
      // Some bound fields are read-only before binding.
    }
  }
  node.setBoundVariable(field, variable);
  return serializeVariableSummary(variable);
}

function validateCanvas(args) {
  args = args || {};
  const maxIssues = valueOr(args.maxIssues, 80);
  const roots = args.scope === "selection" ? figma.currentPage.selection || [] : figma.currentPage.children || [];
  const issues = [];
  let checked = 0;
  function addIssue(node, type, message) {
    if (issues.length >= maxIssues) return;
    issues.push({
      type,
      message,
      node: summarizeNode(node, 0, true, { count: 0, maxNodes: 1 }),
    });
  }
  function visit(node) {
    if (!node || issues.length >= maxIssues) return;
    checked += 1;
    if ((node.type === "FRAME" || node.type === "GROUP" || node.type === "SECTION") && node.children && node.children.length === 0) {
      addIssue(node, "empty-container", "Container has no children.");
    }
    if (node.type === "TEXT") {
      if (!node.characters || !String(node.characters).trim()) addIssue(node, "empty-text", "Text node is empty.");
      if (node.fontName === figma.mixed) addIssue(node, "mixed-font", "Text node has mixed fonts.");
      if (node.textAutoResize === "NONE" && node.height < node.fontSize * 1.1) addIssue(node, "possible-text-clipping", "Text height may be too small.");
    }
    if (args.requireVariables === true && ("fills" in node) && Array.isArray(node.fills) && node.fills.length) {
      if (!nodeHasBoundPaintVariable(node, "fills")) addIssue(node, "unbound-fill", "Node has fills but no bound fill variable.");
    }
    if (args.requireAutoLayout === true && node.type === "FRAME" && node.children && node.children.length > 1 && node.layoutMode === "NONE") {
      addIssue(node, "missing-auto-layout", "Frame has multiple children but no auto layout.");
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i += 1) visit(node.children[i]);
    }
  }
  for (let i = 0; i < roots.length; i += 1) visit(roots[i]);
  return {
    ok: issues.length === 0,
    checked,
    issueCount: issues.length,
    issues,
    truncated: issues.length >= maxIssues,
  };
}

function inspectNodeAppearance(node) {
  if (!node) throw new Error("inspectNodeAppearance requires a node.");
  const result = {
    id: node.id,
    name: node.name,
    type: node.type,
  };
  if ("fills" in node) result.fills = serializePaintValue(node.fills);
  if ("strokes" in node) result.strokes = serializePaintValue(node.strokes);
  if ("fillStyleId" in node) result.fillStyleId = node.fillStyleId;
  if ("strokeStyleId" in node) result.strokeStyleId = node.strokeStyleId;
  if ("textStyleId" in node) result.textStyleId = node.textStyleId;
  if ("effectStyleId" in node) result.effectStyleId = node.effectStyleId;
  if ("boundVariables" in node) result.boundVariables = serializeBoundVariables(node.boundVariables);
  if (node.type === "TEXT") {
    result.characters = node.characters;
    result.fontSize = node.fontSize;
    result.fontName = node.fontName;
  }
  return result;
}

function serializeRuntimeResult(value, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 8) return "[MaxDepth]";
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;
  if (Array.isArray(value)) {
    const list = [];
    const maxItems = Math.min(value.length, 100);
    for (let i = 0; i < maxItems; i += 1) list.push(serializeRuntimeResult(value[i], depth + 1));
    if (value.length > maxItems) list.push({ truncated: value.length - maxItems });
    return list;
  }
  if (value && value.id && value.type && value.name) {
    return summarizeNode(value, 1, true, { count: 0, maxNodes: 8 });
  }
  if (type === "object") {
    const result = {};
    let count = 0;
    for (const key in value) {
      if (count >= 80) {
        result.truncated = true;
        break;
      }
      const item = value[key];
      if (typeof item !== "function") {
        try {
          result[key] = serializeRuntimeResult(item, depth + 1);
        } catch (error) {
          result[key] = `[Unserializable: ${error.message}]`;
        }
        count += 1;
      }
    }
    return result;
  }
  return String(value);
}

function createRunJsHelpers(theme) {
  return {
    paint,
    color,
    hexToRgb,
    rgbToHex,
    normalizeHex,
    loadFont,
    summarizeNode: function (node, depth) {
      return summarizeNode(node, depth || 1, true, { count: 0, maxNodes: 50 });
    },
    serializePaintValue,
    inspectNodeAppearance,
    findVariable: async function (query, resolvedType) {
      let variable = await findLocalVariable(query, resolvedType);
      if (!variable) variable = await findLibraryVariable(query, resolvedType);
      return variable;
    },
    indexDesignSystem: async function (options) {
      return await indexDesignSystem(options || {});
    },
    cloneReferenceNode: async function (selector, options) {
      return await cloneReferenceNode(selector || {}, options || {});
    },
    importComponentByName: async function (query, options) {
      return await importComponentByName(query, options || {});
    },
    applyTextStyle: async function (node, styleName) {
      return await applyTextStyle(node, styleName);
    },
    applyPaintStyle: async function (node, styleName, field) {
      return await applyPaintStyle(node, styleName, field || "fills");
    },
    bindVariable: async function (node, field, variableName, fallbackValue, resolvedType) {
      if (field === "fills" || field === "fill") return await bindPaintVariable(node, "fills", { variableName }, fallbackValue, theme);
      if (field === "strokes" || field === "stroke") return await bindPaintVariable(node, "strokes", { variableName }, fallbackValue, theme);
      return await bindVariable(node, field, variableName, fallbackValue, resolvedType);
    },
    bindFillVariable: async function (node, variableName, fallbackValue) {
      return await bindPaintVariable(node, "fills", { variableName }, fallbackValue, theme);
    },
    bindStrokeVariable: async function (node, variableName, fallbackValue) {
      return await bindPaintVariable(node, "strokes", { variableName }, fallbackValue, theme);
    },
    ensureTextFontLoaded,
    findNodes: async function (selector) {
      return await findNodesBySelector(selector || {}, theme);
    },
    validateCanvas: function (options) {
      return validateCanvas(options || {});
    },
    getNode: async function (id) {
      return await getNodeById(id);
    },
  };
}

async function runJavaScript(args) {
  args = args || {};
  const source = String(args.code || args.javascript || "");
  if (!source.trim()) throw new Error("figma_run_js requires code.");
  const theme = mergeTheme(args.theme || {});
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const helpers = createRunJsHelpers(theme);
  const fn = new AsyncFunction("figma", "args", "helpers", source);
  // Job-level atomicity via snapshot diff: the figma object is read-only in the plugin
  // sandbox, so we cannot wrap create* calls. Instead, record every node id before the
  // job and remove any node that appears only when the job fails.
  let snapshotIds = null;
  if (args.rollback !== false) {
    try {
      const before = figma.root.findAll(function () { return true; });
      snapshotIds = new Set();
      for (let i = 0; i < before.length; i += 1) snapshotIds.add(before[i].id);
    } catch (_snapshotError) {
      snapshotIds = null;
    }
  }
  try {
    const rawResult = await fn(figma, args.args || {}, helpers);
    return {
      ok: true,
      file: figma.root.name,
      page: {
        id: figma.currentPage.id,
        name: figma.currentPage.name,
      },
      result: serializeRuntimeResult(rawResult, 0),
    };
  } catch (error) {
    let removed = 0;
    if (snapshotIds) {
      try {
        const after = figma.root.findAll(function () { return true; });
        for (let i = after.length - 1; i >= 0; i -= 1) {
          const node = after[i];
          if (!snapshotIds.has(node.id) && typeof node.remove === "function") {
            try {
              node.remove();
              removed += 1;
            } catch (_removeError) {}
          }
        }
      } catch (_cleanupError) {}
    }
    error.message = `${error.message} (rolled back ${removed} created node${removed === 1 ? "" : "s"})`;
    throw error;
  }
}

async function readSelectedNodeBindings() {
  const selection = figma.currentPage.selection || [];
  const result = [];
  for (let i = 0; i < selection.length; i += 1) result.push(serializeNodeBinding(selection[i]));
  return result;
}

async function readDesignSystem(toolName, args) {
  if (toolName === "figma_get_local_styles") {
    return { localStyles: await readLocalStyles() };
  }
  if (toolName === "figma_get_selected_node_bindings") {
    return { selection: await readSelectedNodeBindings() };
  }

  return {
    file: {
      name: figma.root.name,
      currentPage: {
        id: figma.currentPage.id,
        name: figma.currentPage.name,
      },
    },
    localVariables: await readLocalVariables(),
    localStyles: await readLocalStyles(),
    libraryVariables: await readLibraryVariables(!args || args.includeLibraryVariables !== false),
    selection:
      args && args.includeSelectedNodeBindings === false
        ? []
        : await readSelectedNodeBindings(),
  };
}

function setNodeFills(node, value, theme) {
  if (!("fills" in node)) throw new Error(`Node does not support fills: ${node.name}`);
  node.fills = [paint(value, theme || defaultTheme)];
}

function setNodeStrokes(node, value, theme, strokeWeight) {
  if (!("strokes" in node)) throw new Error(`Node does not support strokes: ${node.name}`);
  node.strokes = [paint(value, theme || defaultTheme)];
  if ("strokeWeight" in node && strokeWeight !== undefined) node.strokeWeight = strokeWeight;
}

async function bindPaintVariable(node, field, variableArgs, fallbackValue, theme) {
  if (!figma.variables || !figma.variables.setBoundVariableForPaint) {
    throw new Error("Figma variables paint binding API is unavailable in this runtime.");
  }
  const variable = await resolveVariable(variableArgs, "COLOR");
  const paintValue = fallbackValue || (field === "fills" ? "#000000" : "#000000");
  let paints = [];
  if (field === "fills") {
    if (!("fills" in node)) throw new Error(`Node does not support fills: ${node.name}`);
    paints = Array.isArray(node.fills) && node.fills.length ? node.fills.slice() : [paint(paintValue, theme || defaultTheme)];
    paints[0] = figma.variables.setBoundVariableForPaint(paints[0], "color", variable);
    node.fills = paints;
  } else {
    if (!("strokes" in node)) throw new Error(`Node does not support strokes: ${node.name}`);
    paints = Array.isArray(node.strokes) && node.strokes.length ? node.strokes.slice() : [paint(paintValue, theme || defaultTheme)];
    paints[0] = figma.variables.setBoundVariableForPaint(paints[0], "color", variable);
    node.strokes = paints;
  }
  return serializeVariableSummary(variable);
}

async function createNodeFromOperation(operation, parent, theme) {
  const op = operation.op;
  if (op === "createFrame") {
    const frame = figma.createFrame();
    setSize(frame, operation, operation.width || 300, operation.height || 200);
    setPosition(frame, operation);
    applyVisualFrameProps(frame, {
      name: operation.name || "Frame",
      background: operation.background || operation.fill || "$surface",
      stroke: operation.stroke,
      border: operation.border,
      radius: operation.radius,
      cornerRadius: operation.cornerRadius,
      clipsContent: operation.clipsContent,
    }, theme);
    applyLayout(frame, operation);
    parent.appendChild(frame);
    return frame;
  }
  if (op === "createText") return await createText(mergeObjects(operation, { type: "text" }), parent, theme);
  if (op === "createRectangle") return createRectangle(mergeObjects(operation, { type: "rectangle" }), parent, theme);
  if (op === "createLine") return createLine(mergeObjects(operation, { type: "line" }), parent, theme);
  if (op === "createEllipse") return createEllipse(mergeObjects(operation, { type: "ellipse" }), parent, theme);
  throw new Error(`Unsupported create operation: ${op}`);
}

function getOperationTargetRefs(operation) {
  if (Array.isArray(operation.targets)) return operation.targets;
  if (Array.isArray(operation.targetIds)) return operation.targetIds;
  if (Array.isArray(operation.nodeIds)) return operation.nodeIds;
  if (Array.isArray(operation.ids)) return operation.ids;
  const ref = firstValue([
    operation.target,
    operation.targetId,
    operation.nodeId,
    operation.id,
    operation.ref,
    operation.node,
    operation.targetAlias,
  ], null);
  return ref ? [ref] : [];
}

function operationHasInlineSelector(operation) {
  return !!(operation && operation.selector) || !!firstValue([
    operation.query,
    operation.nameQuery,
    operation.text,
    operation.characters,
    operation.content,
    operation.exactText,
    operation.textRegex,
  ], null);
}

function operationHasVariableRef(operation) {
  return !!firstValue([
    operation.variable,
    operation.variableName,
    operation.variablePath,
    operation.variableKey,
  ], null);
}

function cloneOperationForTarget(operation, target) {
  const cloned = {};
  for (const key in operation) {
    if (
      key !== "targets" &&
      key !== "targetIds" &&
      key !== "nodeIds" &&
      key !== "ids"
    ) {
      cloned[key] = operation[key];
    }
  }
  cloned.target = target;
  return cloned;
}

async function applyTextStyleFields(node, operation, theme) {
  if (node.type !== "TEXT") throw new Error(`${operation.op} target must be TEXT`);
  if (
    operation.font ||
    operation.fontFamily ||
    operation.fontStyle ||
    operation.fontWeight ||
    operation.fontToken
  ) {
    node.fontName = await loadFont(fontFromItem(operation, theme));
  } else {
    await ensureTextFontLoaded(node, fontFromItem(operation, theme));
  }
  if (operation.fontSize !== undefined || operation.size !== undefined) {
    node.fontSize = operation.fontSize !== undefined ? operation.fontSize : operation.size;
  }
  if (operation.lineHeight !== undefined) {
    node.lineHeight = { unit: "PIXELS", value: operation.lineHeight };
  }
  if (operation.letterSpacing !== undefined) {
    node.letterSpacing = { unit: "PIXELS", value: operation.letterSpacing };
  }
  if (operation.align) node.textAlignHorizontal = String(operation.align).toUpperCase();
  if (operation.color || operation.fill) node.fills = [paint(operation.color || operation.fill, theme)];
}

async function applyOneOperation(operation, theme) {
  const op = operation.op;
  if (!op) throw new Error("Operation is missing op");

  if (op.indexOf("create") === 0) {
    const parent = await resolveParent(operation.parent);
    const node = await createNodeFromOperation(operation, parent, theme);
    rememberNode(node, operation.as || operation.alias);
    return { op, id: node.id, alias: operation.as || operation.alias || nodeAliases[node.id], node: summarizeNode(node, 1, true, { count: 0, maxNodes: 1 }) };
  }

  if (op === "group") {
    const refs = getOperationTargetRefs(operation);
    const nodes = [];
    for (let i = 0; i < refs.length; i += 1) nodes.push(await requireNode(refs[i], "target"));
    const parent = await resolveParent(operation.parent);
    const group = figma.group(nodes, parent);
    if (operation.name) group.name = operation.name;
    rememberNode(group, operation.as || operation.alias);
    return { op, id: group.id, alias: operation.as || operation.alias || nodeAliases[group.id] };
  }

  const refs = getOperationTargetRefs(operation);
  if (!refs.length && operationHasInlineSelector(operation)) {
    const selector = getSelector(operation);
    const matches = await findNodesBySelector(selector, theme);
    if (!matches.length) {
      throw new Error(
        `${op} selector matched 0 nodes on current page "${figma.currentPage.name}". Use selector.scope/type/nameQuery/text/currentFill/fontSize or select the intended nodes first.`,
      );
    }
    const results = [];
    for (let j = 0; j < matches.length; j += 1) {
      results.push(await applyOneOperation(cloneOperationForTarget(operation, matches[j].id), theme));
    }
    return {
      op,
      matched: matches.length,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      results,
    };
  }
  if (refs.length > 1 && op !== "select") {
    const results = [];
    for (let i = 0; i < refs.length; i += 1) {
      results.push(await applyOneOperation(cloneOperationForTarget(operation, refs[i]), theme));
    }
    return { op, results };
  }
  if (!refs.length) {
    throw new Error(
      `${op} requires a target. Use target, nodeId, id, ref, or targets/nodeIds/ids for batch edits.`,
    );
  }

  const node = await requireNode(refs[0], "target");
  if (op === "setFill") {
    if (operationHasVariableRef(operation)) {
      const variable = await bindPaintVariable(node, "fills", operation, operation.fill || operation.color || operation.value, theme);
      rememberNode(node, operation.as || operation.alias);
      return { op, id: node.id, variable, alias: operation.as || operation.alias || nodeAliases[node.id], node: summarizeNode(node, 1, true, { count: 0, maxNodes: 1 }) };
    }
    setNodeFills(node, operation.fill || operation.color || operation.value, theme);
  }
  else if (op === "setStroke") {
    if (operationHasVariableRef(operation)) {
      const variable = await bindPaintVariable(node, "strokes", operation, operation.stroke || operation.color || operation.value, theme);
      rememberNode(node, operation.as || operation.alias);
      return { op, id: node.id, variable, alias: operation.as || operation.alias || nodeAliases[node.id], node: summarizeNode(node, 1, true, { count: 0, maxNodes: 1 }) };
    }
    setNodeStrokes(node, operation.stroke || operation.color || operation.value, theme, operation.strokeWeight);
  }
  else if (op === "bindFillVariable" || op === "setFillVariable") {
    const variable = await bindPaintVariable(node, "fills", operation, operation.fill || operation.color || operation.value, theme);
    rememberNode(node, operation.as || operation.alias);
    return { op, id: node.id, variable, alias: operation.as || operation.alias || nodeAliases[node.id], node: summarizeNode(node, 1, true, { count: 0, maxNodes: 1 }) };
  } else if (op === "bindStrokeVariable" || op === "setStrokeVariable") {
    const variable = await bindPaintVariable(node, "strokes", operation, operation.stroke || operation.color || operation.value, theme);
    rememberNode(node, operation.as || operation.alias);
    return { op, id: node.id, variable, alias: operation.as || operation.alias || nodeAliases[node.id], node: summarizeNode(node, 1, true, { count: 0, maxNodes: 1 }) };
  }
  else if (op === "setText" || op === "updateText") {
    if (node.type !== "TEXT") throw new Error("setText target must be TEXT");
    await ensureTextFontLoaded(node, fontFromItem(operation, theme));
    const nextText = firstValue([operation.text, operation.characters, operation.content, operation.value], null);
    if (nextText !== null) node.characters = String(nextText);
    await applyTextStyleFields(node, operation, theme);
  } else if (op === "setTextStyle" || op === "setFontSize") {
    await applyTextStyleFields(node, operation, theme);
  } else if (op === "setAutoLayout") {
    applyLayout(node, {
      layout: operation.direction || operation.layout || operation.layoutMode,
      gap: operation.gap,
      itemSpacing: operation.itemSpacing,
      padding: operation.padding,
      primaryAxisAlign: operation.primaryAxisAlign,
      counterAxisAlign: operation.counterAxisAlign,
      primaryAxisSizing: operation.primaryAxisSizing,
      counterAxisSizing: operation.counterAxisSizing,
    });
  } else if (op === "move") {
    if (operation.x !== undefined) node.x = operation.x;
    if (operation.y !== undefined) node.y = operation.y;
    if (operation.dx !== undefined) node.x += operation.dx;
    if (operation.dy !== undefined) node.y += operation.dy;
  } else if (op === "resize") {
    node.resize(operation.width || node.width, operation.height || node.height);
  } else if (op === "rename") {
    node.name = operation.name || node.name;
  } else if (op === "appendChild") {
    const parent = await resolveParent(operation.parent);
    parent.appendChild(node);
  } else if (op === "bringToFront") {
    node.bringToFront();
  } else if (op === "sendToBack") {
    node.sendToBack();
  } else if (op === "delete") {
    node.remove();
    return { op, id: refs[0], removed: true };
  } else if (op === "select") {
    const nodes = [];
    for (let i = 0; i < refs.length; i += 1) nodes.push(await requireNode(refs[i], "target"));
    figma.currentPage.selection = nodes;
    refreshSelectionAliases();
    return { op, selection: nodes.map((item) => item.id), aliases: nodeAliases };
  } else if (op === "scrollIntoView") {
    figma.viewport.scrollAndZoomIntoView([node]);
  } else {
    throw new Error(`Unsupported operation: ${op}`);
  }

  rememberNode(node, operation.as || operation.alias);
  return { op, id: node.id, alias: operation.as || operation.alias || nodeAliases[node.id], node: summarizeNode(node, 1, true, { count: 0, maxNodes: 1 }) };
}

async function applyOperations(args) {
  const theme = mergeTheme(args.theme || {});
  const operations = args.operations || [];
  const results = [];
  refreshSelectionAliases();
  for (let i = 0; i < operations.length; i += 1) {
    results.push(await applyOneOperation(operations[i], theme));
  }
  const createdOrTouched = [];
  for (let i = 0; i < results.length; i += 1) {
    if (results[i].id) {
      const node = await getNodeById(results[i].id);
      if (node && createdOrTouched.indexOf(node) < 0) createdOrTouched.push(node);
    }
  }
  if (createdOrTouched.length) figma.currentPage.selection = createdOrTouched;
  return { results, aliases: nodeAliases };
}

async function runToolCall(toolName, args) {
  if (toolName === "figma_get_design_tokens" || toolName === "figma_get_local_styles" || toolName === "figma_get_selected_node_bindings") {
    return await readDesignSystem(toolName, args || {});
  }
  if (toolName === "figma_list_library_components") return await listLibraryComponents(args || {});
  if (toolName === "figma_import_component_instance") return await importComponentInstance(args || {});
  if (toolName === "figma_inspect_page") return serializePage(args || {});
  if (toolName === "figma_inspect_selection") return serializeSelection(args || {});
  if (toolName === "figma_find_nodes") return await findNodes(args || {});
  if (toolName === "figma_apply_operations") return await applyOperations(args || {});
  if (toolName === "figma_run_js") return await runJavaScript(args || {});
  throw new Error(`Unsupported tool call: ${toolName}`);
}

async function renderSpec(spec) {
  const theme = mergeTheme(spec.theme || {});
  const placementState = createPlacementState(spec);
  const created = [];
  for (const frameSpec of spec.frames || []) {
    const frame = figma.createFrame();
    frame.name = frameSpec.name || "Generated Frame";
    frame.resize(frameSpec.width || 1440, frameSpec.height || 900);
    placeFrame(frame, frameSpec, placementState);
    const visualFrameSpec = mergeObjects(frameSpec, {
      background: frameSpec.background || "$canvas",
    });
    applyVisualFrameProps(frame, visualFrameSpec, theme);
    applyLayout(frame, frameSpec);
    figma.currentPage.appendChild(frame);
    for (const child of frameSpec.children || []) await createNode(child, frame, theme);
    created.push(frame);
  }
  if (created.length) {
    for (const node of created) bringTextToFront(node);
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
  }
  return created.length;
}

let allPagesLoaded = false;

figma.ui.onmessage = async (message) => {
  try {
    if (message.type === "tool-call" || message.type === "read-design-system") {
      if (!allPagesLoaded && figma.loadAllPagesAsync) {
        await figma.loadAllPagesAsync();
        allPagesLoaded = true;
      }
      const data = await runToolCall(message.toolName, message.args || {});
      figma.ui.postMessage({
        id: message.id,
        ok: true,
        message: `Completed ${message.toolName}.`,
        data,
      });
      return;
    }

    if (message.type !== "render-spec") return;
    const count = await renderSpec(message.spec || {});
    figma.ui.postMessage({
      id: message.id,
      ok: true,
      message: `Rendered ${count} frame(s) into Figma.`,
    });
  } catch (error) {
    figma.ui.postMessage({
      id: message.id,
      ok: false,
      message: error.message,
      stack: error.stack,
    });
  }
};
