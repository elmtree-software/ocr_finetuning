/**
 * PaddleOCR Engine
 *
 * OCR engine implementation using PaddleOCR models via ONNX Runtime Web.
 * Two-stage pipeline: Detection (DBNet) + Recognition (CRNN).
 */

import type {
    OCRResult,
    OCRLine,
    OCRWord,
    BoundingBox,
    EngineOptions,
    EngineCapabilities,
    ImageInput,
} from "./types";
import type { OCREngine } from "./engine";
import { toImageData, cropImageData } from "./engine";
import { loadOpenCV, getCV } from "./opencv-loader";
import { matToImageData } from "./opencv-utils";
import { getConfig, MODEL_PATHS } from "./config";

const FALLBACK_DET_INPUT_SIZE = 960;
const FALLBACK_REC_INPUT_HEIGHT = 48;

interface TextBox {
    points: Array<[number, number]>;
    score: number;
}

interface InferenceSession {
    run(feeds: Record<string, any>): Promise<Record<string, any>>;
    release(): Promise<void>;
}

export class PaddleOCREngine implements OCREngine {
    readonly name = "paddleocr" as const;

    private ort: typeof import("onnxruntime-web") | null = null;
    private detSession: InferenceSession | null = null;
    private recSession: InferenceSession | null = null;
    private dictionary: string[] = [];
    private initPromise: Promise<void> | null = null;
    private useGPU = false;
    private webGPUFailed = false; // Track if WebGPU failed at runtime
    private loadedVersion: "v5" | "v3" = "v5";
    private loadedLanguage: "german" | "latin" | "english" = "latin";
    private recInputHeight = FALLBACK_REC_INPUT_HEIGHT;

    async init(): Promise<void> {
        if (this.detSession && this.recSession) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._doInit().catch((err) => {
            this.initPromise = null;
            throw err;
        });
        await this.initPromise;
    }

    isReady(): boolean {
        return this.detSession !== null && this.recSession !== null;
    }

    async recognize(
        image: ImageInput,
        options?: EngineOptions
    ): Promise<OCRResult> {
        await this.init();
        await loadOpenCV();

        const imageData = await toImageData(image);

        options?.onProgress?.(10);
        const textBoxes = await this._detectText(imageData);

        if (textBoxes.length === 0) {
            return { text: "", confidence: 0, lines: [], words: [] };
        }

        options?.onProgress?.(30);
        const results: Array<{ text: string; confidence: number; bbox: BoundingBox }> = [];
        const progressPerBox = 60 / textBoxes.length;

        for (let i = 0; i < textBoxes.length; i++) {
            const box = textBoxes[i];
            const cropped = this._extractOrientedRegion(imageData, box);
            const { text, confidence } = await this._recognizeText(cropped);

            if (text.trim()) {
                results.push({
                    text: text.trim(),
                    confidence,
                    bbox: this._boxToBounds(box),
                });
            }

            options?.onProgress?.(30 + (i + 1) * progressPerBox);
        }

        results.sort((a, b) => a.bbox.y - b.bbox.y);

        const lines: OCRLine[] = results.map((r) => ({
            text: r.text,
            confidence: r.confidence,
            bbox: r.bbox,
        }));

        const words: OCRWord[] = results.map((r) => ({
            text: r.text,
            confidence: r.confidence,
            bbox: r.bbox,
        }));

        const fullText = results.map((r) => r.text).join("\n");
        const avgConfidence =
            results.length > 0
                ? results.reduce((sum, r) => sum + r.confidence, 0) / results.length
                : 0;

        options?.onProgress?.(100);

        return { text: fullText, confidence: avgConfidence, lines, words };
    }

    async recognizeRegion(
        image: ImageInput,
        region: BoundingBox,
        options?: EngineOptions
    ): Promise<OCRResult> {
        const imageData = await toImageData(image);
        const cropped = cropImageData(imageData, region);
        return this.recognize(cropped, options);
    }

