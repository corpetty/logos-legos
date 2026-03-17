# Logos Legos v2 — Native Multi-Module Architecture

## Vision

Logos Legos becomes a **collection of Logos modules** — not a standalone web app with a bridge, but a set of first-class participants in the Logos ecosystem. The visual workflow editor is rebuilt as a native Qt/QML application using QuickQanava for the graph canvas. Every Logos module that gets loaded becomes automatically available as a node type. Workflows execute natively through LogosAPI without any bridge layer.

The system decomposes into four modules with clean boundaries, each independently useful:

```
┌──────────────────────────────────────────────────────────────┐
│                    logos-app / logos_host                      │
│                  (Qt plugin host process)                      │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌─────────────────────┐    ┌──────────────────────────────┐  │
│  │ logos-workflow-canvas│    │ logos-workflow-engine         │  │
│  │                     │    │                              │  │
│  │  QuickQanava graph  │───▶│  DAG executor                │  │
│  │  Node palette       │    │  Control flow handlers       │  │
│  │  Port connections   │    │  Transform handlers          │  │
│  │  Execution viz      │    │  Error recovery              │  │
│  │  Save/load UI       │    │  Module method dispatch      │  │
│  └────────┬────────────┘    └──────────┬───────────────────┘  │
│           │                            │                       │
│           │ queries                    │ calls                 │
│           ▼                            ▼                       │
│  ┌─────────────────────┐    ┌──────────────────────────────┐  │
│  │ logos-workflow-      │    │ Any Logos module             │  │
│  │ registry             │    │                              │  │
│  │                     │    │  chat, storage, wallet,      │  │
│  │  Module discovery   │    │  accounts, waku, irc,        │  │
│  │  Method introspect  │    │  blockchain, package_mgr,    │  │
│  │  Node type defs     │    │  capability, ...             │  │
│  │  Port mappings      │    │                              │  │
│  └─────────────────────┘    └──────────────────────────────┘  │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ logos-workflow-scheduler                                 │  │
│  │                                                         │  │
│  │  Workflow deployment store    Cron/interval scheduling   │  │
│  │  Webhook HTTP listener        Manual trigger API         │  │
│  │  Execution history log        Headless DAG runs          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

---

## Module 1: `logos-workflow-registry`

**Purpose**: Discovers what Logos modules are loaded and translates their method signatures into node type definitions that the canvas can render and the engine can execute.

**Why it's separate**: Any module might want to know what other modules are available. A chat bot module could query the registry to offer workflow suggestions. A package manager UI could show available capabilities. This is useful beyond the workflow editor.

### Interface

All methods return `QString` (JSON-serialized) to match the Logos plugin IPC convention where complex types are marshalled as JSON strings across process boundaries.

```cpp
class WorkflowRegistryPlugin : public QObject, public WorkflowRegistryInterface {
    Q_OBJECT
    Q_PLUGIN_METADATA(IID WorkflowRegistryInterface_iid FILE "metadata.json")
    Q_INTERFACES(WorkflowRegistryInterface PluginInterface)

    // PluginInterface
    QString name() const override { return "workflow_registry"; }
    QString version() const override { return "1.0.0"; }

    // Discovery — all return JSON strings
    Q_INVOKABLE QString getAvailableModules();
    Q_INVOKABLE QString getModuleDetail(const QString& moduleName);
    Q_INVOKABLE QString getNodeTypeDefinitions();
    Q_INVOKABLE QString refreshModules();

    // LogosAPI initialization
    Q_INVOKABLE void initLogos(LogosAPI* logosAPIInstance);

signals:
    void eventResponse(const QString& eventName, const QVariantList& args);
};
```

### Node Type Definition Format

The registry produces a JSON structure for each node type that both the canvas and engine consume:

```json
{
    "nodeTypeId": "Chat/sendMessage",
    "module": "logos_chat_module",
    "method": "sendMessage",
    "displayName": "Chat",
    "methodDisplayName": "sendMessage",
    "category": "module_method",
    "ports": {
        "inputs": [
            { "id": "conversationID", "type": "string", "label": "Conversation ID", "color": "#4caf50" },
            { "id": "text", "type": "string", "label": "Message Text", "color": "#4caf50" }
        ],
        "outputs": [
            { "id": "result", "type": "object", "label": "Result", "color": "#26c6da" }
        ]
    },
    "color": "#4a9eff",
    "isLive": true
}
```

### Type Mapping

| Qt Type | Port Type | Color |
|---------|-----------|-------|
| `QString` | `string` | `#4caf50` (green) |
| `int`, `double`, `float` | `number` | `#ff9800` (orange) |
| `bool` | `boolean` | `#e91e63` (pink) |
| `QByteArray` | `bytes` | `#9e9e9e` (grey) |
| `QVariant`, `QVariantMap`, `QJsonObject` | `object` | `#26c6da` (teal) |
| `QUrl` | `string` | `#4caf50` (green) |
| `QStringList` | `array` | `#00bcd4` (cyan) |
| `LogosResult` | `object` | `#26c6da` (teal) |

