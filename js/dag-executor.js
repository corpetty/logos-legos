/**
 * DAG Executor - Branch-aware directed acyclic graph executor.
 *
 * Replaces the sequential for-loop in app.js with a proper DAG executor
 * that understands control flow nodes (If/Else, Switch, ForEach, Merge).
 *
 * Key concept: "active outputs". When a node executes, it decides which of
 * its output slots are "active" — meaning downstream nodes connected to those
 * slots should run. Module and utility nodes activate ALL outputs. Control
 * flow nodes selectively activate outputs based on their logic.
 *
 * A downstream node only becomes ready when ALL of its incoming connections
 * come from active outputs of already-executed nodes.
 */
class DAGExecutor {
  /**
   * @param {LGraph} graph - The LiteGraph graph instance
   * @param {object} callbacks - Execution callbacks:
   *   - execute(module, method, params): Promise<result> — run a module method via bridge
   *   - setStatus(node, status): void — set visual status on a node
   *   - setResult(node, data): void — store result + push to outputs
   *   - resolveInputs(node): object — gather input parameter values
   *   - onStepComplete(node, result): void — called after each step (optional)
   */
  constructor(graph, callbacks) {
    this.graph = graph;
    this.callbacks = callbacks;

    // Execution state
    this.executed = new Set();          // nodeIds that have finished executing
    this.activeOutputs = new Map();     // nodeId → Set<outputSlotIndex> that fired
    this.nodeResults = new Map();       // nodeId → execution result data
    this.skipped = new Set();           // nodeIds skipped due to inactive branch
    this.errorNodes = new Map();        // nodeId → { message, data } for nodes that errored
  }

