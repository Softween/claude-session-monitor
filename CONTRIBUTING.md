# Contributing

Thanks for your interest. This is a small, focused VS Code extension; PRs and issues
are welcome.

## Setup

```bash
npm install
npm run watch     # rebuild on change
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Useful scripts

- `npm run build` — esbuild bundle to `dist/extension.js`
- `npm run verify` — run the pure data layer (`src/core.ts`) against your real
  transcripts (no `vscode` dependency), handy for debugging state resolution
- `npm run package` — produce a `.vsix`

## Guidelines

- Keep `src/core.ts` free of any `vscode` import so it stays unit-testable.
- The macOS-only pieces (official usage via keychain, native notifications, auto-resume
  keystrokes) should degrade gracefully on other platforms. Cross-platform
  implementations are very welcome.
- Run `npm run build` before opening a PR; CI builds and packages on every push.

## License

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
