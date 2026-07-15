---
title: Network access and privacy
description: What update checks and optional desktop account sync send, store, and leave on your Mac.
---

The engine itself — `resolver.mjs`, `mcp-server.mjs`, and every other CLI tool — makes
no network calls of its own beyond what a layer's `source` requires (an `mcp` layer
spawns the command you configured). This page is about a separate, optional
convenience in the two UI surfaces: the [Console](/demo) and the
[Playground](/docs/guides/playground-tour).

## What it sends

Both UIs can check whether a newer ContextCake release exists. The check is a single
unauthenticated HTTPS `GET` to a pinned host:

```
https://api.github.com/repos/ContextCake/context-cake/releases?per_page=20
```

Nothing is attached beyond the implicit HTTP request — no personal data, no tokens,
no identifiers, no telemetry. The request carries the same information any browser
request to that URL would (the standard HTTP headers your client sends; GitHub sees
whatever it would see from any anonymous visitor). From the response, each surface
picks the newest release in its own tag namespace (`console-v*` for the console,
`v*` for the playground/engine), compares it against the running version, and caches
the result for the session — at most one request per page load, no matter how many
components ask.

## It is disable-able

Both surfaces expose a **Check for updates** toggle in the header, next to any
"update available" notice (a small gear icon opens the setting). It is backed by a
single localStorage flag, `cc-update-check`, shared by the Console and the
Playground:

- **Console, demo build** (the public `/demo-app/` embed on this site): off by
  default. The public embed is network-silent unless you turn the toggle on.
- **Console, live/local use**: on by default.
- **Playground**: on by default — it is a local dev tool, not a public embed.

When the toggle is off, no network request is made at all — the check function
returns immediately without calling `fetch`.

## Why this exists

ContextCake is privacy-by-default: the engine doesn't phone home, and the one place a
UI convenience touches the network, it's unauthenticated, minimal, cached, and
switchable. If you'd rather never make the call — air-gapped environments, strict
network policies, or just preference — turn the toggle off once and it stays off
(the flag persists in localStorage).

## Optional desktop accounts

ContextCake for Mac works fully while signed out. Signing in adds settings sync; it
does not gate the local engine, sources, profiles, resolve tools, or MCP server.

When you sign in with GitHub or Google, authentication runs in your system browser
through Supabase OAuth with PKCE. The desktop app stores the resulting session only in
an OS-keychain-encrypted local file. Raw tokens are never exposed to the Console
renderer or written to logs.

The server-side account data is limited to:

- the email address supplied by the OAuth provider, stored by Supabase Auth;
- one owner-only `user_settings` row containing UI preferences, profile definitions,
  and source configuration metadata.

Before upload, ContextCake replaces local source paths, cache directories, executable
MCP commands and arguments, Keychain references, and `tokenEnv` values with scrub
markers. It then rejects the entire upload if any credential, personal identifier, or
context-content pattern remains. Synced integrations therefore require local setup on
each Mac and can never activate a remote command.

ContextCake never syncs knowledge or document content, resolved output, integration
tokens, environment-variable values, absolute local paths, analytics, or telemetry.
Those stay on the Mac. Deleting the account removes the Supabase Auth user and the
cascading settings row; local ContextCake files and settings are left untouched.

## Related

- [The trust boundary](/docs/concepts/trust-boundary) — the one place ContextCake
  does execute code you didn't write directly (an `mcp` layer's `command`)
- [Playground tour](/docs/guides/playground-tour) — where the settings menu lives
