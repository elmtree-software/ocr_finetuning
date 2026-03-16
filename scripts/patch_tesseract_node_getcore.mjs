#!/usr/bin/env node
/**
 * Patch `tesseract.js` Node worker core selection.
 *
 * Node.js v24 reports `relaxedSimd()` support which makes `tesseract.js` pick the
 * relaxed-SIMD core. That core currently crashes on some systems with:
 *   Aborted(missing function: _ZN9tesseract13DotProductSSEEPKfS1_i)
 *
 * This patch forces the stable SIMD core (`tesseract-core-simd(-lstm)`).
 */

import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const PATCH_SRC = join(REPO_ROOT, "backend", "patches", "tesseract-getCore-simd.js");
const PATCH_DEST = join(
  REPO_ROOT,
  "backend",
  "node_modules",
  "tesseract.js",
  "src",
  "worker-script",
  "node",
  "getCore.js",
);

async function main() {
  if (!existsSync(PATCH_SRC)) {
    throw new Error(`Patch source not found: ${PATCH_SRC}`);
  }

  if (!existsSync(PATCH_DEST)) {
    throw new Error(
      `Target file not found: ${PATCH_DEST}\n` +
        `Run 'npm install' in backend/ first (this patch modifies node_modules).`,
    );
  }

  const [src, dest] = await Promise.all([readFile(PATCH_SRC, "utf8"), readFile(PATCH_DEST, "utf8")]);

  if (src === dest) {
    console.log("[tesseract] getCore already patched.");
    return;
  }

  await copyFile(PATCH_SRC, PATCH_DEST);
  console.log("[tesseract] Patched tesseract.js Node getCore to prefer SIMD core.");
}

main().catch((err) => {
  console.error("[tesseract] Patch failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

