/**
 * Logos Legos - Main Application
 * ComfyUI-style visual workflow builder for Logos Core modules.
 */
class LogosLegosApp {
  constructor() {
    this.graph = null;
    this.canvas = null;
    this.workflow = null;
    this.registry = window.moduleRegistry;
    this.bridge = window.bridgeClient;
    this.running = false;
  }

  async init() {
    // Load module registry (static first, bridge will overlay if connected)
    await this.registry.load();

    // Configure LiteGraph defaults
    LiteGraph.CANVAS_GRID_SIZE = 20;
    LiteGraph.NODE_TEXT_SIZE = 13;

    // Register all node types from the registry
    registerModuleNodes(this.registry);

    // Create graph and canvas
    this.graph = new LGraph();
    const canvasEl = document.getElementById("graph-canvas");
    this.canvas = new LGraphCanvas(canvasEl, this.graph);

    // Canvas appearance
    this.canvas.background_image = null;
    this.canvas.render_shadows = false;
    this.canvas.render_canvas_border = false;
    this.canvas.clear_background_color = "#1a1a2e";
    this.canvas.default_link_color = "#aaa";
    this.canvas.highquality_render = true;
    this.canvas.render_curved_connections = true;
    this.canvas.render_connection_arrows = true;
    this.canvas.links_render_mode = LiteGraph.SPLINE_LINK;
    this.canvas.show_info = false;

    // Workflow manager
    this.workflow = new WorkflowManager(this.graph);

    // Build sidebar
    this.buildSidebar();

    // Bind toolbar actions
    this.bindToolbar();

    // Setup bridge connection UI
    this.setupBridge();

    // Setup link data tooltip (right-click on links after execution)
    this.setupLinkTooltip();

    // Handle resize
    this.handleResize();
    window.addEventListener("resize", () => this.handleResize());

    // Start graph execution loop (for live preview)
    this.graph.start(1000);

    // Expose for debugging
    window.app = this;

    console.log(
      `Logos Legos initialized: ${this.registry.getModules().length} modules, ${this.registry.utilityNodes.length} utility nodes`
    );
  }

  handleResize() {
    const canvasEl = document.getElementById("graph-canvas");
    const container = document.getElementById("canvas-container");
    canvasEl.width = container.clientWidth;
    canvasEl.height = container.clientHeight;
    this.canvas.resize();
  }

  /**
   * Zoom and pan to fit all nodes in the viewport.
   */
  zoomToFit() {
    const nodes = this.graph._nodes;
    if (!nodes || nodes.length === 0) {
      this.canvas.ds.reset();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.pos[0]);
      minY = Math.min(minY, n.pos[1]);
      maxX = Math.max(maxX, n.pos[0] + n.size[0]);
      maxY = Math.max(maxY, n.pos[1] + n.size[1]);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = maxX - minX + 200;
    const h = maxY - minY + 200;
    const scale = Math.min(
      this.canvas.canvas.width / w,
      this.canvas.canvas.height / h,
      1.0
    ) * 0.85;
    this.canvas.ds.scale = scale;
    this.canvas.ds.offset[0] = -cx * scale + this.canvas.canvas.width / 2;
    this.canvas.ds.offset[1] = -cy * scale + this.canvas.canvas.height / 2;
    this.canvas.setDirty(true, true);
  }

  // ── Bridge Connection ─────────────────────────────────────────────────

  setupBridge() {
    const connectBtn = document.getElementById("btn-connect");
    const connectIcon = document.getElementById("connect-icon");
    const connectLabel = document.getElementById("connect-label");
    const statusDot = document.getElementById("status-dot");
    const statusMode = document.getElementById("status-mode");

    // Connection button
    connectBtn.addEventListener("click", async () => {
      if (this.bridge.connected) {
        this.bridge.disconnect();
        return;
      }
      connectLabel.textContent = "Connecting...";
      const status = await this.bridge.connect();
      if (status) {
        this.showNotification(
          `Connected to bridge (${status.mode} mode)`,
          "success"
        );
        // Reload modules from bridge
        await this.reloadFromBridge();
      } else {
        this.showNotification(
          "Cannot reach bridge server. Run: node bridge/server.js",
          "error"
        );
      }
    });

    // Bridge events
    this.bridge.on("connected", (status) => {
      connectIcon.innerHTML = "&#9679;";
      connectIcon.style.color = status.mode === "live" ? "#4CAF50" : "#FF9800";
      connectLabel.textContent = "Disconnect";
      connectBtn.classList.add("connected");
      statusDot.className = `status-dot ${status.mode === "live" ? "green" : "yellow"}`;
      const modeLabel = status.mode === "live" ? "Live" : status.mode === "cli" ? "CLI" : "Mock";
      const moduleCount = status.knownModules || status.modules || 0;
      statusMode.textContent = `${modeLabel} (${moduleCount} modules)`;
      // Rebuild sidebar to show badges
      this.buildSidebar();
    });

    this.bridge.on("disconnected", () => {
      connectIcon.innerHTML = "&#9679;";
      connectIcon.style.color = "";
      connectLabel.textContent = "Connect";
      connectBtn.classList.remove("connected");
      statusDot.className = "status-dot yellow";
      statusMode.textContent = `Offline (static data)`;
    });

    this.bridge.on("connectionLost", () => {
      this.showNotification("Lost connection to bridge server", "warning");
    });

    this.bridge.on("connectionRestored", () => {
      this.showNotification("Reconnected to bridge server", "success");
    });

    // Start polling once connected
    this.bridge.on("connected", () => {
      this.bridge.startPolling(10000);
    });
    this.bridge.on("disconnected", () => {
      this.bridge.stopPolling();
    });
  }

