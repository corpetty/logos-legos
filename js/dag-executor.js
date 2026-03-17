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
      } catch (e) {
        errorCount++;
        this.callbacks.setStatus(node, "error");
        this.callbacks.setResult(node, { error: e.message });
        // Deactivate all outputs on error
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
   */
  _isNodeActive(nodeId, reverseAdj) {
    const incoming = reverseAdj.get(nodeId) || [];

    // Root nodes (no inputs connected) are always active
    if (incoming.length === 0) return true;

    const node = this.graph.getNodeById(nodeId);
    const isMerge = node?.properties?._controlFlow === "merge";

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
    const controlFlow = node.properties?._controlFlow;

    if (controlFlow) {
      await this._handleControlFlow(node, controlFlow);
    } else if (node.properties?.module && node.properties?.method) {
      await this._handleModule(node);
    } else {
      // Utility node — just resolve its value
      this._handleUtility(node);
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
   */
  _handleUtility(node) {
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

    const originNode = this.graph.getNodeById(link[1]);
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
    const outputIndex = link[2];
    if (originNode.getOutputData) {
      return originNode.getOutputData(outputIndex);
    }

    return null;
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