    getCapabilities(): EngineCapabilities {
        const isV5 = this.loadedVersion === "v5";
        return {
            name: `PaddleOCR PP-OCR${this.loadedVersion} (${this.loadedLanguage})`,
            languages: ["eng", "deu", "fra", "spa", "ita", "por", "lat"],
            supportsGPU: this._checkWebGPUSupport(),
            supportsWordBboxes: true,
            supportsLineBboxes: true,
            modelSizeMB: isV5 ? 92 : 10,
        };
    }

    async unload(): Promise<void> {
        if (this.detSession) {
            await this.detSession.release();
            this.detSession = null;
        }
        if (this.recSession) {
            await this.recSession.release();
            this.recSession = null;
        }
        this.dictionary = [];
        this.initPromise = null;
    }

    terminate(): void {
        this.detSession = null;
        this.recSession = null;
        this.dictionary = [];
        this.initPromise = null;
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    private async _doInit(): Promise<void> {
        const config = getConfig();
        const { version, language: requestedLanguage, useWebGPU } = config.paddleocr;

        const resolvedLanguage = requestedLanguage === "german" ? "latin" : requestedLanguage;

        this.ort = await import("onnxruntime-web");
        // Don't use WebGPU if it already failed at runtime
        this.useGPU = useWebGPU && this._checkWebGPUSupport() && !this.webGPUFailed;

        const executionProviders: string[] = this.useGPU ? ["webgpu", "wasm"] : ["wasm"];

        const useV5 = version === "v5";
        const detectionUrl = useV5
            ? MODEL_PATHS.paddleocr.detectionV5
            : MODEL_PATHS.paddleocr.detectionV3;

        console.log(
            `[PaddleOCR] Initializing ${version} with ${this.useGPU ? "WebGPU" : "WASM"}`
        );

        const recUrl = MODEL_PATHS.paddleocr.recognition[resolvedLanguage];
        const dictUrl = MODEL_PATHS.paddleocr.dictionary[resolvedLanguage];

        const [detModel, recModel, dictText] = await Promise.all([
            fetch(detectionUrl).then((r) => {
                if (!r.ok && useV5) {
                    console.warn(`[PaddleOCR] V5 not found, falling back to V3`);
                    this.loadedVersion = "v3";
                    return fetch(MODEL_PATHS.paddleocr.detectionV3).then((r2) => {
                        if (!r2.ok) throw new Error(`Detection model load failed: ${r2.status}`);
                        return r2.arrayBuffer();
                    });
                }
                if (!r.ok) throw new Error(`Detection model load failed: ${r.status}`);
                this.loadedVersion = version;
                return r.arrayBuffer();
            }),
            fetch(recUrl).then((r) => {
                if (!r.ok) throw new Error(`Recognition model load failed: ${r.status}`);
                return r.arrayBuffer();
            }),
            fetch(dictUrl).then((r) => {
                if (!r.ok) throw new Error(`Dictionary load failed: ${r.status}`);
                return r.text();
            }),
        ]);

        this.loadedLanguage = resolvedLanguage;

        this.dictionary = dictText.split("\n").filter((line) => line.length > 0);
        if (!this.dictionary.includes(" ")) {
            this.dictionary.push(" ");
        }
        this.dictionary.unshift("");

        const sessionOptions = {
            executionProviders,
            graphOptimizationLevel: "all" as const,
        };

        this.detSession = (await this.ort.InferenceSession.create(
            detModel,
            sessionOptions
        )) as unknown as InferenceSession;

        this.recSession = (await this.ort.InferenceSession.create(
            recModel,
            sessionOptions
        )) as unknown as InferenceSession;

        const inferredHeight = this._inferRecognitionInputHeight(this.recSession);
        if (inferredHeight) {
            this.recInputHeight = inferredHeight;
            if (config.paddleocr.recInputHeight && config.paddleocr.recInputHeight !== inferredHeight) {
                console.warn(
                    `[PaddleOCR] Overriding configured recInputHeight (${config.paddleocr.recInputHeight}) with model-fixed height (${inferredHeight})`
                );
            }
        } else {
            this.recInputHeight = config.paddleocr.recInputHeight ?? FALLBACK_REC_INPUT_HEIGHT;
        }

        console.log(
            `[PaddleOCR] Ready (${this.loadedVersion}, ${this.loadedLanguage}, H=${this.recInputHeight})`
        );
    }

    private _checkWebGPUSupport(): boolean {
        return typeof navigator !== "undefined" && "gpu" in navigator;
    }

    private _isWebGPUError(error: unknown): boolean {
        const msg = error instanceof Error ? error.message : String(error);
        return (
            msg.includes("ceil()") ||
            msg.includes("not yet supported") ||
            msg.includes("WebGPU") ||
            msg.includes("GPUBuffer")
        );
    }

    private async _fallbackToWASM(): Promise<void> {
        if (!this.useGPU || this.webGPUFailed) return;

        console.warn("[PaddleOCR] WebGPU failed, falling back to WASM...");
        this.webGPUFailed = true;
        this.useGPU = false;

        // Release existing sessions
        if (this.detSession) {
            await this.detSession.release();
            this.detSession = null;
        }
        if (this.recSession) {
            await this.recSession.release();
            this.recSession = null;
        }

        // Reinitialize with WASM only
        this.initPromise = null;
        await this._doInit();
    }

    private _inferRecognitionInputHeight(session: InferenceSession): number | null {
        const sessionAny = session as any;
        const inputNames = sessionAny?.inputNames;
        const inputName = Array.isArray(inputNames) ? inputNames[0] : "x";
        const dims = sessionAny?.inputMetadata?.[inputName]?.dimensions;
        const heightDim = Array.isArray(dims) && typeof dims[2] === "number" && dims[2] > 0 ? dims[2] : null;
        return heightDim;
    }

    // =========================================================================
    // Text Detection
    // =========================================================================

    private async _detectText(imageData: ImageData): Promise<TextBox[]> {
        const config = getConfig();
        const detInputSize = config.paddleocr.detInputSize ?? FALLBACK_DET_INPUT_SIZE;
        const { tensor, scale, padWidth, padHeight } = this._prepareDetectionInput(imageData, detInputSize);

        const feeds = { x: tensor };
        let results: Record<string, any>;

        try {
            results = await this.detSession!.run(feeds);
        } catch (error) {
            if (this._isWebGPUError(error)) {
                await this._fallbackToWASM();
                // Retry with WASM
                results = await this.detSession!.run(feeds);
            } else {
                throw error;
            }
        }

        const outputKey = Object.keys(results)[0];
        const output = results[outputKey];
        const probMap = output.data as Float32Array;
        const dims = output.dims as number[];

        let channels = 1;
        let h: number, w: number;

        if (dims.length === 4) {
            channels = dims[1] ?? 1;
            h = dims[2];
            w = dims[3];
        } else if (dims.length === 3) {
            h = dims[1];
            w = dims[2];
        } else {
            throw new Error(`Unexpected detection dims: ${dims}`);
        }

        const probMap1 = channels > 1 ? probMap.subarray(0, w * h) : probMap;
        const unclipRatio = config.paddleocr.unclipRatio ?? 1.5;

        return this._postProcessDetection(
            probMap1,
            w,
            h,
            scale,
            imageData.width,
            imageData.height,
            padWidth,
            padHeight,
            config.paddleocr.detThreshold,
            config.paddleocr.boxThreshold,
            unclipRatio
        );
    }

    private _prepareDetectionInput(imageData: ImageData, inputSize: number) {
        const config = getConfig();
        const limitType = config.paddleocr.limitType ?? "max";
        const { width, height } = imageData;
        
        // limitType="max": limit longest side (PaddleOCR default)
        // limitType="min": limit shortest side
        const scale = limitType === "max"
            ? Math.min(inputSize / Math.max(width, height), 1.0)
            : Math.min(inputSize / Math.min(width, height), 1.0);
        
        const newWidth = Math.round(width * scale);
        const newHeight = Math.round(height * scale);

        const resized = this._resizeImageData(imageData, newWidth, newHeight);

        const padWidth = Math.ceil(newWidth / 32) * 32;
        const padHeight = Math.ceil(newHeight / 32) * 32;
        const padded = this._padImageData(resized, padWidth, padHeight);

        const tensorData = new Float32Array(3 * padHeight * padWidth);
        const mean = [0.485, 0.456, 0.406];
        const std = [0.229, 0.224, 0.225];

        for (let y = 0; y < padHeight; y++) {
            for (let x = 0; x < padWidth; x++) {
                const idx = (y * padWidth + x) * 4;
                const r = padded.data[idx] / 255;
                const g = padded.data[idx + 1] / 255;
                const b = padded.data[idx + 2] / 255;

                tensorData[0 * padHeight * padWidth + y * padWidth + x] = (r - mean[0]) / std[0];
                tensorData[1 * padHeight * padWidth + y * padWidth + x] = (g - mean[1]) / std[1];
                tensorData[2 * padHeight * padWidth + y * padWidth + x] = (b - mean[2]) / std[2];
            }
        }

        const tensor = new this.ort!.Tensor("float32", tensorData, [1, 3, padHeight, padWidth]);
        return { tensor, scale, padWidth, padHeight };
    }

    private _postProcessDetection(
        probMap: Float32Array,
        mapWidth: number,
        mapHeight: number,
        scale: number,
        origWidth: number,
        origHeight: number,
        inputWidth: number,
        inputHeight: number,
        threshold: number,
        boxThreshold: number,
        unclipRatio: number
    ): TextBox[] {
        const minSize = 3;
        const boxes: TextBox[] = [];

        const mask = new Uint8Array(mapWidth * mapHeight);
        for (let i = 0; i < probMap.length; i++) {
            mask[i] = probMap[i] > threshold ? 1 : 0;
        }

        const visited = new Uint8Array(mapWidth * mapHeight);
        const regions: Array<Array<[number, number]>> = [];

        for (let y = 0; y < mapHeight; y++) {
            for (let x = 0; x < mapWidth; x++) {
                const idx = y * mapWidth + x;
                if (mask[idx] && !visited[idx]) {
                    const region: Array<[number, number]> = [];
                    const stack: Array<[number, number]> = [[x, y]];

                    while (stack.length > 0) {
                        const [cx, cy] = stack.pop()!;
                        const cidx = cy * mapWidth + cx;

                        if (
                            cx < 0 ||
                            cx >= mapWidth ||
                            cy < 0 ||
                            cy >= mapHeight ||
                            visited[cidx] ||
                            !mask[cidx]
                        ) {
                            continue;
                        }

                        visited[cidx] = 1;
                        region.push([cx, cy]);

                        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
                    }

                    if (region.length >= minSize * minSize) {
                        regions.push(region);
                    }
                }
            }
        }

        const strideX = inputWidth / mapWidth;
        const strideY = inputHeight / mapHeight;
        const scaleBack = 1 / scale;

        for (const region of regions) {
            let minX = Infinity,
                minY = Infinity,
                maxX = -Infinity,
                maxY = -Infinity;
            let sumProb = 0;

            for (const [x, y] of region) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                sumProb += probMap[y * mapWidth + x];
            }

            const avgProb = sumProb / region.length;
            if (avgProb < boxThreshold) continue;

            const cv = getCV();
            const pointsMat = cv.matFromArray(region.length, 1, cv.CV_32SC2, region.flat());
            const rect = cv.minAreaRect(pointsMat);
            pointsMat.delete();

            // Get 4 corners
            const vertices = cv.RotatedRect.points(rect);
            const rawPoints: Array<[number, number]> = [];
            for (let i = 0; i < 4; i++) {
                rawPoints.push([vertices[i].x, vertices[i].y]);
            }

            // Expand box (unclip)
            const area = rect.size.width * rect.size.height;
            const perimeter = 2 * (rect.size.width + rect.size.height);
            const dist = (area * unclipRatio) / perimeter;

            // Simple expansion: move points away from center
            const expandedPoints: Array<[number, number]> = rawPoints.map(([px, py]) => {
                const dx = px - rect.center.x;
                const dy = py - rect.center.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len === 0) return [px, py];
                return [
                    rect.center.x + (dx / len) * (len + dist),
                    rect.center.y + (dy / len) * (len + dist),
                ] as [number, number];
            });

            // Sort points into consistent TL→TR→BR→BL order before storing
            const sortedExpandedPoints = this._sortBoxPoints(expandedPoints);

            const box: TextBox = {
                points: sortedExpandedPoints.map(([px, py]) => [
                    px * strideX * scaleBack,
                    py * strideY * scaleBack,
                ]),
                score: avgProb,
            };

            boxes.push(box);
        }

