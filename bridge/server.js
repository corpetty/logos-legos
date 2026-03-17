#!/usr/bin/env node
/**
 * Logos Legos Bridge Server (Node.js)
 *
 * HTTP bridge between the web UI and logos-core via logos-js-sdk.
 * Same REST API as the Python bridge for frontend compatibility.
 *
 * Endpoints:
 *   GET  /api/status              - Bridge and logos-core status
 *   GET  /api/modules             - List available modules with metadata and methods
 *   GET  /api/modules/:n          - Get a single module's details
 *   POST /api/execute             - Execute a single method call
 *   POST /api/workflow            - Execute a full workflow pipeline
 *   GET  /api/discover            - Trigger re-discovery of modules
 *   GET  /api/workflows           - List deployed workflows
 *   GET  /api/executions          - Recent execution log
 *   POST /api/workflows/deploy    - Deploy a workflow for webhook/trigger execution
 *   POST /api/workflows/:id/undeploy - Remove a deployed workflow
 *   POST /api/workflows/:id/trigger  - Manually trigger a deployed workflow
 *   POST /api/webhooks/:id        - Webhook endpoint — executes workflow with POST body
 *
 * Usage:
 *   node bridge/server.js [--port 8081] [--plugins-dir PATH] [--lib-path PATH] [--mock]
 */

const http = require("http");
const url = require("url");
const LogosAdapter = require("./logos-adapter");
const WorkflowEngine = require("./workflow-engine");

// ── CLI Argument Parsing ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    port: parseInt(process.env.LOGOS_BRIDGE_PORT || "8081", 10),
    pluginsDir: process.env.LOGOS_PLUGINS_DIR || null,
    libPath: process.env.LOGOS_LIB_PATH || null,
    mock: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        opts.port = parseInt(args[++i], 10);
        break;
      case "--plugins-dir":
        opts.pluginsDir = args[++i];
        break;
      case "--lib-path":
        opts.libPath = args[++i];
        break;
      case "--mock":
        opts.mock = true;
        break;
      case "--help":
      case "-h":
        console.log(`Logos Legos Bridge Server

Usage: node server.js [options]

Options:
  --port <num>          Server port (default: 8081, env: LOGOS_BRIDGE_PORT)
  --plugins-dir <path>  Path to module plugins directory (env: LOGOS_PLUGINS_DIR)
  --lib-path <path>     Path to liblogos_core shared library (env: LOGOS_LIB_PATH)
  --mock                Force mock mode (no logos-core calls)
  -h, --help            Show this help`);
        process.exit(0);
    }
  }

  return opts;
}

// ── HTTP Server ──────────────────────────────────────────────────────────

function createServer(adapter, engine, port) {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET") {
        await handleGet(pathname, adapter, engine, res);
      } else if (req.method === "POST") {
        const body = await readBody(req);
        const headers = req.headers;
        await handlePost(pathname, body, headers, adapter, engine, res);
      } else {
        jsonResponse(res, { error: "Method not allowed" }, 405);
      }
    } catch (e) {
      console.error(`[bridge] Error handling ${req.method} ${pathname}:`, e.message);
      jsonResponse(res, { error: e.message }, 500);
    }
  });

  server.listen(port, () => {
    console.log(`[bridge] Server listening on http://localhost:${port}`);
    console.log(`[bridge] Mode: ${adapter.mode}`);
    const status = adapter.status();
    console.log(`[bridge] Modules: ${status.modules} loaded, ${status.knownModules} known`);
    if (status.sdk) console.log("[bridge] logos-js-sdk: connected");
    if (status.logoscore) console.log("[bridge] logoscore CLI: available");
    if (status.lm) console.log("[bridge] lm CLI: available");
    console.log(`[bridge] Webhook URL: http://localhost:${port}/api/webhooks/<workflowId>`);
  });

  return server;
}

