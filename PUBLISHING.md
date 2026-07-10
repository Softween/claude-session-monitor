# Publishing to the VS Code Marketplace

One-time setup, then `npm run build && vsce publish`.

## One-time

1. **Create the publisher** `softween` at <https://marketplace.visualstudio.com/manage>
   (sign in with the Microsoft/Azure account that should own the listing). The id must
   match `"publisher"` in `package.json`.
2. **Create a Personal Access Token (PAT)** in Azure DevOps (<https://dev.azure.com>):
   - Organization: any (or "All accessible organizations").
   - Scopes: **Marketplace > Manage**.
   - Copy the token.

## Publish

```bash
npm install
npm run build
npx @vscode/vsce login softween      # paste the PAT once
npx @vscode/vsce publish            # or: vsce publish patch | minor | major
```

`vsce publish patch` bumps the version, packages, and uploads in one step.

## Open VSX (optional, for Cursor / VSCodium / Windsurf users)

```bash
npx ovsx publish -p <OPEN_VSX_TOKEN>
```

Get a token at <https://open-vsx.org> (Eclipse account). This widens reach to non-Microsoft VS Code distributions.

## Notes

- CI (`.github/workflows/ci.yml`) builds and packages on every push; it does not
  publish. Publishing is a manual, credentialed step.
- Bump `CHANGELOG.md` with each release.
