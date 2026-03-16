#!/usr/bin/env node
/**
 * OCR Evaluation Script
 *
 * Evaluates OCR quality by comparing OCR output against ground truth text.
 * Calculates standard metrics:
 * - CER (Character Error Rate): Edit distance at character level / reference length
 * - WER (Word Error Rate): Edit distance at word level / reference word count
 *
 * Lower values are better (0% = perfect, 100% = completely wrong).
 *
 * Usage:
 *   node scripts/eval_ocr.mjs --dataset b-mod_lines/train.easy --limit 100
 *   node scripts/eval_ocr.mjs --image path/to/image.jpg --expected "expected text"
 *
 * Options:
 *   --dataset <path>     Path to dataset file (format: filename<space>ground_truth)
 *   --image <path>       Single image to evaluate
 *   --expected <text>    Expected text for single image
 *   --limit <n>          Max number of samples to evaluate (default: 100)
 *   --lang <lang>        Tesseract language(s) (default: eng, use eng+deu for both)
 *   --verbose            Show individual results for each sample
 *   --json               Output results as JSON for further processing
 *
 * Dataset Format:
 *   Each line: <filename><space><ground_truth_text>
 *   Example: image001.jpg Hello World
 *
 *   Images are expected in a "lines/" subdirectory relative to the dataset file.
 *
 * Note: This script requires tesseract.js from frontend/node_modules.
 */

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Resolve paths
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const FRONTEND_ROOT = join(PROJECT_ROOT, "frontend");

// Import tesseract.js from frontend/node_modules
const require = createRequire(join(FRONTEND_ROOT, "package.json"));
const Tesseract = require("tesseract.js");

// ============================================
// Levenshtein Distance Algorithm
// ============================================

/**
 * Classic dynamic programming Levenshtein distance.
 * Counts minimum edits (insertions, deletions, substitutions) to transform s1 into s2.
 *
 * Time: O(m*n), Space: O(m*n) where m,n are string lengths.
 */
function levenshteinDistance(s1, s2) {
    const m = s1.length;
    const n = s2.length;

    if (m === 0) return n;
    if (n === 0) return m;

    // DP table: dp[i][j] = edit distance between s1[0..i-1] and s2[0..j-1]
    const dp = Array(m + 1)
        .fill(null)
        .map(() => Array(n + 1).fill(0));

    // Base cases: transforming empty string to/from prefix
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    // Fill DP table
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1, // deletion
                dp[i][j - 1] + 1, // insertion
                dp[i - 1][j - 1] + cost // substitution (free if chars match)
            );
        }
    }

    return dp[m][n];
}

// ============================================
// Error Rate Calculations
// ============================================

/**
 * Character Error Rate (CER)
 *
 * CER = levenshtein(predicted, reference) / len(reference)
 *
 * Measures character-level accuracy. More granular than WER.
 * Good for detecting small typos and OCR artifacts.
 */
function calculateCER(predicted, reference) {
    const pred = predicted.toLowerCase().trim();
    const ref = reference.toLowerCase().trim();

    if (ref.length === 0) {
        return pred.length === 0 ? 0 : 1;
    }

    const distance = levenshteinDistance(pred, ref);
    return distance / ref.length;
}

/**
 * Word-level Levenshtein distance.
 * Treats words as atomic units instead of characters.
 */
function wordLevenshtein(predWords, refWords) {
    if (refWords.length === 0) return predWords.length;
    if (predWords.length === 0) return refWords.length;

    const m = predWords.length;
    const n = refWords.length;
    const dp = Array(m + 1)
        .fill(null)
        .map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = predWords[i - 1] === refWords[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }

    return dp[m][n];
}

/**
 * Word Error Rate (WER)
 *
 * WER = word_levenshtein(predicted, reference) / word_count(reference)
 *
 * Standard metric for speech recognition and OCR.
 * More intuitive than CER for understanding "how many words are wrong".
 */
function calculateWER(predicted, reference) {
    const predWords = predicted
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter((w) => w);
    const refWords = reference
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter((w) => w);

    if (refWords.length === 0) {
        return predWords.length === 0 ? 0 : 1;
    }

    const distance = wordLevenshtein(predWords, refWords);
    return distance / refWords.length;
}

// ============================================
// Dataset Loading
// ============================================

/**
 * Parse a single line from the dataset file.
 * Format: <filename><space><ground_truth>
 *
 * Returns null for lines without ground truth (like test.easy).
 */
