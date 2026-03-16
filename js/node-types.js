/**
 * Node Type Registration - Creates LiteGraph node types from the module registry.
 * Each Logos module method becomes a distinct node type.
 * Includes execution status visualization and inline result preview.
 */

const NODE_SLOT_COLORS = {
  string: "#8BC34A",
  number: "#FF9800",
  boolean: "#E91E63",
  bytes: "#9E9E9E",
  object: "#607D8B",
  "*": "#FFFFFF",
};

// Execution status colors
const STATUS_COLORS = {
  running: { border: "#FF9800", glow: "rgba(255, 152, 0, 0.4)", icon: "\u25B6" },
  success: { border: "#4CAF50", glow: "rgba(76, 175, 80, 0.3)", icon: "\u2714" },
  error:   { border: "#f44336", glow: "rgba(244, 67, 54, 0.4)", icon: "\u2718" },
};

function getSlotColor(typeName) {
  if (NODE_SLOT_COLORS[typeName]) return NODE_SLOT_COLORS[typeName];
  if (window.moduleRegistry) return window.moduleRegistry.getTypeColor(typeName);
  return "#AAAAAA";
}

/**
 * Register all module method nodes from the registry.
 */
function registerModuleNodes(registry) {
  for (const mod of registry.getModules()) {
    for (const method of mod.methods) {
      registerMethodNode(mod, method);
    }
  }
  for (const util of registry.utilityNodes) {
    registerUtilityNode(util);
  }
}

/**
 * Create a LiteGraph node type for a module method.
 * Registered as "ModuleDisplayName/methodName"
 */
function registerMethodNode(mod, method) {
  const path = `${mod.displayName}/${method.name}`;

  function MethodNode() {
    // Store metadata
    this.moduleName = mod.name;
    this.moduleDisplayName = mod.displayName;
    this.methodName = method.name;
    this.methodDescription = method.description;

    // Add inputs
    for (const input of method.inputs) {
      this.addInput(input.name, input.type);
    }
    // Add outputs
    for (const output of method.outputs) {
      this.addOutput(output.name, output.type);
    }

    this.properties = {
      module: mod.name,
      method: method.name,
    };

    // Size to fit content
    const slotCount = Math.max(method.inputs.length, method.outputs.length, 1);
    this.size = [220, 30 + slotCount * 26];
  }

  MethodNode.title = `${mod.displayName}.${method.name}`;
  MethodNode.desc = method.description;

  // Node appearance
  MethodNode.prototype.color = darkenColor(mod.color, 0.3);
  MethodNode.prototype.bgcolor = darkenColor(mod.color, 0.6);

  MethodNode.prototype.onExecute = function () {
    for (let i = 0; i < method.outputs.length; i++) {
      const inputData = this.getInputData(0);
      this.setOutputData(i, inputData || `[${method.outputs[i].type}]`);
    }
  };

  MethodNode.prototype.getExtraMenuOptions = function () {
    const opts = [
      {
        content: "View Module Info",
        callback: () => {
          showModuleInfo(mod);
        },
      },
      {
        content: `API: logos.${mod.displayName.toLowerCase()}.${method.name}()`,
        disabled: true,
      },
    ];
    // Show result in info panel if available
    if (this._executionResult) {
      opts.unshift({
        content: "View Execution Result",
        callback: () => {
          showNodeResult(this);
        },
      });
    }
    return opts;
  };

  MethodNode.prototype.onDrawForeground = function (ctx) {
    // Draw module badge
    ctx.fillStyle = mod.color;
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.fillText(mod.displayName.toLowerCase(), this.size[0] - 8, -6);

    // Draw LIVE/MOCK indicator when bridge is connected
    const bridge = window.bridgeClient;
    if (bridge && bridge.connected) {
      const isLive = bridge.isModuleLive(this.moduleName);
      ctx.font = "bold 7px monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = isLive ? "#4CAF50" : "#555577";
      ctx.fillText(isLive ? "LIVE" : "MOCK", 8, -6);
    }

    // Draw execution status
    drawExecutionOverlay(ctx, this);
  };

  MethodNode.prototype.onDrawBackground = function (ctx) {
    drawStatusBorder(ctx, this);
  };

  // Register slot colors
  MethodNode.prototype.getSlotColor = function (slot) {
    return getSlotColor(slot.type);
  };

  LiteGraph.registerNodeType(path, MethodNode);
}

/**
 * Register utility nodes (constants, transforms, display).
 */
