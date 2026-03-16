/**
 * Tesseract.js Engine
 *
 * OCR engine implementation using Tesseract.js.
 */

import Tesseract from "tesseract.js";
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
import { toBlob, toImageData, cropImageData } from "./engine";
import { MODEL_PATHS } from "./config";

/** Maximum jobs before worker reset to prevent WebAssembly memory growth */
const MAX_JOBS_BEFORE_RESET = 500;

export class TesseractEngine implements OCREngine {
    readonly name = "tesseract" as const;

    private worker: Tesseract.Worker | null = null;
    private initPromise: Promise<void> | null = null;
    private currentLanguages: string[] = [];
    private progressCallback: ((progress: number) => void) | null = null;
    private jobCount = 0;

    async init(): Promise<void> {
        if (this.worker) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._doInit(["deu", "eng"]);
        await this.initPromise;
    }

    isReady(): boolean {
        return this.worker !== null;
    }

    async recognize(
        image: ImageInput,
        options?: EngineOptions
    ): Promise<OCRResult> {
        const languages = options?.languages ?? ["deu", "eng"];
        await this._ensureLanguages(languages);

        // Check if worker needs reset due to memory growth
        await this._checkJobCountReset(languages);

        this.progressCallback = options?.onProgress ?? null;

        const blob = await toBlob(image);

        if (options?.psm !== undefined || options?.dpi !== undefined) {
            await this.worker!.setParameters({
                ...(options?.psm !== undefined && {
                    tessedit_pageseg_mode: options.psm as unknown as Tesseract.PSM,
                }),
                ...(options?.dpi !== undefined && {
                    user_defined_dpi: options.dpi.toString(),
                }),
            });
        }

        const result = await this.worker!.recognize(blob, {}, { blocks: true });

        this.progressCallback = null;
        this.jobCount++;

        return this._convertResult(result);
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
        return {
            name: "Tesseract.js",
            languages: ["deu", "eng", "fra", "spa", "ita", "por", "nld"],
            supportsGPU: false,
            supportsWordBboxes: true,
            supportsLineBboxes: true,
            modelSizeMB: 15,
        };
    }

    async unload(): Promise<void> {
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
            this.initPromise = null;
            this.currentLanguages = [];
            this.jobCount = 0;
        }
    }

    terminate(): void {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.initPromise = null;
            this.currentLanguages = [];
            this.jobCount = 0;
        }
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    private async _doInit(languages: string[]): Promise<void> {
        const langString = languages.join("+");

        this.worker = await Tesseract.createWorker(
            langString,
            Tesseract.OEM.LSTM_ONLY,
            {
                workerPath: MODEL_PATHS.tesseract.workerPath,
                corePath: MODEL_PATHS.tesseract.corePath,
                langPath: MODEL_PATHS.tesseract.langPath,
                gzip: true,
                logger: (m) => {
                    if (m.status === "recognizing text" && this.progressCallback) {
                        this.progressCallback(m.progress * 100);
                    }
                },
            }
        );

        await this.worker.setParameters({
            tessedit_pageseg_mode: Tesseract.PSM.AUTO,
            user_defined_dpi: "300",
        });

        this.currentLanguages = languages;
    }

    private async _ensureLanguages(languages: string[]): Promise<void> {
        // Validate languages against supported list
        const supported = this.getCapabilities().languages;
        const validLanguages = languages.filter((lang) => supported.includes(lang));
        
        if (validLanguages.length === 0) {
            console.warn(
                `[Tesseract] No valid languages in [${languages.join(", ")}]. ` +
                `Supported: [${supported.join(", ")}]. Falling back to ["deu", "eng"].`
            );
            validLanguages.push("deu", "eng");
        } else if (validLanguages.length !== languages.length) {
            const invalid = languages.filter((lang) => !supported.includes(lang));
            console.warn(
                `[Tesseract] Ignoring unsupported languages: [${invalid.join(", ")}]. ` +
                `Using: [${validLanguages.join(", ")}].`
            );
        }

        const langKey = validLanguages.sort().join("+");
        const currentKey = this.currentLanguages.sort().join("+");

        if (this.worker && langKey === currentKey) {
            return;
        }

        await this.unload();
        this.initPromise = this._doInit(validLanguages);
        await this.initPromise;
    }

    /**
     * Resets the worker after MAX_JOBS_BEFORE_RESET jobs to prevent
     * WebAssembly memory from growing indefinitely.
     * WebAssembly memory can only grow, never shrink.
     */
    private async _checkJobCountReset(languages: string[]): Promise<void> {
        if (this.jobCount >= MAX_JOBS_BEFORE_RESET) {
            console.log(
                `[Tesseract] Resetting worker after ${this.jobCount} jobs to free WebAssembly memory`
            );
            await this.unload();
            this.initPromise = this._doInit(languages);
            await this.initPromise;
        }
    }

    private _convertResult(result: Tesseract.RecognizeResult): OCRResult {
        const lines: OCRLine[] = [];
        const words: OCRWord[] = [];

        const blocks = result.data.blocks;

        if (blocks && Array.isArray(blocks)) {
            for (const block of blocks) {
                const paragraphs = (block as any).paragraphs;
                if (!paragraphs) continue;

                for (const para of paragraphs) {
                    const paraLines = para.lines;
                    if (!paraLines) continue;

                    for (const line of paraLines) {
                        const lineWords: OCRWord[] = [];

                        if (line.words) {
                            for (const word of line.words) {
                                const ocrWord: OCRWord = {
                                    text: word.text || "",
                                    confidence: (word.confidence || 0) / 100,
                                    bbox: {
                                        x: word.bbox?.x0 || 0,
                                        y: word.bbox?.y0 || 0,
                                        width: (word.bbox?.x1 || 0) - (word.bbox?.x0 || 0),
                                        height: (word.bbox?.y1 || 0) - (word.bbox?.y0 || 0),
                                    },
                                };
                                lineWords.push(ocrWord);
                                words.push(ocrWord);
                            }
                        }

                        lines.push({
                            text: line.text || "",
                            confidence: (line.confidence || 0) / 100,
                            bbox: line.bbox
                                ? {
                                      x: line.bbox.x0,
                                      y: line.bbox.y0,
                                      width: line.bbox.x1 - line.bbox.x0,
                                      height: line.bbox.y1 - line.bbox.y0,
                                  }
                                : undefined,
                            words: lineWords,
                        });
                    }
                }
            }
        }

        return {
            text: result.data.text || "",
            confidence: (result.data.confidence || 0) / 100,
            lines,
            words,
        };
    }
}
