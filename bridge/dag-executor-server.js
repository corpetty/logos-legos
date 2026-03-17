function _deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key]) &&
        result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = _deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * DAG Executor (Server-Side) - Branch-aware directed acyclic graph executor.
 *
 * This is a server-compatible copy of js/dag-executor.js with:
 * 1. module.exports for Node.js require()
 * 2. Enhanced _handleUtility() that explicitly pushes properties.value to outputs
 *    (since ServerNode.onExecute() is a no-op — there's no LiteGraph on the server)
 *
 * Key concept: "active outputs". When a node executes, it decides which of
 * its output slots are "active" — meaning downstream nodes connected to those
 * slots should run. Module and utility nodes activate ALL outputs. Control
 * flow nodes selectively activate outputs based on their logic.
 */
class DAGExecutor {
  constructor(graph, callbacks) {
    this.graph = graph;
    this.callbacks = callbacks;

    // Execution state
    this.executed = new Set();
    this.activeOutputs = new Map();
    this.nodeResults = new Map();
    this.skipped = new Set();
    this.errorNodes = new Map();        // nodeId → { message, data } for nodes that errored
  }

  async run() {
    const { order, adj, reverseAdj } = this._buildGraph();

    if (order.length === 0) return { success: true, steps: 0, skipped: 0 };

    let executedCount = 0;
    let errorCount = 0;

    for (const nodeId of order) {
      const node = this.graph.getNodeById(nodeId);
      if (!node) continue;

      if (!this._isNodeActive(nodeId, reverseAdj)) {
        this.skipped.add(nodeId);
        continue;
      }

      try {
        await this._executeNode(node, adj);
        executedCount++;

        // Track nodes that handled errors internally
        if (node._executionStatus === "error") {
          const errMsg = node._executionResult?.error || "Unknown error";
          this.errorNodes.set(nodeId, { message: errMsg, data: node._executionResult });
          errorCount++;
        }
      } catch (e) {
        errorCount++;
        this.callbacks.setStatus(node, "error");
        this.callbacks.setResult(node, { error: e.message });
        this.errorNodes.set(nodeId, { message: e.message, data: e });
        this.activeOutputs.set(nodeId, new Set());
        this.executed.add(nodeId);
      }
    }

    return {
      success: errorCount === 0,
      steps: executedCount,
      skipped: this.skipped.size,
      errors: errorCount,
    };
  }

  _buildGraph() {
    const nodes = this.graph._nodes || [];
    const links = this.graph.links || {};

    const adj = new Map();
    const reverseAdj = new Map();
    const inDegree = new Map();

    for (const node of nodes) {
      adj.set(node.id, []);
      reverseAdj.set(node.id, []);
      if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
    }

    for (const linkId in links) {
      const link = links[linkId];
      if (!link) continue;

      const sourceId = link[1];
      const outputSlot = link[2];
      const targetId = link[3];
      const inputSlot = link[4];

      if (adj.has(sourceId)) {
        adj.get(sourceId).push({ targetId, outputSlot, inputSlot });
      }
      if (reverseAdj.has(targetId)) {
        reverseAdj.get(targetId).push({ sourceId, outputSlot, inputSlot });
      }
      if (!inDegree.has(targetId)) inDegree.set(targetId, 0);
      inDegree.set(targetId, (inDegree.get(targetId) || 0) + 1);
    }

    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order = [];
    while (queue.length > 0) {
      const id = queue.shift();
      order.push(id);
      for (const edge of adj.get(id) || []) {
        inDegree.set(edge.targetId, inDegree.get(edge.targetId) - 1);
        if (inDegree.get(edge.targetId) === 0) queue.push(edge.targetId);
      }
    }

    return { order, adj, reverseAdj };
  }

  _isNodeActive(nodeId, reverseAdj) {
    const incoming = reverseAdj.get(nodeId) || [];
    if (incoming.length === 0) return true;

    const node = this.graph.getNodeById(nodeId);
    const isMerge = node?.properties?._controlFlow === "merge";
    const isErrorCatcher = node?.properties?._errorCatch === true;

    if (isMerge) {
      for (const { sourceId, outputSlot } of incoming) {
        if (this.skipped.has(sourceId)) continue;
        if (!this.executed.has(sourceId)) continue;
        const activeSlots = this.activeOutputs.get(sourceId);
        if (activeSlots && activeSlots.has(outputSlot)) return true;
      }
      return false;
    }

    if (isErrorCatcher) {
      // Error-catching nodes: active if all upstream have executed (or errored)
      for (const { sourceId } of incoming) {
        if (this.skipped.has(sourceId)) return false;
        if (!this.executed.has(sourceId)) return false;
      }
      return true;
    }

    for (const { sourceId, outputSlot } of incoming) {
      if (this.skipped.has(sourceId)) return false;
      if (!this.executed.has(sourceId)) return false;
      const activeSlots = this.activeOutputs.get(sourceId);
      if (!activeSlots || !activeSlots.has(outputSlot)) return false;
    }

    return true;
  }

  async _executeNode(node, adj) {
    const trigger = node.properties?._trigger;
    const controlFlow = node.properties?._controlFlow;

    if (trigger) {
      // Trigger nodes have pre-injected output data from webhook/timer/manual
      this.callbacks.setStatus(node, "success");
      const data = node.getOutputData ? node.getOutputData(0) : {};
      this.callbacks.setResult(node, data || {});
      this._activateAllOutputs(node);
    } else if (controlFlow) {
      await this._handleControlFlow(node, controlFlow);
    } else if (node.properties?.module && node.properties?.method) {
      await this._handleModule(node);
    } else {
      await this._handleUtility(node);
    }

    this.executed.add(node.id);
  }

  async _handleModule(node) {
    this.callbacks.setStatus(node, "running");

    const params = this.callbacks.resolveInputs(node);
    const result = await this.callbacks.execute(
      node.properties.module,
      node.properties.method,
      params
    );

    if (result.success) {
      this.callbacks.setStatus(node, "success");
      this.callbacks.setResult(node, result.data);
      this.nodeResults.set(node.id, result.data);
      this._activateAllOutputs(node);
    } else {
      this.callbacks.setStatus(node, "error");
      this.callbacks.setResult(node, { error: result.error });
      this.activeOutputs.set(node.id, new Set());
    }

    if (this.callbacks.onStepComplete) {
      this.callbacks.onStepComplete(node, result);
    }
  }

  /**
   * Handle a utility node — resolve value from properties.
   * SERVER-SIDE ENHANCED: Explicitly pushes properties.value to output slots
   * since ServerNode.onExecute() is a no-op (no LiteGraph on the server).
   * Also handles Transform nodes (ArrayMap, ArrayFilter, etc.).
   */
  async _handleUtility(node) {
    const nodeType = node.type;

    // ── Transform nodes ──
    if (nodeType === "Transform/ArrayMap") {
      const arr = node.getInputData(0);
      const expr = node.properties?.expression || "item";
      if (Array.isArray(arr)) {
        try {
          const fn = new Function("item", "index", `return (${expr});`);
          const result = arr.map((item, index) => fn(item, index));
          node.setOutputData(0, result);
          this.callbacks.setResult(node, result);
        } catch (e) {
          node.setOutputData(0, { error: e.message });
          this.callbacks.setResult(node, { error: e.message });
        }
      } else {
        node.setOutputData(0, []);
        this.callbacks.setResult(node, []);
      }

    } else if (nodeType === "Transform/ArrayFilter") {
      const arr = node.getInputData(0);
      const cond = node.properties?.condition || "true";
      if (Array.isArray(arr)) {
        try {
          const fn = new Function("item", "index", `return !!(${cond});`);
          const passed = [];
          const rejected = [];
          arr.forEach((item, index) => {
            if (fn(item, index)) passed.push(item);
            else rejected.push(item);
          });
          node.setOutputData(0, passed);
          node.setOutputData(1, rejected);
          this.callbacks.setResult(node, { passed, rejected });
        } catch (e) {
          node.setOutputData(0, []);
          node.setOutputData(1, []);
          this.callbacks.setResult(node, { error: e.message });
        }
      } else {
        node.setOutputData(0, []);
        node.setOutputData(1, []);
        this.callbacks.setResult(node, []);
      }

    } else if (nodeType === "Transform/ObjectPick") {
      const obj = node.getInputData(0);
      const keys = (node.properties?.keys || "").split(",").map(k => k.trim()).filter(Boolean);
      if (obj && typeof obj === "object") {
        const picked = {};
        for (const k of keys) {
          if (k in obj) picked[k] = obj[k];
        }
        node.setOutputData(0, picked);
        this.callbacks.setResult(node, picked);
      } else {
        node.setOutputData(0, {});
        this.callbacks.setResult(node, {});
      }

    } else if (nodeType === "Transform/ObjectMerge") {
      const a = node.getInputData(0) || {};
      const b = node.getInputData(1) || {};
      const merged = _deepMerge(a, b);
      node.setOutputData(0, merged);
      this.callbacks.setResult(node, merged);

    } else if (nodeType === "Transform/CodeExpression") {
      const data = node.getInputData(0);
      const code = node.properties?.code || "return data;";
      try {
        const fn = new Function("data", "JSON", "Math", "Date", "Array", "Object", "String", "Number", "Boolean", code);
        const result = fn(data, JSON, Math, Date, Array, Object, String, Number, Boolean);
        node.setOutputData(0, result);
        this.callbacks.setResult(node, result);
      } catch (e) {
        node.setOutputData(0, { error: e.message });
        this.callbacks.setResult(node, { error: e.message });
      }

    } else if (nodeType === "Transform/HttpRequest") {
      await this._handleHttpRequest(node);
      this._activateAllOutputs(node);
      return; // _handleHttpRequest manages its own activation

    } else {
      // ── Standard utility nodes ──
      if (node.onExecute) {
        node.onExecute();
      }

      const value = node.properties?.value;
      if (value !== undefined) {
        this.nodeResults.set(node.id, value);
        if (node.outputs) {
          for (let i = 0; i < node.outputs.length; i++) {
            node.setOutputData(i, value);
          }
        }
      }
    }

    this._activateAllOutputs(node);
  }

  /**
   * Handle HTTP Request node — makes an HTTP call using Node.js http/https.
   */
  async _handleHttpRequest(node) {
    const inputUrl = node.getInputData(0) || node.properties?.url || "";
    const body = node.getInputData(1);
    const method = (node.properties?.method || "GET").toUpperCase();
    let headers;
    try { headers = JSON.parse(node.properties?.headers || "{}"); } catch { headers = {}; }

    if (!inputUrl) {
      node.setOutputData(0, { error: "No URL provided" });
      node.setOutputData(1, 0);
      return;
    }

    try {
      const parsedUrl = new (require("url").URL)(inputUrl);
      const httpModule = require(parsedUrl.protocol === "https:" ? "https" : "http");
      const result = await new Promise((resolve, reject) => {
        const opts = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: method,
          headers: { "Content-Type": "application/json", ...headers },
        };
        const req = httpModule.request(opts, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            let parsed;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ body: parsed, status: res.statusCode });
          });
        });
        req.on("error", reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error("Request timeout")); });
        if (body && method !== "GET") {
          req.write(typeof body === "string" ? body : JSON.stringify(body));
        }
        req.end();
      });

      node.setOutputData(0, result.body);
      node.setOutputData(1, result.status);
      this.callbacks.setResult(node, result.body);
    } catch (e) {
      node.setOutputData(0, { error: e.message });
      node.setOutputData(1, 0);
      this.callbacks.setResult(node, { error: e.message });
    }
  }

  async _handleControlFlow(node, type) {
    this.callbacks.setStatus(node, "running");

    const activeSlots = new Set();

    if (type === "if-else") {
      activeSlots.add(...this._handleIfElse(node));
    } else if (type === "switch") {
      activeSlots.add(...this._handleSwitch(node));
    } else if (type === "foreach") {
      await this._handleForEach(node);
      this.callbacks.setStatus(node, "success");
      this.executed.add(node.id);
      return;
    } else if (type === "merge") {
      this._handleMerge(node);
      this._activateAllOutputs(node);
      this.callbacks.setStatus(node, "success");
      return;
    } else if (type === "try-catch") {
      this._handleTryCatch(node);
      return;
    } else if (type === "retry") {
      await this._handleRetry(node);
      return;
    } else if (type === "fallback") {
      this._handleFallback(node);
      return;
    }

    this.activeOutputs.set(node.id, activeSlots);
    this.callbacks.setStatus(node, "success");

    const value = this._resolveControlFlowInput(node, "value") ??
                  this._resolveControlFlowInput(node, "condition");
    for (const slot of activeSlots) {
      node.setOutputData(slot, value);
    }
  }

  _handleIfElse(node) {
    const condition = this._resolveControlFlowInput(node, "condition");
    const value = this._resolveControlFlowInput(node, "value");

    if (condition) {
      node.setOutputData(0, value);
      node.setOutputData(1, null);
      this.callbacks.setResult(node, { branch: "true", value });
      return [0];
    } else {
      node.setOutputData(0, null);
      node.setOutputData(1, value);
      this.callbacks.setResult(node, { branch: "false", value });
      return [1];
    }
  }

  _handleSwitch(node) {
    const value = this._resolveControlFlowInput(node, "value");
    const key = this._resolveControlFlowInput(node, "key");
    const cases = (node.properties.cases || "").split(",").map(s => s.trim());

    for (let i = 0; i < (node.outputs || []).length; i++) {
      node.setOutputData(i, null);
    }

    const matchIndex = cases.indexOf(String(key));
    if (matchIndex >= 0 && matchIndex < (node.outputs || []).length - 1) {
      node.setOutputData(matchIndex, value);
      this.callbacks.setResult(node, { branch: `case_${matchIndex + 1}`, key, value });
      return [matchIndex];
    } else {
      const defaultSlot = (node.outputs || []).length - 1;
      node.setOutputData(defaultSlot, value);
      this.callbacks.setResult(node, { branch: "default", key, value });
      return [defaultSlot];
    }
  }

  async _handleForEach(node) {
    const arr = this._resolveControlFlowInput(node, "array");

    if (!Array.isArray(arr)) {
      this.callbacks.setResult(node, { error: "ForEach input is not an array" });
      this.callbacks.setStatus(node, "error");
      this.activeOutputs.set(node.id, new Set());
      return;
    }

    const lastItem = arr.length > 0 ? arr[arr.length - 1] : null;
    const lastIndex = arr.length > 0 ? arr.length - 1 : 0;

    node.setOutputData(0, lastItem);
    node.setOutputData(1, lastIndex);
    node.setOutputData(2, arr);

    this.callbacks.setResult(node, { items: arr.length, lastItem, array: arr });
    this._activateAllOutputs(node);
  }

  _handleMerge(node) {
    const merged = {};
    for (let i = 0; i < (node.inputs || []).length; i++) {
      const data = this._resolveControlFlowInput(node, node.inputs[i].name);
      if (data !== null && data !== undefined) {
        merged[node.inputs[i].name] = data;
      }
    }

    node.setOutputData(0, merged);
    this.callbacks.setResult(node, merged);
    this.nodeResults.set(node.id, merged);
  }

  _resolveControlFlowInput(node, inputName) {
    if (!node.inputs) return null;

    const inputIndex = node.inputs.findIndex(inp => inp.name === inputName);
    if (inputIndex < 0) return null;

    let data = node.getInputData(inputIndex);
    if (data !== undefined && data !== null) return data;

    const input = node.inputs[inputIndex];
    if (!input || input.link == null) return null;

    const link = this.graph.links[input.link];
    if (!link) return null;

    const originNode = this.graph.getNodeById(link[1]);
    if (!originNode) return null;

    if (originNode._executionResult !== undefined) {
      return originNode._executionResult;
    }

    if (originNode.properties?.value !== undefined) {
      return originNode.properties.value;
    }

    const outputIndex = link[2];
    if (originNode.getOutputData) {
      return originNode.getOutputData(outputIndex);
    }

    return null;
  }

  // ── Error Handling Nodes ────────────────────────────────────────────────

  _handleTryCatch(node) {
    const upstreamError = this._getUpstreamError(node, 0);

    if (upstreamError) {
      const errorData = { error: upstreamError.message, details: upstreamError };
      node.setOutputData(0, null);
      node.setOutputData(1, errorData);
      this.activeOutputs.set(node.id, new Set([1]));
      node._executionResult = { caught: upstreamError.message };
      this.nodeResults.set(node.id, node._executionResult);
    } else {
      const inputData = this._resolveControlFlowInput(node, "input");
      node.setOutputData(0, inputData);
      node.setOutputData(1, null);
      this.activeOutputs.set(node.id, new Set([0]));
      node._executionResult = inputData;
      this.nodeResults.set(node.id, inputData);
    }
    this.callbacks.setStatus(node, "success");
  }

  async _handleRetry(node) {
    const maxRetries = node.properties?.maxRetries || 3;
    const delayMs = node.properties?.delayMs || 1000;
    const upstreamError = this._getUpstreamError(node, 0);

    if (!upstreamError) {
      const inputData = this._resolveControlFlowInput(node, "input");
      node.setOutputData(0, inputData);
      node.setOutputData(1, null);
      this.activeOutputs.set(node.id, new Set([0]));
      node._executionResult = inputData;
      this.nodeResults.set(node.id, inputData);
      this.callbacks.setStatus(node, "success");
      return;
    }

    const upstreamNodeId = this._getUpstreamNodeId(node, 0);
    const upstreamNode = upstreamNodeId ? this.graph.getNodeById(upstreamNodeId) : null;

    if (!upstreamNode) {
      node.setOutputData(0, null);
      node.setOutputData(1, { error: "Cannot find upstream node to retry" });
      this.activeOutputs.set(node.id, new Set([1]));
      node._executionResult = { error: "No upstream to retry" };
      this.callbacks.setStatus(node, "error");
      return;
    }

    let lastError = upstreamError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }

      try {
        const retryResult = await this._retryUpstreamNode(upstreamNode);
        if (retryResult.success) {
          const data = retryResult.data;
          node.setOutputData(0, data);
          node.setOutputData(1, null);
          this.activeOutputs.set(node.id, new Set([0]));
          node._executionResult = { retried: attempt, data };
          this.nodeResults.set(node.id, node._executionResult);
          this.callbacks.setStatus(node, "success");
          this.errorNodes.delete(upstreamNodeId);
          this.callbacks.setStatus(upstreamNode, "success");
          upstreamNode._executionResult = data;
          return;
        } else {
          lastError = { message: retryResult.error };
        }
      } catch (e) {
        lastError = { message: e.message };
      }
    }

    node.setOutputData(0, null);
    node.setOutputData(1, { error: lastError.message, retries: maxRetries });
    this.activeOutputs.set(node.id, new Set([1]));
    node._executionResult = { failed: true, retries: maxRetries, error: lastError.message };
    this.nodeResults.set(node.id, node._executionResult);
    this.callbacks.setStatus(node, "error");
  }

  async _retryUpstreamNode(upstreamNode) {
    if (upstreamNode.properties?.module && upstreamNode.properties?.method) {
      const params = this.callbacks.resolveInputs(upstreamNode);
      const result = await this.callbacks.execute(
        upstreamNode.properties.module,
        upstreamNode.properties.method,
        params
      );
      return result;
    } else {
      // Utility/transform: re-run onExecute
      if (upstreamNode.onExecute) {
        upstreamNode.onExecute();
      }
      const data = upstreamNode.getOutputData ? upstreamNode.getOutputData(0) : undefined;
      return { success: true, data };
    }
  }

  _handleFallback(node) {
    const primaryError = this._getUpstreamError(node, 0);
    const primaryData = this._resolveControlFlowInput(node, "primary");
    const fallbackData = this._resolveControlFlowInput(node, "fallback");

    let result;
    if (primaryError || primaryData === null || primaryData === undefined) {
      result = fallbackData;
      node._executionResult = { source: "fallback", data: result };
    } else {
      result = primaryData;
      node._executionResult = { source: "primary", data: result };
    }

    node.setOutputData(0, result);
    this.nodeResults.set(node.id, node._executionResult);
    this._activateAllOutputs(node);
    this.callbacks.setStatus(node, "success");
  }

  _getUpstreamError(node, inputIndex) {
    if (!node.inputs || !node.inputs[inputIndex]) return null;
    const input = node.inputs[inputIndex];
    if (input.link == null) return null;

    const link = this.graph.links[input.link];
    if (!link) return null;

    const originId = link[1];
    return this.errorNodes.get(originId) || null;
  }

  _getUpstreamNodeId(node, inputIndex) {
    if (!node.inputs || !node.inputs[inputIndex]) return null;
    const input = node.inputs[inputIndex];
    if (input.link == null) return null;

    const link = this.graph.links[input.link];
    if (!link) return null;

    return link[1];
  }

  _activateAllOutputs(node) {
    const slots = new Set();
    for (let i = 0; i < (node.outputs || []).length; i++) {
      slots.add(i);
    }
    this.activeOutputs.set(node.id, slots);
  }
}

module.exports = DAGExecutor;