  /**
   * Reload modules from the bridge and rebuild the sidebar + node types.
   */
  async reloadFromBridge() {
    try {
      await this.registry.loadFromBridge(this.bridge);
      // Re-register node types with the new module data
      registerModuleNodes(this.registry);
      // Rebuild sidebar
      this.buildSidebar();
      this.showNotification(
        `Loaded ${this.registry.getModules().length} modules from bridge (${this.registry.source})`,
        "success"
      );
    } catch (e) {
      this.showNotification(`Bridge module load error: ${e.message}`, "error");
    }
  }

  // ── Workflow Execution ────────────────────────────────────────────────

  /**
   * Execute the current workflow via the bridge.
   * Uses DAGExecutor for branch-aware execution with control flow support.
   */
  async runWorkflow() {
    if (this.running) {
      this.showNotification("Workflow already running", "warning");
      return;
    }

    // Validate first
    const validation = this.workflow.validate();
    if (!validation.valid) {
      this.showValidation(validation);
      return;
    }

    // Check there are actually nodes to execute
    const nodes = this.graph._nodes || [];
    const hasExecutable = nodes.some(n =>
      (n.properties?.module && n.properties?.method) ||
      n.properties?._controlFlow
    );
    if (!hasExecutable) {
      this.showNotification("No module or control flow nodes to execute", "warning");
      return;
    }

    this.running = true;
    this.updateRunButton(true);
    this.clearNodeResults();

    const useBridge = this.bridge.connected;
    const app = this;

    // Create DAG executor with callbacks
    const executor = new DAGExecutor(this.graph, {
      execute: async (module, method, params) => {
        if (useBridge) {
          return await app.bridge.execute(module, method, params);
        } else {
          // Mock execution
          await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
          const ts = Math.floor(Date.now() / 1000);
          return {
            success: true,
            data: {
              status: "ok",
              call: `logos.${(module || "").replace("logos-", "").replace("-module", "")}.${method}()`,
              timestamp: ts,
              mock: true,
            },
          };
        }
      },
      setStatus: (node, status) => app.setNodeStatus(node, status),
      setResult: (node, data) => app.setNodeResult(node, data),
      resolveInputs: (node) => app.gatherNodeInputs(node),
    });

    const modeLabel = useBridge ? "via bridge" : "locally (mock)";
    this.showNotification(`Executing workflow ${modeLabel}...`, "info");

    try {
      const result = await executor.run();
      const msg = result.success
        ? `Workflow complete: ${result.steps} steps executed` +
          (result.skipped > 0 ? `, ${result.skipped} skipped` : "")
        : `Workflow finished with ${result.errors} error(s)`;
      this.showNotification(msg, result.success ? "success" : "error");
    } catch (e) {
      this.showNotification(`Workflow error: ${e.message}`, "error");
    }

    this.running = false;
    this.updateRunButton(false);
  }

  /**
   * Deploy the current workflow to the bridge server for webhook/trigger execution.
   */
  async deployWorkflow() {
    if (!this.bridge.connected) {
      this.showNotification("Connect to bridge server first", "warning");
      return;
    }

    // Validate first
    const validation = this.workflow.validate();
    if (!validation.valid) {
      this.showValidation(validation);
      return;
    }

    const workflowId = prompt("Workflow ID (used in webhook URL):", "my-workflow");
    if (!workflowId) return;

    // Serialize the graph
    const graphData = this.graph.serialize();

    try {
      const result = await this.bridge.deploy(workflowId, graphData);
      if (result.success) {
        let msg = `Deployed "${workflowId}" (${result.triggers.length} trigger(s))`;
        if (result.webhookUrl) {
          msg += `\nWebhook: ${result.webhookUrl}`;
        }
        this.showNotification(msg, "success");

        // Show webhook URL in info panel if there's a webhook trigger
        if (result.webhookUrl) {
          this.showDeployResult(workflowId, result);
        }
      } else {
        this.showNotification(`Deploy failed: ${result.error}`, "error");
      }
    } catch (e) {
      this.showNotification(`Deploy error: ${e.message}`, "error");
    }
  }

