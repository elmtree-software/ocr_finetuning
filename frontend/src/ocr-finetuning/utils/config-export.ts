/**
 * Config Export Utilities
 *
 * Generates TypeScript configuration files from tuning results.
 */

import type {
    ParameterPermutation,
    ParameterValue,
    ExportMetadata,
    PartialOCRConfig,
    ImageScore,
} from "../types/tuning";
import { DEFAULT_CONFIG, type OCRConfig } from "@/services/ocr/config";

type ReadonlyParameterPermutation = readonly { readonly path: string; readonly value: string | number | boolean }[];
type ReadonlyImageScores = readonly {
    readonly filename: string;
    readonly ocrText: string;
    readonly groundTruth: string;
    readonly cer: number;
    readonly wer: number;
    readonly regionScores?: readonly {
        readonly id: string;
        readonly label: string;
        readonly weight: number;
        readonly ocrText: string;
        readonly groundTruth: string;
        readonly cer: number;
        readonly wer: number;
    }[];
}[];

/**
 * Convert a parameter permutation to a partial OCR config object.
 */
export function permutationToConfig(
    permutation: ParameterPermutation | ReadonlyParameterPermutation
): PartialOCRConfig {
    const config: Record<string, unknown> = {};

    for (const { path, value } of permutation) {
        setNestedValue(config, path, value);
    }

    return config as PartialOCRConfig;
}

/**
 * Set a nested value using dot notation path.
 */
function setNestedValue(
    obj: Record<string, unknown>,
    path: string,
    value: unknown
): void {
    const keys = path.split(".");
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!(key in current) || typeof current[key] !== "object") {
            current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
    }

    current[keys[keys.length - 1]] = value;
}

/**
 * Format a JavaScript value for TypeScript output.
 */
function formatValue(value: unknown, indent: number = 0): string {
    const spaces = "    ".repeat(indent);

    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return `"${value}"`;
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return String(value);

    if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        const items = value.map((v) => formatValue(v, indent + 1));
        return `[\n${spaces}    ${items.join(`,\n${spaces}    `)}\n${spaces}]`;
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return "{}";

        const formatted = entries.map(([k, v]) => {
            const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : `"${k}"`;
            return `${spaces}    ${key}: ${formatValue(v, indent + 1)}`;
        });

        return `{\n${formatted.join(",\n")}\n${spaces}}`;
    }

    return String(value);
}

/**
 * Apply parameter permutation to a deep clone of DEFAULT_CONFIG.
 */
function applyPermutationToConfig(
    permutation: ParameterPermutation | ReadonlyParameterPermutation
): OCRConfig {
    const config = structuredClone(DEFAULT_CONFIG);

    for (const { path, value } of permutation) {
        setNestedValue(config as unknown as Record<string, unknown>, path, value);
    }

    return config;
}

/**
 * Generate TypeScript config file content from tuning result.
 * Uses the full DEFAULT_CONFIG format for copy-paste compatibility.
 */
