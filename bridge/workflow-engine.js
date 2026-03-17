/**
 * WorkflowEngine - Server-side workflow deployment and execution.
 *
 * Manages deployed workflows and executes them via DAGExecutor when
 * triggered by webhooks, timers, or manual API calls.
 */
const { ServerGraph } = require("./graph-shim");
const DAGExecutor = require("./dag-executor-server");

class WorkflowEngine {
  constructor(adapter) {
    this.adapter = adapter;
    this.deployedWorkflows = new Map(); // workflowId → { graphData, triggers, name, deployedAt }
    this.executionLog = [];             // Recent execution records (last 100)
    this.scheduler = null;              // Set via setScheduler()
  }

  /**
   * Attach a Scheduler instance for timer-based trigger execution.
   */
  setScheduler(scheduler) {
    this.scheduler = scheduler;
  }

  /**
   * Deploy a workflow for external triggering.
   * @param {string} workflowId - Unique identifier
   * @param {object} workflowData - Full workflow export (from WorkflowManager.exportWorkflow)
   * @returns {{ success: boolean, triggers?: object[], error?: string }}
   */
  deploy(workflowId, workflowData) {
    // Accept either { graph: { nodes, links } } (from WorkflowManager.exportWorkflow)
    // or direct graph data { nodes, links } (from graph.serialize())
    const graphData = workflowData.nodes ? workflowData : workflowData.graph;
    if (!graphData || !graphData.nodes) {
      return { success: false, error: "Invalid workflow: missing graph data" };
    }

    // Find trigger nodes in the graph
    const triggers = [];
    for (const nodeData of graphData.nodes) {
      if (nodeData.properties?._trigger) {
        triggers.push({
          nodeId: nodeData.id,
          type: nodeData.properties._trigger,
          config: { ...nodeData.properties },
        });
      }
    }

    if (triggers.length === 0) {
      return { success: false, error: "Workflow has no trigger nodes. Add a Webhook, Timer, or Manual Trigger node." };
    }

    this.deployedWorkflows.set(workflowId, {
      name: workflowData.name || workflowId,
      graphData,
      triggers,
      deployedAt: new Date().toISOString(),
    });

    console.log(`[engine] Deployed workflow "${workflowId}" with ${triggers.length} trigger(s): ${triggers.map(t => t.type).join(", ")}`);

    // Auto-schedule timer triggers
    if (this.scheduler) {
      for (const trigger of triggers) {
        if (trigger.type === "timer") {
          this.scheduler.schedule(workflowId, trigger.config);
        }
      }
    }

    return {
      success: true,
      workflowId,
      triggers,
      webhookUrl: `/api/webhooks/${workflowId}`,
      message: `Deployed with ${triggers.length} trigger(s)`,
    };
  }

  /**
   * Undeploy a workflow.
   */
  undeploy(workflowId) {
    if (!this.deployedWorkflows.has(workflowId)) {
      return { success: false, error: "Workflow not found" };
    }
    // Unschedule any timers for this workflow
    if (this.scheduler) {
      this.scheduler.unschedule(workflowId);
    }
    this.deployedWorkflows.delete(workflowId);
    console.log(`[engine] Undeployed workflow "${workflowId}"`);
    return { success: true, workflowId };
  }

  /**
   * List all deployed workflows.
   */
  listDeployed() {
    const list = [];
    for (const [id, wf] of this.deployedWorkflows) {
      list.push({
        workflowId: id,
        name: wf.name,
        triggers: wf.triggers,
        deployedAt: wf.deployedAt,
        webhookUrl: `/api/webhooks/${id}`,
      });
    }
    return list;
  }

  /**
   * Get the execution log.
   */
  getExecutionLog() {
    return this.executionLog;
  }

