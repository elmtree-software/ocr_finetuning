#!/usr/bin/env node
/**
 * OCR Parameter Tuning - Playwright Automation Script
 *
 * Runs Bayesian tuning on one split (usually train) and then evaluates the
 * best parameter set across available splits (train/val/test or all).
 *
 * Usage:
 *   node scripts/ocr-optimize/run-tuning.mjs <config.json> [output.json]
 *
 * Config schema (relevant fields):
 * {
 *   "baseConfig": { ...partial OCRConfig... },
 *   "iterateParams": { "path.to.param": { "enabled": true, "min": 0.1, "max": 0.9, "steps": 5 } },
 *   "optimizer": { "iterations": 80, "initialSamples": 20, "candidateSamples": 400 },
 *   "scoringMode": "customWER",
 *   "imagesDir": "./ocr_trainingdata/sel_gt",
 *   "splitManifest": "./ocr_optimization/configs/run3_split_manifest.json",
 *   "tuneSplit": "train",
 *   "appUrl": "http://localhost:5173/ocr_finetuning.html"
 * }
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const DEFAULT_APP_URL = "http://localhost:5173/ocr_finetuning.html";
const RUN_TIMEOUT_MS = 120 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif"]);

function usage(exitCode = 1) {
    console.error("Usage: node scripts/ocr-optimize/run-tuning.mjs <config.json> [output.json]");
    process.exit(exitCode);
}

function normalizeFilename(name) {
    return String(name).trim().toLowerCase();
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function setNestedValue(target, dotPath, value) {
    const keys = dotPath.split(".");
    let current = target;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    }
    current[keys[keys.length - 1]] = value;
}

function mergeBaseConfigWithParameters(baseConfig, parameters) {
    const merged = JSON.parse(JSON.stringify(baseConfig || {}));
    for (const param of parameters || []) {
        if (!param || typeof param.path !== "string") continue;
        setNestedValue(merged, param.path, param.value);
    }
    return merged;
}

function computeDrop1(imageScores) {
    if (!imageScores.length) {
        return { werDrop1: 1, cerDrop1: 1, droppedImage: null, droppedWer: null };
    }
    if (imageScores.length === 1) {
        return {
            werDrop1: imageScores[0].wer,
            cerDrop1: imageScores[0].cer,
            droppedImage: imageScores[0].filename,
            droppedWer: imageScores[0].wer,
        };
    }

    const sortedByWer = [...imageScores].sort((a, b) => b.wer - a.wer);
    const dropped = sortedByWer[0];
    const kept = sortedByWer.slice(1);
    return {
        werDrop1: average(kept.map((item) => item.wer)),
        cerDrop1: average(kept.map((item) => item.cer)),
        droppedImage: dropped.filename,
        droppedWer: dropped.wer,
    };
}

function computeSplitMetrics(imageScores) {
    const werMean = average(imageScores.map((item) => item.wer));
    const cerMean = average(imageScores.map((item) => item.cer));
    const drop1 = computeDrop1(imageScores);

    return {
        imageCount: imageScores.length,
        werMean,
        cerMean,
        werDrop1: drop1.werDrop1,
        cerDrop1: drop1.cerDrop1,
        droppedImage: drop1.droppedImage,
        droppedWer: drop1.droppedWer,
        perDocument: imageScores.map((item) => ({
            filename: item.filename,
            wer: item.wer,
            cer: item.cer,
            lengthRatio: item.lengthRatio ?? null,
            isEmptyOutput: item.isEmptyOutput ?? null,
            isVeryShortOutput: item.isVeryShortOutput ?? null,
        })),
    };
}

function resolveImagePayload(imagesDir, filename) {
    const baseName = filename.replace(/\.[^.]+$/, "");
    const imgBuffer = fs.readFileSync(path.join(imagesDir, filename));
    const ext = path.extname(filename).toLowerCase().replace(".", "");
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;

    let groundTruth = null;
    let groundTruthSource = null;
    let groundTruthRegions = null;
    let groundTruthMeta = null;

    const txtPath = path.join(imagesDir, `${baseName}.txt`);
    const gtJsonPath = path.join(imagesDir, `${baseName}.gt.json`);

    if (fs.existsSync(gtJsonPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(gtJsonPath, "utf-8"));
            groundTruth = parsed.fullText || null;
            groundTruthSource = "gt.json";

            if (Array.isArray(parsed.regions)) {
                groundTruthRegions = parsed.regions
                    .filter((region) => region && region.bbox && typeof region.text === "string")
                    .map((region) => ({
                        id: region.id,
                        label: region.label,
                        bbox: region.bbox,
                        text: region.text || "",
                        order: region.order,
                        source: region.source,
                    }));
            }

            if (parsed.image) {
                groundTruthMeta = {
                    width: parsed.image.width,
                    height: parsed.image.height,
                    rotation: parsed.rotation,
                    rectificationApplied: parsed.rectificationApplied,
                    layoutModelId: parsed.layoutModelId,
                };
            }

            if (!groundTruth && groundTruthRegions?.length) {
                groundTruth = groundTruthRegions.map((region) => region.text).join("\n").trim();
            }
        } catch (error) {
            console.warn(`[run-tuning] Failed to parse ${gtJsonPath}: ${error.message}`);
        }
    }

    if (!groundTruth && fs.existsSync(txtPath)) {
        groundTruth = fs.readFileSync(txtPath, "utf-8");
        groundTruthSource = groundTruthSource || "txt";
    }

    if (!groundTruth) {
        return null;
    }

    return {
        filename,
        base64: imgBuffer.toString("base64"),
        mimeType,
        groundTruth,
        groundTruthSource,
        groundTruthRegions,
        groundTruthMeta,
        split: "all",
    };
}

function loadImagePayloads(imagesDir) {
    const files = fs
        .readdirSync(imagesDir)
        .filter((file) => IMAGE_EXTS.has(path.extname(file).toLowerCase()))
        .filter((file) => !file.includes(":Zone.Identifier"));

    const payloads = [];
    for (const file of files) {
        const payload = resolveImagePayload(imagesDir, file);
        if (!payload) {
            console.warn(`[run-tuning] No ground truth for ${file}, skipping`);
            continue;
        }
        payloads.push(payload);
    }
    return payloads;
}

function parseSplitManifest(splitManifestPath) {
    const absPath = path.resolve(splitManifestPath);
    const parsed = JSON.parse(fs.readFileSync(absPath, "utf-8"));
    const assignments = new Map();

    if (parsed && typeof parsed === "object" && parsed.splits && typeof parsed.splits === "object") {
        for (const [split, files] of Object.entries(parsed.splits)) {
            if (!Array.isArray(files)) continue;
            for (const file of files) {
                assignments.set(normalizeFilename(file), String(split));
            }
        }
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.images)) {
        for (const item of parsed.images) {
            if (!item || typeof item.filename !== "string" || typeof item.split !== "string") continue;
            assignments.set(normalizeFilename(item.filename), item.split);
        }
    } else if (parsed && typeof parsed === "object" && parsed.assignments && typeof parsed.assignments === "object") {
        for (const [filename, split] of Object.entries(parsed.assignments)) {
            assignments.set(normalizeFilename(filename), String(split));
        }
    } else {
        throw new Error(
            "Unsupported split manifest format. Expected {splits:{}}, {images:[...]}, or {assignments:{}}."
        );
    }

    return { absPath, assignments };
}

function applySplitAssignments(payloads, assignmentInfo) {
    if (!assignmentInfo) {
        return payloads.map((payload) => ({ ...payload, split: "all" }));
    }

    return payloads.map((payload) => {
        const split = assignmentInfo.assignments.get(normalizeFilename(payload.filename)) ?? "unassigned";
        return { ...payload, split };
    });
}

function splitPayloadsMap(payloads) {
    const map = new Map();
    for (const payload of payloads) {
        if (!map.has(payload.split)) {
            map.set(payload.split, []);
        }
        map.get(payload.split).push(payload);
    }

    const ordered = ["train", "val", "test"];
    const entries = [];
    for (const name of ordered) {
        if (map.has(name)) {
            entries.push([name, map.get(name)]);
            map.delete(name);
        }
    }
    for (const [name, items] of map.entries()) {
        entries.push([name, items]);
    }
    return entries;
}

async function navigateAndWait(page, appUrl) {
    console.log(`[run-tuning] Navigating to ${appUrl}`);
    await page.goto(appUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForFunction(() => window.__TUNING__ && window.__OCR__, { timeout: 30000 });
}

async function resetAutomationState(page, { baseConfig, engine, scoringMode }) {
    await page.evaluate(({ baseConfig, engine, scoringMode }) => {
        window.__TUNING__.runner.abort?.();
        window.__TUNING__.state.resetRun();
        window.__TUNING__.state.clearImages();
        window.__TUNING__.state.clearParameterConfigs();
        window.__TUNING__.setBaseConfig(baseConfig);
        window.__TUNING__.state.setEngine(engine);
        window.__TUNING__.state.setScoringMode(scoringMode);
    }, { baseConfig, engine, scoringMode });
}

async function loadImagesIntoState(page, payloads) {
    for (const payload of payloads) {
        await page.evaluate((img) => {
            const binary = atob(img.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            const file = new File([bytes], img.filename, { type: img.mimeType });
            const url = URL.createObjectURL(file);

            window.__TUNING__.state.addImage({
                file,
                url,
                filename: img.filename,
                groundTruth: img.groundTruth,
                groundTruthRegions: img.groundTruthRegions || undefined,
                groundTruthMeta: img.groundTruthMeta || undefined,
                groundTruthSource: img.groundTruthSource || undefined,
                hasGroundTruth: true,
                groundTruthChecked: true,
            });
        }, payload);
    }

    return page.evaluate(() => window.__TUNING__.state.imagesWithGroundTruth.value.length);
}

async function waitForTuningCompletion(page) {
    const startTime = Date.now();
    let lastCompleted = -1;

    while (true) {
        const status = await page.evaluate(() => {
            const rs = window.__TUNING__.state.runState.value;
            return {
                status: rs.status,
                completed: rs.completedPermutations,
                total: rs.totalPermutations,
                bestCombinedScore: rs.bestResult?.combinedScore ?? null,
                bestAverageWER: rs.bestResult?.averageWER ?? null,
                error: rs.error ?? null,
            };
        });

        if (status.status === "completed") {
            return { ...status, timedOut: false, elapsedMs: Date.now() - startTime };
        }

        if (status.status === "error") {
            throw new Error(`Tuning run error: ${status.error ?? "unknown"}`);
        }

        if (status.completed !== lastCompleted) {
            const elapsedSec = Math.round((Date.now() - startTime) / 1000);
            const percent = status.total > 0 ? ((status.completed / status.total) * 100).toFixed(1) : "?";
            const bestWer =
                status.bestAverageWER !== null
                    ? ` | best avg WER ${(status.bestAverageWER * 100).toFixed(2)}%`
                    : "";
            console.log(
                `[run-tuning] Progress ${status.completed}/${status.total} (${percent}%) | ${elapsedSec}s${bestWer}`
            );
            lastCompleted = status.completed;
        }

        if (Date.now() - startTime > RUN_TIMEOUT_MS) {
            console.warn("[run-tuning] Timeout reached. Extracting partial results.");
            return { ...status, timedOut: true, elapsedMs: Date.now() - startTime };
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

async function extractRunResults(page) {
    return page.evaluate(() => {
        const rs = window.__TUNING__.state.runState.value;
        const serializeResult = (result) => ({
            id: result.id,
            parameters: result.parameters,
            averageCER: result.averageCER,
            averageWER: result.averageWER,
            combinedScore: result.combinedScore,
            legacyCombinedScore: result.legacyCombinedScore ?? null,
            feasible: result.feasible,
            timestamp: result.timestamp,
            imageScores: result.imageScores.map((item) => ({
                filename: item.filename,
                cer: item.cer,
                wer: item.wer,
                ocrLength: item.ocrLength,
                groundTruthLength: item.groundTruthLength,
                lengthRatio: item.lengthRatio,
                underproductionRate: item.underproductionRate,
                isEmptyOutput: item.isEmptyOutput,
                isVeryShortOutput: item.isVeryShortOutput,
            })),
        });

        return {
            status: rs.status,
            totalPermutations: rs.totalPermutations,
            completedPermutations: rs.completedPermutations,
            results: rs.results.map(serializeResult),
            bestResult: rs.bestResult ? serializeResult(rs.bestResult) : null,
        };
    });
}

function rankResultsWithDrop1(rawResults) {
    const ranked = rawResults.map((result) => {
        const drop1 = computeDrop1(result.imageScores);
        return {
            ...result,
            customWER: drop1.werDrop1,
            customCER: drop1.cerDrop1,
            droppedImage: drop1.droppedImage,
            droppedWER: drop1.droppedWer,
        };
    });
    ranked.sort((a, b) => a.customWER - b.customWER);
    return ranked;
}

async function evaluateParametersForSplit(page, { splitName, payloads, baseConfig, engine, scoringMode, parameters }) {
    if (!payloads.length) return null;

    const mergedConfig = mergeBaseConfigWithParameters(baseConfig, parameters);
    await resetAutomationState(page, {
        baseConfig: mergedConfig,
        engine,
        scoringMode,
    });

    const imageCount = await loadImagesIntoState(page, payloads);
    if (imageCount === 0) {
        throw new Error(`Split '${splitName}' contains no images with ground truth`);
    }

    const runSingleResult = await page.evaluate(async ({ parameters }) => {
        return window.__TUNING__.runner.runSingle(parameters);
    }, { parameters });

    if (!runSingleResult) {
        throw new Error(`Split '${splitName}' evaluation returned null`);
    }

    const metrics = computeSplitMetrics(runSingleResult.imageScores);
    return {
        ...metrics,
        combinedScore: runSingleResult.combinedScore,
        averageWER: runSingleResult.averageWER,
        averageCER: runSingleResult.averageCER,
        feasible: runSingleResult.feasible,
    };
}

async function main() {
    const configPath = process.argv[2];
    const outputPath = process.argv[3] || null;
    if (!configPath) usage(1);

    const resolvedConfigPath = path.resolve(configPath);
    const config = JSON.parse(fs.readFileSync(resolvedConfigPath, "utf-8"));

    const {
        baseConfig = {},
        iterateParams = {},
        optimizer = { iterations: 60, initialSamples: 15, candidateSamples: 400 },
        scoringMode = "customWER",
        imagesDir = "./ocr_trainingdata/sel_gt",
        splitManifest = null,
        tuneSplit = "train",
        appUrl = DEFAULT_APP_URL,
    } = config;

    const selectedEngine = baseConfig?.engine === "paddleocr" ? "paddleocr" : "tesseract";
    const absImagesDir = path.resolve(imagesDir);
    const allPayloadsRaw = loadImagePayloads(absImagesDir);

    if (allPayloadsRaw.length === 0) {
        throw new Error("No images with ground truth found.");
    }

    let splitInfo = null;
    if (splitManifest) {
        splitInfo = parseSplitManifest(splitManifest);
        console.log(`[run-tuning] Using split manifest: ${splitInfo.absPath}`);
    }

    const allPayloads = applySplitAssignments(allPayloadsRaw, splitInfo);
    const splitEntries = splitPayloadsMap(allPayloads);
    const splitCounts = Object.fromEntries(splitEntries.map(([name, items]) => [name, items.length]));

    let tuningPayloads;
    let effectiveTuneSplit;
    if (splitInfo) {
        effectiveTuneSplit = tuneSplit;
        tuningPayloads = allPayloads.filter((payload) => payload.split === effectiveTuneSplit);
        if (!tuningPayloads.length) {
            const available = splitEntries.map(([name]) => name).join(", ");
            throw new Error(
                `Tune split '${effectiveTuneSplit}' has no images. Available splits: ${available}`
            );
        }
    } else {
        effectiveTuneSplit = "all";
        tuningPayloads = allPayloads;
    }

    console.log(`[run-tuning] Loaded ${allPayloads.length} images from ${absImagesDir}`);
    console.log(`[run-tuning] Tuning split '${effectiveTuneSplit}': ${tuningPayloads.length} images`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            "--disable-gpu",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--js-flags=--max-old-space-size=8192",
        ],
    });

    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    page.on("console", (msg) => {
        const type = msg.type();
        if (type === "warning" || type === "error") {
            console.log(`[browser:${type}] ${msg.text()}`);
        }
    });

    try {
        await navigateAndWait(page, appUrl);

        // Phase 1: tuning on selected split
        await resetAutomationState(page, { baseConfig, engine: selectedEngine, scoringMode });
        await loadImagesIntoState(page, tuningPayloads);

        await page.evaluate(() => {
            window.__TUNING__.state.clearParameterConfigs();
        });

        for (const [paramPath, paramConfig] of Object.entries(iterateParams)) {
            await page.evaluate(
                ({ path, config }) => {
                    window.__TUNING__.state.setParameterConfig(path, config);
                },
                { path: paramPath, config: paramConfig }
            );
        }

        await page.evaluate((opt) => {
            window.__TUNING__.state.setOptimizerSettings(opt);
        }, optimizer);

        const paramCount = Object.keys(iterateParams).length;
        console.log(
            `[run-tuning] Start tuning: ${paramCount} params, ${optimizer.iterations} iterations`
        );
        await page.evaluate(() => window.__TUNING__.runner.start());

        const tuningStatus = await waitForTuningCompletion(page);
        const rawResultsSnapshot = await extractRunResults(page);

        if (tuningStatus.timedOut) {
            await page.evaluate(() => window.__TUNING__.runner.abort?.());
        }

        const rankedResults = rankResultsWithDrop1(rawResultsSnapshot.results);
        const best = rankedResults[0] ?? null;
        const bestParameters = best?.parameters ?? [];

        // Phase 2: split evaluation of best params
        const metricsBySplit = {};
        const splitEvaluationErrors = {};
        for (const [splitName, payloads] of splitEntries) {
            if (!payloads.length) continue;
            try {
                const metrics = await evaluateParametersForSplit(page, {
                    splitName,
                    payloads,
                    baseConfig,
                    engine: selectedEngine,
                    scoringMode,
                    parameters: bestParameters,
                });
                if (metrics) metricsBySplit[splitName] = metrics;
            } catch (error) {
                splitEvaluationErrors[splitName] = error instanceof Error ? error.message : String(error);
            }
        }

        const output = {
            runTimestamp: new Date().toISOString(),
            configFile: resolvedConfigPath,
            scoringMode,
            splitManifest: splitInfo?.absPath ?? null,
            tuneSplit: effectiveTuneSplit,
            splitCounts,
            status: {
                tuningStatus: rawResultsSnapshot.status,
                completedIterations: rawResultsSnapshot.completedPermutations,
                configuredIterations: rawResultsSnapshot.totalPermutations,
                timedOut: tuningStatus.timedOut,
                incomplete:
                    tuningStatus.timedOut ||
                    rawResultsSnapshot.status !== "completed" ||
                    rawResultsSnapshot.completedPermutations < rawResultsSnapshot.totalPermutations,
                elapsedMs: tuningStatus.elapsedMs,
            },
            totalIterations: rankedResults.length,
            best: best
                ? {
                    iterationId: best.id,
                    parameters: best.parameters,
                    customWER: best.customWER,
                    customCER: best.customCER,
                    originalWER: best.averageWER,
                    originalCER: best.averageCER,
                    combinedScore: best.combinedScore,
                    feasible: best.feasible,
                    droppedImage: best.droppedImage,
                    droppedWER: best.droppedWER,
                    imageScores: best.imageScores,
                }
                : null,
            metricsBySplit,
            splitEvaluationErrors,
            allResults: rankedResults.map((result) => ({
                id: result.id,
                customWER: result.customWER,
                customCER: result.customCER,
                originalWER: result.averageWER,
                originalCER: result.averageCER,
                combinedScore: result.combinedScore,
                feasible: result.feasible,
                parameters: result.parameters,
            })),
        };

        const resultJson = JSON.stringify(output, null, 2);
        if (outputPath) {
            const resolvedOutputPath = path.resolve(outputPath);
            fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
            fs.writeFileSync(resolvedOutputPath, resultJson);
            console.log(`[run-tuning] Results written to ${resolvedOutputPath}`);
        } else {
            console.log(resultJson);
        }

        if (best) {
            console.log("\n========== TUNING RESULT ==========");
            console.log(`Iterations evaluated: ${rankedResults.length}`);
            console.log(`Best custom WER (drop1): ${(best.customWER * 100).toFixed(2)}%`);
            console.log(`Best avg WER: ${(best.averageWER * 100).toFixed(2)}%`);
            if (best.droppedImage) {
                console.log(
                    `Dropped image: ${best.droppedImage} (${((best.droppedWER ?? 0) * 100).toFixed(2)}%)`
                );
            }
            for (const [splitName, metrics] of Object.entries(metricsBySplit)) {
                console.log(
                    `Split ${splitName}: WER_mean ${(metrics.werMean * 100).toFixed(2)}% | ` +
                    `WER_drop1 ${(metrics.werDrop1 * 100).toFixed(2)}%`
                );
            }
            console.log("===================================\n");
        } else {
            console.log("[run-tuning] No iteration results produced.");
        }
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error("[run-tuning] Fatal error:", error);
    process.exit(1);
});
