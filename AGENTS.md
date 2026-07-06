# ContextCake

## Commands

```bash
# Root engine / MCP / write-path validation
npm test

# Root demo verification
npm run demo:verify

# Console app
cd console
npm ci
npm run typecheck
npm run build
npm run dev

# Site
cd site
npm ci
npm run build
astro dev --background
```

## Architecture

- Repo root is the dependency-free engine, MCP server, classifier, ingest path, and write path. Key entry points: `resolver.mjs`, `mcp-server.mjs`, `classify-context.mjs`, `ingest.mjs`, and `write.mjs`.
- `console/` is the React + Vite application for reading the resolved cascade. It builds independently from the engine and deploys to its own Cloudflare Pages project.
- `site/` is the Astro marketing/docs surface. It also deploys independently to Cloudflare Pages.
- `.github/workflows/ci.yml` is the merge gate. Deploy workflows under `.github/workflows/` validate and publish the `console/` and `site/` surfaces separately.

## Gotchas

- Do not add an install step for the repo root. The engine intentionally runs on plain Node.js without root package dependencies.
- `console/` and `site/` each have their own lockfile and their own `npm ci` step. There is no shared workspace install.
- `CI / required` is intended to be the only required branch protection check. Internal jobs may change, but that outer gate should remain stable.
- `console-v*` production tags should point at commits already merged to `main`. The production workflow enforces that ancestry check.
- Root `npm test` includes `playground-test.sh`, which starts a local server. If you change that test, keep it runnable in CI and configurable by `PORT`.
