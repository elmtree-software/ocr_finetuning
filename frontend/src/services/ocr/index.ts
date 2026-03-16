/**
 * OCR Service - Single Entry Point
 *
 * Usage:
 *   import { OCRService } from "@/services/ocr";
 *
 *   // Simple usage
 *   const result = await OCRService.recognize(imageBlob);
 *   console.log(result.text);
 *
 *   // With options
 *   const result = await OCRService.recognize(imageBlob, {
 *       languages: ["deu", "eng"],
 *       onProgress: (stage, progress) => console.log(stage, progress),
 *   });
 *
 *   // Configure
 *   OCRService.setConfig({ engine: "paddleocr" });
 */

import type {
    PipelineResult,
    ImageInput,
    ProgressCallback,
    OCRResult,
    EngineType,
    BoundingBox,
} from "./types";
import { getConfig, setConfig, resetConfig, type OCRConfig } from "./config";
import { getEngine, getCurrentEngine, terminateAllEngines } from "./engine";
import { runPipeline } from "./pipeline";
import { unloadLayoutModel } from "./layout";

// =============================================================================
// OCR Service
// =============================================================================

export interface RecognizeOptions {
    languages?: string[];
    onProgress?: ProgressCallback;
}

/**
 * @deprecated Use RecognizeOptions instead
 */
export interface OCROptions {
    languages?: string[];
    onProgress?: (progress: number) => void;
}

export const OCRService = {
    /**
     * Main API: Recognize text in an image.
     *
     * Runs the full pipeline: Rectification → Preprocessing → Layout → OCR
     */
    async recognize(
        image: ImageInput,
        options?: RecognizeOptions
    ): Promise<PipelineResult> {
        return runPipeline(image, options);
    },

    /**
     * Simple OCR without layout detection.
     * Faster but less accurate for complex documents.
     */
    async recognizeSimple(
        image: ImageInput,
        options?: RecognizeOptions
    ): Promise<OCRResult> {
        const engine = await getEngine();
        return engine.recognize(image, {
            languages: options?.languages,
            onProgress: options?.onProgress
                ? (p) => options.onProgress!("ocr", p / 100)
                : undefined,
        });
    },

    /**
     * OCR a specific region of an image.
     */
    async recognizeRegion(
        image: ImageInput,
        region: BoundingBox,
        options?: RecognizeOptions
    ): Promise<OCRResult> {
        const engine = await getEngine();
        return engine.recognizeRegion(image, region, {
            languages: options?.languages,
            onProgress: options?.onProgress
                ? (p) => options.onProgress!("ocr", p / 100)
                : undefined,
        });
    },

    /**
     * Initialize the OCR engine.
     * Called automatically on first use, but can be called explicitly for preloading.
     */
    async init(engineType?: EngineType): Promise<void> {
        await getEngine(engineType);
    },

    /**
     * Check if the OCR engine is ready.
     */
    isReady(): boolean {
        return getCurrentEngine()?.isReady() ?? false;
    },

    /**
     * Unload OCR models to free memory.
     */
    async unload(): Promise<void> {
        await terminateAllEngines();
        unloadLayoutModel();
    },

    /**
     * Get current configuration.
     */
    getConfig(): Readonly<OCRConfig> {
        return getConfig();
    },

    /**
     * Update configuration.
     */
    setConfig(partial: Parameters<typeof setConfig>[0]): void {
        setConfig(partial);
    },

    /**
     * Reset configuration to defaults.
     */
    resetConfig(): void {
        resetConfig();
    },
};

// =============================================================================
// Compatibility Aliases
// =============================================================================

/**
 * @deprecated Use OCRService.recognize() instead
 */
export async function recognizeWithLayout(
    image: ImageInput | Blob,
    options?: { onProgress?: (stage: string, progress: number) => void; languages?: string[] }
): Promise<PipelineResult> {
    return OCRService.recognize(image, options);
}

/**
 * @deprecated Use OCRService.recognize() instead
 */
export async function runLayoutOCR(
    image: ImageInput | Blob,
    options?: { onProgress?: (stage: string, progress: number) => void; languages?: string[] }
): Promise<PipelineResult> {
    return OCRService.recognize(image, options);
}

/**
 * @deprecated Use OCRService.recognizeSimple() instead
 */
export async function runSimpleOCR(
    image: ImageInput | Blob,
    options?: { onProgress?: (progress: number) => void; languages?: string[] }
): Promise<{ text: string; confidence: number }> {
    const result = await OCRService.recognizeSimple(image, {
        languages: options?.languages,
    });
    return { text: result.text, confidence: result.confidence };
}

/**
 * @deprecated Use OCRService.recognizeSimple() instead
 */
export async function recognizeText(
    image: ImageInput | Blob,
    options?: { onProgress?: (progress: number) => void; languages?: string[] }
): Promise<OCRResult> {
    return OCRService.recognizeSimple(image, {
        languages: options?.languages,
    });
}

/**
 * @deprecated Use OCRService.init() instead
 */
export async function initOCR(languages?: string[]): Promise<void> {
    await OCRService.init();
}

/**
 * @deprecated Use OCRService.unload() instead
 */
export async function unloadOCR(): Promise<void> {
    await OCRService.unload();
}

/**
 * @deprecated Use result.text directly
 */
export function extractFullText(results: OCRResult[] | OCRResult | PipelineResult): string {
    if (Array.isArray(results)) return results.map((r) => r.text).join("\n");
    return (results as any).text ?? "";
}


// =============================================================================
// Re-exports
// =============================================================================

export type {
    // Types
    PipelineResult,
    OCRResult,
    OCRLine,
    OCRWord,
    BoundingBox,
    LayoutResult,
    LayoutRegion,
    LayoutLabel,
    RegionOCRResult,
    TableResult,
    TableCell,
    RectificationResult,
    DocumentCorners,
    Point2D,
    ImageInput,
    ProgressCallback,
    EngineType,
    EngineOptions,
    EngineCapabilities,
    PreprocessingResult,
    PipelineTimings,
} from "./types";

export { LAYOUT_LABELS } from "./types";

export type { OCRConfig } from "./config";
export { getConfig, setConfig, resetConfig, DEFAULT_CONFIG, MODEL_PATHS } from "./config";

export type { OCREngine } from "./engine";
export { getEngine, terminateAllEngines } from "./engine";

export { loadOpenCV, isOpenCVLoaded } from "./opencv-loader";
export { matToImageData } from "./opencv-utils";
export { rectify } from "./rectification";
export { preprocess, ensureMinDPI, detectAndFixInversion } from "./preprocessing";
export {
    detectLayout,
    loadLayoutModel,
    unloadLayoutModel,
    isLayoutModelLoaded,
    getTextRegions,
    getTableRegions,
    findUncoveredAreas,
} from "./layout";

export { runPipeline } from "./pipeline";

// Default export
export default OCRService;
