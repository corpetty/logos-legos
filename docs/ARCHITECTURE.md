# Architecture

## Overview

Logos Legos is a three-layer system: a static frontend, a Node.js bridge server, and the logos-core runtime.

## Layer 1: Frontend (Browser)

The frontend is a zero-build-step single-page application. All JavaScript runs directly in the browser via `<script>` tags — no bundler, no framework, no transpilation.

### Module Registry (`js/module-registry.js`)

The registry is the central data store for module definitions. It supports two loading modes:

1. **Static** — reads `data/modules.json` for offline/fallback module definitions
2. **Bridge** — fetches live module data from the bridge server via `loadFromBridge()`

When loading from the bridge, the registry enriches modules with display metadata (colors, categories, display names) that the bridge may not provide, since the logos-core introspection only returns raw method signatures.

### Node Types (`js/node-types.js`)

Translates module registry data into LiteGraph node types. Each module method becomes a distinct node class registered as `DisplayName/methodName`.

Key design decisions:
- **Slot colors** map to types: green=string, orange=number, pink=boolean, grey=bytes, teal=object
- **Execution visualization** is drawn directly on the canvas via `onDrawForeground` and `onDrawBackground` hooks
- **Status borders** animate: running shows a dashed orange border with animated offset, success shows solid green, error shows solid red
- **Result panels** render below the node showing formatted output data

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
- **Workflow execution** — `runWorkflow()` extracts pipeline, iterates steps, gathers inputs, executes via bridge
- **Input resolution** — `gatherNodeInputs()` + `resolveInputValue()` walk the link graph to resolve parameter values from connected utility nodes or previous pipeline results
- **Sidebar** — dynamic module list with drag-to-add, search filtering, category collapsing

#### Input Resolution Strategy

When executing a workflow step, the app needs to find the input values for each method parameter. This is handled by two methods:

1. `gatherNodeInputs(node)` — tries `node.getInputData(i)` first (LiteGraph native), then falls back to manual resolution
2. `resolveInputValue(node, inputIndex)` — walks the link graph to the origin node:
   - If origin has `_executionResult` (set by a previous pipeline step): use that
   - If origin has `properties.value` (utility node like StringConstant): use that
   - Otherwise: try `getOutputData()` on the origin

This strategy handles both utility-to-module connections and chained module-to-module connections.

## Layer 2: Bridge Server

### Server (`bridge/server.js`)

Minimal HTTP server with CORS support. Routes:
- `GET /api/status` — adapter status
- `GET /api/modules` — module list with metadata
- `POST /api/execute` — single method execution
- `POST /api/workflow` — pipeline execution
- `GET /api/discover` — re-scan for modules

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

## Data Flow: Workflow Execution

```
User clicks Run
    │
    ▼
app.runWorkflow()
    │
    ├── workflow.extractPipeline()     # Topological sort of graph nodes
    │       │
    │       ▼
    │   [step1, step2, step3, ...]     # Ordered by data dependencies
    │
    ├── Filter to module steps only    # Skip utility nodes
    │
    └── app.runViaBridge(steps)
            │
            ▼ (for each step)
        ┌── app.gatherNodeInputs(node)
        │       │
        │       ├── node.getInputData(i)        # Try LiteGraph native
        │       │
        │       └── app.resolveInputValue()     # Walk links manually
        │               │
        │               ├── origin._executionResult   # From previous step
        │               └── origin.properties.value   # From utility node
        │
        ├── bridge.execute(module, method, params)
        │       │
        │       ▼ (HTTP POST)
        │   server.js → adapter.execute()
        │       │
        │       ├── _executeLive()   # FFI (if available)
        │       ├── _executeCLI()    # Shell to logoscore
        │       └── _executeMock()   # Simulated response
        │
        └── app.setNodeResult(node, data)
                │
                ├── node._executionResult = data     # For downstream steps
                ├── node.setOutputData(i, data)      # For LiteGraph
                └── canvas.setDirty()                # Trigger redraw
```

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

Logos Core uses [Nix flakes](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix3-flake.html) exclusively. Key commands:

```bash
# Build everything
cd logos-workspace && nix build

# Build a specific module
nix build .#test_basic_module

# Enter dev shell
nix develop
```

For single-user Nix installs (common on Fedora with SELinux), the binary is at `~/.nix-profile/bin/nix` rather than `/nix/var/nix/profiles/default/bin/nix`.