### How Discovery Works

On `initLogos()`, the registry queries `core_manager.getKnownPlugins()` via LogosAPI to get the list of loaded modules. For each module, it calls `core_manager.getPluginMethods(pluginName)` to retrieve method metadata (name, parameters, return type). It skips internal modules (`core_manager`, `capability_module`) and its own `workflow_*` modules to avoid circular introspection.

As a fallback (when `core_manager` is unavailable), the `ModuleIntrospector` uses the `lm` CLI tool to introspect plugin `.so` files found in `$LOGOS_PLUGINS_DIR` or `~/.local/share/logos/modules`.

The `NodeTypeBuilder` then takes the raw module data and produces the full node type registry, including built-in node types that don't map to Logos modules:

- **Utility nodes**: String, Number, Boolean, JSON Parse/Stringify, Display, Template
- **Control flow nodes**: If/Else, Switch, ForEach, Merge, Try/Catch, Retry, Fallback
- **Transform nodes**: ArrayMap, ArrayFilter, ObjectPick, ObjectMerge, CodeExpression, HttpRequest
- **Trigger nodes**: Webhook, Timer, Manual

---

## Module 2: `logos-workflow-engine`

**Purpose**: Executes workflow graphs. Takes a serialized graph (from the canvas or from persistent storage), performs topological sorting, and executes nodes in dependency order — dispatching module method calls through LogosAPI and handling control flow, transforms, and errors internally.

**Why it's separate**: The engine runs headlessly. Deployed workflows triggered by webhooks or timers don't need the canvas. A CLI tool could execute workflows. Other modules could programmatically compose and run workflows. The engine is the runtime; the canvas is just one way to author graphs for it.

### Interface

```cpp
class WorkflowEnginePlugin : public QObject, public WorkflowEngineInterface {
    Q_OBJECT
    Q_PLUGIN_METADATA(IID WorkflowEngineInterface_iid FILE "metadata.json")
    Q_INTERFACES(WorkflowEngineInterface PluginInterface)

    QString name() const override { return "workflow_engine"; }
    QString version() const override { return "1.0.0"; }

    // Execution — returns JSON execution result strings
    Q_INVOKABLE QString executeWorkflow(const QString& workflowJson);
    Q_INVOKABLE QString executeWorkflowWithTrigger(const QString& workflowJson,
                                                   const QString& triggerData);
    Q_INVOKABLE QString cancelExecution(const QString& executionId);
    Q_INVOKABLE QString getExecutionStatus(const QString& executionId);

    Q_INVOKABLE void initLogos(LogosAPI* logosAPIInstance);

signals:
    void eventResponse(const QString& eventName, const QVariantList& args);
};
```

### Execution Model

The engine ports the v1 `dag-executor.js` logic to C++. The core algorithm is identical:

```
1. Parse workflow JSON into WorkflowGraph (in-memory model with topology queries)
2. Build adjacency lists from edges
3. Topological sort via Kahn's algorithm
4. For each node in sorted order:
   a. Check if node is active (all incoming connections from active outputs)
   b. Dispatch by node type:
      - Module method → LogosAPI::getClient(module)->invokeRemoteMethod(method, args)
      - Control flow  → ControlFlowHandler (if/else, switch, foreach, etc.)
      - Transform     → TransformHandler (map, filter, pick, merge, expression, HTTP)
      - Trigger       → passthrough (data pre-injected by WorkflowGraph::injectTriggerData)
   c. Track active outputs, results, errors
5. Return execution record: {success, executionId, steps, skipped, errors, nodeResults}
```

