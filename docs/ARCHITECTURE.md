# Architecture

## Overview

Logos Legos is a three-layer system: a static frontend, a Node.js bridge server, and the logos-core runtime. The frontend provides a visual node-graph editor for composing workflows. The bridge server handles module execution, workflow deployment, and timer scheduling. The logos-core runtime provides the actual protocol module implementations.

## Layer 1: Frontend (Browser)

The frontend is a zero-build-step single-page application. All JavaScript runs directly in the browser via `<script>` tags — no bundler, no framework, no transpilation.

### Module Registry (`js/module-registry.js`)

The registry is the central data store for module definitions. It supports two loading modes:

1. **Static** — reads `data/modules.json` for offline/fallback module definitions
2. **Bridge** — fetches live module data from the bridge server via `loadFromBridge()`

When loading from the bridge, the registry enriches modules with display metadata (colors, categories, display names) that the bridge may not provide, since the logos-core introspection only returns raw method signatures.

### Node Types (`js/node-types.js`)

Translates module registry data into LiteGraph node types. Registers four categories of nodes:

1. **Module method nodes** — each module method becomes `DisplayName/methodName`
2. **Utility nodes** — String, Number, Boolean, JSON Parse/Stringify, Display, Template
3. **Control flow nodes** — If/Else, Switch, ForEach, Merge, Try/Catch, Retry, Fallback
4. **Transform nodes** — ArrayMap, ArrayFilter, ObjectPick, ObjectMerge, CodeExpression, HttpRequest
5. **Trigger nodes** — Webhook, Timer, ManualTrigger

Key design decisions:
- **Slot colors** map to types: green=string, orange=number, pink=boolean, grey=bytes, teal=object
- **Execution visualization** is drawn directly on the canvas via `onDrawForeground` and `onDrawBackground` hooks
- **Status borders** animate: running shows a dashed orange border with animated offset, success shows solid green, error shows solid red
- **Result panels** render below the node showing formatted output data
- **Control flow nodes** display a "FLOW" badge; error-handling nodes display a warning icon
- **Trigger nodes** display a "TRIGGER" badge with a lightning bolt icon

### DAG Executor (`js/dag-executor.js`)

The DAG executor replaces the original sequential for-loop with a proper branch-aware directed acyclic graph executor. It is the core execution engine for the frontend.

#### Key Concepts

**Active outputs**: When a node executes, it decides which of its output slots are "active" — meaning downstream nodes connected to those slots should run. Module and utility nodes activate ALL outputs. Control flow nodes selectively activate outputs based on their logic (e.g., If/Else activates only the true or false branch).

**Topological ordering**: The executor builds an adjacency graph from LiteGraph's link data, computes in-degrees, and uses Kahn's algorithm for topological sort. This ensures nodes execute only after all their dependencies are satisfied.

**Error-catch semantics**: Normally, when a node errors, its downstream nodes are skipped. Nodes with `_errorCatch: true` (Try/Catch, Fallback) override this — they execute even when upstream nodes have errored, allowing error recovery workflows.

#### Execution Flow

```
1. _buildGraph()          → adjacency lists + topological order via Kahn's algorithm
2. For each node in order:
   a. _isNodeActive()     → check if all incoming connections are from active outputs
   b. Skip if inactive (unless error-catcher with errored upstream)
   c. Dispatch by node type:
      - Module node       → callbacks.execute(module, method, params) via bridge
      - Utility node      → handled inline (passthrough, template, JSON parse, etc.)
      - Control flow node → _handleControlFlow() dispatches to specific handler
      - Transform node    → _handleTransformNode() dispatches to specific handler
      - Trigger node      → passthrough (data already injected by WorkflowEngine)
   d. Track active outputs, execution results, and errors
3. Return { success, steps, skipped, errors }
```

#### Control Flow Handlers

