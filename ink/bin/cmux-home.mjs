#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const entry = resolve(root, "src/index.tsx");
const distEntry = resolve(root, "dist/index.js");

const argv = process.argv.slice(2);

if (existsSync(distEntry)) {
  await import(distEntry);
} else {
  const tsx = resolve(root, "node_modules/.bin/tsx");
  const fallback = existsSync(tsx) ? tsx : "tsx";
  const child = spawn(fallback, [entry, ...argv], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
