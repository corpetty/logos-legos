/**
 * Module Registry - Loads and manages Logos Core module definitions.
 * Supports both static JSON (Phase 1) and live bridge discovery (Phase 2).
 */
class ModuleRegistry {
  constructor() {
    this.modules = [];
    this.utilityNodes = [];
    this.controlFlowNodes = [];
    this.dataTypes = {};
    this.loaded = false;
    this.source = "static"; // "static" | "bridge"
  }

  /**
   * Load from static JSON file (Phase 1 / fallback).
   */
  async load(url = "data/modules.json") {
    const response = await fetch(url);
    const data = await response.json();
    this.modules = data.modules || [];
    this.utilityNodes = data.utilityNodes || [];
    this.controlFlowNodes = data.controlFlowNodes || [];
    this.dataTypes = data.dataTypes || {};
    this.loaded = true;
    this.source = "static";
    return this;
  }

  /**
   * Load modules from the bridge server (Phase 2 / live discovery).
   * Merges discovered modules with static utility nodes and data types.
   */
  async loadFromBridge(bridgeClient) {
    const data = await bridgeClient.fetchModules();
    const bridgeModules = data.modules || [];

    // Ensure static data is loaded for utilities and type colors
    if (!this.loaded) {
      await this.load();
    }

    if (bridgeModules.length > 0) {
      // Enrich bridge modules with display metadata if missing
      this.modules = bridgeModules.map((mod) => this._enrichModule(mod));
      this.source = data.mode === "live" ? "bridge-live" : "bridge-mock";
    }

    this.loaded = true;
    return this;
  }

  /**
   * Enrich a module from the bridge with display metadata (colors, categories)
   * if the bridge didn't provide them.
   */
  _enrichModule(mod) {
    // Default color palette by category
    const categoryColors = {
      Chat: "#4CAF50",
      Wallet: "#FF9800",
      Blockchain: "#9C27B0",
      Storage: "#2196F3",
      Accounts: "#607D8B",
      Protocol: "#00BCD4",
      Security: "#009688",
      Management: "#795548",
    };

    // Infer category from module name if not provided
    if (!mod.category) {
      const name = mod.name || "";
      if (name.includes("chat") || name.includes("irc")) mod.category = "Chat";
      else if (name.includes("wallet")) mod.category = "Wallet";
      else if (name.includes("blockchain")) mod.category = "Blockchain";
      else if (name.includes("storage")) mod.category = "Storage";
      else if (name.includes("account")) mod.category = "Accounts";
      else if (name.includes("messaging") || name.includes("capability")) mod.category = "Protocol";
      else if (name.includes("package")) mod.category = "Management";
      else mod.category = "Other";
    }

    // Infer display name from module name if not provided
    if (!mod.displayName) {
      mod.displayName = (mod.name || "unknown")
        .replace("logos-", "")
        .replace("-module", "")
        .replace("-ui", " UI")
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    }

    // Assign color if not provided
    if (!mod.color) {
      mod.color = categoryColors[mod.category] || "#78909C";
    }

    // Ensure methods have description fields
    if (mod.methods) {
      mod.methods = mod.methods.map((m) => ({
        description: "",
        ...m,
        inputs: (m.inputs || []).map((inp) => ({
          description: "",
          ...inp,
        })),
        outputs: (m.outputs || []).map((out) => ({
          description: "",
          ...out,
        })),
      }));
    }

    return mod;
  }

  getModules() {
    return this.modules;
  }

  getModule(name) {
    return this.modules.find((m) => m.name === name);
  }

  getCategories() {
    const cats = new Map();
    for (const mod of this.modules) {
      const cat = mod.category || "Uncategorized";
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat).push(mod);
    }
    return cats;
  }

  getControlFlowNodes() {
    return this.controlFlowNodes;
  }

  getTypeColor(typeName) {
    const info = this.dataTypes[typeName];
    return info ? info.color : "#AAAAAA";
  }

  getDependencyGraph() {
    const edges = [];
    for (const mod of this.modules) {
      for (const dep of mod.dependencies || []) {
        edges.push({ from: mod.name, to: dep });
      }
    }
    return edges;
  }
}

// Singleton
window.moduleRegistry = new ModuleRegistry();
