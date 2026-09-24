# Documentation build

Standard VitePress theme; source Markdown lives in `../docs` and `../examples`. No deployment occurs during a local build. See [the publishing guide](../docs/handbook/publishing.md) for Pages activation after repository transfer.

```sh
npm ci --prefix site
npm run build --prefix site
npm run preview --prefix site
```

Build output: `site/.vitepress/dist`. Staged Markdown: `site/.content` (ignored). `prepare.mjs` resolves relative documentation links, imports executable snippets, creates source viewers and packages consumer examples. `check.mjs` verifies generated local links and assets. The build never executes application examples or loads `.env`.

The default base derives from `GITHUB_REPOSITORY` (local fallback `erwinmsmith/Ditto`); override with `DOCS_BASE=/` for a root-hosted site. The workflow is manual, builds by default, and deploys only when explicitly selected on main. It does not enable Pages or change repository visibility.

Use `npm run dev --prefix site` to preview staged content while editing. Re-run the command after changing source Markdown; the source tree is authoritative and `site/.content` must not be edited.
