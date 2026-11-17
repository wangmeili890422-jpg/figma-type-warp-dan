const UI_WIDTH = 1160;
const UI_HEIGHT = 800;
const OUTPUT_KEY = "font-warp-output-v5";
const SOURCE_KEY = "font-warp-source-v5";
const OUTPUT_GAP = 24;

let activeSourceId = null;
let lastSourceId = null;
let lastOutputId = null;
let outlineCache = null;
let outlineRequestSerial = 0;
let outlineRequestRunning = false;
let exportRunning = false;
let suppressSelectionSync = false;

figma.showUI(__html__, { width: UI_WIDTH, height: UI_HEIGHT, themeColors: true });
figma.root.setRelaunchData({ open: "Open" });

function send(type, payload) {
  figma.ui.postMessage({ type: type, payload: payload });
}

function safeRemove(node) {
  try {
    if (node && !node.removed) node.remove();
  } catch (error) {
    // Cleanup must never hide the original error.
  }
}

function getNode(id) {
  if (!id) return null;
  try {
    const node = figma.getNodeById(id);
    return node && !node.removed ? node : null;
  } catch (error) {
    return null;
  }
}

function isInsideInstance(node) {
  let current = node && node.parent;
  while (current) {
    if (current.type === "INSTANCE") return true;
    current = current.parent;
  }
  return false;
}

function isSupportedText(node) {
  return Boolean(
    node &&
    !node.removed &&
    node.type === "TEXT" &&
    node.parent &&
    "children" in node.parent &&
    !isInsideInstance(node)
  );
}

function setAbsoluteInAutoLayout(node, parent) {
  if (!node || !parent || parent.type !== "FRAME" || parent.layoutMode === "NONE") return;
  try {
    if ("layoutPositioning" in node) node.layoutPositioning = "ABSOLUTE";
  } catch (error) {
    // Some Figma containers expose layoutMode but reject this child property.
  }
}

function textSelectionResult(node) {
  if (!node) return { valid: false, message: "请先选择一个文字图层" };
  if (node.type !== "TEXT") return { valid: false, message: "当前选择不是文字图层，请选择文字" };
  if (!node.parent || !("children" in node.parent) || isInsideInstance(node)) {
    return { valid: false, message: "实例内部暂不支持，请先复制到普通画布" };
  }
  return { valid: true, node: node, id: node.id, message: "已选中：" + node.name };
}

function selectedSourceResult() {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) return { valid: false, message: "请先选择一个文字图层" };

  const selected = selection[0];
  if (selected.type === "VECTOR") {
    const sourceId = selected.getPluginData(SOURCE_KEY);
    const source = getNode(sourceId);
    if (source && source.type === "TEXT") {
      return {
        valid: true,
        node: source,
        output: selected,
        id: source.id,
        message: "已生成矢量，原文字仍可编辑"
      };
    }
  }
  return textSelectionResult(selected);
}

function paintForPreview(paint) {
  if (!paint || paint.type !== "SOLID") return null;
  return {
    type: "SOLID",
    color: { r: paint.color.r, g: paint.color.g, b: paint.color.b },
    opacity: paint.opacity === undefined ? 1 : paint.opacity,
    visible: paint.visible !== false
  };
}

function serializeNetwork(network) {
  return {
    vertices: (network.vertices || []).map(function (vertex) {
      const result = { x: vertex.x, y: vertex.y };
      if (vertex.cornerRadius !== undefined) result.cornerRadius = vertex.cornerRadius;
      if (vertex.strokeCap !== undefined) result.strokeCap = vertex.strokeCap;
      if (vertex.strokeJoin !== undefined) result.strokeJoin = vertex.strokeJoin;
      if (vertex.handleMirroring !== undefined) result.handleMirroring = vertex.handleMirroring;
      return result;
    }),
    segments: (network.segments || []).map(function (segment) {
      const result = { start: segment.start, end: segment.end };
      if (segment.tangentStart) result.tangentStart = { x: segment.tangentStart.x, y: segment.tangentStart.y };
      if (segment.tangentEnd) result.tangentEnd = { x: segment.tangentEnd.x, y: segment.tangentEnd.y };
      return result;
    }),
    regions: (network.regions || []).map(function (region) {
      return {
        windingRule: region.windingRule || "NONZERO",
        loops: (region.loops || []).map(function (loop) { return Array.from(loop); }),
        fills: (region.fills || []).map(paintForPreview).filter(Boolean)
      };
    })
  };
}

