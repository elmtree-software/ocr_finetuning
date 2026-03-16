#!/usr/bin/env node
/**
 * OCR Hyperparameter Tuning with Bayesian Optimization
 *
 * Optimizes preprocessing parameters for OCR quality using Gaussian Process-based
 * Bayesian Optimization with Expected Improvement acquisition function.
 *
 * Parameters optimized:
 * - CLAHE: clipLimit, tilesX, tilesY
 * - Preprocessing: contrastBoost, enableCLAHE, autoContrast
 * - Histogram: darkMax, lightMin, maxMidRatio
 *
 * Usage:
 *   node scripts/ocr_tuning.mjs --iterations 50 --metric docsbyhand
 *   node scripts/ocr_tuning.mjs --iterations 100 --metric combined --samples 50
 *
 * Options:
 *   --iterations <n>    Number of optimization iterations (default: 50)
 *   --metric <name>     Optimization target: docsbyhand, all, combined (default: combined)
 *   --samples <n>       Samples per b-mod_lines category (default: 100)
 *   --initial <n>       Initial random samples before optimization (default: 10)
 *   --output <path>     Output file for results (default: tuning_results.json)
 *   --resume <path>     Resume from previous results file
 *   --verbose           Show detailed progress
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCanvas, loadImage } from "canvas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// Import tesseract.js from root node_modules
const require = createRequire(join(PROJECT_ROOT, "package.json"));
const Tesseract = require("tesseract.js");

// ============================================
// Parameter Space Definition
// ============================================

// Preprocessing parameters (optimized on single lines, applies to all OCR)
const PREPROCESSING_PARAMETER_SPACE = {
    // CLAHE parameters - conservative ranges!
    clipLimit: { min: 1.0, max: 3.0, step: 0.1, default: 2.0 },
    tilesX: { min: 4, max: 12, step: 1, default: 8, integer: true },
    tilesY: { min: 4, max: 12, step: 1, default: 8, integer: true },

    // Preprocessing - very conservative!
    contrastBoost: { min: 1.0, max: 2.0, step: 0.1, default: 1.0 },
    enableCLAHE: { min: 0, max: 1, step: 1, default: 1, integer: true, boolean: true },

    // Histogram config
    darkMax: { min: 30, max: 80, step: 5, default: 50, integer: true },
    lightMin: { min: 180, max: 230, step: 5, default: 205, integer: true },
    maxMidRatio: { min: 0.15, max: 0.35, step: 0.05, default: 0.25 },
};

// Layout parameters (optimized on full documents with layout detection)
// These parameters affect reading order, region detection, and fallback OCR
const LAYOUT_PARAMETER_SPACE = {
    // NMS (Non-Maximum Suppression)
    nms_iouThreshold: { min: 0.3, max: 0.7, step: 0.05, default: 0.5 },
    nms_containmentThreshold: { min: 0.6, max: 0.95, step: 0.05, default: 0.8 },

    // Fallback OCR (uncovered areas)
    fallback_enabled: { min: 0, max: 1, step: 1, default: 1, integer: true, boolean: true },
    fallback_gridSize: { min: 30, max: 80, step: 10, default: 50, integer: true },
    fallback_minAreaRatio: { min: 0.01, max: 0.10, step: 0.01, default: 0.03 },
    fallback_minConfidence: { min: 0.2, max: 0.6, step: 0.05, default: 0.3 },

    // XY-Cut++ Reading Order
    xyCut_enabled: { min: 0, max: 1, step: 1, default: 1, integer: true, boolean: true },
    xyCut_minGapThreshold: { min: 10, max: 60, step: 5, default: 20, integer: true },
    xyCut_spanningThreshold: { min: 0.4, max: 0.8, step: 0.05, default: 0.6 },
    xyCut_maxDepth: { min: 5, max: 20, step: 1, default: 15, integer: true },
    xyCut_preferVerticalCutRatio: { min: 1.2, max: 2.0, step: 0.1, default: 1.5 },
    xyCut_preferHorizontalCutRatio: { min: 0.4, max: 0.8, step: 0.05, default: 0.67 },
    xyCut_cutPreferenceRatio: { min: 0.5, max: 0.9, step: 0.05, default: 0.7 },
    xyCut_remapOverlapThreshold: { min: 0.1, max: 0.5, step: 0.05, default: 0.3 },
};

// Combined parameter space for full optimization
const FULL_PARAMETER_SPACE = {
    ...PREPROCESSING_PARAMETER_SPACE,
    ...LAYOUT_PARAMETER_SPACE,
};

// Default to preprocessing for backward compatibility
let PARAMETER_SPACE = PREPROCESSING_PARAMETER_SPACE;

// ============================================
// Levenshtein & Error Rates
// ============================================

function levenshteinDistance(s1, s2) {
    const m = s1.length, n = s2.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[m][n];
}

function calculateCER(predicted, reference) {
    const pred = predicted.toLowerCase().trim();
    const ref = reference.toLowerCase().trim();
    if (ref.length === 0) return pred.length === 0 ? 0 : 1;
    return levenshteinDistance(pred, ref) / ref.length;
}

function calculateWER(predicted, reference) {
    const predWords = predicted.toLowerCase().trim().split(/\s+/).filter(w => w);
    const refWords = reference.toLowerCase().trim().split(/\s+/).filter(w => w);
    if (refWords.length === 0) return predWords.length === 0 ? 0 : 1;

    const m = predWords.length, n = refWords.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = predWords[i - 1] === refWords[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[m][n] / refWords.length;
}

// ============================================
// Image Preprocessing (Node.js port)
// ============================================

function toGrayscale(imageData) {
    const { width, height, data } = imageData;
    const result = { width, height, data: new Uint8ClampedArray(data.length) };

    for (let i = 0; i < data.length; i += 4) {
        const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        result.data[i] = result.data[i + 1] = result.data[i + 2] = gray;
        result.data[i + 3] = 255;
    }
    return result;
}

function analyzeContrast(imageData, config = {}) {
    const { data } = imageData;
    const pixelCount = data.length / 4;
    const darkMax = config.darkMax ?? 50;
    const lightMin = config.lightMin ?? 205;
    const maxMidRatio = config.maxMidRatio ?? 0.25;

    let midPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
        const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        if (gray > darkMax && gray < lightMin) midPixels++;
    }

    return { isHighContrast: (midPixels / pixelCount) <= maxMidRatio };
}

function applyCLAHE(imageData, options = {}) {
    const { width, height, data } = imageData;
    const clipLimit = options.clipLimit ?? 2.0;
    const tilesX = options.tilesX ?? 8;
    const tilesY = options.tilesY ?? 8;

    const tileW = Math.ceil(width / tilesX);
    const tileH = Math.ceil(height / tilesY);
    const bins = 256;

    const tileLUTs = [];
    for (let ty = 0; ty < tilesY; ty++) {
        tileLUTs[ty] = [];
        for (let tx = 0; tx < tilesX; tx++) {
            const histogram = new Uint32Array(bins);
            let pixelCount = 0;

            const x0 = tx * tileW, y0 = ty * tileH;
            const x1 = Math.min(x0 + tileW, width);
            const y1 = Math.min(y0 + tileH, height);

            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const idx = (y * width + x) * 4;
                    histogram[data[idx]]++;
                    pixelCount++;
                }
            }

            const clipThreshold = Math.max(1, Math.floor(clipLimit * pixelCount / bins));
            let clippedPixels = 0;

            for (let i = 0; i < bins; i++) {
                if (histogram[i] > clipThreshold) {
                    clippedPixels += histogram[i] - clipThreshold;
                    histogram[i] = clipThreshold;
                }
            }

            const redistribution = Math.floor(clippedPixels / bins);
            const remainder = clippedPixels % bins;
            for (let i = 0; i < bins; i++) {
                histogram[i] += redistribution;
                if (i < remainder) histogram[i]++;
            }

            const lut = new Uint8Array(bins);
            let cdf = 0;
            const scale = 255 / pixelCount;
            for (let i = 0; i < bins; i++) {
                cdf += histogram[i];
                lut[i] = Math.min(255, Math.round(cdf * scale));
            }
            tileLUTs[ty][tx] = lut;
        }
    }

    const result = { width, height, data: new Uint8ClampedArray(data.length) };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const pixelValue = data[idx];

            const txf = (x + 0.5) / tileW - 0.5;
            const tyf = (y + 0.5) / tileH - 0.5;

            const tx0 = Math.max(0, Math.floor(txf));
            const ty0 = Math.max(0, Math.floor(tyf));
            const tx1 = Math.min(tilesX - 1, tx0 + 1);
            const ty1 = Math.min(tilesY - 1, ty0 + 1);

            const fx = Math.max(0, Math.min(1, txf - tx0));
            const fy = Math.max(0, Math.min(1, tyf - ty0));

            const v00 = tileLUTs[ty0][tx0][pixelValue];
            const v10 = tileLUTs[ty0][tx1][pixelValue];
            const v01 = tileLUTs[ty1][tx0][pixelValue];
            const v11 = tileLUTs[ty1][tx1][pixelValue];

            const top = v00 + fx * (v10 - v00);
            const bottom = v01 + fx * (v11 - v01);
            const newValue = Math.round(top + fy * (bottom - top));

            result.data[idx] = result.data[idx + 1] = result.data[idx + 2] = newValue;
            result.data[idx + 3] = 255;
        }
    }

    return result;
}

function adjustContrast(imageData, factor) {
    const { width, height, data } = imageData;
    const result = { width, height, data: new Uint8ClampedArray(data.length) };

    for (let i = 0; i < data.length; i += 4) {
        const adjusted = Math.round(128 + (data[i] - 128) * factor);
        result.data[i] = result.data[i + 1] = result.data[i + 2] = Math.max(0, Math.min(255, adjusted));
        result.data[i + 3] = 255;
    }
    return result;
}

function preprocessForOCR(imageData, params) {
    let enableCLAHE = params.enableCLAHE ?? true;
    let contrastBoost = params.contrastBoost ?? 1.0;

    if (params.autoContrast) {
        const analysis = analyzeContrast(imageData, {
            darkMax: params.darkMax,
            lightMin: params.lightMin,
            maxMidRatio: params.maxMidRatio,
        });
        if (analysis.isHighContrast) {
            enableCLAHE = false;
            contrastBoost = 1.0;
        }
    }

    let processed = toGrayscale(imageData);

    if (enableCLAHE) {
        processed = applyCLAHE(processed, {
            clipLimit: params.clipLimit,
            tilesX: params.tilesX,
            tilesY: params.tilesY,
        });
    }

    if (contrastBoost !== 1.0) {
        processed = adjustContrast(processed, contrastBoost);
    }

    return processed;
}

// ============================================
// Dataset Loading
// ============================================

function loadDocsbyhandDataset(startIndex = 9, endIndex = 19) {
    const dir = join(PROJECT_ROOT, "docsbyhand");
    const samples = [];

    for (let i = startIndex; i <= endIndex; i++) {
        const num = String(i).padStart(6, "0");
        const imgPath = join(dir, `${num}.jpg`);
        const txtPath = join(dir, `${num}.txt`);

        if (existsSync(imgPath) && existsSync(txtPath)) {
            samples.push({
                imagePath: imgPath,
                groundTruth: readFileSync(txtPath, "utf-8").trim(),
                source: "docsbyhand",
            });
        }
    }
    return samples;
}

function loadBmodDataset(difficulty, count, randomSeed = null) {
    const datasetPath = join(PROJECT_ROOT, "b-mod_lines", `train.${difficulty}`);
    if (!existsSync(datasetPath)) {
        console.error(`Dataset not found: ${datasetPath}`);
        return [];
    }

    const lines = readFileSync(datasetPath, "utf-8").split("\n").filter(l => l.trim());
    const imagesDir = join(PROJECT_ROOT, "b-mod_lines", "lines");

    // Select samples
    let selectedLines;
    if (randomSeed !== null) {
        // Seeded random selection
        const rng = seededRandom(randomSeed);
        const shuffled = [...lines].sort(() => rng() - 0.5);
        selectedLines = shuffled.slice(0, count);
    } else {
        // Fixed selection (first N)
        selectedLines = lines.slice(0, count);
    }

    const samples = [];
    for (const line of selectedLines) {
        const firstSpace = line.indexOf(" ");
        if (firstSpace === -1) continue;

        const filename = line.slice(0, firstSpace);
        const groundTruth = line.slice(firstSpace + 1);
        const imagePath = join(imagesDir, filename);

        samples.push({
            imagePath,
            groundTruth,
            source: `b-mod_${difficulty}`,
        });
    }
    return samples;
}

function seededRandom(seed) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
}

// ============================================
// Bayesian Optimization
// ============================================

class GaussianProcess {
    constructor(lengthScale = 1.0, variance = 1.0, noise = 0.1) {
        this.lengthScale = lengthScale;
        this.variance = variance;
        this.noise = noise;
        this.X = [];
        this.y = [];
        this.K_inv = null;
    }

    // RBF (Squared Exponential) kernel
    kernel(x1, x2) {
        let sqDist = 0;
        for (let i = 0; i < x1.length; i++) {
            sqDist += Math.pow((x1[i] - x2[i]) / this.lengthScale, 2);
        }
        return this.variance * Math.exp(-0.5 * sqDist);
    }

    // Add observation
    addObservation(x, y) {
        this.X.push(x);
        this.y.push(y);
        this.K_inv = null; // Invalidate cache
    }

    // Compute inverse of covariance matrix
    computeKernelInverse() {
        const n = this.X.length;
        if (n === 0) return;

        // Build kernel matrix with noise
        const K = [];
        for (let i = 0; i < n; i++) {
            K[i] = [];
            for (let j = 0; j < n; j++) {
                K[i][j] = this.kernel(this.X[i], this.X[j]);
                if (i === j) K[i][j] += this.noise;
            }
        }

        // Simple matrix inversion (Cholesky would be better for large n)
        this.K_inv = this.invertMatrix(K);
    }

    // Naive matrix inversion via Gauss-Jordan
    invertMatrix(matrix) {
        const n = matrix.length;
        const augmented = matrix.map((row, i) => {
            const newRow = [...row];
            for (let j = 0; j < n; j++) newRow.push(i === j ? 1 : 0);
            return newRow;
        });

        for (let i = 0; i < n; i++) {
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) maxRow = k;
            }
            [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

            const pivot = augmented[i][i];
            if (Math.abs(pivot) < 1e-10) {
                // Singular matrix, add regularization
                augmented[i][i] += 0.01;
            }

            for (let j = 0; j < 2 * n; j++) augmented[i][j] /= augmented[i][i];

            for (let k = 0; k < n; k++) {
                if (k !== i) {
                    const factor = augmented[k][i];
                    for (let j = 0; j < 2 * n; j++) {
                        augmented[k][j] -= factor * augmented[i][j];
                    }
                }
            }
        }

        return augmented.map(row => row.slice(n));
    }

    // Predict mean and variance at point x
    predict(x) {
        if (this.X.length === 0) {
            return { mean: 0, variance: this.variance };
        }

        if (!this.K_inv) this.computeKernelInverse();

        const n = this.X.length;
        const k_star = this.X.map(xi => this.kernel(x, xi));

        // Mean: k_star^T * K^-1 * y
        let mean = 0;
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < n; j++) {
                sum += this.K_inv[i][j] * this.y[j];
            }
            mean += k_star[i] * sum;
        }

        // Variance: k(x,x) - k_star^T * K^-1 * k_star
        let variance = this.kernel(x, x);
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < n; j++) {
                sum += this.K_inv[i][j] * k_star[j];
            }
            variance -= k_star[i] * sum;
        }

        return { mean, variance: Math.max(0.0001, variance) };
    }
}

// Expected Improvement acquisition function
function expectedImprovement(gp, x, bestY) {
    const { mean, variance } = gp.predict(x);
    const std = Math.sqrt(variance);

    if (std < 1e-8) return 0;

    const z = (bestY - mean) / std;
    const cdf = 0.5 * (1 + erf(z / Math.sqrt(2)));
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

    return (bestY - mean) * cdf + std * pdf;
}

// Error function approximation
function erf(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
}

// ============================================
// Parameter Utilities
// ============================================

function normalizeParams(params) {
    const normalized = [];
    for (const [key, spec] of Object.entries(PARAMETER_SPACE)) {
        const value = params[key] ?? spec.default;
        normalized.push((value - spec.min) / (spec.max - spec.min));
    }
    return normalized;
}

function denormalizeParams(normalized) {
    const params = {};
    const keys = Object.keys(PARAMETER_SPACE);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const spec = PARAMETER_SPACE[key];
        let value = normalized[i] * (spec.max - spec.min) + spec.min;

        if (spec.integer) {
            value = Math.round(value);
        } else {
            value = Math.round(value / spec.step) * spec.step;
        }

        value = Math.max(spec.min, Math.min(spec.max, value));

        if (spec.boolean) {
            params[key] = value >= 0.5;
        } else {
            params[key] = value;
        }
    }
    return params;
}

function randomParams() {
    const normalized = Object.keys(PARAMETER_SPACE).map(() => Math.random());
    return denormalizeParams(normalized);
}

function suggestNextParams(gp, bestY, numCandidates = 1000) {
    let bestEI = -Infinity;
    let bestCandidate = null;

    for (let i = 0; i < numCandidates; i++) {
        const normalized = Object.keys(PARAMETER_SPACE).map(() => Math.random());
        const ei = expectedImprovement(gp, normalized, bestY);

        if (ei > bestEI) {
            bestEI = ei;
            bestCandidate = normalized;
        }
    }

    return denormalizeParams(bestCandidate);
}

// ============================================
// OCR Evaluation
// ============================================

let tesseractWorker = null;

async function initOCR(lang = "eng", psmMode = Tesseract.PSM.SINGLE_LINE) {
    if (tesseractWorker) return;

    console.error(`[OCR] Initializing Tesseract with language: ${lang}, PSM: ${psmMode}`);
    tesseractWorker = await Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
        logger: () => {},
    });

    await tesseractWorker.setParameters({
        tessedit_pageseg_mode: psmMode,
        user_defined_dpi: "300",
    });
    console.error("[OCR] Tesseract ready");
}

async function terminateOCR() {
    if (tesseractWorker) {
        await tesseractWorker.terminate();
        tesseractWorker = null;
    }
}

async function processAndRecognize(imagePath, params) {
    if (!existsSync(imagePath)) {
        return null; // Skip missing files
    }

    try {
        // Load image
        const img = await loadImage(imagePath);
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);

        // Preprocess
        const processed = preprocessForOCR(imageData, params);

        // Convert back to canvas for Tesseract
        const outCanvas = createCanvas(processed.width, processed.height);
        const outCtx = outCanvas.getContext("2d");
        const outImageData = outCtx.createImageData(processed.width, processed.height);
        outImageData.data.set(processed.data);
        outCtx.putImageData(outImageData, 0, 0);

        // OCR
        const buffer = outCanvas.toBuffer("image/png");
        const result = await tesseractWorker.recognize(buffer);

        return result.data.text.trim();
    } catch (err) {
        console.error(`[Error] ${imagePath}: ${err.message}`);
        return null;
    }
}

async function evaluateParams(params, samples, verbose = false) {
    let totalCER = 0, totalWER = 0;
    let count = 0;
    let skipped = 0;

    for (const sample of samples) {
        const predicted = await processAndRecognize(sample.imagePath, params);

        if (predicted === null) {
            skipped++;
            continue;
        }

        const cer = calculateCER(predicted, sample.groundTruth);
        const wer = calculateWER(predicted, sample.groundTruth);

        totalCER += cer;
        totalWER += wer;
        count++;

        if (verbose && count <= 5) {
            console.error(`  [${sample.source}] CER: ${(cer * 100).toFixed(1)}%`);
        }
    }

    if (count === 0) {
        return { cer: 1, wer: 1, count: 0, skipped };
    }

    return {
        cer: totalCER / count,
        wer: totalWER / count,
        count,
        skipped,
    };
}

// ============================================
// Main Tuning Loop
// ============================================

async function runTuning(options) {
    const {
        iterations = 50,
        metric = "combined",
        samplesPerCategory = 100,
        initialSamples = 10,
        outputPath = "tuning_results.json",
        resumePath = null,
        verbose = false,
        skipDocsbyhand = false,
        lang = "eng",
    } = options;

    console.error("=== OCR Hyperparameter Tuning ===");
    console.error(`Iterations: ${iterations}`);
    console.error(`Metric: ${metric}`);
    console.error(`Samples per b-mod category: ${samplesPerCategory}`);
    console.error(`Language: ${lang}`);
    console.error(`Skip docsbyhand: ${skipDocsbyhand}`);

    // Load test datasets
    console.error("\n[Loading datasets...]");

    const docsbyhand = skipDocsbyhand ? [] : loadDocsbyhandDataset();
    console.error(`  docsbyhand: ${docsbyhand.length} samples`);

    // Fixed samples (deterministic)
    const bmodEasyFixed = loadBmodDataset("easy", samplesPerCategory);
    const bmodMediumFixed = loadBmodDataset("medium", samplesPerCategory);
    const bmodHardFixed = loadBmodDataset("hard", samplesPerCategory);

    // Random samples (different each run, but consistent within run)
    const randomSeed = Date.now();
    const bmodEasyRandom = loadBmodDataset("easy", samplesPerCategory, randomSeed);
    const bmodMediumRandom = loadBmodDataset("medium", samplesPerCategory, randomSeed + 1);
    const bmodHardRandom = loadBmodDataset("hard", samplesPerCategory, randomSeed + 2);

    console.error(`  b-mod easy (fixed): ${bmodEasyFixed.length}`);
    console.error(`  b-mod medium (fixed): ${bmodMediumFixed.length}`);
    console.error(`  b-mod hard (fixed): ${bmodHardFixed.length}`);
    console.error(`  b-mod easy (random): ${bmodEasyRandom.length}`);
    console.error(`  b-mod medium (random): ${bmodMediumRandom.length}`);
    console.error(`  b-mod hard (random): ${bmodHardRandom.length}`);

    // Determine evaluation samples based on metric
    let evalSamples;
    switch (metric) {
        case "docsbyhand":
            evalSamples = docsbyhand;
            break;
        case "easy":
            evalSamples = [...docsbyhand, ...bmodEasyFixed];
            break;
        case "combined":
            evalSamples = [...docsbyhand, ...bmodEasyFixed, ...bmodEasyRandom];
            break;
        case "all":
            evalSamples = [
                ...docsbyhand,
                ...bmodEasyFixed, ...bmodMediumFixed, ...bmodHardFixed,
                ...bmodEasyRandom, ...bmodMediumRandom, ...bmodHardRandom,
            ];
            break;
        default:
            evalSamples = [...docsbyhand, ...bmodEasyFixed];
    }

    console.error(`\nEvaluation samples: ${evalSamples.length}`);

    // Initialize OCR (SINGLE_LINE for b-mod_lines, AUTO if docsbyhand included)
    const psmMode = skipDocsbyhand ? Tesseract.PSM.SINGLE_LINE : Tesseract.PSM.AUTO;
    await initOCR(lang, psmMode);

    // Initialize Gaussian Process
    const gp = new GaussianProcess(0.5, 1.0, 0.1);

    // Results storage
    let results = [];
    let bestResult = null;

    // Resume from previous run
    if (resumePath && existsSync(resumePath)) {
        console.error(`\nResuming from ${resumePath}`);
        const previous = JSON.parse(readFileSync(resumePath, "utf-8"));
        results = previous.results || [];

        for (const r of results) {
            gp.addObservation(normalizeParams(r.params), r.score);
            if (!bestResult || r.score < bestResult.score) {
                bestResult = r;
            }
        }
        console.error(`Loaded ${results.length} previous results`);
    }

    // Main optimization loop
    const startIter = results.length;
    for (let i = startIter; i < iterations; i++) {
        console.error(`\n--- Iteration ${i + 1}/${iterations} ---`);

        // Choose next parameters
        let params;
        if (i < initialSamples) {
            // Random exploration
            params = randomParams();
            console.error("Strategy: Random exploration");
        } else {
            // Bayesian optimization
            const bestY = bestResult ? bestResult.score : 1.0;
            params = suggestNextParams(gp, bestY);
            console.error("Strategy: Bayesian optimization");
        }

        console.error(`Params: clipLimit=${params.clipLimit.toFixed(2)}, contrastBoost=${params.contrastBoost.toFixed(2)}, tilesX=${params.tilesX}, tilesY=${params.tilesY}`);

        // Evaluate
        const evalResult = await evaluateParams(params, evalSamples, verbose);

        // Score (lower is better, we minimize CER)
        const score = evalResult.cer;

        console.error(`Result: CER=${(evalResult.cer * 100).toFixed(2)}%, WER=${(evalResult.wer * 100).toFixed(2)}%, samples=${evalResult.count}, skipped=${evalResult.skipped}`);

        // Store result
        const result = {
            iteration: i + 1,
            params,
            cer: evalResult.cer,
            wer: evalResult.wer,
            score,
            count: evalResult.count,
            skipped: evalResult.skipped,
            timestamp: new Date().toISOString(),
        };
        results.push(result);

        // Update GP
        gp.addObservation(normalizeParams(params), score);

        // Track best
        if (!bestResult || score < bestResult.score) {
            bestResult = result;
            console.error(`*** New best! CER=${(evalResult.cer * 100).toFixed(2)}% ***`);
        }

        // Save intermediate results
        const output = {
            config: { iterations, metric, samplesPerCategory, initialSamples },
            bestResult,
            results,
        };
        writeFileSync(join(PROJECT_ROOT, outputPath), JSON.stringify(output, null, 2));
    }

    await terminateOCR();

    // Final summary
    console.error("\n=== Final Results ===");
    console.error(`Total iterations: ${results.length}`);
    console.error(`Best CER: ${(bestResult.cer * 100).toFixed(2)}%`);
    console.error(`Best WER: ${(bestResult.wer * 100).toFixed(2)}%`);
    console.error("\nBest parameters:");
    for (const [key, value] of Object.entries(bestResult.params)) {
        console.error(`  ${key}: ${value}`);
    }

    // Statistics
    const cers = results.map(r => r.cer);
    const sorted = [...cers].sort((a, b) => a - b);
    console.error(`\nCER Statistics:`);
    console.error(`  Min: ${(sorted[0] * 100).toFixed(2)}%`);
    console.error(`  Max: ${(sorted[sorted.length - 1] * 100).toFixed(2)}%`);
    console.error(`  Median: ${(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(2)}%`);
    console.error(`  Mean: ${((cers.reduce((a, b) => a + b, 0) / cers.length) * 100).toFixed(2)}%`);

    // Print config.ts format for easy copy-paste
    printConfigFormat(bestResult.params);

    console.error(`\nResults saved to: ${outputPath}`);

    return { bestResult, results };
}

// ============================================
// CLI Entry Point
// ============================================

async function main() {
    const { values } = parseArgs({
        options: {
            iterations: { type: "string", default: "50" },
            metric: { type: "string", default: "combined" },
            samples: { type: "string", default: "100" },
            initial: { type: "string", default: "10" },
            output: { type: "string", default: "tuning_results.json" },
            resume: { type: "string" },
            verbose: { type: "boolean", default: false },
            "skip-docsbyhand": { type: "boolean", default: false },
            lang: { type: "string", default: "eng" },
            mode: { type: "string", default: "preprocessing" },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help) {
        console.log(`
OCR Hyperparameter Tuning with Bayesian Optimization

Usage:
  node scripts/ocr_tuning.mjs --iterations 50 --metric combined

Options:
  --iterations <n>   Number of optimization iterations (default: 50)
  --metric <name>    Target metric:
                       docsbyhand - Optimize on docsbyhand only
                       easy       - docsbyhand + b-mod easy (fixed)
                       combined   - docsbyhand + b-mod easy (fixed + random)
                       all        - All datasets
  --samples <n>      Samples per b-mod category (default: 100)
  --initial <n>      Random exploration iterations (default: 10)
  --output <path>    Output file (default: tuning_results.json)
  --resume <path>    Resume from previous results
  --verbose          Show detailed progress
  --mode <mode>      Parameter mode:
                       preprocessing - CLAHE, contrast (default, for single lines)
                       layout        - NMS, Fallback, XY-Cut++ (for full documents)
                       full          - All parameters combined
  --help, -h         Show this help

Examples:
  # Quick test with 20 iterations (preprocessing)
  node scripts/ocr_tuning.mjs --iterations 20 --samples 50

  # Layout parameter optimization (requires docsbyhand)
  node scripts/ocr_tuning.mjs --mode layout --iterations 50 --metric docsbyhand

  # Full optimization
  node scripts/ocr_tuning.mjs --iterations 100 --metric all --samples 100

  # Resume interrupted run
  node scripts/ocr_tuning.mjs --iterations 100 --resume tuning_results.json
        `);
        process.exit(0);
    }

    // Set parameter space based on mode
    const mode = values.mode;
    switch (mode) {
        case "layout":
            PARAMETER_SPACE = LAYOUT_PARAMETER_SPACE;
            console.error(`[Mode] layout - optimizing NMS, Fallback, XY-Cut++ parameters`);
            console.error(`       Note: Layout parameters require full document OCR pipeline`);
            console.error(`       Currently evaluating with simple line OCR (limited effect)`);
            break;
        case "full":
            PARAMETER_SPACE = FULL_PARAMETER_SPACE;
            console.error(`[Mode] full - optimizing all parameters (preprocessing + layout)`);
            break;
        case "preprocessing":
        default:
            PARAMETER_SPACE = PREPROCESSING_PARAMETER_SPACE;
            console.error(`[Mode] preprocessing - optimizing CLAHE, contrast parameters`);
    }

    console.error(`[Parameters] ${Object.keys(PARAMETER_SPACE).length} parameters to optimize`);

    try {
        await runTuning({
            iterations: parseInt(values.iterations, 10),
            metric: values.metric,
            samplesPerCategory: parseInt(values.samples, 10),
            initialSamples: parseInt(values.initial, 10),
            outputPath: values.output,
            resumePath: values.resume,
            verbose: values.verbose,
            skipDocsbyhand: values["skip-docsbyhand"],
            lang: values.lang,
            mode: mode,
        });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        console.error(err.stack);
        process.exit(1);
    }
}

/**
 * Convert flat tuning parameters to nested config.ts format.
 * Usage: Copy the output into frontend/src/services/layout/config.ts
 */
