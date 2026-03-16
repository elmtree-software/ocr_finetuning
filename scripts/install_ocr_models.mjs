#!/usr/bin/env node
/**
 * Model installer for OCR-related assets.
 *
 * Downloads OpenCV.js and PaddleOCR models into `backend/models/`.
 *
 * Usage:
 *   node scripts/install_ocr_models.mjs           # Install all OCR models
 *   node scripts/install_ocr_models.mjs opencv    # Install only OpenCV.js
 *   node scripts/install_ocr_models.mjs paddle    # Install only PaddleOCR models
 *   node scripts/install_ocr_models.mjs --force   # Re-download all files
 *
 * Assets:
 *   opencv:  OpenCV.js 4.10.0 (~8 MB)
 *   paddle:  PaddleOCR v4 models
 *            - ppocr_det.onnx (text detection, ~2.3 MB)
 *            - ppocr_rec.onnx (text recognition, ~4.7 MB)
 *            - ppocr_keys_v1.txt (character dictionary)
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const MODELS_DIR = join(REPO_ROOT, "backend", "models");

/**
 * Model definitions.
 */
const MODEL_DEFINITIONS = {
    // OpenCV.js - pre-built WebAssembly version
    "opencv": {
        folder: "opencv",
        files: [
            {
                // OpenCV.js 4.10.0 from official docs
                url: "https://docs.opencv.org/4.10.0/opencv.js",
                dest: "opencv.js",
                description: "OpenCV.js 4.10.0 WebAssembly build",
            },
        ],
    },

    // PaddleOCR v4 models (ONNX format)
    // Source: https://github.com/PaddlePaddle/PaddleOCR/blob/release/2.7/doc/doc_en/models_list_en.md
    "paddleocr": {
        folder: "paddleocr",
        files: [
            {
                // PP-OCRv4 Detection Model (English + Chinese)
                // Lightweight model optimized for mobile/web
                url: "https://paddleocr.bj.bcebos.com/PP-OCRv4/english/en_PP-OCRv4_det_infer.tar",
                dest: "en_PP-OCRv4_det_infer.tar",
                extract: true,
                extractedFiles: ["inference.pdmodel", "inference.pdiparams"],
                description: "PP-OCRv4 text detection model",
            },
            {
                // PP-OCRv4 Recognition Model (English)
                url: "https://paddleocr.bj.bcebos.com/PP-OCRv4/english/en_PP-OCRv4_rec_infer.tar",
                dest: "en_PP-OCRv4_rec_infer.tar",
                extract: true,
                extractedFiles: ["inference.pdmodel", "inference.pdiparams"],
                description: "PP-OCRv4 text recognition model (English)",
            },
            {
                // Multi-language recognition model (Latin + Chinese)
                url: "https://paddleocr.bj.bcebos.com/PP-OCRv3/multilingual/Multilingual_PP-OCRv3_rec_infer.tar",
                dest: "Multilingual_PP-OCRv3_rec_infer.tar",
                extract: true,
                extractedFiles: ["inference.pdmodel", "inference.pdiparams"],
                description: "PP-OCRv3 multilingual recognition model",
            },
            {
                // English character dictionary
                url: "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/en_dict.txt",
                dest: "en_dict.txt",
                description: "English character dictionary",
            },
            {
                // German/Latin character dictionary (includes umlauts)
                url: "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/dict/german_dict.txt",
                dest: "german_dict.txt",
                description: "German character dictionary",
            },
        ],
    },

    // Pre-converted ONNX models from Hugging Face (monkt/paddleocr-onnx)
    // PP-OCRv5: Best accuracy for Western languages (~84MB detection, ~8MB recognition)
    // PP-OCRv3: Lightweight fallback (~2.3MB detection)
    // Source: https://huggingface.co/monkt/paddleocr-onnx
    // IMPORTANT: Do not mix versions! Use v5 detection with v5 recognition, v3 with v3.
    "paddleocr-onnx": {
        folder: "paddleocr-onnx",
        files: [
            // === PP-OCRv5 Models (recommended for Western languages) ===
            {
                // PP-OCRv5 Detection model (84 MB) - best accuracy
                url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/detection/v5/det.onnx",
                dest: "det_v5.onnx",
                description: "PP-OCRv5 text detection model (ONNX, 84 MB)",
            },
            {
                // PP-OCRv5 Latin Recognition model (~8 MB) - supports Western European languages
                url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/latin/rec.onnx",
                dest: "rec_latin.onnx",
                description: "PP-OCRv5 Latin recognition model (ONNX, ~8 MB)",
            },
            {
                // Latin character dictionary
                url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/latin/dict.txt",
                dest: "dict_latin.txt",
                description: "Latin character dictionary",
            },
            {
                // Latin config
                url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/latin/config.json",
                dest: "config_latin.json",
                description: "Latin model configuration",
            },
            // NOTE: The monkt/paddleocr-onnx repository does not provide a separate
            // German-only recognition model. German is covered by the Latin model:
            // languages/latin/ (see repository README / model selection guide).
            {
                // PP-OCRv5 English Recognition model
                url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/rec.onnx",
                dest: "rec_english.onnx",
                description: "PP-OCRv5 English recognition model (ONNX)",
            },
            {
                // English character dictionary
                url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/dict.txt",
                dest: "dict_english.txt",
                description: "English character dictionary",
            },
            // === PP-OCRv3 Models (lightweight fallback) ===
            {
                // PP-OCRv3 Detection model (2.3 MB) - smaller, for low-bandwidth/mobile
                url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/detection/v3/det.onnx",
                dest: "det_v3.onnx",
                description: "PP-OCRv3 text detection model (ONNX, 2.3 MB, lightweight)",
            },
        ],
    },
};

