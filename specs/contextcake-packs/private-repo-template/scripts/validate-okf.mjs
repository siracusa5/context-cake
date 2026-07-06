#!/usr/bin/env node
// Standalone subset of the parsing rules in context-cake's sources/okf-local.mjs,
// vendored deliberately. This repo does not depend on the engine repo. Re-sync by
// hand if the engine's OKF grammar changes.

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const defaultPackRoot = "packs/data-analytics-team/skills/data-analytics-team-pack";
const packRoot = path.resolve(repoRoot, process.argv[2] ?? defaultPackRoot);
const pluginJsonPath = path.resolve(repoRoot, "packs/data-analytics-team/.claude-plugin/plugin.json");

const excluded = new Set([
  "SKILL.md",
  "START-HERE.md",
  "updates/CHANGELOG.md",
  "updates/MERGE-GUIDE.md",
  "local-overlay/README.md",
]);

const errors = [];

if (!fs.existsSync(packRoot)) {
  errors.push(`${path.relative(repoRoot, packRoot)}: pack root does not exist`);
} else {
  for (const filePath of walkMarkdown(packRoot)) {
    const rel = toPosix(path.relative(packRoot, filePath));
    if (excluded.has(rel)) continue;
    validateMarkdown(filePath, rel);
  }
  validateVersionMatch();
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`OKF validation passed for ${path.relative(repoRoot, packRoot)}`);

function validateMarkdown(filePath, rel) {
  const content = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body, bodyStartLine } = parseFrontmatter(content);
  if (!frontmatter.type) errors.push(`${rel}: missing frontmatter field "type"`);
  if (!frontmatter.updated) errors.push(`${rel}: missing frontmatter field "updated"`);

  const lines = body.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) return;
    if (!/\{[^}]*#[A-Za-z0-9_-]+[^}]*\}/.test(match[2])) {
      errors.push(`${rel}:${bodyStartLine + index}: missing {#anchor} on heading "${stripAttrs(match[2])}"`);
    }
  });
}

function validateVersionMatch() {
  const packYamlPath = path.join(packRoot, "PACK.yaml");
  if (!fs.existsSync(packYamlPath) || !fs.existsSync(pluginJsonPath)) return;
  const packVersion = readYamlScalar(fs.readFileSync(packYamlPath, "utf8"), "version");
  const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  if (packVersion && !isSemver(packVersion)) {
    errors.push(`invalid version: PACK.yaml version must be semver, got ${packVersion}`);
  }
  if (plugin.version && !isSemver(plugin.version)) {
    errors.push(`invalid version: plugin.json version must be semver, got ${plugin.version}`);
  }
  if (packVersion && plugin.version && packVersion !== plugin.version) {
    errors.push(`version mismatch: PACK.yaml has ${packVersion}, plugin.json has ${plugin.version}`);
  }
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content, bodyStartLine: 1 };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content, bodyStartLine: 1 };
  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  const bodyStartLine = content.slice(0, end + 4).split(/\r?\n/).length + (content.slice(end + 4).startsWith("\n") ? 1 : 0);
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = parseYamlScalar(match[2].trim());
  }
  return { frontmatter, body, bodyStartLine };
}

function readYamlScalar(content, key) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (match) return parseYamlScalar(match[1].trim());
  }
  return null;
}

function parseYamlScalar(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

function stripAttrs(value) {
  return value.replace(/\{[^}]*\}/g, "").trim();
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function walkMarkdown(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(fullPath);
      else if (dirent.isFile() && dirent.name.endsWith(".md")) files.push(fullPath);
    }
  }
  return files.sort();
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
