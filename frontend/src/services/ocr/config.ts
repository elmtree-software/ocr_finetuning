/**
 * OCR Configuration
 *
 * Unified configuration for the entire OCR pipeline.
 * Replaces the old 50+ feature flags spread across multiple files.
 */

import type { EngineType } from "./types";

// =============================================================================
// Configuration Interface
// =============================================================================

export interface OCRConfig {
    // --- Engine Selection ---
    engine: EngineType;

    // --- PaddleOCR Settings ---
    paddleocr: {
        version: "v5" | "v3";
        language: "german" | "latin" | "english";
        useWebGPU: boolean;
        detThreshold: number;
        boxThreshold: number;
        detInputSize?: number;
        /** How to apply detInputSize limit: "max" limits longest side, "min" limits shortest side */
        limitType?: "max" | "min";
        recInputHeight?: number;
        unclipRatio?: number;
        /** Padding around extracted text regions (pixels) */
        regionPadding?: number;
    };

    // --- Rectification ---
    rectification: {
        enabled: boolean;
        minContourConfidence: number;
        minDocumentArea: number;
        cannyLow: number;
        cannyHigh: number;
        blurSize: number;
        useAdaptiveThreshold?: boolean;
    };

    // --- Preprocessing ---
    preprocessing: {
        enabled: boolean;
        grayscale: boolean;
        contrastBoost: number;
        dpiScaling: {
            enabled: boolean;
            minCapitalHeightPx: number;
            maxScale: number;
        };
        inversionDetection: {
            enabled: boolean;
            brightnessThreshold: number;
        };
        clahe: {
            enabled: boolean;
            clipLimit: number;
            tileSize: number;
        };
        bilateralFilter: {
            enabled: boolean;
            diameter: number;
            sigmaColor: number;
            sigmaSpace: number;
        };
        threshold: {
            enabled: boolean;
            type: "otsu" | "binary" | "adaptive";
            value: number;
        };
    };

    // --- Layout Detection ---
    layout: {
        enabled: boolean;
        detectionThreshold: number;
        regionPadding: number;
        internalPadding: number;
        textRegionTypes: readonly string[];
        psmModes: {
            default: number;
            regionOverrides: Partial<Record<string, number>>;
        };
        nms: {
            iouThreshold: number;
            containmentThreshold: number;
        };
        xyCut: {
            enabled: boolean;
            minGapThreshold: number;
            spanningThreshold: number;
            maxDepth: number;
        };
    };

    // --- Rotation Detection ---
    rotation: {
        enabled: boolean;
        fastMode: boolean;
        skipThreshold: number;
        minImprovement: number;
        angleStep?: number;
    };

    // --- Fallback OCR ---
    fallback: {
        enabled: boolean;
        gridSize: number;
        minAreaRatio: number;
        minConfidence: number;
    };

    // --- Table Processing ---
    table: {
        enabled: boolean;
        outputFormat: "markdown" | "tsv" | "text";
        rowClusterTolerance: number;
        colClusterTolerance: number;
    };

    // --- Output Filtering ---
    output: {
        minTextLength: number;
        minLineConfidence: number;
        minWordConfidence: number;
    };

    // --- Debug ---
    debug: {
        logTiming: boolean;
        verbose: boolean;
    };
}

// =============================================================================
// Default Configuration — Run 1 (alt, Custom WER 47.28%, 10 Bilder)
// =============================================================================
// export const DEFAULT_CONFIG_RUN1: OCRConfig = {
//     engine: "paddleocr",
//     paddleocr: {
//         version: "v5",
//         language: "german",
//         useWebGPU: true,
//         detThreshold: 0.3,
//         boxThreshold: 0.55,
//         detInputSize: 960,
//         limitType: "max",
//         recInputHeight: 48,
//         unclipRatio: 1.9,
//         regionPadding: 4,
//     },
//     rectification: {
//         enabled: true,
//         minContourConfidence: 0.8,
//         minDocumentArea: 0.475,
//         cannyLow: 162.5,
//         cannyHigh: 87.5,
//         blurSize: 1,
//         useAdaptiveThreshold: true,
//     },
//     preprocessing: {
//         enabled: true,
//         grayscale: true,
//         contrastBoost: 1.2,
//         dpiScaling: {
//             enabled: true,
//             minCapitalHeightPx: 35,
//             maxScale: 2.5,
//         },
//         inversionDetection: {
//             enabled: true,
//             brightnessThreshold: 106.667,
//         },
//         clahe: {
//             enabled: true,
//             clipLimit: 0.5,
//             tileSize: 24,
//         },
//         bilateralFilter: {
//             enabled: false,
//             diameter: 5,
//             sigmaColor: 75,
//             sigmaSpace: 75,
//         },
//         threshold: {
//             enabled: false,
//             type: "otsu",
//             value: 128,
//         },
//     },
//     layout: {
//         enabled: true,
//         detectionThreshold: 0.1,
//         regionPadding: 20,
//         internalPadding: 5,
//         textRegionTypes: [ "Text", "Title", "Section-header", "Caption", "List-item", "Page-header", "Page-footer", "Footnote", "Table" ],
//         psmModes: {
//             default: 6,
//             regionOverrides: { "Caption": 7, "Footnote": 7, "Page-header": 7, "Page-footer": 7 },
//         },
//         nms: { iouThreshold: 0.6, containmentThreshold: 0.3 },
//         xyCut: { enabled: true, minGapThreshold: 30, spanningThreshold: 0.7, maxDepth: 14 },
//     },
//     rotation: { enabled: true, fastMode: true, skipThreshold: 65, minImprovement: 3, angleStep: 90 },
//     fallback: { enabled: true, gridSize: 120, minAreaRatio: 0.053, minConfidence: 0.4 },
//     table: { enabled: false, outputFormat: "markdown", rowClusterTolerance: 15, colClusterTolerance: 30 },
//     output: { minTextLength: 1, minLineConfidence: 0.6, minWordConfidence: 0.15 },
//     debug: { logTiming: true, verbose: true },
// };