| Handler | Logic |
|---------|-------|
| `_handleIfElse(node)` | Evaluates condition input; activates output 0 (true) or 1 (false) |
| `_handleSwitch(node)` | Matches key against comma-separated cases; activates matching output or default |
| `_handleForEach(node)` | Iterates array input; executes downstream subgraph once per item; collects results |
| `_handleMerge(node)` | Collects all non-null inputs into an array or passes single input through |
| `_handleTryCatch(node)` | Checks upstream error map; routes to success (slot 0) or error (slot 1) |
| `_handleRetry(node)` | If upstream errored, re-executes it up to N times with delay; routes to result or failed |
| `_handleFallback(node)` | Uses primary input if no error; falls back to fallback input otherwise |

#### Transform Node Handlers

| Handler | Logic |
|---------|-------|
| `_handleArrayMap(node)` | Evaluates expression against each array element |
| `_handleArrayFilter(node)` | Filters array by predicate expression |
| `_handleObjectPick(node)` | Selects named properties from object |
| `_handleObjectMerge(node)` | Deep-merges two input objects |
| `_handleCodeExpression(node)` | Evaluates arbitrary JavaScript expression with `input` in scope |
| `_handleHttpRequestBrowser(node)` | Makes fetch() call; returns response data + status |

#### Error Tracking

The executor maintains an `errorNodes` Map (nodeId → error details). Errors are tracked from two sources:

1. **Thrown exceptions** — caught in the main execution try/catch
2. **Internal error status** — nodes like HttpRequest that catch errors internally set `_executionStatus = "error"` without throwing; the executor checks this after each node completes

Error-catching nodes (`_errorCatch: true`) use `_getUpstreamError(node, inputSlot)` to inspect the error map for their upstream nodes.

### Workflow Manager (`js/workflow.js`)

Handles the graph-to-pipeline translation:
- **`extractPipeline()`** — topological sort of the graph, producing an ordered array of steps
- **`validate()`** — checks for cycles, unconnected inputs, and type mismatches
- **`generateCliCommands()`** — produces logoscore CLI commands from the pipeline

### Bridge Client (`js/bridge-client.js`)

HTTP client with an event system for bridge communication:
- Connection management with automatic polling (10s interval)
- Per-module live status tracking (`moduleStatus` map)
- Events: `connected`, `disconnected`, `connectionLost`, `connectionRestored`, `modulesUpdated`, `executed`

### App Controller (`js/app.js`)

Orchestrates everything:
- **Bridge connection** — connect/disconnect button, status bar updates, LIVE/MOCK badges
- **Workflow execution** — creates DAGExecutor with callbacks for execute, setStatus, setResult, resolveInputs; runs the graph
- **Sidebar** — dynamic module list with drag-to-add, search filtering, category collapsing
- **Execution history** — collapsible panel showing recent runs with timing and results
- **Auto-save** — debounced 2-second save to `localStorage["logos-legos-autosave"]` triggered by graph changes
- **Recovery banner** — on page load, checks for auto-saved data and offers restore/dismiss
- **Named save slots** — save/load/delete workflows by name in `localStorage["logos-legos-saves"]`
- **Link tooltips** — hover over connections to see data flowing between nodes

#### DAG Executor Callbacks

The app creates a DAGExecutor and provides four callbacks:

```javascript
{
  execute(module, method, params)  // → bridge.execute() HTTP call
  setStatus(node, status)          // → visual status update (running/success/error)
  setResult(node, data)            // → store result, push to output slots, update display
  resolveInputs(node)              // → gather input values from connected nodes
}
```

#### Auto-Save Implementation

Auto-save works by monkey-patching `graph.add()` and `graph.remove()`, and hooking `canvas.onConnectionChange` and `graph.onNodePropertyChanged`. Each triggers a debounced 2-second save. The saved data includes the serialized graph and a timestamp.

## Layer 2: Bridge Server

### Server (`bridge/server.js`)