function registerUtilityNode(util) {
  const path = `${util.category}/${util.name}`;

  function UtilNode() {
    for (const input of util.inputs || []) {
      this.addInput(input.name, input.type);
    }
    for (const output of util.outputs || []) {
      this.addOutput(output.name, output.type);
    }

    // Add editable properties
    for (const prop of util.properties || []) {
      this.addProperty(prop.name, prop.default, prop.type);
      if (prop.type === "string") {
        this.addWidget("text", prop.name, prop.default, (v) => {
          this.properties[prop.name] = v;
        });
      } else if (prop.type === "number") {
        this.addWidget("number", prop.name, prop.default, (v) => {
          this.properties[prop.name] = v;
        });
      } else if (prop.type === "boolean") {
        this.addWidget("toggle", prop.name, prop.default, (v) => {
          this.properties[prop.name] = v;
        });
      }
    }

    const slotCount = Math.max(
      (util.inputs || []).length,
      (util.outputs || []).length,
      1
    );
    const widgetCount = (util.properties || []).length;
    this.size = [200, 30 + slotCount * 26 + widgetCount * 26];
  }

  UtilNode.title = util.displayName;
  UtilNode.desc = util.description;
  UtilNode.prototype.color = "#37474F";
  UtilNode.prototype.bgcolor = "#263238";

  UtilNode.prototype.onExecute = function () {
    if (util.name === "StringConstant") {
      this.setOutputData(0, this.properties.value || "");
    } else if (util.name === "NumberConstant") {
      this.setOutputData(0, this.properties.value || 0);
    } else if (util.name === "BooleanConstant") {
      this.setOutputData(0, this.properties.value || false);
    } else if (util.name === "JsonParse") {
      try {
        this.setOutputData(0, JSON.parse(this.getInputData(0) || "{}"));
      } catch {
        this.setOutputData(0, null);
      }
    } else if (util.name === "JsonStringify") {
      this.setOutputData(0, JSON.stringify(this.getInputData(0) || {}));
    } else if (util.name === "Display") {
      const val = this.getInputData(0);
      this.title = `Display: ${truncate(String(val), 20)}`;
    } else if (util.name === "StringTemplate") {
      const template = this.properties.template || "";
      const vars = this.getInputData(0) || {};
      const result = template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
      this.setOutputData(0, result);
    }
  };

  LiteGraph.registerNodeType(path, UtilNode);
}

// ── Execution Visualization ──────────────────────────────────────────────

/**
 * Draw a glowing border around the node based on execution status.
 */
function drawStatusBorder(ctx, node) {
  const status = node._executionStatus;
  if (!status || !STATUS_COLORS[status]) return;

  const sc = STATUS_COLORS[status];
  const w = node.size[0];
  const h = node.size[1];

  ctx.save();

  // Outer glow
  ctx.shadowColor = sc.glow;
  ctx.shadowBlur = status === "running" ? 15 : 10;
  ctx.strokeStyle = sc.border;
  ctx.lineWidth = 2;

  // Animated dash for running state
  if (status === "running") {
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -(Date.now() / 50) % 20;
  }

  roundRect(ctx, -1, -LiteGraph.NODE_TITLE_HEIGHT - 1, w + 2, h + LiteGraph.NODE_TITLE_HEIGHT + 2, 6);
  ctx.stroke();

  ctx.restore();
}

/**
 * Draw execution result overlay below the node's normal content.
 */
function drawExecutionOverlay(ctx, node) {
  const status = node._executionStatus;
  const result = node._executionResult;
  if (!status) return;

  const sc = STATUS_COLORS[status];
  if (!sc) return;

  const w = node.size[0];
  const baseH = node.size[1];

  // Status badge (top-left corner)
  ctx.save();
  ctx.fillStyle = sc.border;
  ctx.beginPath();
  ctx.arc(10, -LiteGraph.NODE_TITLE_HEIGHT / 2, 5, 0, Math.PI * 2);
  ctx.fill();

  // Spinning animation for running
  if (status === "running") {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    const angle = (Date.now() / 200) % (Math.PI * 2);
    ctx.beginPath();
    ctx.arc(10, -LiteGraph.NODE_TITLE_HEIGHT / 2, 5, angle, angle + Math.PI * 1.2);
    ctx.stroke();
  }
  ctx.restore();

  // Result preview panel below node
  if (result && (status === "success" || status === "error")) {
    const lines = formatResultLines(result, w);
    if (lines.length === 0) return;

    const lineHeight = 13;
    const padding = 6;
    const panelH = lines.length * lineHeight + padding * 2;
    const panelY = baseH + 4;

    // Expand node size to accommodate result panel
    const neededH = panelY + panelH;
    if (node.size[1] < neededH) {
      node.size[1] = neededH;
    }

    // Panel background
    ctx.save();
    ctx.fillStyle = status === "error" ? "rgba(244, 67, 54, 0.1)" : "rgba(76, 175, 80, 0.08)";
    roundRect(ctx, 4, panelY, w - 8, panelH, 4);
    ctx.fill();

    // Panel border
    ctx.strokeStyle = status === "error" ? "rgba(244, 67, 54, 0.3)" : "rgba(76, 175, 80, 0.2)";
    ctx.lineWidth = 1;
    roundRect(ctx, 4, panelY, w - 8, panelH, 4);
    ctx.stroke();

    // Result text
    ctx.font = "10px monospace";
    ctx.textAlign = "left";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      ctx.fillStyle = line.isKey ? "rgba(255,255,255,0.5)" : (
        status === "error" ? "#f44336" : "rgba(255,255,255,0.75)"
      );
      ctx.fillText(line.text, 10, panelY + padding + (i + 1) * lineHeight - 2);
    }

    ctx.restore();
  }
}

