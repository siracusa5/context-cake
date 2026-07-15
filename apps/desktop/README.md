# ContextCake for Mac

The desktop shell: the dependency-free engine (`packages/core`) runs in the
Electron main process behind a loopback HTTP service with a per-launch bearer
token, and the console (`apps/console`) is the renderer, served at
`/console/` so its live mode engages unchanged. Spec:
`specs/contextcake-distribution/spec.md` + `design.md`.

## Commands

```bash
cd apps/desktop
npm install
npm run renderer   # build the console renderer (needed after console changes)
npm run start      # launch the app (dev, expects a prior renderer build)
npm run dev        # renderer + start
npm test           # auth storage + settings-sync security tests
npm run smoke      # boot headlessly, verify the token-guarded service, exit
npm run pack       # unpacked .app in dist/ (ad-hoc signed)
npm run dist       # DMG + zip in dist/ (ad-hoc signed until release secrets exist)
```

## Layout

| Path | Role |
|---|---|
| `src/main/main.mjs` | App lifecycle, window, deep-link hook (`contextcake://`) |
| `src/main/service-host.mjs` | Boots `packages/core/src/service.mjs` on 127.0.0.1 with a bearer token |
| `src/main/auth.mjs` | Main-process OAuth broker, PKCE callback, encrypted session lifecycle |
| `src/main/settings-sync.mjs` | Owner-scoped settings sync with path/secret scrub-and-reject checks |
| `src/main/updater.mjs` | electron-updater against GitHub Releases (`app-v*`), settings-gated |
| `src/main/cli-install.mjs` | Symlinks the CLI shim into `/usr/local/bin` |
| `src/preload.cjs` | The only main↔renderer bridge (`window.__CC_DESKTOP`) |
| `src/cli/cli.mjs` | `contextcake` dispatcher over the bundled engine entrypoints |
| `resources/bin/contextcake` | Shell shim installed for the CLI |
| `electron-builder.yml` | Packaging: DMG/zip, arm64, hardened runtime, protocols |

## User data (never touched by updates)

- Config: `~/Library/Application Support/ContextCake/` (`manifest.json`, `settings.json`)
- Caches: `~/Library/Caches/ContextCake/`
- Account session: encrypted `session.enc` (Keychain-backed via `safeStorage`)
- Supabase project config: optional `supabase.json` (`url` + public `anonKey`), or
  `SUPABASE_URL` / `SUPABASE_ANON_KEY` in development

Accounts are optional. Supabase stores the OAuth email and one owner-only settings
row. Synced settings contain preferences, profiles, and source metadata after absolute
paths, executable MCP commands/arguments, cache directories, and secret references are
scrubbed. Context content, integration tokens, raw environment values, local paths, and
remote-activatable commands are never uploaded. Integrations are configured locally on
each Mac. Deleting an account removes the Auth user and synced row while leaving local
files untouched.

## Release

`app-v*` tags drive the release workflow (signing + notarization + GitHub
Release with `latest-mac.yml` and `SHA256SUMS`). Requires the Apple Developer
secrets described in `specs/contextcake-distribution/design.md` §8. Until
those exist, `npm run dist` produces ad-hoc-signed artifacts for local testing
only — they must not be distributed.
Packaged account builds require `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` (the `SUPABASE_*` aliases also work). The packaging
scripts generate `build/supabase-config.json` and electron-builder copies that
public project configuration into the app resources; the generated file is
gitignored.