  /**
   * Show deployment result with webhook URL in the info panel.
   */
  showDeployResult(workflowId, result) {
    const panel = document.getElementById("info-panel");
    const content = document.getElementById("info-content");

    const webhookUrl = result.webhookUrl || `http://localhost:8081/api/webhooks/${workflowId}`;
    const curlCmd = `curl -X POST ${webhookUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"message": "hello from webhook"}'`;

    let html = `<h3 style="color: #E040FB">⚡ Workflow Deployed</h3>`;
    html += `<p>Workflow <strong>${workflowId}</strong> is now live on the bridge.</p>`;
    html += `<h4>Triggers</h4>`;
    html += `<ul>`;
    for (const trigger of result.triggers || []) {
      html += `<li>${trigger.type}${trigger.path ? ` (${trigger.path})` : ""}</li>`;
    }
    html += `</ul>`;

    if (result.webhookUrl) {
      html += `<h4>Webhook URL</h4>`;
      html += `<pre class="cli-output">${webhookUrl}</pre>`;
      html += `<h4>Test with cURL</h4>`;
      html += `<pre class="cli-output">${curlCmd}</pre>`;
      html += `<button onclick="navigator.clipboard.writeText('${webhookUrl}').then(()=>window.app.showNotification('URL copied!','success'))">Copy URL</button>`;
    }

    content.innerHTML = html;
    panel.classList.add("visible");
  }

  /**
   * Gather input values for a node from its connected upstream nodes.
   */
  gatherNodeInputs(node) {
    const params = {};
    if (!node || !node.inputs) return params;

    for (let i = 0; i < node.inputs.length; i++) {
      const input = node.inputs[i];
      let data = node.getInputData(i);

      // If getInputData returned nothing, manually resolve from connected node
      if (data === undefined || data === null) {
        data = this.resolveInputValue(node, i);
      }

      if (data !== undefined && data !== null) {
        params[input.name] = data;
      }
    }
    return params;
  }

  /**
   * Manually resolve an input value by walking the link to the origin node.
   * Handles utility nodes (read properties.value) and chained module nodes
   * (read _executionResult from a previous pipeline step).
   */
  resolveInputValue(node, inputIndex) {
    const input = node.inputs[inputIndex];
    if (!input || input.link == null) return null;

    const link = this.graph.links[input.link];
    if (!link) return null;

    const originNode = this.graph.getNodeById(link[1]);
    if (!originNode) return null;

    // If origin node already ran in this pipeline, use its result
    if (originNode._executionResult !== undefined) {
      return originNode._executionResult;
    }

    // Utility nodes store their value in properties
    if (originNode.properties && originNode.properties.value !== undefined) {
      return originNode.properties.value;
    }

    // Last resort: try the origin's output data directly
    const outputIndex = link[2];
    if (originNode.getOutputData) {
      return originNode.getOutputData(outputIndex);
    }

    return null;
  }

  /**
   * Set a visual status indicator on a node.
   */
  setNodeStatus(node, status) {
    node._executionStatus = status;
    this.canvas.setDirty(true, true);
  }

  /**
   * Store and display execution result on a node.
   */
  setNodeResult(node, data) {
    node._executionResult = data;
    // Pass result data to outputs so downstream nodes can see it
    if (node.outputs) {
      for (let i = 0; i < node.outputs.length; i++) {
        node.setOutputData(i, data);
      }
    }
    this.canvas.setDirty(true, true);
  }

  /**
   * Clear execution results from all nodes.
   */
  clearNodeResults() {
    for (const node of this.graph._nodes || []) {
      delete node._executionStatus;
      delete node._executionResult;
    }
    this.canvas.setDirty(true, true);
  }

  /**
   * Update the Run button appearance.
   */
  updateRunButton(running) {
    const btn = document.getElementById("btn-run");
    if (running) {
      btn.classList.add("running");
      btn.innerHTML = `<span class="icon">&#9632;</span> Running...`;
    } else {
      btn.classList.remove("running");
      btn.innerHTML = `<span class="icon">&#9654;</span> Run`;
    }
  }

  // ── Sidebar ───────────────────────────────────────────────────────────