// =============================================================================
// Default Configuration — Run 2 (aktiv, Custom WER 34.85%, 7 Bilder)
// =============================================================================

export const DEFAULT_CONFIG: OCRConfig = {
    // --- Engine Selection ---
    engine: "paddleocr",

    paddleocr: {
        version: "v5",
        language: "german",
        useWebGPU: true,
        detThreshold: 0.3,
        boxThreshold: 0.55,
        detInputSize: 960,
        limitType: "max",
        recInputHeight: 48,
        unclipRatio: 1.9,
        regionPadding: 4,
    },

    rectification: {
        enabled: true,
        minContourConfidence: 0.8,
        minDocumentArea: 0.475,
        cannyLow: 195.5,            // Run 1: 162.5 — Phase 2B
        cannyHigh: 96.333,          // Run 1: 87.5  — Phase 2B
        blurSize: 1,
        useAdaptiveThreshold: true,
    },

    preprocessing: {
        enabled: true,
        grayscale: true,
        contrastBoost: 1.149,       // Run 1: 1.2   — Phase 2A
        dpiScaling: {
            enabled: true,
            minCapitalHeightPx: 46,  // Run 1: 35    — Phase 2A
            maxScale: 3.25,          // Run 1: 2.5   — Phase 2A
        },
        inversionDetection: {
            enabled: true,
            brightnessThreshold: 106.667,
        },
        clahe: {
            enabled: true,
            clipLimit: 0.5,
            tileSize: 32,            // Run 1: 24    — Phase 2A
        },
        bilateralFilter: {
            enabled: false,
            diameter: 5,
            sigmaColor: 75,
            sigmaSpace: 75,
        },
        threshold: {
            enabled: false,
            type: "otsu",
            value: 128,
        },
    },

    layout: {
        enabled: true,
        detectionThreshold: 0.175,   // Run 1: 0.1   — Phase 2B
        regionPadding: 14,           // Run 1: 20    — Phase 2B
        internalPadding: 4,          // Run 1: 5     — Phase 2B
        textRegionTypes: [
            "Text",
            "Title",
            "Section-header",
            "Caption",
            "List-item",
            "Page-header",
            "Page-footer",
            "Footnote",
            "Table",
        ],
        psmModes: {
            default: 6,
            regionOverrides: {
                "Caption": 3,        // Run 1: 7     — Phase 1B (FULLY_AUTO)
                "Footnote": 3,       // Run 1: 7     — Phase 1B (FULLY_AUTO)
                "Page-header": 11,   // Run 1: 7     — Phase 1B (SPARSE_TEXT)
                "Page-footer": 7,
            },
        },
        nms: {
            iouThreshold: 0.6,
            containmentThreshold: 0.3,
        },
        xyCut: {
            enabled: true,
            minGapThreshold: 30,
            spanningThreshold: 0.7,
            maxDepth: 14,
        },
    },

    rotation: {
        enabled: true,
        fastMode: true,
        skipThreshold: 65,
        minImprovement: 3,
        angleStep: 90,
    },

    fallback: {
        enabled: true,
        gridSize: 120,
        minAreaRatio: 0.053,
        minConfidence: 0.4,
    },

    table: {
        enabled: false,
        outputFormat: "markdown",
        rowClusterTolerance: 15,
        colClusterTolerance: 30,
    },

    output: {
        minTextLength: 1,
        minLineConfidence: 0.6,
        minWordConfidence: 0.45,     // Run 1: 0.15  — Phase 1B
    },

    debug: {
        logTiming: true,
        verbose: true,
    },
};

// =============================================================================
// Configuration State
// =============================================================================

