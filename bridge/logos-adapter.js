/**
 * Logos Adapter - Wraps logos-js-sdk (LogosAPI) for use by the bridge server.
 * Handles initialization, module loading, method execution, and introspection.
 * Falls back to mock mode when liblogos_core is not available.
 */
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

class LogosAdapter {
  constructor(options = {}) {
    this.options = options;
    this.logos = null;
    this.mode = "disconnected"; // "live" | "mock" | "disconnected"
    this.loadedModules = [];
    this.knownModules = [];
    this.moduleMetadata = new Map(); // module name -> { methods, metadata }
    this._lmPath = null;
    this._logoscorePath = null;
  }

  /**
   * Initialize the adapter. Tries logos-js-sdk first, falls back to CLI, then mock.
   */
  async init() {
    if (this.options.mock) {
      this.mode = "mock";
      console.log("[adapter] Starting in mock mode (--mock flag)");
      await this._loadMockModules();
      return;
    }

    // Try to find CLI tools
    this._lmPath = this._which("lm");
    this._logoscorePath = this._which("logoscore");

    // Try logos-js-sdk (FFI to liblogos_core)
    try {
      const LogosAPI = this._requireLogosAPI();
      const libPath = this.options.libPath || this._findLibLogosCore();
      const pluginsDir = this.options.pluginsDir || this._findPluginsDir();

      if (!libPath) throw new Error("liblogos_core not found");
      if (!pluginsDir) throw new Error("plugins directory not found");

      console.log(`[adapter] Loading liblogos_core from: ${libPath}`);
      console.log(`[adapter] Plugins directory: ${pluginsDir}`);

      this.logos = new LogosAPI({
        libPath,
        pluginsDir,
        autoInit: true,
      });

      this.logos.start();
      this.mode = "live";

      // Discover available modules
      const status = this.logos.getPluginStatus();
      this.knownModules = status.known || [];
      this.loadedModules = status.loaded || [];

      console.log(`[adapter] Live mode - ${this.knownModules.length} known, ${this.loadedModules.length} loaded`);

      // Introspect modules for method signatures
      await this._introspectModules(pluginsDir);

      return;
    } catch (e) {
      console.log(`[adapter] logos-js-sdk not available: ${e.message}`);
    }

    // Try logoscore CLI fallback
    if (this._logoscorePath) {
      this.mode = "cli";
      console.log(`[adapter] Using logoscore CLI: ${this._logoscorePath}`);
      await this._discoverViaCLI();
      return;
    }

    // Fall back to mock
    this.mode = "mock";
    console.log("[adapter] No logos-core found, starting in mock mode");
    await this._loadMockModules();
  }

  /**
   * Get adapter status.
   */
  status() {
    return {
      mode: this.mode,
      logoscore: !!this._logoscorePath,
      lm: !!this._lmPath,
      sdk: this.logos !== null,
      modules: this.loadedModules.length,
      knownModules: this.knownModules.length,
    };
  }

  /**
   * Get all module definitions with metadata and methods.
   */
  getModules() {
    const modules = [];
    for (const [name, meta] of this.moduleMetadata) {
      const isRealModule = !!meta._introspected; // has a real compiled plugin
      modules.push({
        name,
        displayName: meta.displayName || this._toDisplayName(name),
        version: meta.version || "0.0.0",
        description: meta.description || "",
        category: meta.category || "Other",
        color: meta.color || "#607D8B",
        type: meta.type || "service",
        dependencies: meta.dependencies || [],
        methods: meta.methods || [],
        live: isRealModule, // true if we have a real compiled plugin
      });
    }
    return modules;
  }

  /**
   * Get a single module by name.
   */
  getModule(name) {
    const meta = this.moduleMetadata.get(name);
    if (!meta) return null;
    return {
      name,
      displayName: meta.displayName || this._toDisplayName(name),
      version: meta.version || "0.0.0",
      description: meta.description || "",
      methods: meta.methods || [],
      live: this.loadedModules.includes(name),
    };
  }