function networkBounds(network) {
  const points = [];
  (network.vertices || []).forEach(function (vertex) {
    points.push({ x: vertex.x, y: vertex.y });
  });
  (network.segments || []).forEach(function (segment) {
    const start = network.vertices[segment.start];
    const end = network.vertices[segment.end];
    if (start && segment.tangentStart) points.push({ x: start.x + segment.tangentStart.x, y: start.y + segment.tangentStart.y });
    if (end && segment.tangentEnd) points.push({ x: end.x + segment.tangentEnd.x, y: end.y + segment.tangentEnd.y });
  });
  if (!points.length) throw new Error("未找到可变形的矢量轮廓");
  return points.reduce(function (box, point) {
    return {
      minX: Math.min(box.minX, point.x),
      minY: Math.min(box.minY, point.y),
      maxX: Math.max(box.maxX, point.x),
      maxY: Math.max(box.maxY, point.y)
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function normalizeSettings(raw) {
  const input = raw || {};
  const manual = Array.isArray(input.manual) && input.manual.length === 4
    ? input.manual.map(function (point) {
      return {
        x: clamp(Number(point && point.x) || 0, -2, 2),
        y: clamp(Number(point && point.y) || 0, -2, 2)
      };
    })
    : [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  const custom = Array.isArray(input.custom) && input.custom.length === 5
    ? input.custom.map(function (value) { return clamp(Number(value) || 0, -1, 1); })
    : [0, 0, 0, 0, 0];
  return {
    effect: typeof input.effect === "string" ? input.effect : "none",
    strength: clamp(Number(input.strength) || 0, 0, 100),
    smooth: input.smooth !== false,
    custom: custom,
    manual: manual,
    strokeWidth: clamp(Number(input.strokeWidth) || 0, 0, 20),
    strokeColor: typeof input.strokeColor === "string" ? input.strokeColor : "#111111",
    hideOriginal: input.hideOriginal === true
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothProfile(x, values, smooth) {
  const count = values.length;
  const scaled = clamp(x, 0, 1) * (count - 1);
  const index = Math.min(count - 2, Math.floor(scaled));
  const t = scaled - index;
  const p1 = values[index];
  const p2 = values[index + 1];
  if (!smooth) return p1 + (p2 - p1) * t;
  const p0 = values[Math.max(0, index - 1)];
  const p3 = values[Math.min(count - 1, index + 2)];
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function makeMapper(settings, bounds) {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const strength = settings.strength / 100;
  const amplitude = Math.max(8, height * 0.55) * strength;
  const corners = settings.manual;

  return function (point) {
    const u = clamp((point.x - bounds.minX) / width, 0, 1);
    const v = clamp((point.y - bounds.minY) / height, 0, 1);
    let x = point.x;
    let y = point.y;
    const sin = Math.sin(Math.PI * u);
    switch (settings.effect) {
      case "arch-up": y -= sin * amplitude; break;
      case "arch-down": y += sin * amplitude; break;
      case "bulge": y += sin * (v - 0.5) * amplitude * 1.5; break;
      case "pinch": y -= sin * (v - 0.5) * amplitude * 1.5; break;
      case "wave": y += Math.sin(Math.PI * 2 * u) * amplitude * 0.72; break;
      case "flag": y += ((u - 0.5) * 1.1 + sin * 0.28) * amplitude; break;
      case "slant": y += (u - 0.5) * amplitude * 1.25; break;
      case "perspective": x += (v - 0.5) * width * strength * 0.38; break;
      case "custom": y -= smoothProfile(u, settings.custom, settings.smooth) * amplitude; break;
      case "none":
      default: break;
    }

    const mappedU = clamp((x - bounds.minX) / width, 0, 1);
    const mappedV = clamp((y - bounds.minY) / height, 0, 1);
    const dx = (1 - mappedU) * (1 - mappedV) * corners[0].x +
      mappedU * (1 - mappedV) * corners[1].x +
      mappedU * mappedV * corners[2].x +
      (1 - mappedU) * mappedV * corners[3].x;
    const dy = (1 - mappedU) * (1 - mappedV) * corners[0].y +
      mappedU * (1 - mappedV) * corners[1].y +
      mappedU * mappedV * corners[2].y +
      (1 - mappedU) * mappedV * corners[3].y;
    return { x: x + dx * width, y: y + dy * height };
  };
}

function warpNetwork(network, rawSettings) {
  if (!network || !network.vertices || !network.vertices.length) {
    throw new Error("未找到可变形的矢量轮廓");
  }
  const settings = normalizeSettings(rawSettings);
  const bounds = networkBounds(network);
  const mapPoint = makeMapper(settings, bounds);
  const vertices = network.vertices.map(function (vertex) {
    const point = mapPoint(vertex);
    return Object.assign({}, vertex, { x: point.x, y: point.y });
  });
  const segments = (network.segments || []).map(function (segment) {
    const result = Object.assign({}, segment);
    const start = network.vertices[segment.start];
    const end = network.vertices[segment.end];
    if (segment.tangentStart && start) {
      const a = mapPoint(start);
      const b = mapPoint({ x: start.x + segment.tangentStart.x, y: start.y + segment.tangentStart.y });
      result.tangentStart = { x: b.x - a.x, y: b.y - a.y };
    }
    if (segment.tangentEnd && end) {
      const a = mapPoint(end);
      const b = mapPoint({ x: end.x + segment.tangentEnd.x, y: end.y + segment.tangentEnd.y });
      result.tangentEnd = { x: b.x - a.x, y: b.y - a.y };
    }
    return result;
  });

  const extents = [];
  vertices.forEach(function (vertex) { extents.push({ x: vertex.x, y: vertex.y }); });
  segments.forEach(function (segment) {
    const start = vertices[segment.start];
    const end = vertices[segment.end];
    if (start && segment.tangentStart) extents.push({ x: start.x + segment.tangentStart.x, y: start.y + segment.tangentStart.y });
    if (end && segment.tangentEnd) extents.push({ x: end.x + segment.tangentEnd.x, y: end.y + segment.tangentEnd.y });
  });
  const finalBounds = extents.reduce(function (box, point) {
    return {
      minX: Math.min(box.minX, point.x),
      minY: Math.min(box.minY, point.y),
      maxX: Math.max(box.maxX, point.x),
      maxY: Math.max(box.maxY, point.y)
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

  return {
    network: {
      vertices: vertices.map(function (vertex) {
        return Object.assign({}, vertex, { x: vertex.x - finalBounds.minX, y: vertex.y - finalBounds.minY });
      }),
      segments: segments,
      regions: network.regions || []
    },
    offsetX: finalBounds.minX,
    offsetY: finalBounds.minY
  };
}

function colorFromHex(hex) {
  const value = String(hex || "#111111").replace("#", "");
  const normalized = value.length === 3 ? value.split("").map(function (part) { return part + part; }).join("") : value;
  const number = parseInt(normalized, 16);
  if (!Number.isFinite(number)) return { r: 0.07, g: 0.07, b: 0.07 };
  return { r: ((number >> 16) & 255) / 255, g: ((number >> 8) & 255) / 255, b: (number & 255) / 255 };
}

function effectLabel(effect) {
  const labels = {
    none: "原始",
    "arch-up": "上拱",
    "arch-down": "下弧",
    bulge: "外鼓",
    pinch: "内收",
    wave: "波浪",
    flag: "飘旗",
    slant: "斜切",
    perspective: "透视",
    custom: "自定义曲线"
  };
  return labels[effect] || "变形";
}

function extractOutline(source, requestId) {
  if (outlineRequestRunning || !isSupportedText(source)) return;
  const parent = source.parent;
  const sourceIndex = parent.children.indexOf(source);
  const originalSelection = Array.from(figma.currentPage.selection);
  let clone = null;
  let vector = null;
  outlineRequestRunning = true;
  suppressSelectionSync = true;

  try {
    clone = source.clone();
    clone.visible = true;
    if ("locked" in clone) clone.locked = false;
    setAbsoluteInAutoLayout(clone, parent);
    vector = figma.flatten([clone], parent, sourceIndex + 1);
    vector.visible = false;
    const network = serializeNetwork(vector.vectorNetwork);
    if (!network.vertices.length || !network.regions.length) {
      throw new Error("无法读取文字轮廓，请尝试复制文字后再使用");
    }
    const fills = (Array.isArray(vector.fills) ? vector.fills : []).map(paintForPreview).filter(Boolean);
    outlineCache = { sourceId: source.id, name: source.name, network: network, fills: fills };
    if (requestId === outlineRequestSerial && activeSourceId === source.id) {
      send("outline", { sourceId: source.id, name: source.name, network: network, fills: fills });
      sendPreview({ sourceId: source.id, revision: 0, settings: { effect: "none", strength: 0, smooth: true, custom: [0, 0, 0, 0, 0], manual: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] } });
    }
  } catch (error) {
    outlineCache = null;
    if (requestId === outlineRequestSerial) {
      send("outline-error", { sourceId: source && source.id, message: error && error.message ? error.message : "无法读取文字轮廓" });
    }
  } finally {
    safeRemove(vector);
    safeRemove(clone);
    try { figma.currentPage.selection = originalSelection; } catch (error) {}
    suppressSelectionSync = false;
    outlineRequestRunning = false;
  }
}

function requestOutline(source) {
  outlineRequestSerial += 1;
  extractOutline(source, outlineRequestSerial);
}

function sendPreview(request) {
  const sourceId = request && request.sourceId;
  if (!outlineCache || outlineCache.sourceId !== sourceId || !activeSourceId || activeSourceId !== sourceId) return;
  try {
    const warped = warpNetwork(outlineCache.network, request.settings || {});
    send("preview", { sourceId: sourceId, revision: request.revision || 0, name: outlineCache.name, fills: outlineCache.fills, network: warped.network });
  } catch (error) {
    send("status", { kind: "error", message: error && error.message ? error.message : "预览失败，请重新选择文字" });
  }
}

function publishSelection(result, output) {
  if (!result || !result.valid) {
    send("selection", { valid: false, message: result && result.message ? result.message : "请先选择一个文字图层" });
    return;
  }
  send("selection", { valid: true, id: result.id, outputId: output && !output.removed ? output.id : null, message: result.message });
}

function syncSelection(forceOutline) {
  const result = selectedSourceResult();
  if (!result.valid) {
    activeSourceId = null;
    outlineCache = null;
    publishSelection(result);
    return;
  }

  const changed = activeSourceId !== result.node.id;
  activeSourceId = result.node.id;
  lastSourceId = result.node.id;
  if (result.output) lastOutputId = result.output.id;
  publishSelection(result, result.output);
  if (changed || forceOutline || !outlineCache || outlineCache.sourceId !== result.node.id) {
    requestOutline(result.node);
  }
}

function resolveOperationSource() {
  // The canvas selection is the source of truth at the moment the user
  // clicks Export. Cached IDs are only fallbacks for an output-node selection
  // or for a transient Figma selection event.
  const selected = selectedSourceResult();
  if (selected.valid && isSupportedText(selected.node)) return selected.node;
  return getNode(activeSourceId) || getNode(lastSourceId);
}

async function createVector(source, rawSettings) {
  if (!isSupportedText(source)) throw new Error("请先选择一个有效的文字图层");
  const settings = normalizeSettings(rawSettings);
  const parent = source.parent;
  const sourceIndex = parent.children.indexOf(source);
  const originalSelection = Array.from(figma.currentPage.selection);
  let clone = null;
  let vector = null;
  let selectionGuarded = false;

  try {
    suppressSelectionSync = true;
    selectionGuarded = true;
    clone = source.clone();
    clone.visible = true;
    if ("locked" in clone) clone.locked = false;
    setAbsoluteInAutoLayout(clone, parent);
    // Keep the result in the source's parent. Reparenting to PAGE is the
    // source of the old intermittent failures in frames and auto-layout.
    vector = figma.flatten([clone], parent, sourceIndex + 1);
    setAbsoluteInAutoLayout(vector, parent);
    vector.visible = true;
    if ("locked" in vector) vector.locked = false;
    // flatten may replace the document selection with the temporary vector.
    // Restore the user's source selection before any asynchronous work starts.
    try { figma.currentPage.selection = originalSelection; } catch (error) {}
    suppressSelectionSync = false;
    selectionGuarded = false;

    const warped = warpNetwork(vector.vectorNetwork, settings);
    await vector.setVectorNetworkAsync(warped.network);
    // The warped network is normalized to its own top-left. Place the
    // independent result beside the source using the parent's coordinates.
    vector.x = source.x + source.width + OUTPUT_GAP;
    vector.y = source.y;
    vector.name = source.name + " · " + effectLabel(settings.effect) + "（矢量）";
    vector.setPluginData(OUTPUT_KEY, "1");
    vector.setPluginData(SOURCE_KEY, source.id);
    if (settings.strokeWidth > 0) {
      vector.strokes = [{ type: "SOLID", color: colorFromHex(settings.strokeColor), opacity: 1, visible: true, blendMode: "NORMAL" }];
      vector.strokeWeight = settings.strokeWidth;
    }
    return vector;
  } catch (error) {
    safeRemove(vector);
    safeRemove(clone);
    if (selectionGuarded) {
      try { figma.currentPage.selection = originalSelection; } catch (restoreError) {}
      suppressSelectionSync = false;
    }
    throw error;
  }
}

async function applyEffect(rawSettings) {
  if (exportRunning) throw new Error("正在导出，请稍等片刻");
  const source = resolveOperationSource();
  if (!isSupportedText(source)) throw new Error("请重新选择原始文字后再导出");
  activeSourceId = source.id;
  lastSourceId = source.id;
  const settings = normalizeSettings(rawSettings);
  exportRunning = true;
  let result = null;

  try {
    result = await createVector(source, settings);
    lastSourceId = source.id;
    lastOutputId = result.id;
    if (settings.hideOriginal) source.visible = false;
    figma.currentPage.selection = [result];
    try { figma.viewport.scrollAndZoomIntoView([source, result]); } catch (error) {}
    send("status", { kind: "success", sourceId: source.id, outputId: result.id, message: settings.hideOriginal ? "矢量字已生成，原文字已隐藏" : "矢量字已生成，原文字保持可见" });
  } catch (error) {
    safeRemove(result);
    throw error;
  } finally {
    exportRunning = false;
  }
}

function restoreOriginal() {
  const source = resolveOperationSource();
  if (!isSupportedText(source)) throw new Error("请先选择原始文字图层");
  source.visible = true;
  activeSourceId = source.id;
  lastSourceId = source.id;
  figma.currentPage.selection = [source];
  try { figma.viewport.scrollAndZoomIntoView([source]); } catch (error) {}
  send("status", { kind: "success", message: "已恢复原始字体，生成的矢量仍保留在旁边，可继续编辑" });
  publishSelection({ valid: true, id: source.id, node: source, message: "已恢复原始文字：" + source.name });
}

figma.ui.onmessage = async function (message) {
  try {
    if (!message || !message.type) return;
    if (message.type === "ready") {
      syncSelection(true);
      return;
    }
    if (message.type === "request-outline") {
      syncSelection(true);
      return;
    }
    if (message.type === "preview-settings") {
      sendPreview(message);
      return;
    }
    if (message.type === "apply") {
      await applyEffect(message.settings || {});
      return;
    }
    if (message.type === "restore-original") {
      restoreOriginal();
      return;
    }
    if (message.type === "resize") {
      figma.ui.resize(UI_WIDTH, clamp(Math.round(Number(message.height) || UI_HEIGHT), 620, 1000));
    }
  } catch (error) {
    send("status", { kind: "error", message: error && error.message ? error.message : "操作失败，请重新选择文字" });
  }
};

figma.on("selectionchange", function () {
  if (suppressSelectionSync) return;
  syncSelection(false);
});

syncSelection(true);