type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

let currentConfig: OCRConfig = structuredClone(DEFAULT_CONFIG);

function deepMerge<T extends object>(target: T, source: DeepPartial<T>): T {
    const result = structuredClone(target);

    for (const key of Object.keys(source) as Array<keyof T>) {
        const sourceValue = source[key];
        if (sourceValue === undefined) continue;

        if (
            typeof sourceValue === "object" &&
            sourceValue !== null &&
            !Array.isArray(sourceValue) &&
            typeof result[key] === "object" &&
            result[key] !== null
        ) {
            result[key] = deepMerge(
                result[key] as object,
                sourceValue as object
            ) as T[keyof T];
        } else {
            result[key] = sourceValue as T[keyof T];
        }
    }

    return result;
}

// =============================================================================
// Public API
// =============================================================================

export function getConfig(): Readonly<OCRConfig> {
    return currentConfig;
}

export function setConfig(partial: DeepPartial<OCRConfig>): void {
    currentConfig = deepMerge(currentConfig, partial);

    if (currentConfig.debug.verbose) {
        console.log("[OCR] Config updated:", currentConfig);
    }
}

export function resetConfig(): void {
    currentConfig = structuredClone(DEFAULT_CONFIG);
    console.log("[OCR] Config reset to defaults");
}

// =============================================================================
// Model URLs
// =============================================================================

const MODEL_SERVER_URL =
    (typeof import.meta !== "undefined" && import.meta.env?.VITE_MODEL_SERVER_URL) ||
    "http://127.0.0.1:8767";

export const MODEL_PATHS = {
    opencv: `${MODEL_SERVER_URL}/models/opencv/opencv.js`,

    paddleocr: {
        base: `${MODEL_SERVER_URL}/models/paddleocr-onnx`,
        detectionV5: `${MODEL_SERVER_URL}/models/paddleocr-onnx/det_v5.onnx`,
        detectionV3: `${MODEL_SERVER_URL}/models/paddleocr-onnx/det_v3.onnx`,
        recognition: {
            latin: `${MODEL_SERVER_URL}/models/paddleocr-onnx/rec_latin.onnx`,
            german: `${MODEL_SERVER_URL}/models/paddleocr-onnx/rec_latin.onnx`,
            english: `${MODEL_SERVER_URL}/models/paddleocr-onnx/rec_english.onnx`,
        },
        dictionary: {
            latin: `${MODEL_SERVER_URL}/models/paddleocr-onnx/dict_latin.txt`,
            german: `${MODEL_SERVER_URL}/models/paddleocr-onnx/dict_latin.txt`,
            english: `${MODEL_SERVER_URL}/models/paddleocr-onnx/dict_english.txt`,
        },
    },

    tesseract: {
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract/core",
        langPath: "/tesseract/lang",
    },

    layout: {
        modelId: "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis",
    },
} as const;

// =============================================================================
// Browser Console API
// =============================================================================

if (typeof window !== "undefined") {
    (window as any).__OCR__ = {
        get: getConfig,
        set: setConfig,
        reset: resetConfig,
        defaults: () => structuredClone(DEFAULT_CONFIG),
        presets: {
            paddleV5: () =>
                setConfig({
                    engine: "paddleocr",
                    paddleocr: { version: "v5", useWebGPU: true },
                    debug: { logTiming: true },
                }),
            paddleV3: () =>
                setConfig({
                    engine: "paddleocr",
                    paddleocr: { version: "v3", useWebGPU: true },
                    debug: { logTiming: true },
                }),
            debug: () =>
                setConfig({
                    debug: { logTiming: true, verbose: true },
                }),
            photoMode: () =>
                setConfig({
                    rectification: { enabled: true },
                    preprocessing: { clahe: { enabled: true } },
                }),
            fastMode: () =>
                setConfig({
                    engine: "paddleocr",
                    paddleocr: { version: "v3" },
                    layout: { enabled: false },
                    rotation: { fastMode: true },
                    fallback: { enabled: false },
                }),
        },
        help: () => {
            console.log(`
OCR Configuration API
=====================

Get current config:
  __OCR__.get()

Update config:
  __OCR__.set({ engine: 'paddleocr' })
  __OCR__.set({ paddleocr: { version: 'v5' } })
  __OCR__.set({ rectification: { enabled: true } })

Reset to defaults:
  __OCR__.reset()

Quick presets:
  __OCR__.presets.paddleV5()  - PaddleOCR V5 (best accuracy)
  __OCR__.presets.paddleV3()  - PaddleOCR V3 (lightweight)
  __OCR__.presets.debug()     - Enable debug logging
  __OCR__.presets.photoMode() - For phone photos
  __OCR__.presets.fastMode()  - Speed over accuracy
            `.trim());
        },
    };

    console.log("[OCR] Config available. Type __OCR__.help() for usage.");
}