function parseDatasetLine(line) {
    const firstSpace = line.indexOf(" ");
    if (firstSpace === -1) return null; // No ground truth

    const filename = line.slice(0, firstSpace);
    const groundTruth = line.slice(firstSpace + 1);

    return { filename, groundTruth };
}

/**
 * Load dataset file and parse samples.
 *
 * @param datasetPath - Path to dataset file (relative to PROJECT_ROOT)
 * @param limit - Maximum number of samples to load
 * @returns Array of {filename, groundTruth} objects
 */
function loadDataset(datasetPath, limit) {
    const fullPath = datasetPath.startsWith("/") ? datasetPath : join(PROJECT_ROOT, datasetPath);

    if (!existsSync(fullPath)) {
        throw new Error(`Dataset not found: ${fullPath}`);
    }

    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    const samples = [];
    for (const line of lines) {
        if (samples.length >= limit) break;

        const parsed = parseDatasetLine(line);
        if (parsed) {
            samples.push(parsed);
        }
    }

    return samples;
}

// ============================================
// Tesseract OCR Engine
// ============================================

let tesseractWorker = null;

/**
 * Initialize Tesseract worker with specified language.
 *
 * Uses LSTM_ONLY mode (OEM 1) for best accuracy.
 * PSM.SINGLE_LINE is used for single-line benchmark images.
 */
async function initOCR(lang) {
    if (tesseractWorker) return;

    console.error(`[OCR] Initializing Tesseract with language: ${lang}`);
    tesseractWorker = await Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
        logger: () => {}, // Suppress progress logs
    });

    await tesseractWorker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE, // Optimized for single-line images
        user_defined_dpi: "300", // Assume 300 DPI for consistent results
    });

    console.error("[OCR] Tesseract ready");
}

/**
 * Run OCR on a single image file.
 */
async function recognizeImage(imagePath) {
    if (!tesseractWorker) {
        throw new Error("OCR not initialized");
    }

    const result = await tesseractWorker.recognize(imagePath);
    return result.data.text.trim();
}

/**
 * Clean up Tesseract worker.
 */
async function terminateOCR() {
    if (tesseractWorker) {
        await tesseractWorker.terminate();
        tesseractWorker = null;
    }
}

// ============================================
// Evaluation Functions
// ============================================

/**
 * Evaluate OCR on a dataset of images.
 *
 * @param datasetPath - Path to dataset file
 * @param imagesDir - Directory containing the images
 * @param limit - Max samples to evaluate
 * @param lang - Tesseract language code
 * @param verbose - Show per-sample results
 */
async function evaluateDataset(datasetPath, imagesDir, limit, lang, verbose) {
    const samples = loadDataset(datasetPath, limit);
    console.error(`[Eval] Loaded ${samples.length} samples from ${datasetPath}`);

    await initOCR(lang);

    const results = [];
    let totalCER = 0;
    let totalWER = 0;
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < samples.length; i++) {
        const { filename, groundTruth } = samples[i];
        const imagePath = join(imagesDir, filename);

        if (!existsSync(imagePath)) {
            if (verbose) {
                console.error(`[Skip] Image not found: ${imagePath}`);
            }
            errorCount++;
            continue;
        }

        try {
            const predicted = await recognizeImage(imagePath);
            const cer = calculateCER(predicted, groundTruth);
            const wer = calculateWER(predicted, groundTruth);

            results.push({
                filename,
                groundTruth,
                predicted,
                cer,
                wer,
            });

            totalCER += cer;
            totalWER += wer;
            successCount++;

            if (verbose) {
                console.error(
                    `[${i + 1}/${samples.length}] CER: ${(cer * 100).toFixed(1)}%, WER: ${(wer * 100).toFixed(1)}%`
                );
                console.error(`  Expected: "${groundTruth}"`);
                console.error(`  Got:      "${predicted}"`);
            } else if ((i + 1) % 10 === 0) {
                console.error(`[${i + 1}/${samples.length}] Processing...`);
            }
        } catch (err) {
            if (verbose) {
                console.error(`[Error] ${filename}: ${err.message}`);
            }
            errorCount++;
        }
    }

    await terminateOCR();

    const avgCER = successCount > 0 ? totalCER / successCount : 0;
    const avgWER = successCount > 0 ? totalWER / successCount : 0;

    return {
        dataset: datasetPath,
        language: lang,
        totalSamples: samples.length,
        successCount,
        errorCount,
        averageCER: avgCER,
        averageWER: avgWER,
        cerPercent: (avgCER * 100).toFixed(2),
        werPercent: (avgWER * 100).toFixed(2),
        results,
    };
}