/**
 * Format execution result data into display lines.
 */
function formatResultLines(data, maxWidth) {
  const lines = [];
  const maxChars = Math.floor((maxWidth - 20) / 6); // ~6px per char in 10px monospace

  if (data === null || data === undefined) return lines;

  if (data.error) {
    lines.push({ text: truncate(`ERR: ${data.error}`, maxChars), isKey: false });
    return lines;
  }

  if (typeof data !== "object") {
    lines.push({ text: truncate(String(data), maxChars), isKey: false });
    return lines;
  }

  if (Array.isArray(data)) {
    lines.push({ text: `[${data.length} items]`, isKey: true });
    for (let i = 0; i < Math.min(data.length, 2); i++) {
      const item = data[i];
      if (typeof item === "object") {
        const summary = Object.entries(item).slice(0, 2).map(([k, v]) => `${k}: ${truncate(String(v), 12)}`).join(", ");
        lines.push({ text: truncate(`  ${summary}`, maxChars), isKey: false });
      } else {
        lines.push({ text: truncate(`  ${String(item)}`, maxChars), isKey: false });
      }
    }
    if (data.length > 2) {
      lines.push({ text: `  ...+${data.length - 2} more`, isKey: true });
    }
    return lines;
  }

  // Object: show key-value pairs
  const entries = Object.entries(data);
  const maxEntries = 5;
  for (let i = 0; i < Math.min(entries.length, maxEntries); i++) {
    const [key, value] = entries[i];
    let valStr;
    if (typeof value === "object" && value !== null) {
      valStr = Array.isArray(value) ? `[${value.length}]` : "{...}";
    } else {
      valStr = String(value);
    }
    lines.push({ text: truncate(`${key}: ${valStr}`, maxChars), isKey: false });
  }
  if (entries.length > maxEntries) {
    lines.push({ text: `...+${entries.length - maxEntries} more`, isKey: true });
  }

  return lines;
}

// ── Drawing Helpers ──────────────────────────────────────────────────────

/**
 * Draw a rounded rectangle path.
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function darkenColor(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.round(r * (1 - factor));
  const dg = Math.round(g * (1 - factor));
  const db = Math.round(b * (1 - factor));
  return `#${dr.toString(16).padStart(2, "0")}${dg.toString(16).padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + "\u2026" : str;
}

function showModuleInfo(mod) {
  if (window.app && window.app.showModulePanel) {
    window.app.showModulePanel(mod);
  }
}

/**
 * Show a node's execution result in the info panel.
 */
function showNodeResult(node) {
  const panel = document.getElementById("info-panel");
  const content = document.getElementById("info-content");
  if (!panel || !content) return;

  const status = node._executionStatus || "unknown";
  const result = node._executionResult;
  const sc = STATUS_COLORS[status] || {};

  let html = `<h3 style="color:${sc.border || '#aaa'}">${node.title}</h3>`;
  html += `<div class="module-meta"><span>${status.toUpperCase()}</span></div>`;

  if (result) {
    html += `<h4>Result</h4>`;
    html += `<pre class="cli-output">${JSON.stringify(result, null, 2)}</pre>`;
    html += `<button onclick="navigator.clipboard.writeText(${JSON.stringify(JSON.stringify(result, null, 2))}).then(()=>window.app.showNotification('Copied!','success'))">Copy Result</button>`;
  }

  content.innerHTML = html;
  panel.classList.add("visible");
}