  /**
   * Load a module by name.
   */
  async loadModule(name) {
    if (this.mode === "live" && this.logos) {
      try {
        this.logos.processAndLoadPlugin(name);
        const status = this.logos.getPluginStatus();
        this.loadedModules = status.loaded || [];
        return { success: true, loaded: this.loadedModules };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: "Not in live mode" };
  }

  /**
   * Execute a module method.
   */
  async execute(moduleName, methodName, params = {}) {
    const startTime = Date.now();

    // Check if this module has a real plugin (introspected, not mock)
    const meta = this.moduleMetadata.get(moduleName);
    const isRealModule = meta && meta._introspected; // has a real compiled plugin

    if (this.mode === "live" && this.logos && isRealModule) {
      return this._executeLive(moduleName, methodName, params);
    }

    if (this.mode === "cli" && this._logoscorePath && isRealModule) {
      return this._executeCLI(moduleName, methodName, params);
    }

    // Mock execution for unbuilt modules or mock mode
    return this._executeMock(moduleName, methodName, params, startTime);
  }

  /**
   * Execute a workflow pipeline.
   */
  async executeWorkflow(pipeline) {
    const results = [];
    const context = {};

    for (const step of pipeline) {
      const { nodeId, module: moduleName, method, params = {} } = step;

      // Bind inputs from upstream outputs
      const boundParams = { ...params };
      for (const [key, source] of Object.entries(step.inputBindings || {})) {
        const srcNode = source.nodeId;
        const srcOutput = source.output;
        if (context[srcNode] && context[srcNode][srcOutput] !== undefined) {
          boundParams[key] = context[srcNode][srcOutput];
        }
      }

      const result = await this.execute(moduleName, method, boundParams);
      results.push({ nodeId, module: moduleName, method, result });

      // Store outputs for downstream
      if (result.success && result.data) {
        context[nodeId] = result.data;
      }
    }

    return {
      success: results.every((r) => r.result.success),
      steps: results,
    };
  }

  /**
   * Re-discover modules.
   */
  async discover() {
    if (this.mode === "live" && this.logos) {
      const status = this.logos.getPluginStatus();
      this.knownModules = status.known || [];
      this.loadedModules = status.loaded || [];
      return { discovered: this.knownModules.length, modules: this.knownModules };
    }

    if (this.mode === "cli") {
      await this._discoverViaCLI();
      return { discovered: this.moduleMetadata.size, modules: [...this.moduleMetadata.keys()] };
    }

    return { discovered: this.moduleMetadata.size, modules: [...this.moduleMetadata.keys()] };
  }

  // ── Live Execution (logos-js-sdk) ──────────────────────────────────────

  async _executeLive(moduleName, methodName, params) {
    // Ensure module is loaded
    if (!this.loadedModules.includes(moduleName)) {
      try {
        this.logos.processAndLoadPlugin(moduleName);
        const status = this.logos.getPluginStatus();
        this.loadedModules = status.loaded || [];
      } catch (e) {
        return { success: false, error: `Failed to load module: ${e.message}`, live: true };
      }
    }

    return new Promise((resolve) => {
      const shortName = this._shortName(moduleName);
      const paramsJson = JSON.stringify(
        Object.entries(params).map(([name, value]) => ({
          name,
          value: String(value),
          type: this._inferType(value),
        }))
      );

      this.logos.callPluginMethodAsync(
        shortName,
        methodName,
        paramsJson,
        (success, message, meta) => {
          resolve({
            success,
            data: success ? message : null,
            error: success ? null : (typeof message === "string" ? message : JSON.stringify(message)),
            call: `logos.${shortName}.${methodName}(${JSON.stringify(params)})`,
            live: true,
            duration: Date.now() - Date.now(), // TODO: track properly
          });
        }
      );

      // Process events to ensure callback fires
      if (this.logos.LogosCore) {
        setTimeout(() => this.logos.LogosCore.logos_core_process_events(), 50);
        setTimeout(() => this.logos.LogosCore.logos_core_process_events(), 200);
        setTimeout(() => this.logos.LogosCore.logos_core_process_events(), 500);
      }

      // Timeout after 30 seconds
      setTimeout(() => {
        resolve({
          success: false,
          error: "Method call timed out (30s)",
          call: `logos.${shortName}.${methodName}(${JSON.stringify(params)})`,
          live: true,
        });
      }, 30000);
    });
  }

  // ── CLI Execution (logoscore -c) ───────────────────────────────────────

  async _executeCLI(moduleName, methodName, params) {
    // CLI mode uses the actual module name (not the display-friendly short name)
    const args = Object.values(params)
      .map((v) => (typeof v === "string" ? v : String(v)))
      .join(",");
    const callStr = `${moduleName}.${methodName}(${args})`;

    try {
      const modulesDir = this.options.pluginsDir || this._findPluginsDir();
      const cmd = `"${this._logoscorePath}"` +
        (modulesDir ? ` -m "${modulesDir}"` : "") +
        ` -l ${moduleName}` +
        ` -c "${callStr}"` +
        ` --quit-on-finish`;

      console.log(`[adapter] CLI exec: ${cmd}`);
      const output = execSync(cmd, { timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

      // Parse output - logoscore outputs "Method call successful. Result: <value>"
      // Also captures Debug/Warning lines we want to filter
      const lines = output.split("\n");
      const resultLine = lines.find((l) => l.includes("Method call successful. Result:"));
      let data;
      if (resultLine) {
        const resultStr = resultLine.replace(/.*Result:\s*/, "").trim();
        try {
          data = JSON.parse(resultStr);
        } catch {
          data = { output: resultStr };
        }
      } else {
        // Check for error
        const errorLine = lines.find((l) => l.includes("Method call failed"));
        if (errorLine) {
          return {
            success: false,
            error: errorLine,
            call: `logoscore -c "${callStr}"`,
            live: true,
          };
        }
        data = { output: output.trim() };
      }

      return {
        success: true,
        data,
        call: `logoscore -c "${callStr}"`,
        live: true,
      };
    } catch (e) {
      // execSync throws on non-zero exit - extract stderr
      const stderr = e.stderr ? e.stderr.toString() : e.message;
      return {
        success: false,
        error: stderr.split("\n").filter((l) => !l.startsWith("Debug:") && !l.startsWith("Warning:")).join("\n").trim() || e.message,
        call: `logoscore -c "${callStr}"`,
        live: true,
      };
    }
  }

  // ── Mock Execution ─────────────────────────────────────────────────────

  async _executeMock(moduleName, methodName, params, startTime) {
    // Simulate latency
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 500));

    const shortName = this._shortName(moduleName);
    const ts = Math.floor(Date.now() / 1000);
    const data = this._generateMockResponse(methodName, params, ts);

    return {
      success: true,
      data,
      call: `logos.${shortName}.${methodName}(${JSON.stringify(params)})`,
      mock: true,
      duration: Date.now() - startTime,
    };
  }

  _generateMockResponse(method, params, ts) {
    const m = method.toLowerCase();

    if (m.includes("send") || m.includes("publish")) {
      return { messageId: `msg_${ts}`, timestamp: ts, status: "sent" };
    }
    if (m.includes("balance")) {
      return { address: params.address || "0x1234...abcd", balance: "1.42", token: "ETH" };
    }
    if (m.includes("block") && !m.includes("submit")) {
      return {
        blockNumber: 18847293 + Math.floor(Math.random() * 100),
        hash: `0x${Array(8).fill(0).map(() => Math.random().toString(16).slice(2, 6)).join("")}`,
        timestamp: ts,
        transactions: Math.floor(Math.random() * 200),
        parentHash: `0x${Array(8).fill(0).map(() => Math.random().toString(16).slice(2, 6)).join("")}`,
      };
    }
    if (m.includes("history") || m.includes("list")) {
      return Array.from({ length: 3 }, (_, i) => ({
        id: `item_${ts - i}`,
        timestamp: ts - i * 60,
        data: `Sample item ${i + 1}`,
      }));
    }
    if (m.includes("store") || m.includes("upload")) {
      return { contentId: `Qm${Array(6).fill(0).map(() => Math.random().toString(36).slice(2, 5)).join("")}`, size: 1024, status: "stored" };
    }
    if (m.includes("retrieve") || m.includes("download")) {
      return { contentId: params.contentId || "QmTest123", data: "SGVsbG8gV29ybGQ=", metadata: "{}" };
    }
    if (m.includes("connect")) {
      return { connectionId: `conn_${ts}`, status: "connected", server: params.server || "localhost" };
    }
    if (m.includes("peer")) {
      return Array.from({ length: 4 }, (_, i) => ({
        peerId: `16Uiu2HAm${Math.random().toString(36).slice(2, 10)}`,
        address: `/ip4/192.168.1.${10 + i}/tcp/6000`,
        protocols: ["/waku/2/relay/1.0.0"],
      }));
    }
    if (m.includes("status") || m.includes("info")) {
      return { status: "running", uptime: 3600, version: "0.1.0", peers: 12 };
    }
    if (m.includes("search")) {
      return Array.from({ length: 2 }, (_, i) => ({
        name: `result_${i}`,
        description: `Search result ${i + 1}`,
        version: "1.0.0",
      }));
    }
    if (m.includes("create") || m.includes("register")) {
      return { id: `new_${ts}`, name: params.name || "unnamed", created: ts };
    }
    if (m.includes("authenticate") || m.includes("login")) {
      return { token: `tok_${ts}`, expiresIn: 3600 };
    }
    if (m.includes("sign")) {
      return { signature: `0x${Array(32).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join("")}` };
    }
    if (m.includes("install")) {
      return { package: params.packageName || "unknown", version: "1.0.0", status: "installed" };
    }
    if (m.includes("discover") || m.includes("announce") || m.includes("capability")) {
      return Array.from({ length: 3 }, (_, i) => ({
        peerId: `peer_${i}`,
        capabilities: ["storage", "relay", "chat"],
      }));
    }
    return { status: "ok", timestamp: ts };
  }

  // ── Module Discovery ───────────────────────────────────────────────────

  async _introspectModules(pluginsDir) {
    if (!this._lmPath || !pluginsDir) return;

    const ext = process.platform === "darwin" ? ".dylib" : ".so";

    try {
      // Find .so files - either flat or in subdirectories (modules/modname/modname_plugin.so)
      const pluginFiles = [];
      const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Check subdirectory for plugin .so files
          const subdir = path.join(pluginsDir, entry.name);
          try {
            const subFiles = fs.readdirSync(subdir).filter((f) => f.endsWith(`_plugin${ext}`));
            for (const f of subFiles) {
              pluginFiles.push(path.join(subdir, f));
            }
          } catch {}
        } else if (entry.name.endsWith(`_plugin${ext}`)) {
          pluginFiles.push(path.join(pluginsDir, entry.name));
        }
      }

      console.log(`[adapter] Found ${pluginFiles.length} plugin files to introspect`);

      for (const pluginPath of pluginFiles) {
        try {
          const output = execSync(`"${this._lmPath}" "${pluginPath}" --json`, {
            timeout: 10000,
            encoding: "utf-8",
          });
          const data = JSON.parse(output);
          const name = data.metadata?.name || path.basename(pluginPath).replace(`_plugin${ext}`, "");

          // Filter to only invokable methods (the public API)
          const invokableMethods = (data.methods || []).filter(
            (m) => m.isInvokable && m.name !== "initLogos" && m.name !== "eventResponse"
          );

          this.moduleMetadata.set(name, {
            ...data.metadata,
            _introspected: true, // Flag: this module has a real compiled plugin
            methods: invokableMethods.map((m) => ({
              name: m.name,
              description: m.description || "",
              inputs: (m.parameters || []).map((p) => ({
                name: p.name,
                type: this._mapQtType(p.type),
                description: "",
              })),
              outputs: [
                {
                  name: m.returnType === "void" ? "result" : "value",
                  type: this._mapQtType(m.returnType || "void"),
                  description: "",
                },
              ],
            })),
          });

          this.knownModules.push(name);
          console.log(`[adapter] Introspected ${name}: ${invokableMethods.length} invokable methods`);
        } catch (e) {
          console.log(`[adapter] Failed to introspect ${path.basename(pluginPath)}: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[adapter] Module introspection failed: ${e.message}`);
    }
  }

  async _discoverViaCLI() {
    const pluginsDir = this.options.pluginsDir || this._findPluginsDir();
    if (pluginsDir) {
      await this._introspectModules(pluginsDir);
    }
    // Always load mock modules as fallback for modules not yet built
    await this._loadMockModules();
  }

  async _loadMockModules() {
    const mockPath = path.resolve(__dirname, "../data/modules.json");
    if (!fs.existsSync(mockPath)) {
      console.log("[adapter] No mock modules.json found");
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(mockPath, "utf-8"));
      let added = 0;
      for (const mod of data.modules || []) {
        // Don't overwrite real introspected modules
        if (!this.moduleMetadata.has(mod.name)) {
          this.moduleMetadata.set(mod.name, mod);
          if (!this.knownModules.includes(mod.name)) {
            this.knownModules.push(mod.name);
          }
          added++;
        }
      }
      console.log(`[adapter] Added ${added} mock modules (${this.moduleMetadata.size} total)`);
    } catch (e) {
      console.log(`[adapter] Failed to load mock modules: ${e.message}`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _requireLogosAPI() {
    // Try workspace path
    const workspacePath = path.resolve(__dirname, "../../../logos-co/logos-workspace/repos/logos-js-sdk");
    if (fs.existsSync(path.join(workspacePath, "index.js"))) {
      return require(workspacePath);
    }
    // Try standalone clone
    const standalonePath = path.resolve(__dirname, "../../../logos-co/logos-js-sdk");
    if (fs.existsSync(path.join(standalonePath, "index.js"))) {
      return require(standalonePath);
    }
    // Try npm package
    return require("logos-api");
  }

  _findLibLogosCore() {
    const ext = process.platform === "darwin" ? ".dylib" : ".so";
    const candidates = [
      this.options.libPath,
      path.resolve(__dirname, "../../../logos-co/logos-workspace/result/lib/liblogos_core" + ext),
      path.resolve(__dirname, "../../../logos-co/logos-workspace/repos/logos-liblogos/result/lib/liblogos_core" + ext),
      path.resolve(__dirname, "../../../logos-co/logos-liblogos/result/lib/liblogos_core" + ext),
      path.resolve(__dirname, "../../../logos-co/logos-liblogos/build/lib/liblogos_core" + ext),
    ].filter(Boolean);

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  _findPluginsDir() {
    const candidates = [
      this.options.pluginsDir,
      path.resolve(__dirname, "../../../logos-co/logos-workspace/result/modules"),
      path.resolve(__dirname, "../../../logos-co/logos-workspace/repos/logos-liblogos/result/modules"),
      path.resolve(__dirname, "../../../logos-co/logos-workspace/repos/logos-liblogos/result/lib"),
      path.resolve(__dirname, "../../../logos-co/logos-liblogos/result/modules"),
      path.resolve(__dirname, "../modules"),
    ].filter(Boolean);

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  _which(cmd) {
    // Check workspace result/bin first (Nix build output)
    const wsResult = path.resolve(__dirname, "../../../logos-co/logos-workspace/result/bin", cmd);
    if (fs.existsSync(wsResult)) return wsResult;

    // Check Nix store for lm (the workspace script wrapper requires nix on PATH)
    if (cmd === "lm") {
      try {
        const nixPaths = execSync(
          'find /nix/store -maxdepth 3 -name "lm" -path "*/bin/lm" -type f 2>/dev/null | head -1',
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        if (nixPaths) return nixPaths;
      } catch {}
    }

    // Check workspace scripts (these are wrapper scripts that need nix)
    const wsScript = path.resolve(__dirname, "../../../logos-co/logos-workspace/scripts", cmd);
    if (fs.existsSync(wsScript)) return wsScript;

    try {
      return execSync(`which ${cmd}`, { encoding: "utf-8" }).trim() || null;
    } catch {
      return null;
    }
  }

  _shortName(moduleName) {
    // "logos-chat-module" -> "chat", "logos_waku_module" -> "waku_module"
    return moduleName
      .replace(/^logos[-_]/, "")
      .replace(/[-_]module$/, "");
  }

  _toDisplayName(name) {
    return this._shortName(name)
      .split(/[-_]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
  }

  _mapQtType(qtType) {
    const map = {
      QString: "string",
      "const QString&": "string",
      int: "number",
      double: "number",
      float: "number",
      bool: "boolean",
      QVariant: "object",
      QVariantMap: "object",
      QVariantList: "object",
      QByteArray: "bytes",
      void: "object",
      LogosResult: "object",
    };
    return map[qtType] || "object";
  }

  _inferType(value) {
    if (typeof value === "boolean") return "bool";
    if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
    return "string";
  }
}

module.exports = LogosAdapter;