// Map variant names to model definitions
const VARIANT_TO_MODELS = {
    opencv: ["opencv"],
    paddle: ["paddleocr-onnx"], // Use pre-converted ONNX models by default
    "paddle-native": ["paddleocr"], // Native PaddlePaddle format (needs conversion)
    all: ["opencv", "paddleocr-onnx"],
};

function usage(exitCode = 0) {
    console.log(`
Install OCR-related models and assets.

Usage:
  node scripts/install_ocr_models.mjs [options] [variant...]

Variants:
  opencv         - OpenCV.js 4.10.0 (~8 MB)
  paddle         - PaddleOCR ONNX models (~7 MB total)
  paddle-native  - PaddleOCR native models (requires conversion)
  all            - Install opencv + paddle (default)

Options:
  --force   Re-download existing files
  --help    Show this help

Examples:
  node scripts/install_ocr_models.mjs              # Install all
  node scripts/install_ocr_models.mjs opencv       # Install only OpenCV.js
  node scripts/install_ocr_models.mjs paddle       # Install only PaddleOCR
  node scripts/install_ocr_models.mjs --force      # Re-download all
`.trim());
    process.exit(exitCode);
}

function parseArgs(argv) {
    const args = { force: false, variants: [] };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") {
            args.force = true;
        } else if (a === "--help" || a === "-h") {
            usage(0);
        } else if (VARIANT_TO_MODELS[a]) {
            args.variants.push(a);
        } else {
            console.error(`Unknown argument: ${a}`);
            usage(1);
        }
    }
    if (args.variants.length === 0) {
        args.variants = ["all"];
    }
    return args;
}

async function fileExists(path) {
    try {
        const s = await stat(path);
        return s.isFile();
    } catch {
        return false;
    }
}