  /**
   * Build the sidebar with module categories and drag-to-add nodes.
   */
  buildSidebar() {
    const sidebar = document.getElementById("sidebar-modules");
    sidebar.innerHTML = "";

    const categories = this.registry.getCategories();

    for (const [catName, modules] of categories) {
      const section = document.createElement("div");
      section.className = "sidebar-category";

      const header = document.createElement("div");
      header.className = "category-header";
      header.innerHTML = `
        <span class="category-toggle">&#9660;</span>
        <span class="category-name">${catName}</span>
        <span class="category-count">${modules.length}</span>
      `;
      header.addEventListener("click", () => {
        section.classList.toggle("collapsed");
        const toggle = header.querySelector(".category-toggle");
        toggle.innerHTML = section.classList.contains("collapsed")
          ? "&#9654;"
          : "&#9660;";
      });
      section.appendChild(header);

      const moduleList = document.createElement("div");
      moduleList.className = "module-list";

      for (const mod of modules) {
        const modItem = document.createElement("div");
        modItem.className = "module-item";

        const modHeader = document.createElement("div");
        modHeader.className = "module-header";
        const isLive = this.bridge.connected && this.bridge.isModuleLive(mod.name);
        const badgeClass = isLive ? "live" : "mock";
        const badgeText = isLive ? "LIVE" : "MOCK";
        const badgeHtml = this.bridge.connected
          ? `<span class="module-badge ${badgeClass}">${badgeText}</span>`
          : "";
        modHeader.innerHTML = `
          <span class="module-color" style="background:${mod.color}"></span>
          <span class="module-name">${mod.displayName}</span>
          ${badgeHtml}
          <span class="module-version">${mod.version}</span>
          <span class="module-expand">&#9654;</span>
        `;
        modHeader.addEventListener("click", (e) => {
          e.stopPropagation();
          modItem.classList.toggle("expanded");
          const expand = modHeader.querySelector(".module-expand");
          expand.innerHTML = modItem.classList.contains("expanded")
            ? "&#9660;"
            : "&#9654;";
        });
        modItem.appendChild(modHeader);

        const methodList = document.createElement("div");
        methodList.className = "method-list";

        for (const method of mod.methods) {
          const methodItem = document.createElement("div");
          methodItem.className = "method-item";
          methodItem.draggable = true;
          methodItem.title = method.description;
          methodItem.innerHTML = `
            <span class="method-name">${method.name}</span>
            <span class="method-io">${method.inputs.length}&#8594;${method.outputs.length}</span>
          `;

          // Drag to add node
          methodItem.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData(
              "text/plain",
              JSON.stringify({
                type: "method",
                nodeType: `${mod.displayName}/${method.name}`,
              })
            );
            methodItem.classList.add("dragging");
          });
          methodItem.addEventListener("dragend", () => {
            methodItem.classList.remove("dragging");
          });

          // Click to add at center
          methodItem.addEventListener("dblclick", () => {
            this.addNodeAtCenter(`${mod.displayName}/${method.name}`);
          });

          methodList.appendChild(methodItem);
        }

        modItem.appendChild(methodList);
        moduleList.appendChild(modItem);
      }

