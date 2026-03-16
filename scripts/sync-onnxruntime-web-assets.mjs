#!/usr/bin/env node
/**
 * ONNX Runtime Web Assets Synchronization Script
 *
 * Copies the ONNX Runtime Web WASM files from node_modules into the public
 * directory so they can be served by the frontend dev server and production build.
 *
 * Why is this needed?
 * -------------------
 * ONNX Runtime Web uses WebAssembly for inference. The WASM files need to be
 * accessible via HTTP at runtime. Vite doesn't automatically bundle WASM files
 * from node_modules, so we copy them to public/ where they're served as-is.
 *
 * The files include:
 * - ort-wasm-simd-threaded.wasm      - Main WASM binary with SIMD + threading
 * - ort-wasm-simd-threaded.mjs       - JavaScript loader for the WASM
 * - *.jsep.*                         - JavaScript Execution Provider (WebGPU)
 * - *.asyncify.*                     - Asyncify variant for better async support
 *
 * Usage:
 *   node scripts/sync-onnxruntime-web-assets.mjs
 *
 * This script is typically run:
 * - After `npm install` (via postinstall hook in package.json)
 * - Manually when updating onnxruntime-web version
 *
 * The script is idempotent - it only copies files that have changed (based on
 * file size comparison) to avoid unnecessary disk writes.
 */

import { mkdir, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve paths relative to this script's location
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project structure paths
const PROJECT_ROOT = join(__dirname, "..");
const FRONTEND_ROOT = join(PROJECT_ROOT, "frontend");
const ORT_DIST_DIR = join(FRONTEND_ROOT, "node_modules", "onnxruntime-web", "dist");
const PUBLIC_DIR = join(FRONTEND_ROOT, "public");

/**
 * WASM files to copy from onnxruntime-web dist.
 *
 * We copy multiple variants to support different browser capabilities:
 * - simd-threaded: Best performance (requires SharedArrayBuffer + SIMD)
 * - jsep: JavaScript Execution Provider for WebGPU acceleration
 * - asyncify: Better async/await integration
 */
const FILES = [
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
];

/**
 * Get file size, or null if file doesn't exist.
 */
async function fileSize(path) {
    try {
        return (await stat(path)).size;
    } catch {
        return null;
    }
}

/**
 * Main synchronization routine.
 *
 * For each file in FILES:
 * 1. Check if source exists in node_modules
 * 2. Compare file sizes (skip if identical)
 * 3. Copy if needed
 */
async function main() {
    // Verify onnxruntime-web is installed
    if (!existsSync(ORT_DIST_DIR)) {
        console.warn(
            `[onnxruntime-web] dist directory not found at ${ORT_DIST_DIR}.\n` +
            `Did you run 'npm install' in the frontend directory?`
        );
        process.exitCode = 1;
        return;
    }

    // Ensure public directory exists
    await mkdir(PUBLIC_DIR, { recursive: true });

    const copied = [];
    const skipped = [];

    for (const name of FILES) {
        const src = join(ORT_DIST_DIR, name);
        const dst = join(PUBLIC_DIR, name);

        // Skip missing source files (some variants may not exist in all versions)
        if (!existsSync(src)) {
            console.warn(`[onnxruntime-web] Missing ${name} (skipping)`);
            continue;
        }

        // Compare file sizes to detect changes
        const [srcSize, dstSize] = await Promise.all([fileSize(src), fileSize(dst)]);

        // Skip if destination exists and has same size (likely identical)
        if (dstSize !== null && srcSize === dstSize) {
            skipped.push(name);
            continue;
        }

        // Copy the file
        await copyFile(src, dst);
        copied.push(name);
    }

    // Report results
    if (copied.length > 0) {
        console.log(`[onnxruntime-web] Synced ${copied.length} runtime asset(s) into public/`);
    }
    if (skipped.length > 0) {
        console.log(`[onnxruntime-web] ${skipped.length} runtime asset(s) already up-to-date`);
    }
}

main().catch((err) => {
    console.error("[onnxruntime-web] Failed to sync runtime assets:", err);
    process.exitCode = 1;
});
