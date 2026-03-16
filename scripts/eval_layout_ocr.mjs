#!/usr/bin/env node
/**
 * Evaluate Layout-Aware OCR vs Ground Truth
 *
 * Compares CER/WER for:
 * 1. Layout-aware OCR (YOLO + region-based Tesseract)
 * 2. Simple OCR (Tesseract AUTO mode)
 */

import { AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";
import Tesseract from "tesseract.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DOCSBYHAND_DIR = path.join(PROJECT_ROOT, "docsbyhand");

const LAYOUT_LABELS = {
    0: "Caption", 1: "Footnote", 2: "Formula", 3: "List-item",
    4: "Page-footer", 5: "Page-header", 6: "Picture", 7: "Section-header",
    8: "Table", 9: "Text", 10: "Title",
};

const TEXT_LABELS = ["Text", "Title", "Section-header", "Caption", "Footnote", "List-item", "Page-header", "Page-footer"];
const MODEL_ID = "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis";

const PSM_MODES = {
    "Text": Tesseract.PSM.SINGLE_BLOCK,
    "Title": Tesseract.PSM.SINGLE_LINE,
    "Section-header": Tesseract.PSM.SINGLE_LINE,
    "Caption": Tesseract.PSM.SINGLE_BLOCK,
    "Footnote": Tesseract.PSM.SINGLE_BLOCK,
    "List-item": Tesseract.PSM.SINGLE_LINE,
    "Page-header": Tesseract.PSM.SINGLE_LINE,
    "Page-footer": Tesseract.PSM.SINGLE_LINE,
    "Table": Tesseract.PSM.SPARSE_TEXT,
};

let model = null;
let processor = null;
let tesseractWorker = null;

async function loadModels() {
    console.log("Loading models...");

    [model, processor] = await Promise.all([
        AutoModel.from_pretrained(MODEL_ID, { dtype: "fp32" }),
        AutoProcessor.from_pretrained(MODEL_ID),
    ]);

    tesseractWorker = await Tesseract.createWorker("deu+eng", Tesseract.OEM.LSTM_ONLY);

    console.log("Models loaded.\n");
}

async function detectLayout(imagePath, threshold = 0.30) {
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
            label, labelId, score,
            bbox: {
                x: xmin * scaleX, y: ymin * scaleY,
                width: (xmax - xmin) * scaleX, height: (ymax - ymin) * scaleY,
            },
        });
    }

    regions.sort((a, b) => a.bbox.y - b.bbox.y);
    return { regions, width: image.width, height: image.height };
}

async function layoutOCR(imagePath) {
    const layout = await detectLayout(imagePath);
    const textRegions = layout.regions.filter(r => TEXT_LABELS.includes(r.label));
    const tableRegions = layout.regions.filter(r => r.label === "Table");

    const texts = [];

    for (const region of textRegions) {
        const { x, y, width, height } = region.bbox;
        const padding = 5;
        const cropX = Math.max(0, Math.floor(x - padding));
        const cropY = Math.max(0, Math.floor(y - padding));
        const cropW = Math.ceil(width + padding * 2);
        const cropH = Math.ceil(height + padding * 2);

        const psmMode = PSM_MODES[region.label] ?? Tesseract.PSM.SINGLE_BLOCK;
        await tesseractWorker.setParameters({ tessedit_pageseg_mode: psmMode });

        const result = await tesseractWorker.recognize(imagePath, {
            rectangle: { left: cropX, top: cropY, width: cropW, height: cropH }
        });

        const text = result.data.text.trim();
        if (text) texts.push(text);
    }

    // Also OCR tables as text
    for (const region of tableRegions) {
        const { x, y, width, height } = region.bbox;
        const padding = 5;
        const cropX = Math.max(0, Math.floor(x - padding));
        const cropY = Math.max(0, Math.floor(y - padding));

        await tesseractWorker.setParameters({
            tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
            preserve_interword_spaces: "1"
        });

        const result = await tesseractWorker.recognize(imagePath, {
            rectangle: { left: cropX, top: cropY, width: Math.ceil(width + padding * 2), height: Math.ceil(height + padding * 2) }
        });

        const text = result.data.text.trim();
        if (text) texts.push(text);
    }

    return {
        text: texts.join("\n"),
        regionsFound: textRegions.length + tableRegions.length,
    };
}

