# Scry for VS Code

## Development

```console
npm install
npm run check
npm test
npm run build
```

Package a VSIX:

```console
npx @vscode/vsce package --no-dependencies
```

Install it:

```console
code --install-extension scry-vscode-0.1.0.vsix
```

Extension finds the nearest `mix.exs` above the active file, then reads
`.scry.local.json` or `.scry.json` from that project root. The project-relative
file path selects the application. Chosen environment persists per Elixir
project in VS Code workspace state.

Use `"protocol": "xrpc"` on environments backed by the original DebugSocket
server. Connection fields remain `hosts`, `port`, and `token`; the matched
application `service` becomes the XRPC node name.
