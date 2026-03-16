# Logos Legos

A visual workflow builder for [Logos Core](https://github.com/logos-co) modules. Think ComfyUI, but for composing Logos protocol operations — chat, wallet, blockchain, storage, and more — into executable pipelines.

Built on [LiteGraph.js](https://github.com/jagenjo/litegraph.js), the same node-graph engine behind ComfyUI.

## What It Does

- **Visual node editor** — drag, drop, and wire together Logos module methods
- **Live execution** — connect to a running logos-core instance and execute real module calls
- **Module introspection** — automatically discovers modules and their methods from compiled plugins via the `lm` inspector tool
- **Three-tier fallback** — live FFI (logos-js-sdk) > CLI (logoscore) > mock simulation
- **LIVE/MOCK badges** — each module shows whether it has a real compiled backend or is running in mock mode
- **Workflow export/import** — save and share workflows as JSON files

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (port 8080)                      │
│  ┌──────────┐  ┌─────────────┐  ┌───────────┐  ┌────────────┐ │
│  │ app.js   │  │ node-types  │  │ workflow  │  │ bridge-    │ │
│  │ (main)   │  │ (LiteGraph) │  │ manager   │  │ client.js  │ │
│  └──────────┘  └─────────────┘  └───────────┘  └─────┬──────┘ │
└───────────────────────────────────────────────────────┼────────┘
                                                        │ HTTP
┌───────────────────────────────────────────────────────┼────────┐
│                   Bridge Server (port 8081)            │        │
│  ┌────────────┐  ┌─────────────────────────────────┐  │        │
│  │ server.js  │  │ logos-adapter.js                 │  │        │
│  │ (HTTP API) ├──┤  ┌─────┐  ┌─────┐  ┌──────┐   │  │        │
│  │            │  │  │ FFI │  │ CLI │  │ Mock │   │  │        │
│  └────────────┘  │  └──┬──┘  └──┬──┘  └──┬───┘   │  │        │
│                  └─────┼────────┼────────┼────────┘  │        │
└────────────────────────┼────────┼────────┼───────────┘        │
                         │        │        │                     │
                    liblogos   logoscore  (simulated)            │
                    _core.so   CLI binary                        │
```

### Frontend (Pure HTML/JS, no build step)

| File | Purpose |
|------|---------|
| `index.html` | Single-page app shell with toolbar, sidebar, canvas, status bar |
| `js/app.js` | Main application: bridge connection, workflow execution, sidebar, toolbar |
| `js/node-types.js` | LiteGraph node type registration — each module method becomes a node |
| `js/module-registry.js` | Module data management — loads from static JSON or live bridge |
| `js/bridge-client.js` | HTTP client for the bridge server with event system |
| `js/workflow.js` | Workflow export/import, validation, pipeline extraction, CLI generation |
| `css/styles.css` | Dark theme styling for the full UI |
| `data/modules.json` | Static module definitions (fallback when bridge unavailable) |

### Bridge Server (Node.js)

| File | Purpose |
|------|---------|
| `bridge/server.js` | HTTP server with CORS, routes requests to the adapter |
| `bridge/logos-adapter.js` | Core adapter: initializes logos-core connection, introspects modules, executes methods |
| `bridge/package.json` | Dependencies (ffi-napi, ref-napi as optional for FFI mode) |

### Module Plugins

| Path | Purpose |
|------|---------|
| `modules/<name>/<name>_plugin.so` | Compiled Qt plugin shared libraries (symlinked from Nix store) |
| `modules/<name>/manifest.json` | Required by logoscore to discover plugins in subdirectories |

## Getting Started

### Prerequisites

- [Nix](https://nixos.org/download.html) with flakes enabled (for building logos-core)
- Node.js 18+ (Node 22 works for CLI mode; Node 18 required for FFI mode)
- Python 3 (for the static file dev server)

### 1. Build Logos Core

```bash
# Clone and build the workspace
cd ~/Github/logos-co
git clone https://github.com/logos-co/logos-workspace.git
cd logos-workspace

# Configure git for HTTPS (submodules use SSH URLs)
git config --global url."https://github.com/".insteadOf "git@github.com:"

# Initialize submodules and build
git submodule update --init --recursive
nix build

# Verify the build produced binaries
ls result/bin/    # logoscore, logos_host, lm
ls result/lib/    # liblogos_core.so
```

### 2. Set Up Module Plugins

Create a local `modules/` directory with symlinks to the built plugins:

```bash
cd /path/to/logos-legos

# Create module directories
mkdir -p modules/capability_module
mkdir -p modules/test_basic_module

# Symlink the compiled .so files from the Nix store
ln -s $(find /nix/store -name "capability_module_plugin.so" -path "*/lib/*" | head -1) \
  modules/capability_module/capability_module_plugin.so

ln -s $(find /nix/store -name "test_basic_module_plugin.so" -path "*/lib/*" | head -1) \
  modules/test_basic_module/test_basic_module_plugin.so
```

Each module subdirectory needs a `manifest.json`:

```json
{
  "name": "test_basic_module",
  "version": "1.0.0",
  "main": {
    "linux-x86_64": "test_basic_module_plugin.so",
    "linux-amd64": "test_basic_module_plugin.so",
    "linux-aarch64": "test_basic_module_plugin.so"
  }
}
```

### 3. Start the Bridge Server

```bash
cd bridge
npm install
cd ..

# Start with explicit plugins directory
node bridge/server.js --plugins-dir ./modules

# Or mock mode (no logos-core needed)
node bridge/server.js --mock
```

You should see output like:
```
[bridge] Logos Legos Bridge Server (Node.js)
[bridge] Initializing adapter...
[adapter] Using logoscore CLI: /path/to/logoscore
[adapter] Found 2 plugin files to introspect
[adapter] Introspected capability_module: 1 invokable methods
[adapter] Introspected test_basic_module: 37 invokable methods
[adapter] Added 9 mock modules (11 total)
[bridge] Server listening on http://localhost:8081
[bridge] Mode: cli
[bridge] Modules: 0 loaded, 11 known
```

### 4. Start the Frontend

```bash
python3 -m http.server 8080
```

Open http://localhost:8080 in your browser.

### 5. Connect and Execute

1. Click **Connect** in the top-right toolbar
2. The sidebar will show LIVE badges on modules with real backends
3. Drag nodes from the sidebar onto the canvas
4. Connect utility nodes (String, Number) to module method inputs
5. Click **Run** to execute the workflow through logos-core

## Bridge API

The bridge server exposes a REST API on port 8081:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Bridge mode, available tools, module count |
| `/api/modules` | GET | All modules with metadata, methods, live status |
| `/api/modules/:name` | GET | Single module details |
| `/api/execute` | POST | Execute a single method: `{module, method, params}` |
| `/api/workflow` | POST | Execute a pipeline: `{pipeline: [...steps]}` |
| `/api/discover` | GET | Re-scan for modules |
| `/api/load` | POST | Load a specific module: `{module}` |

### Example: Execute a Method

```bash
curl -X POST http://localhost:8081/api/execute \
  -H "Content-Type: application/json" \
  -d '{"module":"test_basic_module","method":"echo","params":{"input":"hello"}}'

# Response:
# {
#   "success": true,
#   "data": {"output": "hello"},
#   "call": "logoscore -c \"test_basic_module.echo(hello)\"",
#   "live": true
# }
```

## Execution Modes

The adapter tries three execution strategies in order:

1. **Live (FFI)** — Direct function calls via `logos-js-sdk` binding to `liblogos_core.so`. Requires Node.js 18 and `ffi-napi`. Fastest, but has native dependency requirements.

2. **CLI** — Shells out to `logoscore -c "module.method(args)"` for each call. Works with any Node.js version. Each call spawns a fresh logoscore process (~3-5s per call including initialization).

3. **Mock** — Generates simulated responses based on method name heuristics. No logos-core needed. Useful for UI development and testing.

## Module System

### How Modules Are Discovered

1. The adapter scans `modules/` for subdirectories containing `*_plugin.so` files
2. Each plugin is introspected using the `lm` binary: `lm path/to/plugin.so --json`
3. Methods marked `Q_INVOKABLE` in the Qt plugin become node types (excluding `initLogos` and `eventResponse`)
4. Parameter types are mapped from Qt types: `QString` -> `string`, `int`/`double` -> `number`, `bool` -> `boolean`, `QVariant*` -> `object`

### Adding New Modules

1. Build the module in logos-workspace
2. Symlink the `.so` file into `modules/<name>/`
3. Create a `manifest.json` in the same directory
4. Restart the bridge server — the new module will be auto-discovered

### Mock Modules

Modules defined in `data/modules.json` but without compiled plugins show as MOCK in the UI. They can still be placed on the canvas and connected, but execution returns simulated data. This lets you design workflows before all modules are built.

## Node Types

### Module Method Nodes

Each module method registers as `DisplayName/methodName` in LiteGraph. For example, `test_basic_module.echo` becomes the node type `Test Basic/echo`.

Node features:
- Color-coded by module (darker shades for background)
- LIVE/MOCK indicator in the title bar
- Execution status border (orange=running, green=success, red=error)
- Inline result preview panel below the node
- Right-click menu: View Module Info, View Execution Result, API call syntax

### Utility Nodes

| Node | Inputs | Outputs | Purpose |
|------|--------|---------|---------|
| StringConstant | — | string | Provide a string value |
| NumberConstant | — | number | Provide a numeric value |
| BooleanConstant | — | boolean | Provide a boolean value |
| JsonParse | string | object | Parse JSON string to object |
| JsonStringify | object | string | Serialize object to JSON |
| Display | * | — | Show input value in node title |
| StringTemplate | object | string | Template interpolation with `{key}` syntax |

## Project Structure

```
logos-legos/
├── index.html              # Single-page app
├── css/
│   └── styles.css          # Dark theme UI styles
├── js/
│   ├── app.js              # Main application controller
│   ├── bridge-client.js    # HTTP client for bridge server
│   ├── module-registry.js  # Module data management
│   ├── node-types.js       # LiteGraph node registration + visualization
│   └── workflow.js         # Workflow export/import/validation
├── bridge/
│   ├── server.js           # Node.js HTTP bridge server
│   ├── logos-adapter.js    # Logos-core adapter (FFI/CLI/mock)
│   └── package.json        # Bridge dependencies
├── data/
│   └── modules.json        # Static module definitions (mock fallback)
├── modules/                # Compiled module plugins (symlinks to Nix store)
│   ├── capability_module/
│   │   └── capability_module_plugin.so
│   └── test_basic_module/
│       ├── manifest.json
│       └── test_basic_module_plugin.so
└── .claude/
    └── launch.json         # Dev server configuration
```

## Development

### Running in Mock Mode

For UI development without logos-core:

```bash
# Terminal 1: Bridge in mock mode
node bridge/server.js --mock

# Terminal 2: Frontend
python3 -m http.server 8080
```

### Key Globals (Browser Console)

- `window.app` — LogosLegosApp instance
- `window.app.graph` — LiteGraph graph
- `window.app.bridge` — BridgeClient instance
- `window.moduleRegistry` — ModuleRegistry singleton
- `window.bridgeClient` — BridgeClient singleton

### Programmatic Node Creation

```javascript
// Create nodes via console
const str = LiteGraph.createNode("Utility/StringConstant");
str.pos = [100, 100];
str.properties.value = "hello";
app.graph.add(str);

const echo = LiteGraph.createNode("Test Basic/echo");
echo.pos = [400, 100];
app.graph.add(echo);

str.connect(0, echo, 0);  // Connect string output to echo input
```

## License

MIT