async function simpleOCR(imagePath) {
    await tesseractWorker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
    const result = await tesseractWorker.recognize(imagePath);
    return { text: result.data.text.trim() };
}

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

function calculateWER(reference, hypothesis) {
    const refWords = reference.replace(/\s+/g, " ").trim().toLowerCase().split(" ").filter(w => w);
    const hypWords = hypothesis.replace(/\s+/g, " ").trim().toLowerCase().split(" ").filter(w => w);

    if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;

    const m = refWords.length;
    const n = hypWords.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (refWords[i - 1] === hypWords[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }

    return dp[m][n] / m;
}

async function main() {
    console.log("=" .repeat(70));
    console.log("Layout OCR vs Simple OCR Evaluation");
    console.log("=".repeat(70));

    await loadModels();

    const results = [];

    // Test images 9-19
    for (let i = 9; i <= 19; i++) {
        const num = String(i).padStart(6, "0");
        const imagePath = path.join(DOCSBYHAND_DIR, `${num}.jpg`);
        const txtPath = path.join(DOCSBYHAND_DIR, `${num}.txt`);

        if (!fs.existsSync(imagePath) || !fs.existsSync(txtPath)) continue;

        const groundTruth = fs.readFileSync(txtPath, "utf-8");

        console.log(`\nProcessing ${num}.jpg...`);

        // Layout OCR
        const layoutResult = await layoutOCR(imagePath);
        const layoutCER = calculateCER(groundTruth, layoutResult.text);
        const layoutWER = calculateWER(groundTruth, layoutResult.text);

        // Simple OCR
        const simpleResult = await simpleOCR(imagePath);
        const simpleCER = calculateCER(groundTruth, simpleResult.text);
        const simpleWER = calculateWER(groundTruth, simpleResult.text);

        results.push({
            image: num,
            regions: layoutResult.regionsFound,
            layoutCER, layoutWER,
            simpleCER, simpleWER,
            gtLength: groundTruth.length,
            layoutLength: layoutResult.text.length,
            simpleLength: simpleResult.text.length,
        });

        console.log(`  Regions: ${layoutResult.regionsFound}`);
        console.log(`  Layout OCR - CER: ${(layoutCER * 100).toFixed(1)}%, WER: ${(layoutWER * 100).toFixed(1)}%`);
        console.log(`  Simple OCR - CER: ${(simpleCER * 100).toFixed(1)}%, WER: ${(simpleWER * 100).toFixed(1)}%`);
    }

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log("SUMMARY");
    console.log("=".repeat(70));

    console.log("\n| Image  | Regions | Layout CER | Layout WER | Simple CER | Simple WER |");
    console.log("|--------|---------|------------|------------|------------|------------|");

    for (const r of results) {
        console.log(`| ${r.image} | ${String(r.regions).padStart(7)} | ${(r.layoutCER * 100).toFixed(1).padStart(9)}% | ${(r.layoutWER * 100).toFixed(1).padStart(9)}% | ${(r.simpleCER * 100).toFixed(1).padStart(9)}% | ${(r.simpleWER * 100).toFixed(1).padStart(9)}% |`);
    }

    const avgLayoutCER = results.reduce((s, r) => s + r.layoutCER, 0) / results.length;
    const avgLayoutWER = results.reduce((s, r) => s + r.layoutWER, 0) / results.length;
    const avgSimpleCER = results.reduce((s, r) => s + r.simpleCER, 0) / results.length;
    const avgSimpleWER = results.reduce((s, r) => s + r.simpleWER, 0) / results.length;

    console.log("|--------|---------|------------|------------|------------|------------|");
    console.log(`| AVG    |         | ${(avgLayoutCER * 100).toFixed(1).padStart(9)}% | ${(avgLayoutWER * 100).toFixed(1).padStart(9)}% | ${(avgSimpleCER * 100).toFixed(1).padStart(9)}% | ${(avgSimpleWER * 100).toFixed(1).padStart(9)}% |`);

    console.log("\n" + "=".repeat(70));
    if (avgLayoutCER < avgSimpleCER) {
        console.log(`Layout OCR ist ${((avgSimpleCER - avgLayoutCER) * 100).toFixed(1)}% besser (CER)`);
    } else {
        console.log(`Simple OCR ist ${((avgLayoutCER - avgSimpleCER) * 100).toFixed(1)}% besser (CER)`);
    }
    console.log("=".repeat(70));

    await tesseractWorker.terminate();
}

main().catch(console.error);
