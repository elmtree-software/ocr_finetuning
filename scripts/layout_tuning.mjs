#!/usr/bin/env node
/**
 * Layout Parameter Tuning for Document OCR
 *
 * Optimizes layout-related parameters for full document OCR:
 * - NMS: iouThreshold, containmentThreshold
 * - Fallback: enabled, gridSize, minAreaRatio, minConfidence
 * - XY-Cut++: enabled, minGapThreshold, spanningThreshold, maxDepth, etc.
 *
 * This script uses the full layout detection pipeline (YOLO + Tesseract)
 * and evaluates on complete documents from docsbyhand/.
 *
 * Usage:
 *   node scripts/layout_tuning.mjs --iterations 30
 *   node scripts/layout_tuning.mjs --iterations 50 --output layout_results.json
 *
 * Options:
 *   --iterations <n>    Number of optimization iterations (default: 30)
 *   --initial <n>       Initial random samples (default: 8)
 *   --output <path>     Output file (default: layout_tuning_results.json)
 *   --resume <path>     Resume from previous results
 *   --verbose           Show detailed progress
 *   --skip-yolo         Skip YOLO, use cached bounding boxes if available
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCanvas, loadImage } from "canvas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const require = createRequire(join(PROJECT_ROOT, "package.json"));
const Tesseract = require("tesseract.js");

// ============================================
// Layout Parameter Space
// ============================================

const PARAMETER_SPACE = {
    // NMS (Non-Maximum Suppression)
    nms_iouThreshold: { min: 0.3, max: 0.7, step: 0.05, default: 0.5 },
    nms_containmentThreshold: { min: 0.6, max: 0.95, step: 0.05, default: 0.8 },

    // Fallback OCR (uncovered areas)
    fallback_enabled: { min: 0, max: 1, step: 1, default: 1, integer: true, boolean: true },
    fallback_gridSize: { min: 30, max: 80, step: 10, default: 50, integer: true },
    fallback_minAreaRatio: { min: 0.02, max: 0.15, step: 0.01, default: 0.05 },
    fallback_minConfidence: { min: 0.1, max: 0.5, step: 0.05, default: 0.2 },

    // XY-Cut++ Reading Order
    xyCut_enabled: { min: 0, max: 1, step: 1, default: 0, integer: true, boolean: true },
    xyCut_minGapThreshold: { min: 10, max: 60, step: 5, default: 20, integer: true },
    xyCut_spanningThreshold: { min: 0.4, max: 0.8, step: 0.05, default: 0.6 },
    xyCut_maxDepth: { min: 5, max: 20, step: 2, default: 15, integer: true },
    xyCut_cutPreferenceRatio: { min: 0.5, max: 0.9, step: 0.1, default: 0.7 },
};

// ============================================
// YOLO Layout Detection (using transformers.js)
// ============================================

let pipeline = null;
let processor = null;
let model = null;

const LAYOUT_LABELS = {
    0: "Caption",
    1: "Footnote",
    2: "Formula",
    3: "List-item",
    4: "Page-footer",
    5: "Page-header",
    6: "Picture",
    7: "Section-header",
    8: "Table",
    9: "Text",
    10: "Title",
};

async function initYOLO() {
    if (pipeline) return;

    console.error("[YOLO] Loading layout detection model...");

    // Dynamic import for ESM compatibility
    const { AutoProcessor, AutoModel, RawImage } = await import("@huggingface/transformers");

    const modelId = "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis";

    processor = await AutoProcessor.from_pretrained(modelId);
    model = await AutoModel.from_pretrained(modelId);

    // Store RawImage for later use
    pipeline = { processor, model, RawImage };

    console.error("[YOLO] Model loaded");
}

async function detectLayout(imagePath, threshold = 0.2) {
    if (!pipeline) await initYOLO();

    const { processor, model, RawImage } = pipeline;

    // Load image
    const image = await RawImage.read(imagePath);

    // Process
    const processed = await processor(image);
    const { pixel_values, reshaped_input_sizes } = processed;

    // Inference
    const { output0 } = await model({ images: pixel_values });

    // Process predictions
    const predictions = output0.tolist()[0];
    const sizes = reshaped_input_sizes.tolist
        ? reshaped_input_sizes.tolist()[0]
        : reshaped_input_sizes[0];
    const [newHeight, newWidth] = sizes;
    const scaleX = image.width / newWidth;
    const scaleY = image.height / newHeight;

    const regions = [];

    for (const [xmin, ymin, xmax, ymax, score, id] of predictions) {
        if (score < threshold) continue;

        const labelId = Math.round(id);
        const label = LAYOUT_LABELS[labelId];
        if (!label) continue;

        regions.push({
            label,
            labelId,
            score,
            bbox: {
                x: xmin * scaleX,
                y: ymin * scaleY,
                width: (xmax - xmin) * scaleX,
                height: (ymax - ymin) * scaleY,
            },
        });
    }

    return {
        regions,
        imageWidth: image.width,
        imageHeight: image.height,
    };
}

// ============================================
// Layout Processing (ported from layoutOCR.ts)
// ============================================

function calculateIoU(a, b) {
    const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const intersection = xOverlap * yOverlap;
    const union = a.width * a.height + b.width * b.height - intersection;
    return union > 0 ? intersection / union : 0;
}

function containsRegion(outer, inner, threshold) {
    const xOverlap = Math.max(0, Math.min(outer.x + outer.width, inner.x + inner.width) - Math.max(outer.x, inner.x));
    const yOverlap = Math.max(0, Math.min(outer.y + outer.height, inner.y + inner.height) - Math.max(outer.y, inner.y));
    const intersection = xOverlap * yOverlap;
    const innerArea = inner.width * inner.height;
    return innerArea > 0 && (intersection / innerArea) >= threshold;
}

function nonMaxSuppression(regions, iouThreshold, containmentThreshold) {
    if (regions.length === 0) return [];

    const sorted = [...regions].sort((a, b) => b.score - a.score);
    const kept = [];
    const suppressed = new Set();

    for (let i = 0; i < sorted.length; i++) {
        if (suppressed.has(i)) continue;

        const current = sorted[i];
        kept.push(current);

        for (let j = i + 1; j < sorted.length; j++) {
            if (suppressed.has(j)) continue;

            const other = sorted[j];
            const iou = calculateIoU(current.bbox, other.bbox);

            if (iou > iouThreshold ||
                containsRegion(current.bbox, other.bbox, containmentThreshold) ||
                containsRegion(other.bbox, current.bbox, containmentThreshold)) {
                suppressed.add(j);
            }
        }
    }

    return kept;
}

// XY-Cut++ algorithm
function sortByReadingOrder(regions, imageWidth, params) {
    if (regions.length === 0) return [];
    if (regions.length === 1) return regions;

    if (!params.xyCut_enabled) {
        return [...regions].sort((a, b) => a.bbox.y - b.bbox.y);
    }

    // Pre-masking
    const spanningThreshold = imageWidth * params.xyCut_spanningThreshold;
    const masked = [];
    const unmasked = [];

    for (const region of regions) {
        if (region.bbox.width >= spanningThreshold) {
            masked.push(region);
        } else {
            unmasked.push(region);
        }
    }

    if (unmasked.length === 0) {
        return [...masked].sort((a, b) => a.bbox.y - b.bbox.y);
    }

    // Build XY-Cut tree
    const rootBbox = computeBoundingBox(unmasked);
    const tree = buildXYCutTree(unmasked, rootBbox, 0, params);
    const orderedUnmasked = traverseXYCutTree(tree);

    // Re-map masked elements
    return remapMaskedElements(orderedUnmasked, masked, 0.3);
}

function computeBoundingBox(regions) {
    if (regions.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of regions) {
        minX = Math.min(minX, r.bbox.x);
        minY = Math.min(minY, r.bbox.y);
        maxX = Math.max(maxX, r.bbox.x + r.bbox.width);
        maxY = Math.max(maxY, r.bbox.y + r.bbox.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function buildXYCutTree(regions, bbox, depth, params) {
    if (regions.length <= 1 || depth > params.xyCut_maxDepth) {
        return { regions: [...regions].sort((a, b) => a.bbox.y - b.bbox.y), children: [], cutDirection: 'leaf' };
    }

    const horizontalCut = findBestHorizontalCut(regions, bbox);
    const verticalCut = findBestVerticalCut(regions, bbox);

    let bestCut = null;
    const minGap = params.xyCut_minGapThreshold;

    if (horizontalCut.gap >= minGap && verticalCut.gap >= minGap) {
        bestCut = horizontalCut.gap >= verticalCut.gap
            ? { ...horizontalCut, direction: 'horizontal' }
            : { ...verticalCut, direction: 'vertical' };
    } else if (horizontalCut.gap >= minGap) {
        bestCut = { ...horizontalCut, direction: 'horizontal' };
    } else if (verticalCut.gap >= minGap) {
        bestCut = { ...verticalCut, direction: 'vertical' };
    }

    if (!bestCut) {
        return { regions: [...regions].sort((a, b) => a.bbox.y - b.bbox.y), children: [], cutDirection: 'leaf' };
    }

    const { above, below } = splitRegionsByCut(regions, bestCut.position, bestCut.direction);

    if (above.length === 0 || below.length === 0) {
        return { regions: [...regions].sort((a, b) => a.bbox.y - b.bbox.y), children: [], cutDirection: 'leaf' };
    }

    return {
        regions: [],
        children: [
            buildXYCutTree(above, computeBoundingBox(above), depth + 1, params),
            buildXYCutTree(below, computeBoundingBox(below), depth + 1, params),
        ],
        cutDirection: bestCut.direction,
    };
}

function findBestHorizontalCut(regions, bbox) {
    if (regions.length < 2) return { position: 0, gap: 0 };

    const events = [];
    for (const r of regions) {
        events.push({ y: r.bbox.y, type: 'start' });
        events.push({ y: r.bbox.y + r.bbox.height, type: 'end' });
    }
    events.sort((a, b) => a.y - b.y);

    let activeCount = 0;
    let bestGap = 0;
    let bestPosition = 0;
    let gapStart = bbox.y;

    for (const event of events) {
        if (activeCount === 0 && event.type === 'start') {
            const gap = event.y - gapStart;
            if (gap > bestGap) {
                bestGap = gap;
                bestPosition = gapStart + gap / 2;
            }
        }
        if (event.type === 'start') activeCount++;
        else {
            activeCount--;
            if (activeCount === 0) gapStart = event.y;
        }
    }

    return { position: bestPosition, gap: bestGap };
}

function findBestVerticalCut(regions, bbox) {
    if (regions.length < 2) return { position: 0, gap: 0 };

    const events = [];
    for (const r of regions) {
        events.push({ x: r.bbox.x, type: 'start' });
        events.push({ x: r.bbox.x + r.bbox.width, type: 'end' });
    }
    events.sort((a, b) => a.x - b.x);

    let activeCount = 0;
    let bestGap = 0;
    let bestPosition = 0;
    let gapStart = bbox.x;

    for (const event of events) {
        if (activeCount === 0 && event.type === 'start') {
            const gap = event.x - gapStart;
            if (gap > bestGap) {
                bestGap = gap;
                bestPosition = gapStart + gap / 2;
            }
        }
        if (event.type === 'start') activeCount++;
        else {
            activeCount--;
            if (activeCount === 0) gapStart = event.x;
        }
    }

    return { position: bestPosition, gap: bestGap };
}

function splitRegionsByCut(regions, position, direction) {
    const above = [];
    const below = [];

    for (const r of regions) {
        if (direction === 'horizontal') {
            const centerY = r.bbox.y + r.bbox.height / 2;
            if (centerY < position) above.push(r);
            else below.push(r);
        } else {
            const centerX = r.bbox.x + r.bbox.width / 2;
            if (centerX < position) above.push(r);
            else below.push(r);
        }
    }

    return { above, below };
}

function traverseXYCutTree(node) {
    if (node.cutDirection === 'leaf') return node.regions;
    const result = [];
    for (const child of node.children) {
        result.push(...traverseXYCutTree(child));
    }
    return result;
}

function remapMaskedElements(ordered, masked, overlapThreshold) {
    if (masked.length === 0) return ordered;
    if (ordered.length === 0) return [...masked].sort((a, b) => a.bbox.y - b.bbox.y);

    const sortedMasked = [...masked].sort((a, b) => a.bbox.y - b.bbox.y);
    const result = [];
    let maskedIdx = 0;

    for (const region of ordered) {
        while (maskedIdx < sortedMasked.length) {
            const maskedRegion = sortedMasked[maskedIdx];
            const maskedBottom = maskedRegion.bbox.y + maskedRegion.bbox.height;
            if (maskedBottom <= region.bbox.y + region.bbox.height * overlapThreshold) {
                result.push(maskedRegion);
                maskedIdx++;
            } else {
                break;
            }
        }
        result.push(region);
    }

    while (maskedIdx < sortedMasked.length) {
        result.push(sortedMasked[maskedIdx]);
        maskedIdx++;
    }

    return result;
}

// Fallback: find uncovered areas
function findUncoveredAreas(regions, imageWidth, imageHeight, params) {
    if (!params.fallback_enabled) return [];
    if (regions.length === 0) {
        return [{ x: 0, y: 0, width: imageWidth, height: imageHeight }];
    }

    const gridSize = params.fallback_gridSize;
    const minAreaRatio = params.fallback_minAreaRatio;

    const gridCols = Math.ceil(imageWidth / gridSize);
    const gridRows = Math.ceil(imageHeight / gridSize);
    const covered = Array(gridRows).fill(null).map(() => Array(gridCols).fill(false));

    for (const region of regions) {
        const startCol = Math.floor(region.bbox.x / gridSize);
        const endCol = Math.ceil((region.bbox.x + region.bbox.width) / gridSize);
        const startRow = Math.floor(region.bbox.y / gridSize);
        const endRow = Math.ceil((region.bbox.y + region.bbox.height) / gridSize);

        for (let row = Math.max(0, startRow); row < Math.min(gridRows, endRow); row++) {
            for (let col = Math.max(0, startCol); col < Math.min(gridCols, endCol); col++) {
                covered[row][col] = true;
            }
        }
    }

    const uncoveredAreas = [];
    const visited = Array(gridRows).fill(null).map(() => Array(gridCols).fill(false));

    for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
            if (!covered[row][col] && !visited[row][col]) {
                let maxCol = col;
                while (maxCol + 1 < gridCols && !covered[row][maxCol + 1] && !visited[row][maxCol + 1]) {
                    maxCol++;
                }

                let maxRow = row;
                let canExpand = true;
                while (canExpand && maxRow + 1 < gridRows) {
                    for (let c = col; c <= maxCol; c++) {
                        if (covered[maxRow + 1][c] || visited[maxRow + 1][c]) {
                            canExpand = false;
                            break;
                        }
                    }
                    if (canExpand) maxRow++;
                }

                for (let r = row; r <= maxRow; r++) {
                    for (let c = col; c <= maxCol; c++) {
                        visited[r][c] = true;
                    }
                }

                const bbox = {
                    x: col * gridSize,
                    y: row * gridSize,
                    width: Math.min((maxCol - col + 1) * gridSize, imageWidth - col * gridSize),
                    height: Math.min((maxRow - row + 1) * gridSize, imageHeight - row * gridSize),
                };

                const areaRatio = (bbox.width * bbox.height) / (imageWidth * imageHeight);
                if (areaRatio >= minAreaRatio) {
                    uncoveredAreas.push(bbox);
                }
            }
        }
    }

    return uncoveredAreas;
}

// ============================================
// OCR
// ============================================

let tesseractWorker = null;

async function initOCR(lang = "deu+eng") {
    if (tesseractWorker) return;

    console.error(`[OCR] Initializing Tesseract with languages: ${lang}`);
    tesseractWorker = await Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
        logger: () => {},
    });

    await tesseractWorker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
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

async function ocrRegion(imagePath, region) {
    const img = await loadImage(imagePath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    // Crop region with padding
    const padding = 5;
    const x = Math.max(0, Math.floor(region.x - padding));
    const y = Math.max(0, Math.floor(region.y - padding));
    const w = Math.min(img.width - x, Math.ceil(region.width + padding * 2));
    const h = Math.min(img.height - y, Math.ceil(region.height + padding * 2));

    const cropped = createCanvas(w, h);
    const cropCtx = cropped.getContext("2d");
    cropCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);

    const buffer = cropped.toBuffer("image/png");
    const result = await tesseractWorker.recognize(buffer);

    return {
        text: result.data.text.trim(),
        confidence: result.data.confidence / 100,
    };
}

// ============================================
// Evaluation Metrics
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
    const pred = predicted.toLowerCase().replace(/\s+/g, ' ').trim();
    const ref = reference.toLowerCase().replace(/\s+/g, ' ').trim();
    if (ref.length === 0) return pred.length === 0 ? 0 : 1;
    return Math.min(1, levenshteinDistance(pred, ref) / ref.length);
}

// ============================================
// Full Pipeline Evaluation
// ============================================

async function evaluateDocument(imagePath, groundTruth, params, verbose = false) {
    // 1. Layout detection
    const layout = await detectLayout(imagePath, 0.2);

    // 2. Filter text regions
    const textTypes = ["Text", "Title", "Section-header", "Caption", "List-item", "Page-header", "Page-footer", "Footnote"];
    let regions = layout.regions.filter(r => textTypes.includes(r.label));

    // 3. NMS
    regions = nonMaxSuppression(regions, params.nms_iouThreshold, params.nms_containmentThreshold);

    // 4. Sort by reading order
    regions = sortByReadingOrder(regions, layout.imageWidth, params);

    // 5. Find fallback regions
    const fallbackAreas = findUncoveredAreas(regions, layout.imageWidth, layout.imageHeight, params);

    // 6. OCR each region
    const texts = [];

    for (const region of regions) {
        const result = await ocrRegion(imagePath, region.bbox);
        if (result.text) {
            texts.push(result.text);
        }
    }

    // 7. OCR fallback regions
    for (const bbox of fallbackAreas) {
        const result = await ocrRegion(imagePath, bbox);
        if (result.text && result.confidence >= params.fallback_minConfidence) {
            texts.push(result.text);
        }
    }

    // 8. Combine and evaluate
    const fullText = texts.join("\n");
    const cer = calculateCER(fullText, groundTruth);

    if (verbose) {
        console.error(`  Regions: ${regions.length}, Fallback: ${fallbackAreas.length}, CER: ${(cer * 100).toFixed(1)}%`);
    }

    return { cer, regionCount: regions.length, fallbackCount: fallbackAreas.length };
}

// ============================================
// Bayesian Optimization (simplified)
// ============================================

function normalizeParams(params) {
    return Object.entries(PARAMETER_SPACE).map(([key, spec]) => {
        const value = params[key] ?? spec.default;
        return (value - spec.min) / (spec.max - spec.min);
    });
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

// Simple GP for small datasets
class SimpleGP {
    constructor() {
        this.observations = [];
    }

    addObservation(params, score) {
        this.observations.push({ params: normalizeParams(params), score });
    }

    suggestNext(numCandidates = 500) {
        if (this.observations.length === 0) {
            return randomParams();
        }

        // Find best so far
        const bestScore = Math.min(...this.observations.map(o => o.score));

        // Generate candidates and pick the one most different from seen points
        // with preference for areas that had good scores
        let bestCandidate = null;
        let bestExpectedImprovement = -Infinity;

        for (let i = 0; i < numCandidates; i++) {
            const normalized = Object.keys(PARAMETER_SPACE).map(() => Math.random());

            // Estimate score based on nearest neighbors
            let minDist = Infinity;
            let nearestScore = 1;

            for (const obs of this.observations) {
                const dist = normalized.reduce((sum, v, j) => sum + Math.pow(v - obs.params[j], 2), 0);
                if (dist < minDist) {
                    minDist = dist;
                    nearestScore = obs.score;
                }
            }

            // Expected improvement: explore (distance) + exploit (low score)
            const exploration = Math.sqrt(minDist);
            const exploitation = Math.max(0, bestScore - nearestScore + 0.1);
            const ei = exploration * 0.5 + exploitation * 0.5;

            if (ei > bestExpectedImprovement) {
                bestExpectedImprovement = ei;
                bestCandidate = normalized;
            }
        }

        return denormalizeParams(bestCandidate);
    }
}

// ============================================
// Dataset Loading
// ============================================

function loadDocsbyhandDataset() {
    const dir = join(PROJECT_ROOT, "docsbyhand");
    const samples = [];

    const files = readdirSync(dir).filter(f => f.endsWith(".jpg"));
    for (const file of files) {
        const num = file.replace(".jpg", "");
        const imgPath = join(dir, file);
        const txtPath = join(dir, `${num}.txt`);

        if (existsSync(txtPath)) {
            samples.push({
                imagePath: imgPath,
                groundTruth: readFileSync(txtPath, "utf-8").trim(),
                name: num,
            });
        }
    }

    return samples.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================
// Main Tuning Loop
// ============================================

async function runTuning(options) {
    const {
        iterations = 30,
        initialSamples = 8,
        outputPath = "layout_tuning_results.json",
        resumePath = null,
        verbose = false,
    } = options;

    console.error("=== Layout Parameter Tuning ===");
    console.error(`Iterations: ${iterations}`);
    console.error(`Parameters: ${Object.keys(PARAMETER_SPACE).length}`);

    // Load dataset
    const samples = loadDocsbyhandDataset();
    console.error(`Documents: ${samples.length}`);

    if (samples.length === 0) {
        console.error("No documents found in docsbyhand/");
        process.exit(1);
    }

    // Initialize
    await initYOLO();
    await initOCR();

    const gp = new SimpleGP();
    let results = [];
    let bestResult = null;

    // Resume
    if (resumePath && existsSync(resumePath)) {
        console.error(`Resuming from ${resumePath}`);
        const previous = JSON.parse(readFileSync(resumePath, "utf-8"));
        results = previous.results || [];

        for (const r of results) {
            gp.addObservation(r.params, r.score);
            if (!bestResult || r.score < bestResult.score) {
                bestResult = r;
            }
        }
        console.error(`Loaded ${results.length} previous results`);
    }

    // Main loop
    const startIter = results.length;

    for (let i = startIter; i < iterations; i++) {
        console.error(`\n--- Iteration ${i + 1}/${iterations} ---`);

        // Choose parameters
        let params;
        if (i < initialSamples) {
            params = randomParams();
            console.error("Strategy: Random exploration");
        } else {
            params = gp.suggestNext();
            console.error("Strategy: Guided search");
        }

        // Log key params
        console.error(`XY-Cut: ${params.xyCut_enabled}, NMS IoU: ${params.nms_iouThreshold.toFixed(2)}, Fallback: ${params.fallback_enabled}`);

        // Evaluate on all documents
        let totalCER = 0;
        let count = 0;

        for (const sample of samples) {
            try {
                const result = await evaluateDocument(sample.imagePath, sample.groundTruth, params, verbose);
                totalCER += result.cer;
                count++;

                if (verbose) {
                    console.error(`  ${sample.name}: CER=${(result.cer * 100).toFixed(1)}%`);
                }
            } catch (err) {
                console.error(`  ${sample.name}: Error - ${err.message}`);
            }
        }

        const avgCER = count > 0 ? totalCER / count : 1;
        console.error(`Average CER: ${(avgCER * 100).toFixed(2)}%`);

        // Store result
        const result = {
            iteration: i + 1,
            params,
            score: avgCER,
            cer: avgCER,
            count,
            timestamp: new Date().toISOString(),
        };
        results.push(result);
        gp.addObservation(params, avgCER);

        // Track best
        if (!bestResult || avgCER < bestResult.score) {
            bestResult = result;
            console.error(`*** New best! CER=${(avgCER * 100).toFixed(2)}% ***`);
        }

        // Save intermediate
        const output = {
            config: { iterations, initialSamples },
            bestResult,
            results,
        };
        writeFileSync(join(PROJECT_ROOT, outputPath), JSON.stringify(output, null, 2));
    }

    await terminateOCR();

    // Final summary
    console.error("\n=== Final Results ===");
    console.error(`Best CER: ${(bestResult.cer * 100).toFixed(2)}%`);
    console.error("\nBest parameters:");
    for (const [key, value] of Object.entries(bestResult.params)) {
        console.error(`  ${key}: ${value}`);
    }

    // Print config format
    console.error("\n=== Config.ts Format ===");
    printConfigFormat(bestResult.params);

    console.error(`\nResults saved to: ${outputPath}`);
}

function printConfigFormat(params) {
    const groups = { nms: {}, fallback: {}, xyCut: {} };

    for (const [key, value] of Object.entries(params)) {
        if (key.startsWith("nms_")) {
            groups.nms[key.replace("nms_", "")] = value;
        } else if (key.startsWith("fallback_")) {
            groups.fallback[key.replace("fallback_", "")] = value;
        } else if (key.startsWith("xyCut_")) {
            groups.xyCut[key.replace("xyCut_", "")] = value;
        }
    }

    for (const [group, values] of Object.entries(groups)) {
        if (Object.keys(values).length > 0) {
            console.error(`\n// ${group}`);
            for (const [key, value] of Object.entries(values)) {
                const formatted = typeof value === "number" && !Number.isInteger(value)
                    ? value.toFixed(2)
                    : value;
                console.error(`${key}: ${formatted},`);
            }
        }
    }
}

// ============================================
// CLI
// ============================================

async function main() {
    const { values } = parseArgs({
        options: {
            iterations: { type: "string", default: "30" },
            initial: { type: "string", default: "8" },
            output: { type: "string", default: "layout_tuning_results.json" },
            resume: { type: "string" },
            verbose: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help) {
        console.log(`
Layout Parameter Tuning for Document OCR

Usage:
  node scripts/layout_tuning.mjs --iterations 30

Options:
  --iterations <n>   Number of iterations (default: 30)
  --initial <n>      Random exploration iterations (default: 8)
  --output <path>    Output file (default: layout_tuning_results.json)
  --resume <path>    Resume from previous results
  --verbose          Show per-document results
  --help, -h         Show this help

Parameters optimized:
  - NMS: iouThreshold, containmentThreshold
  - Fallback: enabled, gridSize, minAreaRatio, minConfidence
  - XY-Cut++: enabled, minGapThreshold, spanningThreshold, maxDepth, cutPreferenceRatio
        `);
        process.exit(0);
    }

    try {
        await runTuning({
            iterations: parseInt(values.iterations, 10),
            initialSamples: parseInt(values.initial, 10),
            outputPath: values.output,
            resumePath: values.resume,
            verbose: values.verbose,
        });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        console.error(err.stack);
        process.exit(1);
    }
}

main();
