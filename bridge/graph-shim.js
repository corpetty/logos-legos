/**
 * ServerGraph & ServerNode - Lightweight LiteGraph-compatible graph shim
 * for server-side DAG execution.
 *
 * Constructed from a serialized LiteGraph graph JSON (the output of
 * graph.serialize()). Provides the same interface that DAGExecutor expects:
 *   - graph._nodes (array)
 *   - graph.links (object keyed by linkId)
 *   - graph.getNodeById(id)
 *   - node.getInputData(slot), setOutputData(slot, data), getOutputData(slot)
 *   - node.inputs[], outputs[], properties, id, type
 */

class ServerGraph {
  constructor(serializedGraph) {
    this._nodes = [];
    this.links = {};
    this._nodeMap = new Map();

    this._loadFromSerialized(serializedGraph);
  }

  _loadFromSerialized(data) {
    // LiteGraph serializes links as an array of arrays:
    // [linkId, originId, originSlot, targetId, targetSlot, type]
    // Convert to object keyed by linkId (how DAGExecutor iterates them)
    for (const linkArr of data.links || []) {
      const linkId = linkArr[0];
      this.links[linkId] = linkArr;
    }

    // Build ServerNode objects from serialized node data
    for (const nodeData of data.nodes || []) {
      const node = new ServerNode(nodeData, this);
      this._nodes.push(node);
      this._nodeMap.set(node.id, node);
    }
  }

  getNodeById(id) {
    return this._nodeMap.get(id) || null;
  }
}

class ServerNode {
  constructor(nodeData, graph) {
    this.id = nodeData.id;
    this.type = nodeData.type;
    this.title = nodeData.title || nodeData.type;
    this.properties = { ...(nodeData.properties || {}) };
    this.pos = nodeData.pos;
    this.size = nodeData.size;
    this._graph = graph;

    // Deep copy inputs/outputs so link references are preserved
    this.inputs = (nodeData.inputs || []).map(inp => ({ ...inp }));
    this.outputs = (nodeData.outputs || []).map(out => ({
      ...out,
      // Ensure links array exists (LiteGraph serializes this)
      links: out.links ? [...out.links] : [],
    }));

    // Output data storage (mirrors LiteGraph node output data)
    this._outputData = {};

    // Execution state (set by DAGExecutor during execution)
    this._executionResult = undefined;
    this._executionStatus = undefined;

    // Restore widget values into properties
    // LiteGraph serializes widget values in nodeData.widgets_values
    if (nodeData.widgets_values && Array.isArray(nodeData.widgets_values)) {
      this._restoreWidgetValues(nodeData);
    }
  }

  /**
   * Restore widget values from LiteGraph serialization into properties.
   * LiteGraph stores widget values as an ordered array matching widget order.
   * We need to map them back to property names.
   */
  _restoreWidgetValues(nodeData) {
    // For utility nodes, the widget order matches properties order.
    // We look at the properties that exist and map widget_values to them.
    const propNames = Object.keys(this.properties).filter(k => !k.startsWith("_"));
    const widgetValues = nodeData.widgets_values;

    // Simple heuristic: map widget values to non-internal properties in order
    let wi = 0;
    for (const propName of propNames) {
      if (wi < widgetValues.length) {
        this.properties[propName] = widgetValues[wi];
        wi++;
      }
    }
  }

  /**
   * Get input data by walking the link to the origin node's output.
   * Mirrors LiteGraph's node.getInputData(slotIndex).
   */
  getInputData(slotIndex) {
    const input = this.inputs[slotIndex];
    if (!input || input.link == null) return undefined;

    const link = this._graph.links[input.link];
    if (!link) return undefined;

    const originId = link[1];
    const originSlot = link[2];
    const originNode = this._graph.getNodeById(originId);
    if (!originNode) return undefined;

    return originNode.getOutputData(originSlot);
  }

  /**
   * Store data on an output slot for downstream consumption.
   */
  setOutputData(slotIndex, data) {
    this._outputData[slotIndex] = data;
  }

  /**
   * Retrieve stored output data.
   */
  getOutputData(slotIndex) {
    return this._outputData[slotIndex];
  }

  /**
   * No-op stub for onExecute. Server-side nodes don't have LiteGraph's
   * execution logic — the DAGExecutor handles everything.
   */
  onExecute() {}
}

module.exports = { ServerGraph, ServerNode };
