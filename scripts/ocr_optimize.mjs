/**
 * OCR Parameter Optimization Script
 *
 * Uses Playwright to run headless Chromium, loads the OCR finetuning page,
 * and systematically tests parameter combinations using Tesseract.js.
 *
 * Usage:
 *   node scripts/ocr_optimize.mjs <config.json> [output.json]
 *
 * Config format:
 * {
 *   "iterationName": "1A_rectification",
 *   "baseConfig": { "engine": "tesseract", ... },
 *   "parameters": [
 *     { "path": "rectification.enabled", "values": [true, false] },
 *     { "path": "preprocessing.contrastBoost", "values": [1.0, 1.5, 2.0] }
 *   ],
 *   "imageDir": "./ocr_trainingdata/sel_gt",
 *   "appUrl": "http://localhost:5173/ocr_finetuning.html"
 * }
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// =============================================================================
// CER / WER Calculation (mirrors frontend cer-wer.ts)
// =============================================================================

function normalizeText(text) {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    if (a.length > b.length) [a, b] = [b, a];

    const m = a.length;
    const n = b.length;
    let prev = Array.from({ length: m + 1 }, (_, i) => i);
    let curr = new Array(m + 1);

    for (let j = 1; j <= n; j++) {
        curr[0] = j;
        for (let i = 1; i <= m; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[m];
}

function levenshteinDistanceWords(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    if (a.length > b.length) [a, b] = [b, a];

    const m = a.length;
    const n = b.length;
    let prev = Array.from({ length: m + 1 }, (_, i) => i);
    let curr = new Array(m + 1);

    for (let j = 1; j <= n; j++) {
        curr[0] = j;
        for (let i = 1; i <= m; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[m];
}

function calculateCER(ocr, groundTruth) {
    const ocrNorm = normalizeText(ocr);
    const gtNorm = normalizeText(groundTruth);
    if (gtNorm.length === 0) return ocrNorm.length === 0 ? 0 : 1;
    return levenshteinDistance(ocrNorm, gtNorm) / gtNorm.length;
}

function calculateWER(ocr, groundTruth) {
    const ocrWords = normalizeText(ocr).split(" ").filter((w) => w.length > 0);
    const gtWords = normalizeText(groundTruth).split(" ").filter((w) => w.length > 0);
    if (gtWords.length === 0) return ocrWords.length === 0 ? 0 : 1;
    return levenshteinDistanceWords(ocrWords, gtWords) / gtWords.length;
}

// =============================================================================
// Cartesian Product Generator
// =============================================================================

function cartesianProduct(parameters) {
    if (parameters.length === 0) return [[]];

    const [first, ...rest] = parameters;
    const restProduct = cartesianProduct(rest);

    const result = [];
    for (const value of first.values) {
        for (const restCombo of restProduct) {
            result.push([{ path: first.path, value }, ...restCombo]);
        }
    }
    return result;
}

// =============================================================================
// Config Helper
// =============================================================================

function setNestedValue(obj, dotPath, value) {
    const keys = dotPath.split(".");
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in current) || typeof current[keys[i]] !== "object") {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
}

function permutationToConfig(baseConfig, permutation) {
    const config = JSON.parse(JSON.stringify(baseConfig));
    for (const { path: p, value } of permutation) {
        setNestedValue(config, p, value);
    }
    return config;
}

// =============================================================================
// Drop-1 Scoring
// =============================================================================

function calculateDrop1Score(imageScores) {
    if (imageScores.length <= 1) {
        const s = imageScores[0] || { cer: 1, wer: 1 };
        return { avgCER: s.cer, avgWER: s.wer, combinedScore: 0.7 * s.cer + 0.3 * s.wer, droppedImage: null };
    }

    // Find worst image by combined score
    let worstIdx = 0;
    let worstScore = -1;
    for (let i = 0; i < imageScores.length; i++) {
        const s = 0.7 * imageScores[i].cer + 0.3 * imageScores[i].wer;
        if (s > worstScore) {
            worstScore = s;
            worstIdx = i;
        }
    }

    const kept = imageScores.filter((_, i) => i !== worstIdx);
    const avgCER = kept.reduce((sum, s) => sum + s.cer, 0) / kept.length;
    const avgWER = kept.reduce((sum, s) => sum + s.wer, 0) / kept.length;

    return {
        avgCER,
        avgWER,
        combinedScore: 0.7 * avgCER + 0.3 * avgWER,
        droppedImage: imageScores[worstIdx].filename,
    };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        console.error("Usage: node scripts/ocr_optimize.mjs <config.json> [output.json]");
        process.exit(1);
    }

    const outputPath = process.argv[3] || path.join(PROJECT_ROOT, "ocr_optimization/iterations/result.json");
    const config = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf-8"));

    const imageDir = path.resolve(PROJECT_ROOT, config.imageDir || "ocr_trainingdata/sel_gt");
    const appUrl = config.appUrl || "http://localhost:5173/ocr_finetuning.html";
    const baseConfig = { engine: "tesseract", ...config.baseConfig };

    // --- Discover images and ground truths ---
    const imageFiles = fs.readdirSync(imageDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f) && !f.includes("Zone.Identifier"));
    console.log(`Found ${imageFiles.length} images in ${imageDir}`);

    const groundTruths = {};
    for (const imgFile of imageFiles) {
        const baseName = imgFile.replace(/\.(jpg|jpeg|png)$/i, "");
        const txtPath = path.join(imageDir, `${baseName}.txt`);
        if (fs.existsSync(txtPath)) {
            groundTruths[imgFile] = fs.readFileSync(txtPath, "utf-8");
        } else {
            // Try .gt.json for fullText
            const jsonPath = path.join(imageDir, `${baseName}.gt.json`);
            if (fs.existsSync(jsonPath)) {
                const gt = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
                groundTruths[imgFile] = gt.fullText || "";
            }
        }
    }

    const imagesWithGT = imageFiles.filter((f) => groundTruths[f] && groundTruths[f].trim().length > 0);
    console.log(`${imagesWithGT.length} images have ground truth`);

    if (imagesWithGT.length === 0) {
        console.error("No images with ground truth found!");
        process.exit(1);
    }

    // --- Pre-load image data URLs ---
    console.log("Pre-loading images as base64...");
    const imageDataUrls = {};
    for (const imgFile of imagesWithGT) {
        const imgPath = path.join(imageDir, imgFile);
        const buffer = fs.readFileSync(imgPath);
        const ext = path.extname(imgFile).toLowerCase();
        const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
        imageDataUrls[imgFile] = `data:${mimeType};base64,${buffer.toString("base64")}`;
    }

    // --- Generate permutations ---
    const permutations = cartesianProduct(config.parameters || []);
    console.log(`Generated ${permutations.length} parameter combinations`);

    if (permutations.length === 0) {
        // Single run with base config (baseline mode)
        permutations.push([]);
    }

    // --- Launch browser ---
    console.log("Launching headless Chromium...");
    const browser = await chromium.launch({
        headless: true,
        args: [
            "--disable-gpu",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
        ],
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    // Suppress verbose console output from the app
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            console.error(`[Browser] ${msg.text()}`);
        }
    });

    console.log(`Navigating to ${appUrl}...`);
    await page.goto(appUrl, { waitUntil: "networkidle", timeout: 60000 });

    // --- Initialize OCR service in browser ---
    console.log("Initializing OCR service (Tesseract)...");
    const initOk = await page.evaluate(async (baseCfg) => {
        try {
            // Import OCR service module via Vite
            const mod = await import("/src/services/ocr/index.ts");
            window.__ocrService = mod.OCRService;
            window.__ocrRunPipeline = mod.runPipeline;

            // Set engine to Tesseract
            window.__OCR__.reset();
            window.__OCR__.set(baseCfg);

            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }, baseConfig);

    if (!initOk.ok) {
        console.error("Failed to initialize OCR service:", initOk.error);
        await browser.close();
        process.exit(1);
    }

    // --- Warm-up OCR (first call initializes WASM + models) ---
    console.log("Warming up Tesseract engine (first run, may take 30-60s)...");
    const warmupStart = Date.now();
    const warmupResult = await page.evaluate(async (dataUrl) => {
        try {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = dataUrl;
            });
            const canvas = document.createElement("canvas");
            // Use a small crop for warmup
            const w = Math.min(img.naturalWidth, 400);
            const h = Math.min(img.naturalHeight, 400);
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);

            const result = await window.__ocrService.recognize(imageData);
            return { ok: true, textLength: (result.text || "").length };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }, imageDataUrls[imagesWithGT[0]]);

    if (!warmupResult.ok) {
        console.error("Warmup failed:", warmupResult.error);
        await browser.close();
        process.exit(1);
    }
    console.log(`Warmup complete in ${((Date.now() - warmupStart) / 1000).toFixed(1)}s (got ${warmupResult.textLength} chars)`);

    // --- Run optimization ---
    const allResults = [];
    let bestResult = null;
    const startTime = Date.now();

    console.log(`\nStarting optimization: ${permutations.length} combinations × ${imagesWithGT.length} images\n`);

    for (let permIdx = 0; permIdx < permutations.length; permIdx++) {
        const permutation = permutations[permIdx];
        const ocrConfig = permutationToConfig(baseConfig, permutation);

        // Set config in browser
        await page.evaluate((cfg) => {
            window.__OCR__.reset();
            window.__OCR__.set(cfg);
        }, ocrConfig);

        // OCR each image
        const imageScores = [];
        for (const imgFile of imagesWithGT) {
            try {
                const ocrText = await page.evaluate(async (dataUrl) => {
                    const img = new Image();
                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                        img.src = dataUrl;
                    });
                    const canvas = document.createElement("canvas");
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

                    const result = await window.__ocrService.recognize(imageData);
                    return result.text || "";
                }, imageDataUrls[imgFile]);

                const gt = groundTruths[imgFile];
                const cer = calculateCER(ocrText, gt);
                const wer = calculateWER(ocrText, gt);

                imageScores.push({
                    filename: imgFile,
                    cer,
                    wer,
                    ocrTextLength: ocrText.length,
                    groundTruthLength: gt.length,
                });
            } catch (err) {
                console.error(`  Error on ${imgFile}: ${err.message}`);
                imageScores.push({
                    filename: imgFile,
                    cer: 1.0,
                    wer: 1.0,
                    ocrTextLength: 0,
                    groundTruthLength: (groundTruths[imgFile] || "").length,
                    error: err.message,
                });
            }
        }

        // Calculate drop-1 score
        const scoring = calculateDrop1Score(imageScores);

        const result = {
            id: permIdx + 1,
            parameters: permutation,
            config: ocrConfig,
            imageScores,
            ...scoring,
            timestamp: Date.now(),
        };

        allResults.push(result);

        if (!bestResult || result.combinedScore < bestResult.combinedScore) {
            bestResult = result;
        }

        // Progress
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const eta = permIdx > 0
            ? (((Date.now() - startTime) / (permIdx + 1)) * (permutations.length - permIdx - 1) / 1000 / 60).toFixed(1)
            : "?";
        console.log(
            `[${permIdx + 1}/${permutations.length}] ` +
            `Score: ${(result.combinedScore * 100).toFixed(2)}% ` +
            `(CER: ${(result.avgCER * 100).toFixed(2)}%, WER: ${(result.avgWER * 100).toFixed(2)}%) ` +
            `| Best: ${(bestResult.combinedScore * 100).toFixed(2)}% ` +
            `| ${elapsed}s elapsed, ~${eta}min remaining` +
            `${result.droppedImage ? ` [dropped: ${result.droppedImage.substring(0, 20)}...]` : ""}`
        );

        // Periodically save intermediate results
        if ((permIdx + 1) % 10 === 0 || permIdx === permutations.length - 1) {
            const intermediate = buildOutput(config, allResults, bestResult, startTime);
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, JSON.stringify(intermediate, null, 2));
        }
    }

    // --- Final output ---
    const output = buildOutput(config, allResults, bestResult, startTime);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log("\n" + "=".repeat(70));
    console.log(`OPTIMIZATION COMPLETE: ${config.iterationName || "unnamed"}`);
    console.log("=".repeat(70));
    console.log(`Total permutations: ${allResults.length}`);
    console.log(`Best combined score: ${(bestResult.combinedScore * 100).toFixed(2)}%`);
    console.log(`Best CER: ${(bestResult.avgCER * 100).toFixed(2)}%`);
    console.log(`Best WER: ${(bestResult.avgWER * 100).toFixed(2)}%`);
    console.log(`Dropped image: ${bestResult.droppedImage}`);
    console.log(`Best parameters:`);
    for (const { path: p, value } of bestResult.parameters) {
        console.log(`  ${p} = ${value}`);
    }
    console.log(`Results saved to: ${outputPath}`);
    console.log(`Duration: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);

    await browser.close();
}

function buildOutput(config, allResults, bestResult, startTime) {
    return {
        iterationName: config.iterationName || "unnamed",
        totalPermutations: allResults.length,
        duration_ms: Date.now() - startTime,
        bestResult: {
            id: bestResult.id,
            parameters: bestResult.parameters,
            avgCER: bestResult.avgCER,
            avgWER: bestResult.avgWER,
            combinedScore: bestResult.combinedScore,
            droppedImage: bestResult.droppedImage,
            imageScores: bestResult.imageScores,
        },
        allResults: allResults.map((r) => ({
            id: r.id,
            parameters: r.parameters,
            avgCER: r.avgCER,
            avgWER: r.avgWER,
            combinedScore: r.combinedScore,
            droppedImage: r.droppedImage,
        })),
        completedAt: new Date().toISOString(),
    };
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