export function generateConfigExport(
    permutation: ParameterPermutation | ReadonlyParameterPermutation,
    metadata: ExportMetadata,
    imageScores?: ReadonlyImageScores
): string {
    const config = applyPermutationToConfig(permutation);

    let output = `// OCR Finetuning Result
// Images: ${metadata.images.join(", ")}
// CER: ${(metadata.cer * 100).toFixed(2)}%, WER: ${(metadata.wer * 100).toFixed(2)}%
// Date: ${metadata.date}
//
// This config can be copy-pasted into frontend/src/services/ocr/config.ts

import type { OCRConfig } from "./types";

export const TUNED_CONFIG: OCRConfig = {
    // --- Engine Selection ---
    engine: "${config.engine}",

    paddleocr: {
        version: "${config.paddleocr.version}",
        language: "${config.paddleocr.language}",
        useWebGPU: ${config.paddleocr.useWebGPU},
        detThreshold: ${config.paddleocr.detThreshold},
        boxThreshold: ${config.paddleocr.boxThreshold},
        detInputSize: ${config.paddleocr.detInputSize},
        recInputHeight: ${config.paddleocr.recInputHeight},
        unclipRatio: ${config.paddleocr.unclipRatio},
        regionPadding: ${config.paddleocr.regionPadding},
    },

    rectification: {
        enabled: ${config.rectification.enabled},
        minContourConfidence: ${config.rectification.minContourConfidence},
        minDocumentArea: ${config.rectification.minDocumentArea},
        cannyLow: ${config.rectification.cannyLow},
        cannyHigh: ${config.rectification.cannyHigh},
        blurSize: ${config.rectification.blurSize},
        useAdaptiveThreshold: ${config.rectification.useAdaptiveThreshold},
    },

    preprocessing: {
        enabled: ${config.preprocessing.enabled},
        grayscale: ${config.preprocessing.grayscale},
        contrastBoost: ${config.preprocessing.contrastBoost},
        dpiScaling: {
            enabled: ${config.preprocessing.dpiScaling.enabled},
            minCapitalHeightPx: ${config.preprocessing.dpiScaling.minCapitalHeightPx},
            maxScale: ${config.preprocessing.dpiScaling.maxScale},
        },
        inversionDetection: {
            enabled: ${config.preprocessing.inversionDetection.enabled},
            brightnessThreshold: ${config.preprocessing.inversionDetection.brightnessThreshold},
        },
        clahe: {
            enabled: ${config.preprocessing.clahe.enabled},
            clipLimit: ${config.preprocessing.clahe.clipLimit},
            tileSize: ${config.preprocessing.clahe.tileSize},
        },
        bilateralFilter: {
            enabled: ${config.preprocessing.bilateralFilter.enabled},
            diameter: ${config.preprocessing.bilateralFilter.diameter},
            sigmaColor: ${config.preprocessing.bilateralFilter.sigmaColor},
            sigmaSpace: ${config.preprocessing.bilateralFilter.sigmaSpace},
        },
        threshold: {
            enabled: ${config.preprocessing.threshold.enabled},
            type: "${config.preprocessing.threshold.type}",
            value: ${config.preprocessing.threshold.value},
        },
    },

    layout: {
        enabled: ${config.layout.enabled},
        detectionThreshold: ${config.layout.detectionThreshold},
        regionPadding: ${config.layout.regionPadding},
        internalPadding: ${config.layout.internalPadding},
        textRegionTypes: ${JSON.stringify(config.layout.textRegionTypes)},
        psmModes: {
            default: ${config.layout.psmModes.default},
            regionOverrides: ${JSON.stringify(config.layout.psmModes.regionOverrides)},
        },
        nms: {
            iouThreshold: ${config.layout.nms.iouThreshold},
            containmentThreshold: ${config.layout.nms.containmentThreshold},
        },
        xyCut: {
            enabled: ${config.layout.xyCut.enabled},
            minGapThreshold: ${config.layout.xyCut.minGapThreshold},
            spanningThreshold: ${config.layout.xyCut.spanningThreshold},
            maxDepth: ${config.layout.xyCut.maxDepth},
        },
    },

    rotation: {
        enabled: ${config.rotation.enabled},
        fastMode: ${config.rotation.fastMode},
        skipThreshold: ${config.rotation.skipThreshold},
        minImprovement: ${config.rotation.minImprovement},
        angleStep: ${config.rotation.angleStep},
    },

    fallback: {
        enabled: ${config.fallback.enabled},
        gridSize: ${config.fallback.gridSize},
        minAreaRatio: ${config.fallback.minAreaRatio},
        minConfidence: ${config.fallback.minConfidence},
    },

    table: {
        enabled: ${config.table.enabled},
        outputFormat: "${config.table.outputFormat}",
        rowClusterTolerance: ${config.table.rowClusterTolerance},
        colClusterTolerance: ${config.table.colClusterTolerance},
    },

    output: {
        minTextLength: ${config.output.minTextLength},
        minLineConfidence: ${config.output.minLineConfidence},
        minWordConfidence: ${config.output.minWordConfidence},
    },

    debug: {
        logTiming: ${config.debug.logTiming},
        verbose: ${config.debug.verbose},
    },
};
`;

    // Add OCR results if provided
    if (imageScores && imageScores.length > 0) {
        output += `
// =============================================================================
// OCR Results
// =============================================================================

`;
        for (const score of imageScores) {
            output += `/*
 * Image: ${score.filename}
 * CER: ${(score.cer * 100).toFixed(2)}%, WER: ${(score.wer * 100).toFixed(2)}%
 *
 * Ground Truth:
 * ${score.groundTruth.split('\n').join('\n * ')}
 *
 * OCR Output:
 * ${score.ocrText.split('\n').join('\n * ')}
 */

`;
        }
    }

    return output;
}

/**
 * Generate TypeScript export of all results as copyable chunks.
 */
export function generateAllResultsTs(
    results: ReadonlyArray<{
        readonly id: number;
        readonly parameters: ReadonlyParameterPermutation;
        readonly averageCER: number;
        readonly averageWER: number;
        readonly combinedScore: number;
        readonly imageScores: ReadonlyImageScores;
    }>,
    images: readonly string[]
): string {
    const date = new Date().toISOString().replace("T", " ").slice(0, 19);

    let output = `// OCR Finetuning Results - All Iterations
// Images: ${images.join(", ")}
// Date: ${date}
// Total: ${results.length} iterations
//
// Each section contains the full config that can be copy-pasted.

`;

    for (const result of results) {
        output += generateConfigExport(
            result.parameters,
            {
                images,
                cer: result.averageCER,
                wer: result.averageWER,
                date,
            },
            result.imageScores
        );

        output += `\n// ${"=".repeat(77)}\n// END OF CONFIG #${result.id + 1}\n// ${"=".repeat(77)}\n\n`;
    }

    return output;
}

/**
 * Generate a timestamp string for filenames.
 */
export function generateTimestamp(): string {
    const now = new Date();
    return now
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
}

/**
 * Generate a safe filename from image names.
 */
export function generateFilename(imageNames: readonly string[], suffix: string): string {
    // Take first image name, remove extension, sanitize
    const baseName = imageNames[0]
        ?.replace(/\.[^.]+$/, "")
        ?.replace(/[^a-zA-Z0-9_-]/g, "_")
        ?? "tuning";

    const timestamp = generateTimestamp();
    return `${baseName}_${timestamp}_${suffix}`;
}
