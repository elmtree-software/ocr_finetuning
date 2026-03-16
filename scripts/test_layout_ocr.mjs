#!/usr/bin/env node
/**
 * Test Layout Detection + OCR Pipeline
 *
 * Tests the complete pipeline including:
 * - Layout detection with YOLO
 * - Text region OCR with appropriate PSM modes
 * - Table OCR with structure detection
 */

import { AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";
import Tesseract from "tesseract.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DOCSBYHAND_DIR = path.join(PROJECT_ROOT, "docsbyhand");

// DocLayNet labels
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

const TEXT_LABELS = ["Text", "Title", "Section-header", "Caption", "Footnote", "List-item"];
const MODEL_ID = "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis";

// PSM modes for different region types
const PSM_MODES = {
    "Text": Tesseract.PSM.SINGLE_BLOCK,
    "Title": Tesseract.PSM.SINGLE_LINE,
    "Section-header": Tesseract.PSM.SINGLE_LINE,
    "Caption": Tesseract.PSM.SINGLE_BLOCK,
    "Footnote": Tesseract.PSM.SINGLE_BLOCK,
    "List-item": Tesseract.PSM.SINGLE_LINE,
    "Page-header": Tesseract.PSM.SINGLE_LINE,
    "Page-footer": Tesseract.PSM.SINGLE_LINE,
    "Table": Tesseract.PSM.AUTO,
};

let model = null;
let processor = null;
let tesseractWorker = null;

/**
 * Load layout detection model.
 */
async function loadLayoutModel() {
    if (model && processor) return;

    console.log("Loading layout detection model...");
    const start = Date.now();

    [model, processor] = await Promise.all([
        AutoModel.from_pretrained(MODEL_ID, { dtype: "fp32" }),
        AutoProcessor.from_pretrained(MODEL_ID),
    ]);

    console.log(`Model loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

/**
 * Load Tesseract worker.
 */
async function loadTesseract() {
    if (tesseractWorker) return;

    console.log("Loading Tesseract...");
    const start = Date.now();

    tesseractWorker = await Tesseract.createWorker("deu+eng", Tesseract.OEM.LSTM_ONLY);

    console.log(`Tesseract loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

/**
 * Detect layout in an image.
 */
async function detectLayout(imagePath, threshold = 0.35) {
    const image = await RawImage.read(imagePath);
    const processed = await processor(image);
    const { pixel_values, reshaped_input_sizes } = processed;
    const { output0 } = await model({ images: pixel_values });

    const predictions = output0.tolist()[0];
    const sizes = reshaped_input_sizes.tolist ? reshaped_input_sizes.tolist()[0] : reshaped_input_sizes[0];
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

    // Sort by vertical position
    regions.sort((a, b) => a.bbox.y - b.bbox.y);

    return { regions, width: image.width, height: image.height, image };
}

/**
 * Crop a region from an image.
 */
async function cropRegion(image, region, padding = 5) {
    const { x, y, width, height } = region.bbox;

    const cropX = Math.max(0, Math.floor(x - padding));
    const cropY = Math.max(0, Math.floor(y - padding));
    const cropW = Math.min(image.width - cropX, Math.ceil(width + padding * 2));
    const cropH = Math.min(image.height - cropY, Math.ceil(height + padding * 2));

    // Create a cropped image using RawImage
    const cropped = image.clone();
    cropped.resize(cropW, cropH, { left: cropX, top: cropY });

    return cropped;
}

/**
 * OCR a single region.
 */
async function ocrRegion(imagePath, region) {
    // Read full image and crop
    const image = await RawImage.read(imagePath);
    const { x, y, width, height } = region.bbox;

    const padding = 5;
    const cropX = Math.max(0, Math.floor(x - padding));
    const cropY = Math.max(0, Math.floor(y - padding));
    const cropW = Math.min(image.width - cropX, Math.ceil(width + padding * 2));
    const cropH = Math.min(image.height - cropY, Math.ceil(height + padding * 2));

    // For Node.js, we use the image URL directly with rectangle parameter
    const psmMode = PSM_MODES[region.label] ?? Tesseract.PSM.SINGLE_BLOCK;

    await tesseractWorker.setParameters({
        tessedit_pageseg_mode: psmMode,
    });

    // Recognize with rectangle
    const result = await tesseractWorker.recognize(imagePath, {
        rectangle: { left: cropX, top: cropY, width: cropW, height: cropH }
    });

    return {
        text: result.data.text.trim(),
        confidence: result.data.confidence / 100,
    };
}

/**
 * Process table region and extract structure.
 */
async function processTable(imagePath, tableRegion) {
    const { x, y, width, height } = tableRegion.bbox;

    const padding = 5;
    const cropX = Math.max(0, Math.floor(x - padding));
    const cropY = Math.max(0, Math.floor(y - padding));

    await tesseractWorker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        preserve_interword_spaces: "1",
    });

    const result = await tesseractWorker.recognize(imagePath, {
        rectangle: { left: cropX, top: cropY, width: Math.ceil(width + padding * 2), height: Math.ceil(height + padding * 2) }
    }, { blocks: true });

    // Extract words with positions
    const words = [];
    if (result.data.blocks) {
        for (const block of result.data.blocks) {
            if (block.paragraphs) {
                for (const para of block.paragraphs) {
                    if (para.lines) {
                        for (const line of para.lines) {
                            if (line.words) {
                                for (const word of line.words) {
                                    if (word.text?.trim()) {
                                        words.push({
                                            text: word.text.trim(),
                                            confidence: word.confidence / 100,
                                            bbox: word.bbox,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Simple row clustering by Y position
    const rows = clusterByY(words, 15);

    // Generate markdown
    let markdown = "";
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        // Sort by X position
        row.sort((a, b) => a.bbox.x0 - b.bbox.x0);
        const cells = row.map(w => w.text);
        markdown += "| " + cells.join(" | ") + " |\n";
        if (i === 0) {
            markdown += "| " + cells.map(() => "---").join(" | ") + " |\n";
        }
    }

    return {
        text: result.data.text.trim(),
        markdown,
        rows: rows.length,
        words: words.length,
    };
}

/**
 * Cluster words by Y position.
 */
function clusterByY(items, tolerance) {
    if (items.length === 0) return [];

    const sorted = [...items].sort((a, b) => (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2);

    const clusters = [];
    let currentCluster = [sorted[0]];
    let clusterCenterY = (sorted[0].bbox.y0 + sorted[0].bbox.y1) / 2;

    for (let i = 1; i < sorted.length; i++) {
        const item = sorted[i];
        const centerY = (item.bbox.y0 + item.bbox.y1) / 2;

        if (Math.abs(centerY - clusterCenterY) <= tolerance) {
            currentCluster.push(item);
            clusterCenterY = currentCluster.reduce((sum, w) => sum + (w.bbox.y0 + w.bbox.y1) / 2, 0) / currentCluster.length;
        } else {
            clusters.push(currentCluster);
            currentCluster = [item];
            clusterCenterY = centerY;
        }
    }

    if (currentCluster.length > 0) {
        clusters.push(currentCluster);
    }

    return clusters;
}

/**
 * Run full layout-aware OCR on an image.
 */
async function runLayoutOCR(imageNumber) {
    const imagePath = path.join(DOCSBYHAND_DIR, `${imageNumber}.jpg`);
    const txtPath = path.join(DOCSBYHAND_DIR, `${imageNumber}.txt`);

    if (!fs.existsSync(imagePath)) {
        console.log(`Image not found: ${imagePath}`);
        return null;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing ${imageNumber}.jpg`);
    console.log("=".repeat(60));

    // Detect layout
    const layoutStart = Date.now();
    const layout = await detectLayout(imagePath);
    console.log(`Layout detection: ${Date.now() - layoutStart}ms`);
    console.log(`Found ${layout.regions.length} regions`);

    // Separate text and table regions
    const textRegions = layout.regions.filter(r => TEXT_LABELS.includes(r.label));
    const tableRegions = layout.regions.filter(r => r.label === "Table");

    console.log(`  Text regions: ${textRegions.length}`);
    console.log(`  Table regions: ${tableRegions.length}`);

    // OCR text regions
    const ocrResults = [];
    const ocrStart = Date.now();

    for (const region of textRegions) {
        const result = await ocrRegion(imagePath, region);
        if (result.text) {
            ocrResults.push({
                label: region.label,
                text: result.text,
                confidence: result.confidence,
                bbox: region.bbox,
            });
        }
    }

    console.log(`Text OCR: ${Date.now() - ocrStart}ms`);

    // Process tables
    const tableResults = [];
    if (tableRegions.length > 0) {
        const tableStart = Date.now();
        for (const tableRegion of tableRegions) {
            const result = await processTable(imagePath, tableRegion);
            tableResults.push(result);
        }
        console.log(`Table OCR: ${Date.now() - tableStart}ms`);
    }

    // Output results
    console.log("\n--- Text Regions ---");
    for (const r of ocrResults.slice(0, 5)) {
        const preview = r.text.length > 60 ? r.text.slice(0, 60) + "..." : r.text;
        console.log(`[${r.label}] (${(r.confidence * 100).toFixed(0)}%): ${preview}`);
    }
    if (ocrResults.length > 5) {
        console.log(`... and ${ocrResults.length - 5} more regions`);
    }

    if (tableResults.length > 0) {
        console.log("\n--- Tables ---");
        for (let i = 0; i < tableResults.length; i++) {
            const t = tableResults[i];
            console.log(`Table ${i + 1}: ${t.rows} rows, ${t.words} words`);
            if (t.markdown) {
                console.log(t.markdown.split("\n").slice(0, 5).join("\n"));
                if (t.rows > 4) console.log("...");
            }
        }
    }

    // Compare with ground truth if available
    if (fs.existsSync(txtPath)) {
        const groundTruth = fs.readFileSync(txtPath, "utf-8");
        const extractedText = ocrResults.map(r => r.text).join("\n");
        const cer = calculateCER(groundTruth, extractedText);
        console.log(`\nCER vs ground truth: ${(cer * 100).toFixed(1)}%`);
    }

    return {
        imageNumber,
        textRegions: ocrResults.length,
        tableRegions: tableResults.length,
        ocrResults,
        tableResults,
    };
}

/**
 * Calculate CER.
 */
function calculateCER(reference, hypothesis) {
    const ref = reference.replace(/\s+/g, " ").trim().toLowerCase();
    const hyp = hypothesis.replace(/\s+/g, " ").trim().toLowerCase();

    if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

    const m = ref.length;
    const n = hyp.length;

    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (ref[i - 1] === hyp[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }

    return dp[m][n] / m;
}

/**
 * Main
 */
async function main() {
    console.log("Layout-Aware OCR Pipeline Test");
    console.log("=".repeat(60));

    await loadLayoutModel();
    await loadTesseract();

    // Test specific images
    const testImages = ["000009", "000013", "000015"];  // 013 has a table

    const results = [];
    for (const num of testImages) {
        const result = await runLayoutOCR(num);
        if (result) results.push(result);
    }

    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));

    for (const r of results) {
        console.log(`${r.imageNumber}: ${r.textRegions} text regions, ${r.tableRegions} tables`);
    }

    // Cleanup
    await tesseractWorker.terminate();
}

main().catch(console.error);
