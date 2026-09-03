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

See component READMEs for development commands.