async function downloadFile(url, destPath, { force, description }) {
    if (!force && (await fileExists(destPath))) {
        const stats = await stat(destPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        console.log(`  [cached] ${description || destPath} (${sizeMB} MB)`);
        return;
    }

    console.log(`  [download] ${description || url}`);
    const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (compatible; OCRFinetuningModelInstaller/1.0)",
        },
    });

    if (!res.ok || !res.body) {
        throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
    }

    await mkdir(dirname(destPath), { recursive: true });

    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
    let downloaded = 0;
    let lastProgress = 0;

    // Convert Web ReadableStream to Node.js Readable stream using Readable.fromWeb()
    // This properly bridges Web Streams API with Node.js streams
    const nodeReadable = Readable.fromWeb(res.body);

    const out = createWriteStream(destPath);

    // Track progress
    nodeReadable.on("data", (chunk) => {
        downloaded += chunk.length;
        if (contentLength > 0) {
            const progress = Math.floor((downloaded / contentLength) * 100);
            if (progress >= lastProgress + 10) {
                process.stdout.write(`  [progress] ${progress}%\r`);
                lastProgress = progress;
            }
        }
    });

    await pipeline(nodeReadable, out);

    const sizeMB = (downloaded / 1024 / 1024).toFixed(1);
    console.log(`  [done] ${description || destPath} (${sizeMB} MB)       `);
}

async function installModel(modelKey, { force }) {
    const def = MODEL_DEFINITIONS[modelKey];
    if (!def) {
        throw new Error(`Unknown model: ${modelKey}`);
    }

    const targetDir = join(MODELS_DIR, def.folder);
    console.log(`\nInstalling ${modelKey}...`);

    await mkdir(targetDir, { recursive: true });

    for (const file of def.files) {
        const destPath = join(targetDir, file.dest);
        await downloadFile(file.url, destPath, {
            force,
            description: file.description,
        });

        // Handle tar extraction if needed
        if (file.extract && file.dest.endsWith(".tar")) {
            console.log(`  [extract] ${file.dest}`);
            // For now, just note that extraction is needed
            // In production, we'd use tar package or spawn tar command
            console.log(`  [note] Manual extraction may be needed for ${file.dest}`);
        }
    }
}

async function main() {
    const args = parseArgs(process.argv);

    // Collect unique model keys
    const modelsToInstall = new Set();
    for (const variant of args.variants) {
        for (const modelKey of VARIANT_TO_MODELS[variant]) {
            modelsToInstall.add(modelKey);
        }
    }

    console.log("=== OCR Model Installer ===");
    console.log(`Models to install: ${[...modelsToInstall].join(", ")}`);
    console.log(`Target directory: ${MODELS_DIR}`);

    for (const modelKey of modelsToInstall) {
        await installModel(modelKey, { force: args.force });
    }

    console.log("\n=== Installation complete ===");

    // Show summary
    console.log("\nInstalled assets:");
    for (const modelKey of modelsToInstall) {
        const def = MODEL_DEFINITIONS[modelKey];
        const dir = join(MODELS_DIR, def.folder);
        console.log(`  ${def.folder}/`);
        for (const file of def.files) {
            const filePath = join(dir, file.dest);
            if (await fileExists(filePath)) {
                const stats = await stat(filePath);
                const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
                console.log(`    - ${file.dest} (${sizeMB} MB)`);
            }
        }
    }

    // Print usage hint
    console.log("\nTo serve these models, ensure ModelServer routes are configured.");
    console.log("Models will be available at:");
    if (modelsToInstall.has("opencv")) {
        console.log("  /models/opencv/opencv.js");
    }
    if (modelsToInstall.has("paddleocr-onnx")) {
        console.log("  /models/paddleocr-onnx/det_v5.onnx (84 MB - best accuracy)");
        console.log("  /models/paddleocr-onnx/det_v3.onnx (2.3 MB - lightweight fallback)");
        console.log("  /models/paddleocr-onnx/rec_latin.onnx (also used for German)");
        console.log("  /models/paddleocr-onnx/rec_english.onnx");
        console.log("\nNote: PP-OCRv5 offers better accuracy but larger model size.");
        console.log("      Use v3 detection for bandwidth-constrained environments.");
    }
}

main().catch((err) => {
    console.error("\n[error] Installation failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