  /**
   * Main entry point — execute the entire graph.
   */
  async run() {
    const { order, adj, reverseAdj } = this._buildGraph();

    if (order.length === 0) return { success: true, steps: 0, skipped: 0 };

    let executedCount = 0;
    let errorCount = 0;

    for (const nodeId of order) {
      const node = this.graph.getNodeById(nodeId);
      if (!node) continue;

      // Check if this node should be skipped (inactive branch)
      if (!this._isNodeActive(nodeId, reverseAdj)) {
        this.skipped.add(nodeId);
        continue;
      }

      // Check if this is a merge node waiting for branches
      if (node.properties?._controlFlow === "merge") {
        // Merge is active if at least one active input arrives
        // (handled by _isNodeActive above)
      }

      try {
        await this._executeNode(node, adj);
        executedCount++;

        // Track nodes that handled errors internally (e.g., HTTP Request catches
        // fetch errors and sets status to "error" without throwing)
        if (node._executionStatus === "error") {
          const errMsg = node._executionResult?.error || "Unknown error";
          this.errorNodes.set(nodeId, { message: errMsg, data: node._executionResult });
          errorCount++;
        }
      } catch (e) {
        errorCount++;
        this.callbacks.setStatus(node, "error");
        this.callbacks.setResult(node, { error: e.message });
        // Track error for downstream error-catching nodes
        this.errorNodes.set(nodeId, { message: e.message, data: e });
        // Deactivate all outputs on error (error-catchers use _hasUpstreamError)
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

  /**
   * Build adjacency lists and topological order from the LiteGraph graph.
   * Returns { order, adj, reverseAdj, edgesByOutput }
   *
   * adj: nodeId → [{ targetId, outputSlot, inputSlot }]
   * reverseAdj: nodeId → [{ sourceId, outputSlot, inputSlot }]
   */
  _buildGraph() {
    const nodes = this.graph._nodes || [];
    const links = this.graph.links || {};

    // Adjacency: which nodes does each node feed into (with slot info)
    const adj = new Map();
    // Reverse adjacency: which nodes feed into each node
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

      const sourceId = link.origin_id !== undefined ? link.origin_id : link[1];
      const outputSlot = link.origin_slot !== undefined ? link.origin_slot : link[2];
      const targetId = link.target_id !== undefined ? link.target_id : link[3];
      const inputSlot = link.target_slot !== undefined ? link.target_slot : link[4];

      if (adj.has(sourceId)) {
        adj.get(sourceId).push({ targetId, outputSlot, inputSlot });
      }
      if (reverseAdj.has(targetId)) {
        reverseAdj.get(targetId).push({ sourceId, outputSlot, inputSlot });
      }
      if (!inDegree.has(targetId)) inDegree.set(targetId, 0);
      inDegree.set(targetId, (inDegree.get(targetId) || 0) + 1);
    }

    // Kahn's algorithm for topological sort
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

  /**
   * Determine if a node should execute based on branch activation.
   *
   * Rules:
   * - Nodes with NO incoming connections are always active (root nodes)
   * - A node is active if ALL of its incoming connections come from
   *   active output slots of already-executed upstream nodes
   * - If ANY incoming connection comes from a skipped or inactive-output
   *   upstream, the node is inactive (skipped)
   * - Special case: Merge nodes are active if at least ONE input is active
   * - Special case: Error-catching nodes (_errorCatch) are active if any
   *   upstream node errored (even if its outputs were deactivated)
   */
  _isNodeActive(nodeId, reverseAdj) {
    const incoming = reverseAdj.get(nodeId) || [];

    // Root nodes (no inputs connected) are always active
    if (incoming.length === 0) return true;

    const node = this.graph.getNodeById(nodeId);
    const isMerge = node?.properties?._controlFlow === "merge";
    const isErrorCatcher = node?.properties?._errorCatch === true;

    if (isMerge) {
      // Merge: active if at least one incoming branch is active
      for (const { sourceId, outputSlot } of incoming) {
        if (this.skipped.has(sourceId)) continue;
        if (!this.executed.has(sourceId)) continue;
        const activeSlots = this.activeOutputs.get(sourceId);
        if (activeSlots && activeSlots.has(outputSlot)) return true;
      }
      return false;
    }

    if (isErrorCatcher) {
      // Error-catching nodes: active if all upstream have executed (or errored),
      // even if their outputs were deactivated
      for (const { sourceId } of incoming) {
        if (this.skipped.has(sourceId)) return false;
        if (!this.executed.has(sourceId)) return false;
      }
      return true;
    }

    // Normal nodes: all incoming must be from active outputs
    for (const { sourceId, outputSlot } of incoming) {
      // If upstream was skipped, we're also skipped
      if (this.skipped.has(sourceId)) return false;

      // If upstream hasn't run yet, something is wrong with topo order
      // (shouldn't happen with correct Kahn's)
      if (!this.executed.has(sourceId)) return false;

      // Check if the specific output slot that feeds us is active
      const activeSlots = this.activeOutputs.get(sourceId);
      if (!activeSlots || !activeSlots.has(outputSlot)) return false;
    }

    return true;
  }

  /**
   * Execute a single node, dispatching to the appropriate handler.
   */
  async _executeNode(node, adj) {
    const trigger = node.properties?._trigger;
    const controlFlow = node.properties?._controlFlow;

    if (trigger) {
      // Trigger nodes are root nodes whose output data is pre-injected
      // (by webhook handler, timer, or manual trigger on the server side).
      // In browser mode, they act as passthrough with whatever data exists.
      this.callbacks.setStatus(node, "success");
      const data = node.getOutputData ? node.getOutputData(0) : {};
      this.callbacks.setResult(node, data || {});
      this._activateAllOutputs(node);
    } else if (controlFlow) {
      await this._handleControlFlow(node, controlFlow);
    } else if (node.properties?.module && node.properties?.method) {
      await this._handleModule(node);
    } else {
      // Utility node — just resolve its value (async for HTTP Request etc.)
      await this._handleUtility(node);
    }

    this.executed.add(node.id);
  }

  /**
   * Handle a module method node — execute via bridge.
   */
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
      // Module nodes activate ALL outputs
      this._activateAllOutputs(node);
    } else {
      this.callbacks.setStatus(node, "error");
      this.callbacks.setResult(node, { error: result.error });
      // Error: deactivate all outputs (stop downstream execution)
      this.activeOutputs.set(node.id, new Set());
    }

    if (this.callbacks.onStepComplete) {
      this.callbacks.onStepComplete(node, result);
    }
  }

  /**
   * Handle a utility node — resolve value from properties.
   * Async because some utility nodes (e.g., HTTP Request) need async execution.
   */
  async _handleUtility(node) {
    // HTTP Request needs special async handling in the browser
    if (node.type === "Transform/HttpRequest") {
      await this._handleHttpRequestBrowser(node);
      return;
    }

    // Run LiteGraph's onExecute to push output data
    if (node.onExecute) {
      node.onExecute();
    }

    // Store result for downstream resolution
    const value = node.properties?.value;
    if (value !== undefined) {
      this.nodeResults.set(node.id, value);
    }

    // Utility nodes activate ALL outputs
    this._activateAllOutputs(node);
  }

  /**
   * Handle HTTP Request node in the browser using fetch().
   */
  async _handleHttpRequestBrowser(node) {
    this.callbacks.setStatus(node, "running");

    const urlInput = node.getInputData ? node.getInputData(0) : null;
    const bodyInput = node.getInputData ? node.getInputData(1) : null;
    const url = urlInput || node.properties?.url || "";
    const method = (node.properties?.method || "GET").toUpperCase();

    if (!url) {
      this.callbacks.setStatus(node, "error");
      this.callbacks.setResult(node, { error: "No URL provided" });
      this.activeOutputs.set(node.id, new Set());
      return;
    }

    let headers = {};
    try {
      headers = JSON.parse(node.properties?.headers || "{}");
    } catch { /* ignore parse errors */ }

    const fetchOpts = { method, headers };
    if (bodyInput && method !== "GET" && method !== "HEAD") {
      fetchOpts.body = typeof bodyInput === "string" ? bodyInput : JSON.stringify(bodyInput);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        fetchOpts.headers["Content-Type"] = "application/json";
      }
    }

    try {
      const resp = await fetch(url, fetchOpts);
      const status = resp.status;
      let responseData;
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        responseData = await resp.json();
      } else {
        responseData = await resp.text();
      }

      node.setOutputData(0, responseData);
      node.setOutputData(1, status);

      this.callbacks.setStatus(node, resp.ok ? "success" : "warning");
      this.callbacks.setResult(node, responseData);
      this.nodeResults.set(node.id, responseData);
      this._activateAllOutputs(node);
    } catch (e) {
      this.callbacks.setStatus(node, "error");
      this.callbacks.setResult(node, { error: e.message });
      node.setOutputData(0, { error: e.message });
      node.setOutputData(1, 0);
      this.activeOutputs.set(node.id, new Set());
    }
  }

  /**
   * Handle a control flow node — evaluate condition and activate specific outputs.
   */
  async _handleControlFlow(node, type) {
    this.callbacks.setStatus(node, "running");

    const activeSlots = new Set();

    if (type === "if-else") {
      activeSlots.add(...this._handleIfElse(node));
    } else if (type === "switch") {
      activeSlots.add(...this._handleSwitch(node));
    } else if (type === "foreach") {
      await this._handleForEach(node);
      // ForEach handles its own output activation
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

    // Set output data for the active slots
    const value = this._resolveControlFlowInput(node, "value") ??
                  this._resolveControlFlowInput(node, "condition");
    for (const slot of activeSlots) {
      node.setOutputData(slot, value);
    }
  }

  /**
   * If/Else: evaluate the condition input and activate true or false branch.
   */
  _handleIfElse(node) {
    const condition = this._resolveControlFlowInput(node, "condition");
    const value = this._resolveControlFlowInput(node, "value");

    if (condition) {
      // True branch = output slot 0
      node.setOutputData(0, value);
      node.setOutputData(1, null);
      this.callbacks.setResult(node, { branch: "true", value });
      return [0];
    } else {
      // False branch = output slot 1
      node.setOutputData(0, null);
      node.setOutputData(1, value);
      this.callbacks.setResult(node, { branch: "false", value });
      return [1];
    }
  }

  /**
   * Switch: match key against case values and activate the matching output.
   */
  _handleSwitch(node) {
    const value = this._resolveControlFlowInput(node, "value");
    const key = this._resolveControlFlowInput(node, "key");
    const cases = (node.properties.cases || "").split(",").map(s => s.trim());

    // Reset all outputs
    for (let i = 0; i < (node.outputs || []).length; i++) {
      node.setOutputData(i, null);
    }

    const matchIndex = cases.indexOf(String(key));
    if (matchIndex >= 0 && matchIndex < (node.outputs || []).length - 1) {
      node.setOutputData(matchIndex, value);
      this.callbacks.setResult(node, { branch: `case_${matchIndex + 1}`, key, value });
      return [matchIndex];
    } else {
      // Default (last output)
      const defaultSlot = (node.outputs || []).length - 1;
      node.setOutputData(defaultSlot, value);
      this.callbacks.setResult(node, { branch: "default", key, value });
      return [defaultSlot];
    }
  }

  /**
   * ForEach: iterate over an array, executing downstream subgraph per item.
   *
   * For Phase 1, we take a simpler approach: emit each item sequentially
   * on the "item" output, and emit the full array on "done" when complete.
   * The DAG executor doesn't re-run the downstream subgraph per item yet —
   * instead it emits the full array as the result so downstream nodes
   * can consume it. Full subgraph-per-item execution is a Phase 2 feature.
   */
  async _handleForEach(node) {
    const arr = this._resolveControlFlowInput(node, "array");

    if (!Array.isArray(arr)) {
      this.callbacks.setResult(node, { error: "ForEach input is not an array" });
      this.callbacks.setStatus(node, "error");
      this.activeOutputs.set(node.id, new Set());
      return;
    }

    // For now, emit the last item on "item", last index on "index",
    // and the full array on "done"
    const lastItem = arr.length > 0 ? arr[arr.length - 1] : null;
    const lastIndex = arr.length > 0 ? arr.length - 1 : 0;

    node.setOutputData(0, lastItem);  // item
    node.setOutputData(1, lastIndex); // index
    node.setOutputData(2, arr);       // done

    this.callbacks.setResult(node, {
      items: arr.length,
      lastItem,
      array: arr,
    });

    // Activate all outputs
    this._activateAllOutputs(node);
  }

  /**
   * Merge: collect data from all active incoming branches.
   */
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

  /**
   * Resolve an input value for a control flow node by name.
   * Uses the same strategy as app.resolveInputValue() — check connected
   * upstream nodes for _executionResult or properties.value.
   */
  _resolveControlFlowInput(node, inputName) {
    if (!node.inputs) return null;

    const inputIndex = node.inputs.findIndex(inp => inp.name === inputName);
    if (inputIndex < 0) return null;

    // Try LiteGraph native first
    let data = node.getInputData(inputIndex);
    if (data !== undefined && data !== null) return data;

    // Manual link walk
    const input = node.inputs[inputIndex];
    if (!input || input.link == null) return null;

    const link = this.graph.links[input.link];
    if (!link) return null;

    const originId = link.origin_id !== undefined ? link.origin_id : link[1];
    const originNode = this.graph.getNodeById(originId);
    if (!originNode) return null;

    // Check execution result
    if (originNode._executionResult !== undefined) {
      return originNode._executionResult;
    }

    // Check properties.value (utility nodes)
    if (originNode.properties?.value !== undefined) {
      return originNode.properties.value;
    }

    // Try output data
    const outputIndex = link.origin_slot !== undefined ? link.origin_slot : link[2];
    if (originNode.getOutputData) {
      return originNode.getOutputData(outputIndex);
    }

    return null;
  }

  // ── Error Handling Nodes ────────────────────────────────────────────────

  /**
   * Try/Catch: inspect upstream execution status.
   * If upstream succeeded → route to success output (slot 0).
   * If upstream errored → route to error output (slot 1) with error details.
   */
  _handleTryCatch(node) {
    const upstreamError = this._getUpstreamError(node, 0);

    if (upstreamError) {
      // Route to error output (slot 1)
      const errorData = { error: upstreamError.message, details: upstreamError };
      node.setOutputData(0, null);
      node.setOutputData(1, errorData);
      this.activeOutputs.set(node.id, new Set([1]));
      // Set result directly (don't use callbacks.setResult which overwrites per-slot data)
      node._executionResult = { caught: upstreamError.message };
      this.nodeResults.set(node.id, node._executionResult);
    } else {
      // Route to success output (slot 0)
      const inputData = this._resolveControlFlowInput(node, "input");
      node.setOutputData(0, inputData);
      node.setOutputData(1, null);
      this.activeOutputs.set(node.id, new Set([0]));
      node._executionResult = inputData;
      this.nodeResults.set(node.id, inputData);
    }
    this.callbacks.setStatus(node, "success");
  }

  /**
   * Retry: if upstream errored, re-execute the upstream node up to N times.
   * On success → route to result output (slot 0).
   * On all retries exhausted → route to failed output (slot 1).
   */
  async _handleRetry(node) {
    const maxRetries = node.properties?.maxRetries || 3;
    const delayMs = node.properties?.delayMs || 1000;
    const upstreamError = this._getUpstreamError(node, 0);

    if (!upstreamError) {
      // Upstream succeeded — pass through
      const inputData = this._resolveControlFlowInput(node, "input");
      node.setOutputData(0, inputData);
      node.setOutputData(1, null);
      this.activeOutputs.set(node.id, new Set([0]));
      node._executionResult = inputData;
      this.nodeResults.set(node.id, inputData);
      this.callbacks.setStatus(node, "success");
      return;
    }

    // Upstream errored — find and retry it
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
      node._executionResult = { retrying: attempt, of: maxRetries };

      // Delay between retries
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
          // Clear error from upstream
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

    // All retries exhausted
    node.setOutputData(0, null);
    node.setOutputData(1, { error: lastError.message, retries: maxRetries });
    this.activeOutputs.set(node.id, new Set([1]));
    node._executionResult = { failed: true, retries: maxRetries, error: lastError.message };
    this.nodeResults.set(node.id, node._executionResult);
    this.callbacks.setStatus(node, "error");
  }

  /**
   * Retry a single upstream node — re-execute its logic.
   * Returns { success, data } or { success: false, error }.
   */
  async _retryUpstreamNode(upstreamNode) {
    if (upstreamNode.properties?.module && upstreamNode.properties?.method) {
      // Module node — call bridge
      const params = this.callbacks.resolveInputs(upstreamNode);
      const result = await this.callbacks.execute(
        upstreamNode.properties.module,
        upstreamNode.properties.method,
        params
      );
      return result;
    } else {
      // Utility/transform node — re-run onExecute
      if (upstreamNode.onExecute) {
        upstreamNode.onExecute();
      }
      const data = upstreamNode.getOutputData ? upstreamNode.getOutputData(0) : undefined;
      return { success: true, data };
    }
  }

  /**
   * Fallback: use primary input if available and no error, else use fallback.
   */
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

  /**
   * Get the upstream error for a specific input slot, if the upstream node errored.
   */
  _getUpstreamError(node, inputIndex) {
    if (!node.inputs || !node.inputs[inputIndex]) return null;
    const input = node.inputs[inputIndex];
    if (input.link == null) return null;

    const link = this.graph.links[input.link];
    if (!link) return null;

    // Handle both LiteGraph object format and serialized array format
    const originId = link.origin_id !== undefined ? link.origin_id : link[1];
    return this.errorNodes.get(originId) || null;
  }

  /**
   * Get the upstream node ID for a specific input slot.
   */
  _getUpstreamNodeId(node, inputIndex) {
    if (!node.inputs || !node.inputs[inputIndex]) return null;
    const input = node.inputs[inputIndex];
    if (input.link == null) return null;

    const link = this.graph.links[input.link];
    if (!link) return null;

    // Handle both LiteGraph object format and serialized array format
    return link.origin_id !== undefined ? link.origin_id : link[1];
  }

  /**
   * Mark all output slots of a node as active.
   */
  _activateAllOutputs(node) {
    const slots = new Set();
    for (let i = 0; i < (node.outputs || []).length; i++) {
      slots.add(i);
    }
    this.activeOutputs.set(node.id, slots);
  }
}