function paramsToConfigFormat(params) {
    const config = {
        preprocessing: {},
        nms: {},
        fallback: {},
        xyCut: {},
    };

    for (const [key, value] of Object.entries(params)) {
        if (key.startsWith("nms_")) {
            const subKey = key.replace("nms_", "");
            config.nms[subKey] = value;
        } else if (key.startsWith("fallback_")) {
            const subKey = key.replace("fallback_", "");
            config.fallback[subKey] = value;
        } else if (key.startsWith("xyCut_")) {
            const subKey = key.replace("xyCut_", "");
            config.xyCut[subKey] = value;
        } else {
            // Preprocessing parameters
            config.preprocessing[key] = value;
        }
    }

    return config;
}

/**
 * Print optimized parameters in config.ts format for easy copy-paste.
 */
function printConfigFormat(bestParams) {
    const config = paramsToConfigFormat(bestParams);

    console.error("\n=== Config.ts Format (copy-paste ready) ===\n");

    if (Object.keys(config.preprocessing).length > 0) {
        console.error("// Preprocessing (config.preprocessing)");
        for (const [key, value] of Object.entries(config.preprocessing)) {
            const formatted = typeof value === "number" && !Number.isInteger(value)
                ? value.toFixed(2)
                : value;
            console.error(`${key}: ${formatted},`);
        }
        console.error("");
    }

    if (Object.keys(config.nms).length > 0) {
        console.error("// NMS (config.nms)");
        for (const [key, value] of Object.entries(config.nms)) {
            const formatted = typeof value === "number" && !Number.isInteger(value)
                ? value.toFixed(2)
                : value;
            console.error(`${key}: ${formatted},`);
        }
        console.error("");
    }

    if (Object.keys(config.fallback).length > 0) {
        console.error("// Fallback OCR (config.fallback)");
        for (const [key, value] of Object.entries(config.fallback)) {
            const formatted = typeof value === "number" && !Number.isInteger(value)
                ? value.toFixed(2)
                : value;
            console.error(`${key}: ${formatted},`);
        }
        console.error("");
    }

    if (Object.keys(config.xyCut).length > 0) {
        console.error("// XY-Cut++ (config.xyCut)");
        for (const [key, value] of Object.entries(config.xyCut)) {
            const formatted = typeof value === "number" && !Number.isInteger(value)
                ? value.toFixed(2)
                : value;
            console.error(`${key}: ${formatted},`);
        }
        console.error("");
    }
}

// Export for programmatic use
export { paramsToConfigFormat, printConfigFormat, LAYOUT_PARAMETER_SPACE, PREPROCESSING_PARAMETER_SPACE, FULL_PARAMETER_SPACE };

main();