  /**
   * Execute a deployed workflow, injecting trigger data into the appropriate
   * trigger node's outputs.
   *
   * @param {string} workflowId
   * @param {string} triggerType - "webhook" | "timer" | "manual"
   * @param {object} triggerData - Data to inject (e.g., webhook body + headers)
   * @returns {Promise<object>} Execution result
   */
  async execute(workflowId, triggerType, triggerData) {
    const deployed = this.deployedWorkflows.get(workflowId);
    if (!deployed) {
      return { success: false, error: `Workflow "${workflowId}" not deployed` };
    }

    console.log(`[engine] Executing workflow "${workflowId}" (trigger: ${triggerType})`);

    // Create a fresh ServerGraph from the stored graph data
    const graph = new ServerGraph(deployed.graphData);

    // Find trigger node(s) matching this type and pre-inject data into outputs
    let triggerFound = false;
    for (const triggerInfo of deployed.triggers) {
      if (triggerInfo.type === triggerType) {
        const triggerNode = graph.getNodeById(triggerInfo.nodeId);
        if (triggerNode) {
          this._injectTriggerData(triggerNode, triggerType, triggerData);
          triggerFound = true;
        }
      }
    }

    if (!triggerFound) {
      return {
        success: false,
        error: `No ${triggerType} trigger found in workflow "${workflowId}"`,
      };
    }

    // Create server-side DAGExecutor callbacks
    const nodeResults = new Map();
    const adapter = this.adapter;

    const callbacks = {
      execute: async (moduleName, methodName, params) => {
        return await adapter.execute(moduleName, methodName, params);
      },
      setStatus: (node, status) => {
        node._executionStatus = status;
      },
      setResult: (node, data) => {
        node._executionResult = data;
        if (node.outputs) {
          for (let i = 0; i < node.outputs.length; i++) {
            node.setOutputData(i, data);
          }
        }
        nodeResults.set(node.id, data);
      },
      resolveInputs: (node) => {
        const params = {};
        if (!node || !node.inputs) return params;
        for (let i = 0; i < node.inputs.length; i++) {
          const input = node.inputs[i];
          let data = node.getInputData(i);
          if (data !== undefined && data !== null) {
            params[input.name] = data;
          }
        }
        return params;
      },
    };

    const executor = new DAGExecutor(graph, callbacks);
    const startTime = Date.now();

    try {
      const result = await executor.run();

      const executionRecord = {
        success: result.success,
        workflowId,
        workflowName: deployed.name,
        triggerType,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        steps: result.steps,
        skipped: result.skipped,
        errors: result.errors,
        nodeResults: Object.fromEntries(nodeResults),
      };

      this._logExecution(executionRecord);
      console.log(`[engine] Workflow "${workflowId}" completed: ${result.steps} steps, ${result.skipped} skipped, ${result.errors} errors (${Date.now() - startTime}ms)`);

      return executionRecord;
    } catch (e) {
      const errorRecord = {
        success: false,
        error: e.message,
        workflowId,
        triggerType,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
      this._logExecution(errorRecord);
      console.error(`[engine] Workflow "${workflowId}" error: ${e.message}`);
      return errorRecord;
    }
  }

  /**
   * Inject trigger data into a trigger node's output slots.
   */
  _injectTriggerData(triggerNode, triggerType, triggerData) {
    if (triggerType === "webhook") {
      triggerNode.setOutputData(0, triggerData.body || triggerData);
      triggerNode.setOutputData(1, triggerData.headers || {});
      triggerNode._executionResult = triggerData.body || triggerData;
    } else if (triggerType === "timer") {
      const tickData = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        ...(triggerData || {}),
      };
      triggerNode.setOutputData(0, tickData);
      triggerNode._executionResult = tickData;
    } else if (triggerType === "manual") {
      let data = triggerData;
      if (!data || Object.keys(data).length === 0) {
        // Try parsing the node's static data property
        try {
          data = JSON.parse(triggerNode.properties.data || "{}");
        } catch {
          data = {};
        }
      }
      triggerNode.setOutputData(0, data);
      triggerNode._executionResult = data;
    }
  }

  /**
   * Log an execution record, keeping only the last 100.
   */
  _logExecution(record) {
    this.executionLog.push(record);
    if (this.executionLog.length > 100) {
      this.executionLog = this.executionLog.slice(-100);
    }
  }
}

module.exports = WorkflowEngine;