/**
 * Evaluate OCR on a single image with known expected text.
 */
async function evaluateSingleImage(imagePath, expectedText, lang) {
    await initOCR(lang);

    const fullPath = imagePath.startsWith("/") ? imagePath : join(PROJECT_ROOT, imagePath);

    if (!existsSync(fullPath)) {
        throw new Error(`Image not found: ${fullPath}`);
    }

    const predicted = await recognizeImage(fullPath);
    const cer = calculateCER(predicted, expectedText);
    const wer = calculateWER(predicted, expectedText);

    await terminateOCR();

    return {
        imagePath,
        groundTruth: expectedText,
        predicted,
        cer,
        wer,
        cerPercent: (cer * 100).toFixed(2),
        werPercent: (wer * 100).toFixed(2),
    };
}

// ============================================
// CLI Entry Point
// ============================================

async function main() {
    const { values } = parseArgs({
        options: {
            dataset: { type: "string" },
            image: { type: "string" },
            expected: { type: "string" },
            limit: { type: "string", default: "100" },
            lang: { type: "string", default: "eng" },
            verbose: { type: "boolean", default: false },
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help) {
        console.log(`
OCR Evaluation Script

Evaluates OCR quality using WER (Word Error Rate) and CER (Character Error Rate).

Usage:
  node scripts/eval_ocr.mjs --dataset b-mod_lines/train.easy --limit 100
  node scripts/eval_ocr.mjs --image path/to/image.jpg --expected "expected text"

Options:
  --dataset <path>     Path to dataset file (format: filename<space>ground_truth)
  --image <path>       Single image to evaluate
  --expected <text>    Expected text for single image
  --limit <n>          Max samples to evaluate (default: 100)
  --lang <lang>        Tesseract language(s) (default: eng)
  --verbose            Show individual results
  --json               Output results as JSON
  --help, -h           Show this help

Dataset Format:
  Each line: <filename><space><ground_truth_text>
  Images should be in a "lines/" subdirectory next to the dataset file.

Examples:
  # Evaluate 50 samples from b-mod_lines dataset
  node scripts/eval_ocr.mjs --dataset b-mod_lines/train.easy --limit 50 --verbose

  # Test a single image
  node scripts/eval_ocr.mjs --image test.jpg --expected "Hello World"

  # German text evaluation
  node scripts/eval_ocr.mjs --dataset german_samples.txt --lang deu
        `);
        process.exit(0);
    }

    try {
        let result;

        if (values.image) {
            if (!values.expected) {
                console.error("Error: --expected is required when using --image");
                process.exit(1);
            }
            result = await evaluateSingleImage(values.image, values.expected, values.lang);
        } else if (values.dataset) {
            // Determine images directory from dataset path
            const datasetFullPath = values.dataset.startsWith("/")
                ? values.dataset
                : join(PROJECT_ROOT, values.dataset);
            const datasetDir = dirname(datasetFullPath);
            const imagesDir = join(datasetDir, "lines");

            result = await evaluateDataset(
                values.dataset,
                imagesDir,
                parseInt(values.limit, 10),
                values.lang,
                values.verbose
            );

            // Remove individual results for cleaner summary output
            if (!values.json) {
                delete result.results;
            }
        } else {
            console.error("Error: Either --dataset or --image is required");
            console.error("Use --help for usage information");
            process.exit(1);
        }

        if (values.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log("\n=== OCR Evaluation Results ===");
            if (result.dataset) {
                console.log(`Dataset: ${result.dataset}`);
                console.log(`Language: ${result.language}`);
                console.log(
                    `Samples: ${result.successCount} / ${result.totalSamples} (${result.errorCount} errors)`
                );
            } else {
                console.log(`Image: ${result.imagePath}`);
                console.log(`Expected: "${result.groundTruth}"`);
                console.log(`Predicted: "${result.predicted}"`);
            }
            console.log(`\nCharacter Error Rate (CER): ${result.cerPercent}%`);
            console.log(`Word Error Rate (WER): ${result.werPercent}%`);
            console.log("");
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

main();