async function handleGet(pathname, adapter, engine, res) {
  if (pathname === "/api/status") {
    const status = adapter.status();
    status.deployedWorkflows = engine.listDeployed().length;
    jsonResponse(res, status);
  } else if (pathname === "/api/modules") {
    const modules = adapter.getModules();
    jsonResponse(res, { modules, mode: adapter.mode });
  } else if (pathname.startsWith("/api/modules/")) {
    const name = pathname.slice("/api/modules/".length);
    const mod = adapter.getModule(name);
    if (mod) {
      jsonResponse(res, mod);
    } else {
      jsonResponse(res, { error: `Module '${name}' not found` }, 404);
    }
  } else if (pathname === "/api/discover") {
    const result = await adapter.discover();
    jsonResponse(res, result);
  } else if (pathname === "/api/workflows") {
    jsonResponse(res, { workflows: engine.listDeployed() });
  } else if (pathname === "/api/executions") {
    jsonResponse(res, { executions: engine.getExecutionLog() });
  } else {
    jsonResponse(res, { error: "Not found" }, 404);
  }
}

async function handlePost(pathname, body, headers, adapter, engine, res) {
  if (pathname === "/api/execute") {
    const { module: moduleName, method, params } = body;
    if (!moduleName || !method) {
      jsonResponse(res, { error: "module and method required" }, 400);
      return;
    }
    const result = await adapter.execute(moduleName, method, params || {});
    jsonResponse(res, result);
  } else if (pathname === "/api/workflow") {
    const pipeline = body.pipeline;
    if (!pipeline || !Array.isArray(pipeline)) {
      jsonResponse(res, { error: "pipeline required" }, 400);
      return;
    }
    const result = await adapter.executeWorkflow(pipeline);
    jsonResponse(res, result);
  } else if (pathname === "/api/load") {
    const { module: moduleName } = body;
    if (!moduleName) {
      jsonResponse(res, { error: "module required" }, 400);
      return;
    }
    const result = await adapter.loadModule(moduleName);
    jsonResponse(res, result);

  // ── Workflow deployment & execution routes ──
  } else if (pathname === "/api/workflows/deploy") {
    const { workflowId, workflow } = body;
    if (!workflowId || !workflow) {
      jsonResponse(res, { error: "workflowId and workflow required" }, 400);
      return;
    }
    const result = engine.deploy(workflowId, workflow);
    console.log(`[bridge] Deployed workflow '${workflowId}' (${result.triggers.length} trigger(s))`);
    jsonResponse(res, result);

  } else if (pathname.match(/^\/api\/workflows\/[^/]+\/undeploy$/)) {
    const workflowId = pathname.split("/")[3];
    const result = engine.undeploy(workflowId);
    if (result.success) {
      console.log(`[bridge] Undeployed workflow '${workflowId}'`);
    }
    jsonResponse(res, result, result.success ? 200 : 404);

  } else if (pathname.match(/^\/api\/workflows\/[^/]+\/trigger$/)) {
    const workflowId = pathname.split("/")[3];
    const { triggerType, data } = body;
    if (!triggerType) {
      jsonResponse(res, { error: "triggerType required" }, 400);
      return;
    }
    console.log(`[bridge] Triggering workflow '${workflowId}' (type: ${triggerType})`);
    const result = await engine.execute(workflowId, triggerType, data || {});
    jsonResponse(res, result, result.success ? 200 : 500);

  } else if (pathname.startsWith("/api/webhooks/")) {
    const workflowId = pathname.slice("/api/webhooks/".length);
    if (!workflowId) {
      jsonResponse(res, { error: "workflowId required in URL" }, 400);
      return;
    }
    console.log(`[bridge] Webhook received for workflow '${workflowId}'`);
    const result = await engine.execute(workflowId, "webhook", {
      body: body,
      headers: headers,
    });
    jsonResponse(res, result, result.success ? 200 : 500);

  } else {
    jsonResponse(res, { error: "Not found" }, 404);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log("[bridge] Logos Legos Bridge Server (Node.js)");
  console.log("[bridge] Initializing adapter...");

  const adapter = new LogosAdapter({
    mock: opts.mock,
    pluginsDir: opts.pluginsDir,
    libPath: opts.libPath,
  });

  await adapter.init();

  const engine = new WorkflowEngine(adapter);
  console.log("[bridge] Workflow engine ready");

  const server = createServer(adapter, engine, opts.port);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[bridge] Shutting down...");
    server.close();
    if (adapter.logos) {
      adapter.logos.cleanup();
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.close();
    if (adapter.logos) {
      adapter.logos.cleanup();
    }
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[bridge] Fatal error:", e);
  process.exit(1);
});
