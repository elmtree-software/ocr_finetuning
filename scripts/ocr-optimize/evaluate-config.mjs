#!/usr/bin/env node
/**
 * Evaluate fixed OCR configurations (A/B/C) across splits.
 *
 * This script orchestrates `run-tuning.mjs` in single-iteration mode
 * (`iterateParams = {}`), so each candidate config is evaluated consistently
 * and reported with split metrics (`WER_mean`, `WER_drop1`, `CER_mean`).
 *
 * Usage:
 *   node scripts/ocr-optimize/evaluate-config.mjs <config.json> [output.json]
 *
 * Config schema:
 * {
 *   "baseConfig": { ...optional global base config... },
 *   "imagesDir": "./ocr_trainingdata/sel_gt",
 *   "splitManifest": "./ocr_optimization/configs/run3_split_manifest.json",
 *   "tuneSplit": "train",
 *   "scoringMode": "customWER",
 *   "appUrl": "http://localhost:5173/ocr_finetuning.html",
 *   "rankSplit": "test",
 *   "configs": [
 *     {
 *       "id": "A_run2_best",
 *       "label": "Run2 Best",
 *       "baseConfig": { ...optional override... },
 *       "parameters": [
 *         { "path": "layout.regionPadding", "value": 14 }
 *       ]
 *     }
 *   ]
 * }
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUN_TUNING_SCRIPT = path.resolve(__dirname, "run-tuning.mjs");
const DEFAULT_OUTPUT = path.resolve(
    __dirname,
    "../../ocr_optimization/iterations/evaluate-config-result.json"
);

function usage(exitCode = 1) {
    console.error(
        "Usage: node scripts/ocr-optimize/evaluate-config.mjs <config.json> [output.json]"
    );
    process.exit(exitCode);
}

function setNestedValue(target, dotPath, value) {
    const keys = String(dotPath).split(".");
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

function mergeConfigs(base, overlay) {
    const result = JSON.parse(JSON.stringify(base || {}));
    const src = overlay || {};
    for (const [key, value] of Object.entries(src)) {
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            result[key] &&
            typeof result[key] === "object" &&
            !Array.isArray(result[key])
        ) {
            result[key] = mergeConfigs(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

function normalizeParameters(parameters) {
    if (!parameters) return [];
    if (Array.isArray(parameters)) {
        return parameters
            .filter((item) => item && typeof item.path === "string")
            .map((item) => ({ path: item.path, value: item.value }));
    }
    if (typeof parameters === "object") {
        return Object.entries(parameters).map(([path, value]) => ({ path, value }));
    }
    return [];
}

function applyParameterList(baseConfig, parameters) {
    const merged = JSON.parse(JSON.stringify(baseConfig || {}));
    for (const parameter of parameters) {
        setNestedValue(merged, parameter.path, parameter.value);
    }
    return merged;
}

function pickPrimarySplit(metricsBySplit, preferredSplit) {
    if (preferredSplit && metricsBySplit[preferredSplit]) return preferredSplit;
    if (metricsBySplit.test) return "test";
    if (metricsBySplit.val) return "val";
    if (metricsBySplit.train) return "train";
    if (metricsBySplit.all) return "all";
    const fallback = Object.keys(metricsBySplit);
    return fallback.length > 0 ? fallback[0] : null;
}

function runSingleCandidate({
    candidate,
    globalBaseConfig,
    sharedConfig,
    tempDir,
}) {
    const id = candidate.id || candidate.label;
    if (!id) {
        throw new Error("Each candidate config needs at least 'id' or 'label'");
    }

    const candidateBase = mergeConfigs(globalBaseConfig, candidate.baseConfig || {});
    const parameterList = normalizeParameters(candidate.parameters || candidate.parameterOverrides);
    const mergedBaseConfig = applyParameterList(candidateBase, parameterList);

    const tempConfigPath = path.join(tempDir, `${id}.config.json`);
    const tempOutputPath = path.join(tempDir, `${id}.result.json`);

    const runTuningConfig = {
        baseConfig: mergedBaseConfig,
        iterateParams: {},
        optimizer: { iterations: 1, initialSamples: 1, candidateSamples: 50 },
        scoringMode: sharedConfig.scoringMode,
        imagesDir: sharedConfig.imagesDir,
        splitManifest: sharedConfig.splitManifest,
        tuneSplit: sharedConfig.tuneSplit,
        appUrl: sharedConfig.appUrl,
    };

    fs.writeFileSync(tempConfigPath, JSON.stringify(runTuningConfig, null, 2), "utf-8");

    const proc = spawnSync(
        process.execPath,
        [RUN_TUNING_SCRIPT, tempConfigPath, tempOutputPath],
        { encoding: "utf-8", stdio: "pipe" }
    );

    if (proc.status !== 0) {
        const stdout = proc.stdout || "";
        const stderr = proc.stderr || "";
        throw new Error(
            `Candidate '${id}' failed (exit ${proc.status}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
    }

    const result = JSON.parse(fs.readFileSync(tempOutputPath, "utf-8"));
    return {
        id,
        label: candidate.label || id,
        notes: candidate.notes || null,
        parameterList,
        runConfigPath: tempConfigPath,
        runResultPath: tempOutputPath,
        result,
    };
}

function main() {
    const configPath = process.argv[2];
    const outputPath = process.argv[3]
        ? path.resolve(process.argv[3])
        : DEFAULT_OUTPUT;

    if (!configPath) usage(1);

    const resolvedConfigPath = path.resolve(configPath);
    const config = JSON.parse(fs.readFileSync(resolvedConfigPath, "utf-8"));

    if (!Array.isArray(config.configs) || config.configs.length === 0) {
        throw new Error("Config must contain a non-empty 'configs' array.");
    }

    const sharedConfig = {
        imagesDir: config.imagesDir || "./ocr_trainingdata/sel_gt",
        splitManifest: config.splitManifest || null,
        tuneSplit: config.tuneSplit || "train",
        scoringMode: config.scoringMode || "customWER",
        appUrl: config.appUrl || "http://localhost:5173/ocr_finetuning.html",
        rankSplit: config.rankSplit || "test",
    };

    const globalBaseConfig = config.baseConfig || {};
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-evaluate-config-"));

    try {
        const candidateRuns = [];
        for (const candidate of config.configs) {
            const id = candidate.id || candidate.label || "unnamed";
            console.log(`[evaluate-config] Running candidate: ${id}`);
            const run = runSingleCandidate({
                candidate,
                globalBaseConfig,
                sharedConfig,
                tempDir,
            });
            candidateRuns.push(run);
        }

        const summarized = candidateRuns.map((run) => {
            const metricsBySplit = run.result.metricsBySplit || {};
            const primarySplit = pickPrimarySplit(metricsBySplit, sharedConfig.rankSplit);
            const primaryWerMean =
                primarySplit && metricsBySplit[primarySplit]
                    ? metricsBySplit[primarySplit].werMean
                    : Number.POSITIVE_INFINITY;

            return {
                id: run.id,
                label: run.label,
                notes: run.notes,
                parameters: run.parameterList,
                status: run.result.status,
                tuneSplit: run.result.tuneSplit,
                splitCounts: run.result.splitCounts,
                metricsBySplit,
                best: run.result.best,
                primarySplit,
                primaryWerMean,
            };
        });

        const ranking = [...summarized]
            .sort((a, b) => a.primaryWerMean - b.primaryWerMean)
            .map((item, index) => ({
                rank: index + 1,
                id: item.id,
                label: item.label,
                primarySplit: item.primarySplit,
                werMean: item.primaryWerMean,
            }));

        const output = {
            runTimestamp: new Date().toISOString(),
            configFile: resolvedConfigPath,
            rankSplit: sharedConfig.rankSplit,
            sharedConfig: {
                imagesDir: sharedConfig.imagesDir,
                splitManifest: sharedConfig.splitManifest,
                tuneSplit: sharedConfig.tuneSplit,
                scoringMode: sharedConfig.scoringMode,
                appUrl: sharedConfig.appUrl,
            },
            ranking,
            candidates: summarized,
        };

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
        console.log(`[evaluate-config] Results written to ${outputPath}`);

        console.log("\n========== EVALUATION RANKING ==========");
        for (const row of ranking) {
            const metric = Number.isFinite(row.werMean)
                ? `${(row.werMean * 100).toFixed(2)}%`
                : "n/a";
            console.log(
                `${String(row.rank).padStart(2, " ")}. ${row.id} (${row.primarySplit ?? "n/a"}): ${metric}`
            );
        }
        console.log("========================================\n");
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error("[evaluate-config] Fatal error:", error);
    process.exit(1);
}
