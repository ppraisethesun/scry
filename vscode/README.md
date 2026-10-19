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

Packaging automatically rebuilds the extension bundle through `vscode:prepublish`.

Install it:

```console
code --install-extension scry-vscode-0.1.9.vsix
```

Extension finds the nearest `mix.exs` above the active file, then reads
`.scry.local.json` or `.scry.json` from that project root. The project-relative
file path selects the application. Chosen environment persists per Elixir
project in VS Code workspace state.

Use `"protocol": "xrpc"` on environments backed by the original DebugSocket
server. Connection fields remain `hosts`, `port`, and `token`; the matched
application `service` becomes the XRPC node name.

## Command-line client

`src/cli.ts` is a command-line client built on the same config, protocol and transport modules as the extension. It is used by the agent `scry` skill and writes a Markdown log of each evaluation to `.scry-history/` beside the project's Scry config.

```sh
npm run build:cli   # writes dist/scry-cli.cjs, a dependency-free bundle
node dist/scry-cli.cjs --project <mix-project> targets
```

After changing shared client code, rebuild and copy `dist/scry-cli.cjs` into the skill's `scripts/` directory.