        return boxes;
    }

    // =========================================================================
    // Text Recognition
    // =========================================================================

    private async _recognizeText(
        imageData: ImageData
    ): Promise<{ text: string; confidence: number }> {
        const tensor = this._prepareRecognitionInput(imageData);

        const feeds = { x: tensor };
        let results: Record<string, any>;

        try {
            results = await this.recSession!.run(feeds);
        } catch (error) {
            if (this._isWebGPUError(error)) {
                await this._fallbackToWASM();
                // Retry with WASM
                results = await this.recSession!.run(feeds);
            } else {
                throw error;
            }
        }

        const outputKey = Object.keys(results)[0];
        const output = results[outputKey];
        const logits = output.data as Float32Array;
        const dims = output.dims as number[];

        const seqLen = dims[dims.length - 2];
        const vocabSize = dims[dims.length - 1];

        return this._ctcDecode(logits, seqLen, vocabSize);
    }

    private _prepareRecognitionInput(imageData: ImageData) {
        const { width, height } = imageData;
        const newHeight = this.recInputHeight;
        const newWidth = Math.round((width / height) * newHeight);
        const resized = this._resizeImageData(imageData, newWidth, newHeight);

        const tensorData = new Float32Array(3 * newHeight * newWidth);

        for (let y = 0; y < newHeight; y++) {
            for (let x = 0; x < newWidth; x++) {
                const idx = (y * newWidth + x) * 4;
                const r = (resized.data[idx] / 255) * 2 - 1;
                const g = (resized.data[idx + 1] / 255) * 2 - 1;
                const b = (resized.data[idx + 2] / 255) * 2 - 1;

                tensorData[0 * newHeight * newWidth + y * newWidth + x] = r;
                tensorData[1 * newHeight * newWidth + y * newWidth + x] = g;
                tensorData[2 * newHeight * newWidth + y * newWidth + x] = b;
            }
        }

        return new this.ort!.Tensor("float32", tensorData, [1, 3, newHeight, newWidth]);
    }

    private _ctcDecode(
        logits: Float32Array,
        seqLen: number,
        vocabSize: number
    ): { text: string; confidence: number } {
        const chars: string[] = [];
        let totalProb = 0;
        let prevIdx = -1;

        for (let t = 0; t < seqLen; t++) {
            let maxProb = -Infinity;
            let maxIdx = 0;

            for (let v = 0; v < vocabSize; v++) {
                const prob = logits[t * vocabSize + v];
                if (prob > maxProb) {
                    maxProb = prob;
                    maxIdx = v;
                }
            }

            if (maxIdx !== 0 && maxIdx !== prevIdx) {
                if (maxIdx < this.dictionary.length) {
                    chars.push(this.dictionary[maxIdx]);
                    totalProb += maxProb;
                }
            }

            prevIdx = maxIdx;
        }

        const text = chars.join("");
        const confidence = chars.length > 0 ? totalProb / chars.length : 0;

        return { text, confidence: Math.min(confidence, 1) };
    }

    // =========================================================================
    // Image Utilities
    // =========================================================================

    private _resizeImageData(imageData: ImageData, newWidth: number, newHeight: number): ImageData {
        const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height);
        const srcCtx = srcCanvas.getContext("2d")!;
        srcCtx.putImageData(imageData, 0, 0);

        const dstCanvas = new OffscreenCanvas(newWidth, newHeight);
        const dstCtx = dstCanvas.getContext("2d")!;
        dstCtx.drawImage(srcCanvas, 0, 0, newWidth, newHeight);

        return dstCtx.getImageData(0, 0, newWidth, newHeight);
    }

    private _padImageData(imageData: ImageData, padWidth: number, padHeight: number): ImageData {
        const canvas = new OffscreenCanvas(padWidth, padHeight);
        const ctx = canvas.getContext("2d")!;

        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, padWidth, padHeight);

        const tempCanvas = new OffscreenCanvas(imageData.width, imageData.height);
        const tempCtx = tempCanvas.getContext("2d")!;
        tempCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(tempCanvas, 0, 0);

        return ctx.getImageData(0, 0, padWidth, padHeight);
    }

    /**
     * Sort 4 points into consistent TL→TR→BR→BL order.
     * cv.RotatedRect.points() does NOT guarantee order, so we must sort ourselves.
     */
    private _sortBoxPoints(points: Array<[number, number]>): Array<[number, number]> {
        // Sort by Y first to get top 2 and bottom 2
        const sorted = [...points].sort((a, b) => a[1] - b[1]);
        const top = sorted.slice(0, 2);
        const bottom = sorted.slice(2, 4);
        
        // Sort top by X: left is TL, right is TR
        top.sort((a, b) => a[0] - b[0]);
        // Sort bottom by X: left is BL, right is BR
        bottom.sort((a, b) => a[0] - b[0]);
        
        // Return in TL→TR→BR→BL order
        return [top[0], top[1], bottom[1], bottom[0]];
    }

    private _extractOrientedRegion(imageData: ImageData, box: TextBox): ImageData {
        const cv = getCV();
        const src = cv.matFromImageData(imageData);

        const dist = (p1: [number, number], p2: [number, number]) =>
            Math.sqrt(Math.pow(p2[0] - p1[0], 2) + Math.pow(p2[1] - p1[1], 2));

        // Sort points into consistent TL→TR→BR→BL order
        const sortedPoints = this._sortBoxPoints(box.points);

        const w = Math.round(Math.max(dist(sortedPoints[0], sortedPoints[1]), dist(sortedPoints[3], sortedPoints[2])));
        const h = Math.round(Math.max(dist(sortedPoints[0], sortedPoints[3]), dist(sortedPoints[1], sortedPoints[2])));

        if (w <= 0 || h <= 0) {
            src.delete();
            return new ImageData(Math.max(1, w), Math.max(1, h));
        }

        // Track OpenCV Mats for cleanup
        let srcPoints: ReturnType<typeof cv.matFromArray> | null = null;
        let dstPoints: ReturnType<typeof cv.matFromArray> | null = null;
        let M: ReturnType<typeof cv.getPerspectiveTransform> | null = null;
        let dst: InstanceType<typeof cv.Mat> | null = null;

        try {
            srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, sortedPoints.flat());
            dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
                0, 0,
                w - 1, 0,
                w - 1, h - 1,
                0, h - 1,
            ]);

            M = cv.getPerspectiveTransform(srcPoints, dstPoints);
            dst = new cv.Mat();

            // Add some internal padding to the unwarped result to help the recognition model
            const config = getConfig();
            const pad = config.paddleocr.regionPadding ?? 4;
            const paddedW = w + pad * 2;
            const paddedH = h + pad * 2;

            cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);

            // Convert to ImageData and add white padding manually (cheaper than Mat manipulations)
            const warpedData = matToImageData(dst);
            const finalCanvas = new OffscreenCanvas(paddedW, paddedH);
            const finalCtx = finalCanvas.getContext("2d")!;
            finalCtx.fillStyle = "white";
            finalCtx.fillRect(0, 0, paddedW, paddedH);

            const tempCanvas = new OffscreenCanvas(w, h);
            const tempCtx = tempCanvas.getContext("2d")!;
            tempCtx.putImageData(warpedData, 0, 0);
            finalCtx.drawImage(tempCanvas, pad, pad);

            return finalCtx.getImageData(0, 0, paddedW, paddedH);
        } finally {
            // Always clean up OpenCV Mats to prevent memory leaks
            src.delete();
            srcPoints?.delete();
            dstPoints?.delete();
            M?.delete();
            dst?.delete();
        }
    }

    private _boxToBounds(box: TextBox): BoundingBox {
        const xs = box.points.map((p) => p[0]);
        const ys = box.points.map((p) => p[1]);

        return {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
        };
    }
}