Minimal HTTP server with CORS support. Initializes three subsystems:

1. **LogosAdapter** — module discovery and execution
2. **WorkflowEngine** — workflow deployment and trigger-based execution
3. **Scheduler** — timer/cron scheduling for deployed workflows

Routes are split into core (module execution) and workflow (deployment/triggers) groups. See README for the full endpoint list.

### Adapter (`bridge/logos-adapter.js`)

The adapter handles all logos-core interaction. It tries three strategies in order:

#### FFI Mode (logos-js-sdk)
- Loads `liblogos_core.so` via `ffi-napi` + `ref-napi`
- Direct C function calls through Node.js FFI
- Requires Node.js 18 (ffi-napi doesn't compile on Node 22)
- Not yet working end-to-end (dependency issues)

#### CLI Mode (logoscore)
- Shells out to `logoscore -c "module.method(args)" --quit-on-finish`
- Each call spawns a fresh process (~3-5s including initialization)
- Parses stdout for "Method call successful. Result: <value>"
- Currently the primary execution mode

#### Mock Mode
- Generates plausible fake responses based on method name heuristics
- `send*` methods return message IDs, `balance*` returns ETH balances, etc.
- Used for UI development and for modules without compiled plugins

### Module Introspection

The adapter discovers modules by:
1. Scanning the plugins directory for `*_plugin.so` files (in subdirectories)
2. Running `lm <path> --json` on each plugin (the `lm` module inspector binary)
3. Filtering methods to only `isInvokable: true` (excluding `initLogos`, `eventResponse`)
4. Mapping Qt types to JavaScript types
5. Setting `_introspected: true` flag to distinguish real modules from mock

After introspecting real modules, it loads `data/modules.json` for mock modules, skipping any names that already exist (real modules take precedence).

### Workflow Engine (`bridge/workflow-engine.js`)

Manages deployed workflows and executes them when triggered. Core responsibilities:

- **Deploy** — stores workflow graph data, extracts trigger nodes, auto-schedules timers
- **Undeploy** — removes workflow and cleans up scheduled timers
- **Execute** — creates a fresh ServerGraph from stored data, injects trigger data, runs DAGExecutor

#### Trigger Data Injection

When a workflow is triggered, the engine injects data into the trigger node's output slots before running the DAG:

| Trigger Type | Slot 0 | Slot 1 |
|-------------|--------|--------|
| Webhook | Request body | Request headers |
| Timer | `{timestamp, iso, source: "scheduler"}` | — |
| Manual | Provided data or node's static `data` property | — |

#### Server-Side Execution

The engine uses `ServerGraph` (from `graph-shim.js`) to create a LiteGraph-compatible graph object from serialized JSON, then runs `DAGExecutor` (from `dag-executor-server.js`) with callbacks that route `execute()` calls through the LogosAdapter.

### DAG Executor Server (`bridge/dag-executor-server.js`)

Mirrors the browser-side DAG executor (`js/dag-executor.js`) with identical control flow, error handling, and transform logic. The key difference is that it operates on `ServerGraph` nodes (which use array-format links from serialized data) rather than live LiteGraph nodes (which use object-format links at runtime).

### Graph Shim (`bridge/graph-shim.js`)

Provides a lightweight LiteGraph-compatible interface for server-side execution:

- `ServerGraph` — constructed from serialized LiteGraph JSON (`graph.serialize()` output)
- Converts link arrays `[id, originId, originSlot, targetId, targetSlot, type]` into keyed objects
- Provides `getNodeById()`, `getInputData()`, `setOutputData()` matching LiteGraph's API
- Enables the same DAGExecutor logic to run server-side without the full LiteGraph library

### Scheduler (`bridge/scheduler.js`)

Lightweight timer scheduler with no external dependencies. Supports two modes:

#### Interval Mode
- Uses `setInterval()` directly with the `intervalMs` property
- Fires the workflow at regular intervals

#### Cron Mode
- Parses 5-field cron expressions: `minute hour day-of-month month day-of-week`
- Supports: `*`, exact values, ranges (`N-M`), lists (`N,M,O`), steps (`*/N`)
- Uses a shared 60-second ticker (`setInterval` at 60000ms) that checks all cron schedules
- Includes double-fire prevention (tracks last fire minute per workflow)
- Automatically starts/stops the cron ticker when schedules are added/removed

Integration points:
- `WorkflowEngine.deploy()` → `scheduler.schedule()` for timer triggers
- `WorkflowEngine.undeploy()` → `scheduler.unschedule()` for cleanup
- `GET /api/scheduler` → `scheduler.getStatus()` for monitoring

## Layer 3: Logos Core

### logoscore

The plugin runtime binary. Key flags:
- `-m <dir>` — modules directory
- `-l <mods>` — comma-separated modules to load
- `-c "mod.method(args)"` — call a method
- `--quit-on-finish` — exit after method calls complete

### lm

Module inspector binary. Usage: `lm <plugin.so> --json`

Outputs JSON with:
- `metadata` — name, version, etc.
- `methods[]` — name, parameters, returnType, isInvokable

### Module Plugin Structure

Each module is a Qt plugin (`.so` shared library):
- Built with Qt's `Q_PLUGIN_METADATA` macro
- Methods marked `Q_INVOKABLE` become the public API
- Uses Qt Remote Objects for IPC between logoscore and module hosts
- Requires a `manifest.json` alongside for logoscore discovery

### Qt Type Mapping

| Qt Type | JavaScript Type |
|---------|----------------|
| QString, const QString& | string |
| int, double, float | number |
| bool | boolean |
| QVariant, QVariantMap, QVariantList | object |
| QByteArray | bytes |
| LogosResult | object |

## Data Flow: Workflow Execution (Browser)

```
User clicks Run
    │
    ▼
app._runWorkflow()
    │
    ├── Create DAGExecutor(graph, callbacks)
    │
    └── executor.run()
            │
            ├── _buildGraph()                  # Adjacency lists + Kahn's topological sort
            │
            └── For each node in topological order:
                │
                ├── _isNodeActive()            # Check all incoming from active outputs
                │   ├── Yes → execute node
                │   ├── No, error-catcher → check upstream errors, maybe execute
                │   └── No → skip
                │
                ├── [Module node]
                │   ├── callbacks.resolveInputs(node)    # Gather params from connected nodes
                │   ├── callbacks.execute(mod, method, params)
                │   │       │
                │   │       ▼ (HTTP POST to bridge)
                │   │   adapter.execute(mod, method, params)
                │   │       ├── _executeLive()   # FFI
                │   │       ├── _executeCLI()    # logoscore shell
                │   │       └── _executeMock()   # simulated
                │   │
                │   └── callbacks.setResult(node, data)
                │           ├── node._executionResult = data
                │           ├── node.setOutputData(i, data)
                │           └── activeOutputs.set(node.id, all slots)
                │
                ├── [Control flow node]
                │   └── _handleControlFlow(node)
                │       ├── if-else    → activate slot 0 or 1
                │       ├── switch     → activate matching case slot
                │       ├── for-each   → iterate + collect results
                │       ├── merge      → combine inputs
                │       ├── try-catch  → route to success or error slot
                │       ├── retry      → re-execute upstream N times
                │       └── fallback   → use primary or fallback input
                │
                ├── [Transform node]
                │   └── _handleTransformNode(node)
                │       ├── array-map, array-filter, object-pick, object-merge
                │       ├── code-expression (eval with sandboxed scope)
                │       └── http-request (browser fetch)
                │
                └── [Trigger node]
                    └── passthrough (data pre-injected by WorkflowEngine)
```

## Data Flow: Server-Side Workflow Execution

```
Trigger event (webhook POST, timer tick, manual API call)
    │
    ▼
WorkflowEngine.execute(workflowId, triggerType, triggerData)
    │
    ├── Look up deployed workflow by ID
    ├── Create fresh ServerGraph from stored graphData
    ├── _injectTriggerData() into trigger node outputs
    │
    ├── Create DAGExecutor(serverGraph, callbacks)
    │       callbacks.execute → adapter.execute()
    │
    └── executor.run()
            │
            └── Same DAG execution as browser (topological order,
                control flow, error handling, transforms)
            │
            ▼
    Return execution record:
      { success, workflowId, triggerType, timestamp,
        duration, steps, skipped, errors, nodeResults }
```

## Persistence

### Auto-Save (Browser)

- **Key**: `localStorage["logos-legos-autosave"]`
- **Format**: `{ graph: <serialized LiteGraph>, timestamp: <epoch ms> }`
- **Trigger**: Debounced 2 seconds after any graph change (add/remove node, connection change, property change)
- **Recovery**: On page load, shows banner with relative time and Restore/Dismiss buttons

### Named Save Slots (Browser)

- **Key**: `localStorage["logos-legos-saves"]`
- **Format**: `{ "<name>": { graph: <serialized>, timestamp: <epoch ms>, nodeCount: <N> }, ... }`
- **UI**: Toolbar dropdown with name input, save button, and list of saved workflows (click to load, × to delete)

### Deployed Workflows (Server)

- **Storage**: In-memory Map on WorkflowEngine (lost on server restart)
- **Key**: workflowId (string)
- **Value**: `{ name, graphData, triggers, deployedAt }`

### Execution Log (Server)

- **Storage**: In-memory array on WorkflowEngine (last 100 entries)
- **Format**: `{ success, workflowId, workflowName, triggerType, timestamp, duration, steps, skipped, errors, nodeResults }`

## Path Resolution

The project lives at a specific path relative to the logos-workspace:

```
~/Github/
├── corpetty/
│   └── logos-legos/          # This project
│       └── bridge/
│           └── logos-adapter.js  ← uses __dirname
└── logos-co/
    └── logos-workspace/      # Logos build system
        └── result/           # Nix build output
            ├── bin/          # logoscore, lm, logos_host
            ├── lib/          # liblogos_core.so
            └── modules/      # Built module plugins
```

The adapter resolves paths relative to `__dirname` (the bridge/ directory), traversing `../../../logos-co/logos-workspace/`. This assumes the directory layout above. The `--plugins-dir` and `--lib-path` CLI flags override auto-detection.

## Build System

Logos Core uses [Nix flakes](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix3-flake.html) exclusively. The workspace flake does not have a default package — you must specify a build target.

```bash
cd logos-workspace

# Build logos-liblogos (logoscore, logos_host, liblogos_core.so, capability_module)
nix build .#logos-liblogos

# Build the module inspector (lm binary)
nix build .#logos-module

# Build a specific module (e.g., test modules, chat, wallet, etc.)
nix build .#logos-test-modules
nix build .#logos-chat-module
nix build .#logos-wallet-module

# Enter dev shell
nix develop
```

For single-user Nix installs (common on Fedora with SELinux), the binary is at `~/.nix-profile/bin/nix` rather than `/nix/var/nix/profiles/default/bin/nix`.

## LiteGraph Link Format

LiteGraph uses two different formats for link data, which is important for the DAG executor:

- **Serialized (array)**: `[linkId, originId, originSlot, targetId, targetSlot, type]` — used in `graph.serialize()` output and by `ServerGraph`
- **Runtime (object)**: `{ id, origin_id, origin_slot, target_id, target_slot, type, _data }` — used by live LiteGraph in the browser

The browser DAG executor handles both formats with fallback accessors:
```javascript
const originId = link.origin_id !== undefined ? link.origin_id : link[1];
```

The server DAG executor operates on `ServerGraph` which uses the array format consistently.
