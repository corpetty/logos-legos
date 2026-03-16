/**
 * Workflow Manager - Export, import, validate, and manage workflows.
 */
class WorkflowManager {
  constructor(graph) {
    this.graph = graph;
  }

  /**
   * Export the current graph as a Logos Legos workflow JSON.
   */
  exportWorkflow(name = "untitled") {
    const graphData = this.graph.serialize();

    const workflow = {
      version: "0.1.0",
      name: name,
      createdAt: new Date().toISOString(),
      description: "",
      graph: graphData,
      // Extract a high-level pipeline description
      pipeline: this.extractPipeline(),
    };

    return workflow;
  }

  /**
   * Import a workflow from JSON.
   */
  importWorkflow(workflow) {
    if (!workflow || !workflow.graph) {
      throw new Error("Invalid workflow format");
    }
    this.graph.configure(workflow.graph);
    return workflow;
  }

  /**
   * Extract a human-readable pipeline description from the graph.
   * Returns an array of steps showing the data flow.
   */
  extractPipeline() {
    const nodes = this.graph._nodes || [];
    const links = this.graph.links || {};

    // Build adjacency list
    const adj = new Map();
    const inDegree = new Map();

    for (const node of nodes) {
      adj.set(node.id, []);
      if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
    }

    for (const linkId in links) {
      const link = links[linkId];
      if (!link) continue;
      const fromId = link[1]; // origin_id
      const toId = link[3]; // target_id
      if (adj.has(fromId)) {
        adj.get(fromId).push(toId);
      }
      if (!inDegree.has(toId)) inDegree.set(toId, 0);
      inDegree.set(toId, (inDegree.get(toId) || 0) + 1);
    }

    // Topological sort for pipeline order
    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order = [];
    while (queue.length > 0) {
      const id = queue.shift();
      order.push(id);
      for (const next of adj.get(id) || []) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) queue.push(next);
      }
    }

    // Build step descriptions
    return order.map((id) => {
      const node = this.graph.getNodeById(id);
      if (!node) return null;
      return {
        nodeId: id,
        title: node.title,
        type: node.type,
        module: node.properties?.module || null,
        method: node.properties?.method || null,
      };
    }).filter(Boolean);
  }

  /**
   * Validate the workflow for issues.
   * Returns { valid: boolean, errors: string[], warnings: string[] }
   */
  validate() {
    const errors = [];
    const warnings = [];
    const nodes = this.graph._nodes || [];
    const links = this.graph.links || {};

    if (nodes.length === 0) {
      errors.push("Workflow has no nodes");
      return { valid: false, errors, warnings };
    }

    // Check for unconnected required inputs
    for (const node of nodes) {
      if (!node.inputs) continue;
      for (let i = 0; i < node.inputs.length; i++) {
        const input = node.inputs[i];
        if (!input.link && input.type !== "*") {
          warnings.push(
            `${node.title}: input "${input.name}" (${input.type}) is not connected`
          );
        }
      }
    }

    // Check for type mismatches in connections
    for (const linkId in links) {
      const link = links[linkId];
      if (!link) continue;
      const originNode = this.graph.getNodeById(link[1]);
      const targetNode = this.graph.getNodeById(link[3]);
      if (!originNode || !targetNode) continue;

      const outputSlot = originNode.outputs?.[link[2]];
      const inputSlot = targetNode.inputs?.[link[4]];
      if (!outputSlot || !inputSlot) continue;

      if (
        inputSlot.type !== "*" &&
        outputSlot.type !== "*" &&
        inputSlot.type !== outputSlot.type
      ) {
        warnings.push(
          `Type mismatch: ${originNode.title}.${outputSlot.name} (${outputSlot.type}) -> ${targetNode.title}.${inputSlot.name} (${inputSlot.type})`
        );
      }
    }

    // Check for cycles
    if (this.hasCycle()) {
      errors.push("Workflow contains a cycle (data pipelines must be acyclic)");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Detect cycles in the graph using DFS.
   */
  hasCycle() {
    const nodes = this.graph._nodes || [];
    const links = this.graph.links || {};
    const adj = new Map();

    for (const node of nodes) {
      adj.set(node.id, []);
    }
    for (const linkId in links) {
      const link = links[linkId];
      if (!link) continue;
      if (adj.has(link[1])) {
        adj.get(link[1]).push(link[3]);
      }
    }

    const visited = new Set();
    const inStack = new Set();

    const dfs = (id) => {
      visited.add(id);
      inStack.add(id);
      for (const next of adj.get(id) || []) {
        if (!visited.has(next)) {
          if (dfs(next)) return true;
        } else if (inStack.has(next)) {
          return true;
        }
      }
      inStack.delete(id);
      return false;
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        if (dfs(node.id)) return true;
      }
    }
    return false;
  }

  /**
   * Download the workflow as a JSON file.
   */
  downloadWorkflow(name = "workflow") {
    const workflow = this.exportWorkflow(name);
    const blob = new Blob([JSON.stringify(workflow, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.logos-workflow.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Load a workflow from a file input.
   */
  async loadFromFile(file) {
    const text = await file.text();
    const workflow = JSON.parse(text);
    return this.importWorkflow(workflow);
  }

  /**
   * Generate a logoscore CLI command sequence from the pipeline.
   */
  generateCliCommands() {
    const pipeline = this.extractPipeline();
    const commands = [];

    for (const step of pipeline) {
      if (step.module && step.method) {
        commands.push(
          `logoscore -c "logos.${step.module.replace("logos-", "").replace("-module", "")}.${step.method}()"`
        );
      }
    }

    return commands;
  }
}
