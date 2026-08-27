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

Extension reads `.scry.local.json`, then `.scry.json`, from active workspace
root. Active file path selects application. Chosen environment persists in VS
Code workspace state.
