// Builds source adapters from a manifest. Each layer declares a `source`
// ("okf-local" default, "files", or "mcp"). Paths/commands resolve relative to
// the manifest's own directory. An optional per-layer `cache` block
// ({"ttlSeconds": N, "dir": "..."}) wraps the adapter with withCache.

import path from "node:path";
import { createOkfLocalSource } from "./okf-local.mjs";
import { createFilesSource } from "./files.mjs";
import { createMcpSource } from "./mcp.mjs";
import { withCache } from "./cache.mjs";

export function buildSources(manifest, manifestDir) {
  return (manifest.layers ?? []).map((layer) => {
    const kind = layer.source ?? "okf-local";
    const base = { name: layer.name, level: Number(layer.level) };
    let source;
    if (kind === "okf-local") {
      source = createOkfLocalSource({ ...base, root: path.resolve(manifestDir, layer.path) });
    } else if (kind === "files") {
      source = createFilesSource({ ...base, root: path.resolve(manifestDir, layer.path) });
    } else if (kind === "mcp") {
      source = createMcpSource({
        ...base,
        command: layer.command,
        args: (layer.args ?? []).map((a) => (a.startsWith("./") || a.startsWith("../") ? path.resolve(manifestDir, a) : a)),
      });
    } else {
      throw new Error(`Unknown source kind "${kind}" for layer "${layer.name}"`);
    }
    if (layer.cache) {
      source = withCache(source, {
        ...(layer.cache.ttlSeconds != null ? { ttlMs: Number(layer.cache.ttlSeconds) * 1000 } : {}),
        cacheDir: layer.cache.dir ? path.resolve(manifestDir, layer.cache.dir) : null,
      });
    }
    return source;
  });
}
