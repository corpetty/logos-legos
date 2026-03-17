/**
 * Bridge Client - Communicates with the Logos Legos bridge server.
 * Handles connection management, module discovery, and method execution.
 */
class BridgeClient {
  constructor(baseUrl = "http://localhost:8081") {
    this.baseUrl = baseUrl;
    this.connected = false;
    this.mode = "disconnected"; // "disconnected" | "mock" | "live" | "cli"
    this.listeners = new Map();
    this._pollInterval = null;
    this.moduleStatus = {}; // module name -> { live: bool }
  }

  /**
   * Attempt to connect to the bridge server.
   * Returns status object or null if unreachable.
   */
  async connect() {
    try {
      const status = await this._get("/api/status");
      this.connected = true;
      this.mode = status.mode;
      this._emit("connected", status);
      return status;
    } catch (e) {
      this.connected = false;
      this.mode = "disconnected";
      this._emit("disconnected", { error: e.message });
      return null;
    }
  }

  /**
   * Disconnect and stop polling.
   */
  disconnect() {
    this.connected = false;
    this.mode = "disconnected";
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    this._emit("disconnected", {});
  }

  /**
   * Start polling bridge status every N seconds.
   */
  startPolling(intervalMs = 5000) {
    this.stopPolling();
    this._pollInterval = setInterval(async () => {
      const wasConnected = this.connected;
      await this.connect();
      if (wasConnected && !this.connected) {
        this._emit("connectionLost", {});
      } else if (!wasConnected && this.connected) {
        this._emit("connectionRestored", {});
      }
    }, intervalMs);
  }

  stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  /**
   * Fetch all modules from the bridge (auto-discovery).
   * Returns { modules: [...], mode: "mock"|"live" }
   */
  async fetchModules() {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    const data = await this._get("/api/modules");
    // Track per-module live status
    for (const mod of data.modules || []) {
      this.moduleStatus[mod.name] = { live: !!mod.live };
    }
    this._emit("modulesUpdated", data);
    return data;
  }

  /**
   * Check if a specific module has a live backend.
   */
  isModuleLive(moduleName) {
    return this.moduleStatus[moduleName]?.live || false;
  }

  /**
   * Trigger module re-discovery on the bridge.
   */
  async rediscover() {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    const result = await this._get("/api/discover");
    this._emit("modulesDiscovered", result);
    return result;
  }

  /**
   * Execute a single method call.
   * @param {string} module - Module name (e.g., "logos-chat-module")
   * @param {string} method - Method name (e.g., "sendMessage")
   * @param {object} params - Method parameters
   */
  async execute(module, method, params = {}) {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    const result = await this._post("/api/execute", { module, method, params });
    this._emit("executed", { module, method, params, result });
    return result;
  }

  /**
   * Execute a full workflow pipeline.
   * @param {Array} pipeline - Array of step objects from WorkflowManager.extractPipeline()
   */
  async executeWorkflow(pipeline) {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    this._emit("workflowStarted", { steps: pipeline.length });

    const result = await this._post("/api/workflow", { pipeline });

    this._emit("workflowCompleted", result);
    return result;
  }

  // ── Workflow deployment ──

  /**
   * Deploy a workflow to the bridge for webhook/trigger execution.
   * @param {string} workflowId - Unique identifier for the workflow
   * @param {object} workflow - Serialized graph data (from graph.serialize())
   * @returns {{ success, workflowId, triggers, webhookUrl }}
   */
  async deploy(workflowId, workflow) {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    const result = await this._post("/api/workflows/deploy", { workflowId, workflow });
    this._emit("workflowDeployed", result);
    return result;
  }

  /**
   * Remove a deployed workflow from the bridge.
   * @param {string} workflowId - The workflow to undeploy
   */
  async undeploy(workflowId) {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    const result = await this._post(`/api/workflows/${workflowId}/undeploy`, {});
    this._emit("workflowUndeployed", { workflowId, ...result });
    return result;
  }

  /**
   * List all deployed workflows on the bridge.
   */
  async listDeployed() {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    return await this._get("/api/workflows");
  }

  /**
   * Manually trigger a deployed workflow.
   * @param {string} workflowId - The workflow to trigger
   * @param {string} triggerType - "webhook" | "timer" | "manual"
   * @param {object} data - Trigger data payload
   */
  async triggerWorkflow(workflowId, triggerType, data = {}) {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    const result = await this._post(`/api/workflows/${workflowId}/trigger`, {
      triggerType,
      data,
    });
    this._emit("workflowTriggered", { workflowId, triggerType, ...result });
    return result;
  }

  /**
   * Get recent execution log from the bridge.
   */
  async getExecutions() {
    if (!this.connected) {
      throw new Error("Not connected to bridge");
    }
    return await this._get("/api/executions");
  }

  // ── Event system ──

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const list = this.listeners.get(event);
    if (list) {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  _emit(event, data) {
    const list = this.listeners.get(event);
    if (list) {
      for (const cb of list) {
        try { cb(data); } catch (e) { console.error(`[bridge-client] Event error:`, e); }
      }
    }
  }

  // ── HTTP helpers ──

  _makeController(ms) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl;
  }

  async _get(path) {
    const ctrl = this._makeController(5000);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    return resp.json();
  }

  async _post(path, data) {
    const ctrl = this._makeController(30000);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    return resp.json();
  }
}

// Singleton
window.bridgeClient = new BridgeClient();
