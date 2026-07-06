#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const contentRoot = path.resolve(repoRoot, "packs/data-analytics-team/skills/data-analytics-team-pack");
const dist = path.resolve(repoRoot, "dist");
const version = readYamlScalar(fs.readFileSync(path.join(contentRoot, "PACK.yaml"), "utf8"), "version") ?? "0.0.0";
if (!isSemver(version)) throw new Error(`PACK.yaml version must be semver, got ${version}`);
const zipName = `data-analytics-team-pack-v${version}.zip`;
const zipPath = path.join(dist, zipName);

const allowlist = [
  "START-HERE.md",
  "PACK.yaml",
  "overview",
  "glossary",
  "workflows",
  "templates",
  "examples",
  "prompt-guides",
  "policies-and-rules",
  "tool-guides",
  "local-overlay",
  "updates",
];

fs.mkdirSync(dist, { recursive: true });
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "contextcake-pack-"));
try {
  const stage = path.join(tmpdir, "data-analytics-team-pack");
  fs.mkdirSync(stage);
  for (const item of allowlist) {
    const source = path.join(contentRoot, item);
    if (!fs.existsSync(source)) throw new Error(`Missing allowlisted path: ${item}`);
    fs.cpSync(source, path.join(stage, item), { recursive: true });
  }
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  childProcess.execFileSync("zip", ["-qr", zipPath, "data-analytics-team-pack"], { cwd: tmpdir, stdio: "inherit" });
  console.log(`Built ${path.relative(repoRoot, zipPath)}`);
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true });
}

function readYamlScalar(content, key) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return null;
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}