### Node Re-Execution

The `DAGExecutor` exposes a `reExecuteNode(nodeId)` method used by two control flow handlers:

- **Retry**: When an upstream node has errored, Retry clears the error, calls `reExecuteNode()` on the upstream node up to `maxRetries` times with configurable `delayMs` backoff between attempts. Routes to "result" on success or "failed" with detailed error info on exhaustion.

- **ForEach**: Finds downstream nodes connected to its "item" output, then for each array element sets the "item" output and calls `reExecuteNode()` on each downstream node per iteration, collecting results into the "done" output.

### Expression Evaluation

The engine embeds **QJSEngine** (Qt's JavaScript engine) for expression evaluation in CodeExpression, ArrayMap, and ArrayFilter nodes. This keeps the expression syntax familiar to anyone who used the JS version:

```cpp
// ExpressionEvaluator wraps QJSEngine with scope injection
QVariant ExpressionEvaluator::evaluate(const QString& expression, const QVariantMap& scope) {
    QJSValue global = m_engine->globalObject();
    for (auto it = scope.begin(); it != scope.end(); ++it) {
        global.setProperty(it.key(), m_engine->toScriptValue(it.value()));
    }
    QJSValue result = m_engine->evaluate(expression);
    // Clean up scope variables after evaluation
    for (auto it = scope.begin(); it != scope.end(); ++it) {
        global.deleteProperty(it.key());
    }
    return result.toVariant();
}
```

### Event-Driven Execution Feedback

The engine emits events as it executes, which the canvas (if running) can subscribe to for live visualization:

```
engineExecutionStarted(executionId)
engineNodeExecuting(executionId, module, method)
engineExecutionCompleted(executionId, success)
```

---

## Module 3: `logos-workflow-canvas`

**Purpose**: The visual workflow editor. A Qt/QML UI module that provides the QuickQanava-based graph canvas, node palette, connection handling, execution visualization, and save/load interface.

**Why it's separate**: It's a UI component. You could run Logos without it and still execute workflows via the engine + scheduler. You could also replace it with a different editor or a headless authoring tool.

### Architecture

```
logos-workflow-canvas/
├── src/
│   ├── CanvasComponent.h/cpp         # IComponent factory
│   ├── CanvasWidget.h/cpp            # Main widget, owns the QQuickWidget
│   ├── WorkflowGraph.h/cpp           # Extends qan::Graph for workflow semantics
│   ├── WorkflowSerializer.h/cpp      # Serialize/deserialize QuickQanava ↔ JSON
│   └── nodes/
│       ├── ModuleMethodNode.h/cpp    # Generic node for any Logos module method
│       ├── UtilityNode.h/cpp         # String, Number, Boolean, etc.
│       ├── ControlFlowNode.h/cpp     # If/Else, Switch, ForEach, etc.
│       ├── TransformNode.h/cpp       # Map, Filter, Pick, Merge, Expression
│       └── TriggerNode.h/cpp         # Webhook, Timer, Manual
├── interfaces/
│   └── IComponent.h                  # UI plugin interface
├── qml/
│   ├── WorkflowCanvas.qml           # Main canvas: toolbar, sidebar palette,
│   │                                 # graph view, and status bar (all-in-one)
│   └── delegates/
│       ├── ModuleNodeDelegate.qml    # Colored header, LIVE/MOCK badge, result preview
│       ├── UtilityNodeDelegate.qml   # Inline value editors (text, number, bool, template)
│       ├── ControlFlowDelegate.qml   # Purple FLOW badge, warning icon for error-catchers
│       ├── TransformNodeDelegate.qml # Teal TRANSFORM badge
│       └── TriggerNodeDelegate.qml   # Orange TRIGGER badge with lightning bolt
├── resources/
│   └── canvas_resources.qrc          # QML files bundled into the plugin binary
├── CMakeLists.txt
├── metadata.json
├── module.yaml
└── flake.nix                         # depends on: logos-cpp-sdk, logos-liblogos,
                                      #             QuickQanava (fetched as flake input)
```

### C++ Node Classes

Each node category has a C++ class extending `qan::Node` with typed Q_PROPERTY bindings for QML:

```cpp
class ModuleMethodNode : public qan::Node {
    Q_OBJECT
    QML_ELEMENT

    Q_PROPERTY(QString moduleName READ moduleName WRITE setModuleName NOTIFY moduleNameChanged)
    Q_PROPERTY(QString methodName READ methodName WRITE setMethodName NOTIFY methodNameChanged)
    Q_PROPERTY(QString nodeTypeId READ nodeTypeId WRITE setNodeTypeId NOTIFY nodeTypeIdChanged)
    Q_PROPERTY(QString nodeColor READ nodeColor WRITE setNodeColor NOTIFY nodeColorChanged)
    Q_PROPERTY(bool isLive READ isLive WRITE setIsLive NOTIFY isLiveChanged)
    Q_PROPERTY(QString executionStatus READ executionStatus
               WRITE setExecutionStatus NOTIFY executionStatusChanged)
    Q_PROPERTY(QVariant executionResult READ executionResult
               WRITE setExecutionResult NOTIFY executionResultChanged)

public:
    static QQmlComponent* delegate(QQmlEngine& engine, QObject* parent = nullptr);
    static qan::NodeStyle* style(QObject* parent = nullptr);
};
```

Ports are created dynamically by `WorkflowGraph::configurePorts()` based on the node type definition from the registry, using `qan::Graph::insertPort()` with typed dock positions and port IDs.

### Graph Serialization

`WorkflowGraph::serializeToJson()` iterates all nodes via `getNodes().items()`, serializes each by dynamic type (`dynamic_cast` to `ModuleMethodNode`, `UtilityNode`, etc.) with positions from `QQuickItem::x()/y()`, port definitions from `getInPorts()/getOutPorts()`, and property values. Edges are collected by iterating adjacency lists and extracting bound port IDs.

`WorkflowGraph::loadFromJson()` rebuilds the graph by mapping serialized node IDs to newly created nodes via `insertWorkflowNode()`, restoring positions, then recreating edges by looking up source/target port items by ID and calling `insertEdge()` + `bindEdge()`.

### Save/Load

Workflows are saved as JSON files to disk rather than localStorage:

- **Quick save** — writes to `QStandardPaths::AppDataLocation/workflows/<name>.json`
- **List/Delete** — enumerate and manage saved workflows by name
- `CanvasWidget` exposes `saveWorkflow()`, `loadWorkflow()`, `listSavedWorkflows()`, `deleteWorkflow()` as slots callable from QML

---

## Module 4: `logos-workflow-scheduler`

**Purpose**: Manages deployed workflows and fires them on triggers. Runs headlessly. Persists deployed workflows to disk. Exposes an HTTP endpoint for webhooks.

**Why it's separate**: Scheduling and deployment are runtime concerns independent of both the editor UI and the execution logic. You might want to deploy workflows authored on one machine to run on another. The scheduler has its own lifecycle — it starts timers and listens for webhooks whether or not anyone has the canvas open.

### Interface

```cpp
class WorkflowSchedulerPlugin : public QObject, public WorkflowSchedulerInterface {
    Q_OBJECT
    Q_PLUGIN_METADATA(IID WorkflowSchedulerInterface_iid FILE "metadata.json")
    Q_INTERFACES(WorkflowSchedulerInterface PluginInterface)

    QString name() const override { return "workflow_scheduler"; }
    QString version() const override { return "1.0.0"; }

    // Deployment — returns JSON strings
    Q_INVOKABLE QString deployWorkflow(const QString& workflowId, const QString& workflowJson);
    Q_INVOKABLE QString undeployWorkflow(const QString& workflowId);
    Q_INVOKABLE QString listDeployedWorkflows();

    // Manual trigger
    Q_INVOKABLE QString triggerWorkflow(const QString& workflowId, const QString& triggerData);

    // Status
    Q_INVOKABLE QString getSchedulerStatus();
    Q_INVOKABLE QString getExecutionHistory(int limit);

    Q_INVOKABLE void initLogos(LogosAPI* logosAPIInstance);

signals:
    void eventResponse(const QString& eventName, const QVariantList& args);
};
```

### Trigger Types

**Cron/Interval**: Parsed from trigger node properties. Uses `QTimer` for intervals and a 60-second tick loop with `CronParser::matchesNow()` for cron expression matching (same 5-field cron algorithm as the v1 `scheduler.js`, ported to C++).

**Webhook**: The `WebhookListener` starts a `QTcpServer` on a configurable port (default 8081, overridable via `LOGOS_WEBHOOK_PORT` env var). Incoming `POST /webhooks/<workflowId>` triggers the workflow with the parsed JSON body and HTTP headers passed through as trigger data.

**Manual**: Exposed through the `triggerWorkflow()` method. The canvas UI provides a deploy button, and other modules can call it programmatically.

### Persistence

`DeploymentStore` persists deployed workflows to `QStandardPaths::AppDataLocation/deployed-workflows/` as individual JSON files. On `initLogos()`, the scheduler loads all deployed workflows from disk and resumes their timer schedules.

---

## Inter-Module Communication Map

```
                    ┌──────────────────┐
                    │     Registry     │
                    │                  │
                    │ getNodeTypeDefs()│
                    └────────┬─────────┘
                        ▲    │
           queries      │    │ definitions
                        │    ▼
┌──────────────┐    ┌────────────────┐    ┌──────────────────┐
│   Canvas     │───▶│    Engine       │◀───│   Scheduler      │
│              │    │                │    │                  │
│ serialize    │    │ executeWorkflow│    │ deployWorkflow   │
│ graph to JSON│    │                │    │ triggerWorkflow   │
│ + subscribe  │    │ emits events   │    │                  │
│ to events    │    │ per node       │    │ on trigger:      │
│              │    │                │    │ calls engine     │
└──────────────┘    └────────┬───────┘    └──────────────────┘
                             │
                    LogosAPI │ invokeRemoteMethod()
                             │
                    ┌────────▼───────────────────────┐
                    │   Any loaded Logos module       │
                    │   chat, storage, wallet, ...    │
                    └────────────────────────────────┘
```

**Canvas → Registry**: `getNodeTypeDefinitions()` to populate the palette. Subscribes to `registryNodeTypesUpdated` event to handle hot-loaded modules.

**Canvas → Engine**: `executeWorkflow(json)` when user clicks Run. Subscribes to engine events for live visualization.

**Scheduler → Engine**: `executeWorkflowWithTrigger(json, triggerData)` when a cron/interval/webhook trigger fires.

**Engine → Any Module**: `LogosAPI::getClient(moduleName)->invokeRemoteMethod(method, args)` for each module method node in the workflow.

**Registry → core_manager**: `getKnownPlugins()` and `getPluginMethods(pluginName)` to discover and introspect loaded modules.

---

## Build Structure

Each module is its own repository (following Logos conventions) and its own Nix flake. The three core modules (`registry`, `engine`, `scheduler`) use `logos-module-builder` for standardized build infrastructure. The canvas module manages its own flake since it has the additional QuickQanava dependency.

```
logos-co/
├── logos-workflow-registry/
│   ├── src/
│   │   ├── workflow_registry_interface.h
│   │   ├── workflow_registry_plugin.h/cpp
│   │   ├── module_introspector.h/cpp
│   │   └── node_type_builder.h/cpp
│   ├── metadata.json
│   ├── module.yaml
│   ├── CMakeLists.txt
│   └── flake.nix              # uses logos-module-builder
│
├── logos-workflow-engine/
│   ├── src/
│   │   ├── workflow_engine_interface.h
│   │   ├── workflow_engine_plugin.h/cpp
│   │   ├── dag_executor.h/cpp
│   │   ├── workflow_graph.h/cpp
│   │   ├── expression_evaluator.h/cpp
│   │   └── handlers/
│   │       ├── control_flow_handler.h/cpp
│   │       └── transform_handler.h/cpp
│   ├── metadata.json
│   ├── module.yaml
│   ├── CMakeLists.txt
│   └── flake.nix              # uses logos-module-builder
│
├── logos-workflow-canvas/
│   ├── src/
│   │   ├── CanvasComponent.h/cpp
│   │   ├── CanvasWidget.h/cpp
│   │   ├── WorkflowGraph.h/cpp
│   │   ├── WorkflowSerializer.h/cpp
│   │   └── nodes/
│   │       ├── ModuleMethodNode.h/cpp
│   │       ├── UtilityNode.h/cpp
│   │       ├── ControlFlowNode.h/cpp
│   │       ├── TransformNode.h/cpp
│   │       └── TriggerNode.h/cpp
│   ├── interfaces/
│   │   └── IComponent.h
│   ├── qml/
│   │   ├── WorkflowCanvas.qml
│   │   └── delegates/
│   │       ├── ModuleNodeDelegate.qml
│   │       ├── UtilityNodeDelegate.qml
│   │       ├── ControlFlowDelegate.qml
│   │       ├── TransformNodeDelegate.qml
│   │       └── TriggerNodeDelegate.qml
│   ├── resources/
│   │   └── canvas_resources.qrc
│   ├── metadata.json
│   ├── module.yaml
│   ├── CMakeLists.txt
│   └── flake.nix              # depends on: logos-cpp-sdk, logos-liblogos,
│                               #             QuickQanava (fetched as flake input)
│
├── logos-workflow-scheduler/
│   ├── src/
│   │   ├── workflow_scheduler_interface.h
│   │   ├── workflow_scheduler_plugin.h/cpp
│   │   ├── cron_parser.h/cpp
│   │   ├── webhook_listener.h/cpp
│   │   └── deployment_store.h/cpp
│   ├── metadata.json
│   ├── module.yaml
│   ├── CMakeLists.txt
│   └── flake.nix              # uses logos-module-builder
│
└── logos-workspace/
    └── flake.nix              # adds all four as inputs with follows
```

### Dependency Graph

```
logos-module-builder (provides logos-cpp-sdk + logos-liblogos internally)
    ▲
    ├── logos-workflow-registry
    ├── logos-workflow-engine
    └── logos-workflow-scheduler

logos-cpp-sdk + logos-liblogos (direct dependencies)
    ▲
    └── logos-workflow-canvas ──── QuickQanava (fetched via flake input)
```

Only the canvas depends on QuickQanava and manages its own SDK dependencies. The other three modules are pure Qt/C++ using `logos-module-builder`'s `mkLogosModule` abstraction.

### Adding to logos-workspace

```nix
# In logos-workspace/flake.nix, add:
inputs = {
    # ... existing inputs ...
    logos-workflow-registry = {
        url = "github:logos-co/logos-workflow-registry";
        inputs.logos-module-builder.follows = "logos-module-builder";
    };
    logos-workflow-engine = {
        url = "github:logos-co/logos-workflow-engine";
        inputs.logos-module-builder.follows = "logos-module-builder";
    };
    logos-workflow-canvas = {
        url = "github:logos-co/logos-workflow-canvas";
        inputs.logos-cpp-sdk.follows = "logos-cpp-sdk";
        inputs.logos-liblogos.follows = "logos-liblogos";
    };
    logos-workflow-scheduler = {
        url = "github:logos-co/logos-workflow-scheduler";
        inputs.logos-module-builder.follows = "logos-module-builder";
    };
};
```

---

## Implementation Status

All four modules compile to native shared libraries and the three headless modules have been tested running inside `logoscore`.

| Module | Output | Size | Status |
|--------|--------|------|--------|
| `workflow_registry_plugin.so` | ✅ Compiles + Runs | 571K | Loads in logoscore, discovers 23 built-in node types |
| `workflow_engine_plugin.so` | ✅ Compiles + Runs | 1.1M | Executes workflows headlessly with correct DAG ordering |
| `workflow_scheduler_plugin.so` | ✅ Compiles + Runs | 657K | Loads in logoscore |
| `workflow_canvas.so` | ✅ Compiles | 4.7M | Needs testing in logos-app |

### Test Results

Three workflow tests pass with correct results:

- **Simple String Echo** — 2 nodes, 2 steps. String constant flows to Display. ✅
- **If/Else Branch** — 5 nodes, 4 steps, 1 skipped (false branch correctly inactive). ✅
- **Transform Pipeline** — 6 nodes, 6 steps. JSON parse → ObjectPick → Template interpolation, plus CodeExpression via QJSEngine evaluating `input.name + ' v' + input.version`. ✅

### Building from Source

The modules build against Qt 6.9.2 and the logos-cpp-sdk source headers. A "hybrid SDK" layout is used: source headers (which define the `Timeout` struct matching the runtime ABI) paired with the pre-built `liblogos_sdk.a` from the nix store.

```bash
# Prerequisites: cmake, ninja, g++, Qt6 (from nix store)
# SDK headers must match the logoscore runtime ABI (Timeout struct vs int)

CMAKE="/nix/store/.../cmake"
HYBRID_SDK="/path/to/hybrid-sdk"  # Source headers + matching liblogos_sdk.a

cd logos-workflow-registry
cmake -B build -GNinja \
  -DCMAKE_PREFIX_PATH="$QT_BASE;$QT_REMOTE" \
  -DQt6RemoteObjects_DIR="$QT_REMOTE/lib/cmake/Qt6RemoteObjects" \
  -DLOGOS_SDK_LIB="$HYBRID_SDK/lib/liblogos_sdk.a"
cmake --build build
```

The SDK code generator (`logos-cpp-generator`) must be run before building each module to produce `logos_sdk.h`/`logos_sdk.cpp`:

```bash
logos-cpp-generator --metadata metadata.json --general-only --output-dir generated_code
```

### Running in logoscore

Modules need `LD_PRELOAD` of `liblogos_core.so` so that `logos_host` child processes can resolve SDK symbols. The engine additionally needs `LD_LIBRARY_PATH` to include Qt6 Qml for `QJSEngine`:

```bash
export LD_PRELOAD="/path/to/liblogos_core.so"
export LD_LIBRARY_PATH="/path/to/qtdeclarative/lib"
export QT_QPA_PLATFORM=offscreen
export QT_FORCE_STDERR_LOGGING=1

logoscore -m /path/to/test-workflow-modules \
  -l workflow_engine \
  -c "workflow_engine.executeWorkflow(@test_simple.json)" \
  --quit-on-finish
```

Note: the `-m` flag requires a logoscore binary built from current `logos-liblogos` source. Older nix store binaries ignore `-m` and only scan `applicationDirPath()/../modules`.

### Compile Fixes Applied

Key issues discovered and fixed during the build process:

- **SDK ABI mismatch**: Installed SDK headers use `int timeoutMs` but runtime uses `struct Timeout`. Fixed by using source SDK headers.
- **`#include <QuickQanava>`** → `#include "QuickQanava.h"` for direct include path resolution
- **`clearGraph()` needs `noexcept override`** to match `qan::Graph` virtual
- **`insertNode(nullptr)` ambiguous** between two overloads → `insertNode(static_cast<QQmlComponent*>(nullptr))`
- **`getPorts()` returns `QQuickItem*`** container → need `qobject_cast<qan::PortItem*>` per item
- **`invokeRemoteMethod` overloads** ambiguous with `{}` initializer → explicit `QString()`, `QVariantList()`, `QVariant()` casts
- **`QNetworkRequest request(QUrl(url))`** most-vexing-parse → brace initialization `{QUrl(url)}`
- **Missing `#include <QRegularExpression>`** in cron parser
- **Missing `#include "logos_api_client.h"`** where methods are called (not just forward-declared)
- **OpenGL headers missing** for Qt6Gui → stub `FindOpenGL.cmake` for headless plugin builds
- **`metadata.json` not found by MOC** → symlink from `src/` to root

---

## Open Questions

**SDK version alignment**: The hybrid SDK approach works for dev but is fragile. A proper nix build (via `nix build`) would resolve the ABI mismatch automatically since all packages share the same nixpkgs pin. Priority: set up `flake.nix` builds for each module.

**Canvas node type registration**: `insertNode()` returns `qan::Node*`, not our custom subclass. Need to use `insertNode<ModuleMethodNode>()` template or register custom types with QuickQanava's type system and provide QML delegates. This is the first thing to fix when testing the canvas in `logos-app`.

**Graph serialization ownership**: The workflow JSON format is defined by the canvas (`WorkflowGraph::serializeToJson`) and consumed by the engine (`WorkflowGraph` in the engine module — same class name, different implementation). A shared format spec or header-only library would be cleaner.

**Hot module loading**: If a new module is loaded while the canvas is running, the registry emits `registryNodeTypesUpdated` and the canvas rebuilds its palette. Running workflows that reference unloaded modules will get a null client from LogosAPI — the engine logs a warning and returns an empty result for that node.

**Expression sandboxing**: `ExpressionEvaluator` strips `quit` and `gc` from the QJSEngine global scope. For untrusted expressions, further sandboxing of the global object would be needed.

**Workflow format versioning**: The v2 native format is not compatible with v1 LiteGraph JSON. A migration tool could convert v1 workflows to v2 for users of the prototype.
