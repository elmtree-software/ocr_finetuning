/**
 * OCR Engine Interface and Factory
 *
 * Defines the contract for OCR engines and provides a factory
 * for creating engine instances based on configuration.
 */

import type {
    OCRResult,
    BoundingBox,
    EngineOptions,
    EngineCapabilities,
    ImageInput,
    EngineType,
} from "./types";
import { getConfig } from "./config";

// =============================================================================
// Engine Interface
// =============================================================================

export interface OCREngine {
    readonly name: EngineType;

    init(): Promise<void>;
    isReady(): boolean;

    recognize(image: ImageInput, options?: EngineOptions): Promise<OCRResult>;

    recognizeRegion(
        image: ImageInput,
        region: BoundingBox,
        options?: EngineOptions
    ): Promise<OCRResult>;

    getCapabilities(): EngineCapabilities;

    unload(): Promise<void>;
    terminate(): void;
}

// =============================================================================
// Engine Singleton Management
// =============================================================================

let tesseractEngine: OCREngine | null = null;
let paddleEngine: OCREngine | null = null;

export async function getEngine(type?: EngineType): Promise<OCREngine> {
    const engineType = type ?? getConfig().engine;

    if (engineType === "tesseract") {
        if (!tesseractEngine) {
            const { TesseractEngine } = await import("./tesseract-engine");
            tesseractEngine = new TesseractEngine();
        }
        if (!tesseractEngine.isReady()) {
            await tesseractEngine.init();
        }
        return tesseractEngine;
    }

    if (engineType === "paddleocr") {
        if (!paddleEngine) {
            const { PaddleOCREngine } = await import("./paddle-engine");
            paddleEngine = new PaddleOCREngine();
        }
        if (!paddleEngine.isReady()) {
            await paddleEngine.init();
        }
        return paddleEngine;
    }

    throw new Error(`Unknown engine type: ${engineType}`);
}

export function getCurrentEngine(): OCREngine | null {
    const engineType = getConfig().engine;
    return engineType === "tesseract" ? tesseractEngine : paddleEngine;
}

export async function switchEngine(type: EngineType): Promise<OCREngine> {
    const current = getCurrentEngine();
    if (current && current.name !== type) {
        await current.unload();
    }
    return getEngine(type);
}

export async function terminateAllEngines(): Promise<void> {
    if (tesseractEngine) {
        tesseractEngine.terminate();
        tesseractEngine = null;
    }
    if (paddleEngine) {
        paddleEngine.terminate();
        paddleEngine = null;
    }
}

// =============================================================================
// Image Utilities
// =============================================================================

export async function toImageData(image: ImageInput): Promise<ImageData> {
    if (image instanceof ImageData) {
        return image;
    }

    let canvas: OffscreenCanvas;
    let ctx: OffscreenCanvasRenderingContext2D;

    if (image instanceof Blob) {
        const bitmap = await createImageBitmap(image);
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
    } else {
        canvas = new OffscreenCanvas(image.width, image.height);
        ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
    }

    return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export async function toBlob(image: ImageInput): Promise<Blob> {
    if (image instanceof Blob) {
        return image;
    }

    const imageData = await toImageData(image);
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
}

export function cropImageData(
    imageData: ImageData,
    region: BoundingBox
): ImageData {
    const { x, y, width, height } = region;
    const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height);
    const srcCtx = srcCanvas.getContext("2d")!;
    srcCtx.putImageData(imageData, 0, 0);

    const cropX = Math.floor(Math.max(2, Math.min(imageData.width - 12, x)));
    const cropY = Math.floor(Math.max(2, Math.min(imageData.height - 12, y)));
    let cropW = Math.ceil(Math.min(imageData.width - cropX - 2, Math.max(10, width)));
    let cropH = Math.ceil(Math.min(imageData.height - cropY - 2, Math.max(10, height)));

    if (cropW <= 0 || cropH <= 0) {
        return new ImageData(10, 10);
    }

    return srcCtx.getImageData(cropX, cropY, cropW, cropH);
}

export function imageDataToCanvas(imageData: ImageData): OffscreenCanvas {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}
