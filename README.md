# Scry

Scry evaluates Elixir code inside running applications from VS Code. Each
application runs its own private Scry listener.

This repository contains:

- `server`: Elixir TCP listener, evaluator, and persistent sessions
- `vscode`: VS Code extension
- `examples/.scry.json`: project configuration example

## Request path

```text
VS Code -> Scry listener -> Code.eval_string
VS Code -> original DebugSocket -> XRPC.call(service, Code, :eval_string, [code])
```

Scry finds the nearest `mix.exs` above the active file and reads `.scry.json`
from that Elixir project root. It maps the project-relative file to an
application, picks an environment, then connects to the configured private IP.

## Start the server

Add Scry to the application's supervision tree:

```elixir
children = [
  {Scry,
   ip: {0, 0, 0, 0},
   port: 4321,
   token: System.fetch_env!("SCRY_TOKEN")}
]
```

Scry compiles in every Mix environment. Starting it remains explicit through
the supervision tree.

## Configure a project

Copy `examples/.scry.json` to project root. Use strict JSON, not JSONC. Scry
loads `.scry.local.json` first when present, otherwise `.scry.json`. Local file
must contain full config rather than a partial override.

Tokens may be literal strings or environment references:

```json
"token": "${env:SCRY_TOKEN}"
```

Literal tokens belong only in ignored `.scry.local.json`. Add that filename to
project `.gitignore`. Never expose a Scry
port to the public internet. Scry grants code execution with application OS and
database permissions. Restrict it to private networks or VPNs.

## Sessions

Set `"protocol": "xrpc"` on an environment to use the original deployed
DebugSocket protocol. `hosts`, `port`, `token`, and application `service` keep
the same meaning. XRPC environments do not support persistent bindings or
session clearing because the original server evaluates each request independently.

VS Code creates one session ID per workspace. Server stores bindings per
session and service for 30 minutes after last use:

```elixir
# First evaluation
user = Repo.get!(User, 42)

# Later evaluation in same workspace and service
user.email
```

Each gateway IP owns separate session state. `Scry: Eval Everywhere` updates
one session on every selected gateway.

## Extension commands

- `Scry: Eval`, `Shift+F2`
- `Scry: Pick Target and Eval`, `Shift+F1`
- `Scry: Eval in Panel`
- `Scry: Eval Everywhere`
- `Scry: Eval Changed Modules`
- `Scry: Repeat Last Eval`
- `Scry: Change Environment`
- `Scry: Clear Session`

`Eval Changed Modules` evaluates Git-changed `.ex` files and their transitive
compile-time dependents, with dependencies evaluated first. It also includes
struct/API dependents conservatively, while excluding runtime-only callers and
test files. A native Quick Pick lists searchable groups of changed files and
derived dependents, with evaluation positions and targets. Choose `Evaluate all`
to confirm, or press Escape to cancel before sending any code. Dependency discovery runs
`mise exec -- mix xref` against the last
local compilation without compiling or starting the application. Compile locally
first to create or refresh that graph after changing dependency relationships.
Ambiguous umbrella source paths and direct compile-time dependency cycles are
reported before any code is sent. Indirect runtime paths guide evaluation order
when they do not conflict with direct compile dependencies.

See component READMEs for development commands.