      section.appendChild(moduleList);
      sidebar.appendChild(section);
    }

    // Utility + Transform nodes sections (grouped by category)
    if (this.registry.utilityNodes.length > 0) {
      const utilByCategory = new Map();
      for (const util of this.registry.utilityNodes) {
        const cat = util.category || "Utility";
        if (!utilByCategory.has(cat)) utilByCategory.set(cat, []);
        utilByCategory.get(cat).push(util);
      }

      for (const [catName, nodes] of utilByCategory) {
        const isTransform = catName === "Transform";
        const catSection = document.createElement("div");
        catSection.className = "sidebar-category";

        const catHeader = document.createElement("div");
        catHeader.className = "category-header";
        catHeader.innerHTML = `
          <span class="category-toggle">&#9660;</span>
          <span class="category-name">${catName}</span>
          <span class="category-count">${nodes.length}</span>
        `;
        catHeader.addEventListener("click", () => {
          catSection.classList.toggle("collapsed");
          const toggle = catHeader.querySelector(".category-toggle");
          toggle.innerHTML = catSection.classList.contains("collapsed")
            ? "&#9654;"
            : "&#9660;";
        });
        catSection.appendChild(catHeader);

        const nodeList = document.createElement("div");
        nodeList.className = "module-list";

        for (const util of nodes) {
          const item = document.createElement("div");
          item.className = `method-item ${isTransform ? "transform-item" : "utility-item"}`;
          item.draggable = true;
          item.title = util.description;
          item.innerHTML = `
            <span class="method-name">${util.displayName}</span>
            <span class="method-io">${(util.inputs || []).length}&#8594;${(util.outputs || []).length}</span>
          `;

          item.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData(
              "text/plain",
              JSON.stringify({
                type: "utility",
                nodeType: `${util.category}/${util.name}`,
              })
            );
          });
          item.addEventListener("dblclick", () => {
            this.addNodeAtCenter(`${util.category}/${util.name}`);
          });

          nodeList.appendChild(item);
        }

        catSection.appendChild(nodeList);
        sidebar.appendChild(catSection);
      }
    }

    // Control Flow nodes section
    if (this.registry.controlFlowNodes.length > 0) {
      const flowSection = document.createElement("div");
      flowSection.className = "sidebar-category";

      const flowHeader = document.createElement("div");
      flowHeader.className = "category-header";
      flowHeader.innerHTML = `
        <span class="category-toggle">&#9660;</span>
        <span class="category-name">Flow</span>
        <span class="category-count">${this.registry.controlFlowNodes.length}</span>
      `;
      flowHeader.addEventListener("click", () => {
        flowSection.classList.toggle("collapsed");
        const toggle = flowHeader.querySelector(".category-toggle");
        toggle.innerHTML = flowSection.classList.contains("collapsed")
          ? "&#9654;"
          : "&#9660;";
      });
      flowSection.appendChild(flowHeader);

      const flowList = document.createElement("div");
      flowList.className = "module-list";

      for (const cfNode of this.registry.controlFlowNodes) {
        const item = document.createElement("div");
        item.className = "method-item flow-item";
        item.draggable = true;
        item.title = cfNode.description;
        item.innerHTML = `
          <span class="flow-diamond" style="color:${cfNode.color}">&#9670;</span>
          <span class="method-name">${cfNode.displayName}</span>
          <span class="method-io">${(cfNode.inputs || []).length}&#8594;${(cfNode.outputs || []).length}</span>
        `;

        item.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData(
            "text/plain",
            JSON.stringify({
              type: "flow",
              nodeType: `${cfNode.category}/${cfNode.name}`,
            })
          );
        });
        item.addEventListener("dblclick", () => {
          this.addNodeAtCenter(`${cfNode.category}/${cfNode.name}`);
        });

        flowList.appendChild(item);
      }

      flowSection.appendChild(flowList);
      sidebar.appendChild(flowSection);
    }

    // Trigger nodes section
    if (this.registry.triggerNodes && this.registry.triggerNodes.length > 0) {
      const trigSection = document.createElement("div");
      trigSection.className = "sidebar-category";

      const trigHeader = document.createElement("div");
      trigHeader.className = "category-header";
      trigHeader.innerHTML = `
        <span class="category-toggle">&#9660;</span>
        <span class="category-name">Trigger</span>
        <span class="category-count">${this.registry.triggerNodes.length}</span>
      `;
      trigHeader.addEventListener("click", () => {
        trigSection.classList.toggle("collapsed");
        const toggle = trigHeader.querySelector(".category-toggle");
        toggle.innerHTML = trigSection.classList.contains("collapsed")
          ? "&#9654;"
          : "&#9660;";
      });
      trigSection.appendChild(trigHeader);

      const trigList = document.createElement("div");
      trigList.className = "module-list";

      for (const trigNode of this.registry.triggerNodes) {
        const item = document.createElement("div");
        item.className = "method-item trigger-item";
        item.draggable = true;
        item.title = trigNode.description;
        item.innerHTML = `
          <span class="trigger-bolt" style="color:${trigNode.color}">&#9889;</span>
          <span class="method-name">${trigNode.displayName}</span>
          <span class="method-io">0&#8594;${(trigNode.outputs || []).length}</span>
        `;

        item.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData(
            "text/plain",
            JSON.stringify({
              type: "trigger",
              nodeType: `${trigNode.category}/${trigNode.name}`,
            })
          );
        });
        item.addEventListener("dblclick", () => {
          this.addNodeAtCenter(`${trigNode.category}/${trigNode.name}`);
        });

        trigList.appendChild(item);
      }

      trigSection.appendChild(trigList);
      sidebar.appendChild(trigSection);
    }

    // Search filter
    const searchInput = document.getElementById("sidebar-search");
    searchInput.addEventListener("input", (e) => {
      this.filterSidebar(e.target.value);
    });
  }

  /**
   * Filter sidebar items by search query.
   */
  filterSidebar(query) {
    const q = query.toLowerCase();
    const items = document.querySelectorAll(".method-item, .module-item");
    const categories = document.querySelectorAll(".sidebar-category");

    if (!q) {
      items.forEach((el) => (el.style.display = ""));
      categories.forEach((el) => el.classList.remove("collapsed"));
      return;
    }

    for (const item of items) {
      const text = item.textContent.toLowerCase();
      const match = text.includes(q);
      item.style.display = match ? "" : "none";
      if (match && item.classList.contains("method-item")) {
        const parent = item.closest(".module-item");
        if (parent) {
          parent.classList.add("expanded");
          parent.style.display = "";
        }
      }
    }
  }

  /**
   * Add a node at the center of the visible canvas.
   */
  addNodeAtCenter(nodeType) {
    const node = LiteGraph.createNode(nodeType);
    if (!node) {
      console.warn("Unknown node type:", nodeType);
      return;
    }
    const center = this.canvas.convertOffsetToCanvas([
      this.canvas.canvas.width / 2,
      this.canvas.canvas.height / 2,
    ]);
    node.pos = [
      center[0] + (Math.random() - 0.5) * 100,
      center[1] + (Math.random() - 0.5) * 100,
    ];
    this.graph.add(node);
    this.canvas.selectNode(node);
  }

  // ── Toolbar ───────────────────────────────────────────────────────────

  bindToolbar() {
    document.getElementById("btn-clear").addEventListener("click", () => {
      if (confirm("Clear the entire workflow?")) {
        this.graph.clear();
      }
    });

    document.getElementById("btn-export").addEventListener("click", () => {
      const name = prompt("Workflow name:", "my-workflow") || "my-workflow";
      this.workflow.downloadWorkflow(name);
    });

    document.getElementById("btn-import").addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const wf = await this.workflow.loadFromFile(file);
          this.showNotification(`Loaded: ${wf.name || "workflow"}`, "success");
        } catch (err) {
          this.showNotification(`Error: ${err.message}`, "error");
        }
      });
      input.click();
    });

    document.getElementById("btn-validate").addEventListener("click", () => {
      const result = this.workflow.validate();
      this.showValidation(result);
    });

    document.getElementById("btn-arrange").addEventListener("click", () => {
      this.graph.arrange();
    });

    document.getElementById("btn-fit").addEventListener("click", () => {
      this.zoomToFit();
    });

    document.getElementById("btn-cli").addEventListener("click", () => {
      const commands = this.workflow.generateCliCommands();
      if (commands.length === 0) {
        this.showNotification("No module nodes in workflow", "warning");
        return;
      }
      this.showCliOutput(commands);
    });

    // Run workflow
    document.getElementById("btn-run").addEventListener("click", () => {
      this.runWorkflow();
    });

    // Deploy workflow
    document.getElementById("btn-deploy").addEventListener("click", () => {
      this.deployWorkflow();
    });

    // Executions panel
    document.getElementById("btn-executions").addEventListener("click", () => {
      this.toggleExecutionsPanel();
    });
    document.getElementById("executions-refresh").addEventListener("click", () => {
      this.fetchAndRenderExecutions();
    });

    // Toggle sidebar
    document.getElementById("btn-toggle-sidebar").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("collapsed");
      this.handleResize();
    });

    // Drop on canvas
    const canvasContainer = document.getElementById("canvas-container");
    canvasContainer.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    canvasContainer.addEventListener("drop", (e) => {
      e.preventDefault();
      try {
        const data = JSON.parse(e.dataTransfer.getData("text/plain"));
        const node = LiteGraph.createNode(data.nodeType);
        if (!node) return;
        const pos = this.canvas.convertEventToCanvasOffset(e);
        node.pos = [pos[0], pos[1]];
        this.graph.add(node);
      } catch {
        // Not our drag data
      }
    });
  }

  // ── Panels & Notifications ────────────────────────────────────────────

  showNotification(message, type = "info") {
    const container = document.getElementById("notifications");
    const toast = document.createElement("div");
    toast.className = `notification ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add("show"), 10);
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  showValidation(result) {
    const panel = document.getElementById("info-panel");
    const content = document.getElementById("info-content");

    let html = `<h3>Workflow Validation</h3>`;
    if (result.valid) {
      html += `<p class="validation-ok">Workflow is valid</p>`;
    } else {
      html += `<p class="validation-error">Workflow has errors</p>`;
    }

    if (result.errors.length > 0) {
      html += `<h4>Errors</h4><ul class="error-list">`;
      for (const err of result.errors) html += `<li>${err}</li>`;
      html += `</ul>`;
    }

    if (result.warnings.length > 0) {
      html += `<h4>Warnings</h4><ul class="warning-list">`;
      for (const warn of result.warnings) html += `<li>${warn}</li>`;
      html += `</ul>`;
    }

    content.innerHTML = html;
    panel.classList.add("visible");
  }

  showModulePanel(mod) {
    const panel = document.getElementById("info-panel");
    const content = document.getElementById("info-content");

    let html = `
      <h3 style="color:${mod.color}">${mod.displayName}</h3>
      <p class="module-desc">${mod.description}</p>
      <div class="module-meta">
        <span>v${mod.version}</span>
        <span>${mod.type}</span>
        <span>${mod.category}</span>
      </div>
    `;

    if (mod.dependencies && mod.dependencies.length > 0) {
      html += `<h4>Dependencies</h4><ul>`;
      for (const dep of mod.dependencies) html += `<li>${dep}</li>`;
      html += `</ul>`;
    }

    html += `<h4>Methods</h4>`;
    for (const method of mod.methods) {
      html += `
        <div class="method-info">
          <code>logos.${mod.displayName.toLowerCase()}.${method.name}(${method.inputs.map((i) => i.name).join(", ")})</code>
          <p>${method.description}</p>
        </div>
      `;
    }

    content.innerHTML = html;
    panel.classList.add("visible");
  }

  showCliOutput(commands) {
    const panel = document.getElementById("info-panel");
    const content = document.getElementById("info-content");

    let html = `<h3>Generated CLI Commands</h3>`;
    html += `<p>Run these with a <code>logoscore</code> instance:</p>`;
    html += `<pre class="cli-output">`;
    html += commands.join("\n");
    html += `</pre>`;
    html += `<button onclick="navigator.clipboard.writeText(${JSON.stringify(commands.join("\n"))}).then(()=>window.app.showNotification('Copied!','success'))">Copy to Clipboard</button>`;

    content.innerHTML = html;
    panel.classList.add("visible");
  }

  // ── Executions Panel ───────────────────────────────────────────────

  /**
   * Toggle the executions history panel open/closed.
   */
  toggleExecutionsPanel() {
    const panel = document.getElementById("executions-panel");
    const isVisible = panel.classList.contains("visible");

    // Close info panel if open
    document.getElementById("info-panel").classList.remove("visible");

    if (isVisible) {
      panel.classList.remove("visible");
      if (this._executionsRefreshTimer) {
        clearInterval(this._executionsRefreshTimer);
        this._executionsRefreshTimer = null;
      }
    } else {
      panel.classList.add("visible");
      this.fetchAndRenderExecutions();

      // Auto-refresh every 5s when panel is open and bridge is connected
      // Skip refresh if user is viewing expanded details
      this._executionsRefreshTimer = setInterval(() => {
        if (this.bridge.connected && panel.classList.contains("visible")) {
          const hasExpanded = document.querySelector(".execution-row.expanded");
          if (!hasExpanded) {
            this.fetchAndRenderExecutions();
          }
        }
      }, 5000);
    }
  }

  /**
   * Fetch execution history from the bridge and render it.
   */
  async fetchAndRenderExecutions() {
    const list = document.getElementById("executions-list");

    if (!this.bridge.connected) {
      list.innerHTML = `<div class="executions-empty">Connect to bridge to see executions</div>`;
      return;
    }

    try {
      const response = await this.bridge.getExecutions();
      const executions = Array.isArray(response) ? response : response?.executions || [];

      if (!executions || executions.length === 0) {
        list.innerHTML = `<div class="executions-empty">No executions yet</div>`;
        return;
      }

      // Render most recent first
      const sorted = [...executions].reverse();
      list.innerHTML = "";

      for (const exec of sorted) {
        const row = document.createElement("div");
        row.className = "execution-row";

        const statusIcon = exec.success ? "✓" : "✗";
        const statusClass = exec.success ? "success" : "error";
        const triggerClass = exec.triggerType || "manual";
        const relTime = this._relativeTime(exec.timestamp);
        const duration = exec.duration ? `${exec.duration}ms` : "—";
        const steps = exec.steps !== undefined ? `${exec.steps} step${exec.steps !== 1 ? "s" : ""}` : "";
        const skipped = exec.skipped ? `, ${exec.skipped} skipped` : "";
        const errors = exec.errors ? `, ${exec.errors} error${exec.errors !== 1 ? "s" : ""}` : "";

        row.innerHTML = `
          <div class="execution-summary">
            <span class="execution-status-icon ${statusClass}">${statusIcon}</span>
            <span class="execution-name">${this._escapeHtml(exec.workflowName || exec.workflowId || "unknown")}</span>
            <span class="execution-trigger-badge ${triggerClass}">${exec.triggerType || "?"}</span>
          </div>
          <div class="execution-meta">
            <span>${relTime}</span>
            <span>${duration}</span>
            <span>${steps}${skipped}${errors}</span>
          </div>
        `;

        // Click to expand/collapse details
        row.addEventListener("click", () => {
          const existing = row.querySelector(".execution-details");
          if (existing) {
            existing.remove();
            row.classList.remove("expanded");
            return;
          }
          // Collapse other expanded rows
          list.querySelectorAll(".execution-row.expanded").forEach(r => {
            r.querySelector(".execution-details")?.remove();
            r.classList.remove("expanded");
          });

          row.classList.add("expanded");
          const details = document.createElement("div");
          details.className = "execution-details";

          if (exec.error) {
            details.innerHTML = `<div style="color:var(--error)">Error: ${this._escapeHtml(exec.error)}</div>`;
          } else if (exec.nodeResults && Object.keys(exec.nodeResults).length > 0) {
            let html = "";
            for (const [nodeId, result] of Object.entries(exec.nodeResults)) {
              const label = `Node ${nodeId}`;
              const json = JSON.stringify(result, null, 2);
              const truncated = json.length > 1000 ? json.slice(0, 1000) + "\n... (truncated)" : json;
              html += `
                <div class="execution-node-result">
                  <div class="node-label">${label}</div>
                  <pre>${this._escapeHtml(truncated)}</pre>
                </div>
              `;
            }
            details.innerHTML = html;
          } else {
            details.innerHTML = `<div style="color:var(--text-muted)">No detailed results available</div>`;
          }

          row.appendChild(details);
        });

        list.appendChild(row);
      }
    } catch (e) {
      list.innerHTML = `<div class="executions-empty">Error loading executions: ${e.message}</div>`;
    }
  }

  /**
   * Relative time string (e.g., "2m ago", "1h ago").
   */
  _relativeTime(isoString) {
    if (!isoString) return "—";
    const diff = Date.now() - new Date(isoString).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 5) return "just now";
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  /**
   * Escape HTML entities.
   */
  _escapeHtml(str) {
    if (typeof str !== "string") return str;
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Link Data Tooltip ──────────────────────────────────────────────

  /**
   * Setup canvas hook to show link data on right-click.
   * Called after canvas is created.
   */
  setupLinkTooltip() {
    const canvas = this.canvas;
    const graph = this.graph;

    // Override the onShowLinkMenu callback on the canvas
    canvas.onShowLinkMenu = (link, e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!link) return false;

      // Resolve link — LiteGraph passes link objects with origin_id/origin_slot
      let originId, outputSlot, targetId;
      if (link.origin_id !== undefined) {
        // LiteGraph link object format
        originId = link.origin_id;
        outputSlot = link.origin_slot;
        targetId = link.target_id;
      } else if (Array.isArray(link)) {
        // Array format: [linkId, originId, originSlot, targetId, targetSlot, type]
        originId = link[1];
        outputSlot = link[2];
        targetId = link[3];
      } else {
        return false;
      }

      const originNode = graph.getNodeById(originId);
      const targetNode = graph.getNodeById(targetId);

      if (!originNode) return false;

      // Get data flowing through this link
      let data;
      if (originNode.getOutputData) {
        data = originNode.getOutputData(outputSlot);
      }
      if (data === undefined && originNode._executionResult !== undefined) {
        data = originNode._executionResult;
      }

      const originLabel = originNode.title || originNode.type || `Node ${originId}`;
      const targetLabel = targetNode ? (targetNode.title || targetNode.type || `Node ${targetId}`) : "?";
      const outputName = originNode.outputs?.[outputSlot]?.name || `out_${outputSlot}`;

      // Position tooltip near the right-click
      const tooltip = document.getElementById("link-tooltip");
      const labelEl = document.getElementById("link-tooltip-label");
      const dataEl = document.getElementById("link-tooltip-data");

      labelEl.textContent = `${originLabel}.${outputName} → ${targetLabel}`;

      if (data === undefined || data === null) {
        dataEl.textContent = "(no data — run workflow first)";
        dataEl.style.color = "var(--text-muted)";
      } else {
        const json = JSON.stringify(data, null, 2);
        const truncated = json.length > 1000 ? json.slice(0, 1000) + "\n... (truncated)" : json;
        dataEl.textContent = truncated;
        dataEl.style.color = "";
      }

      // Position near the click
      const container = document.getElementById("canvas-container");
      const rect = container.getBoundingClientRect();
      let left = e.clientX - rect.left + 10;
      let top = e.clientY - rect.top + 10;

      // Keep within bounds
      if (left + 400 > rect.width) left = Math.max(10, rect.width - 410);
      if (top + 280 > rect.height) top = Math.max(10, rect.height - 290);

      tooltip.style.left = left + "px";
      tooltip.style.top = top + "px";
      tooltip.classList.remove("hidden");

      return false; // Prevent default context menu
    };
  }

  /**
   * Show execution results in the info panel.
   */
  showExecutionResults(results) {
    const panel = document.getElementById("info-panel");
    const content = document.getElementById("info-content");

    let html = `<h3>Execution Results</h3>`;
    html += `<p class="${results.success ? 'validation-ok' : 'validation-error'}">`;
    html += results.success ? "All steps completed" : "Some steps failed";
    html += `</p>`;

    for (const step of results.steps || []) {
      const statusClass = step.result?.success ? "validation-ok" : "validation-error";
      html += `
        <div class="method-info">
          <code>${step.module}.${step.method}</code>
          <span class="${statusClass}">${step.result?.success ? "OK" : "FAIL"}</span>
          <pre class="cli-output">${JSON.stringify(step.result?.data || step.result?.error, null, 2)}</pre>
        </div>
      `;
    }

    content.innerHTML = html;
    panel.classList.add("visible");
  }
}

// Boot
document.addEventListener("DOMContentLoaded", async () => {
  const app = new LogosLegosApp();
  await app.init();
});
