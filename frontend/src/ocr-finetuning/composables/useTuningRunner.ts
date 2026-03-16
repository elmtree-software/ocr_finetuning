/**
 * Tuning Runner Composable
 *
 * Executes OCR iterations over parameter permutations.
 * Handles pause/resume and calculates scores.
 */

import { ref, readonly } from "vue";
import { useTuningState, isNumberConfig, isBooleanConfig, isEnumConfig } from "./useTuningState";
import { useFileSaver } from "./useFileSaver";
import { OCRService } from "@/services/ocr";
import {
    calculateCER,
    calculateWER,
    calculateCombinedScore,
    calculateLengthDiagnostics,
    calculateRobustCombinedScore,
} from "../utils/cer-wer";
import type {
    ParameterPermutation,
    IterationResult,
    ImageScore,
    PartialOCRConfig,
    ParameterConfigMap,
    GroundTruthRegion,
    GroundTruthMeta,
    RegionScore,
    TuningImage,
    ScoringMode,
} from "../types/tuning";
import type { BoundingBox, EngineType } from "@/services/ocr/types";
import { buildMacroRegions } from "../utils/macro-layout";
import { cropImageData } from "@/services/ocr/engine";

// =============================================================================
// Internal State
// =============================================================================

const abortController = ref<AbortController | null>(null);
const isPaused = ref(false);

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Convert permutation to partial config for OCRService.setConfig()
 */
function permutationToPartialConfig(
    permutation: ParameterPermutation
): PartialOCRConfig {
    const config: Record<string, unknown> = {};

    for (const { path, value } of permutation) {
        const keys = path.split(".");
        let current = config;

        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!(key in current)) {
                current[key] = {};
            }
            current = current[key] as Record<string, unknown>;
        }

        current[keys[keys.length - 1]] = value;
    }

    return config as PartialOCRConfig;
}

/**
 * Sleep for UI responsiveness
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRunDirectoryName(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    const millis = String(date.getMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}-${millis}`;
}

function formatIterationFilename(iteration: number): string {
    return `iteration_${String(iteration).padStart(4, "0")}.json`;
}

/**
 * Wait for unpause
 */
async function waitForUnpause(): Promise<void> {
    while (isPaused.value) {
        await sleep(100);
    }
}

/**
 * Load image from TuningImage to ImageData
 */
async function loadImageData(url: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";

        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;

            const ctx = canvas.getContext("2d");
            if (!ctx) {
                reject(new Error("Could not get canvas context"));
                return;
            }

            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            resolve(imageData);
        };

        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = url;
    });
}

async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read image file"));
        reader.readAsDataURL(file);
    });
}

function dataUrlToFile(dataUrl: string, filename: string, mimeType?: string): File | null {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return null;

    try {
        const resolvedMimeType = mimeType || match[1] || "application/octet-stream";
        const binary = atob(match[2]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new File([bytes], filename, { type: resolvedMimeType });
    } catch {
        return null;
    }
}

// =============================================================================
// Region-Weighted Metrics (Macro-Region OCR)
// =============================================================================

const REGION_WEIGHTS: Record<string, number> = {
    Body: 0.4,
    Address: 0.2,
    Meta: 0.15,
    Header: 0.15,
    Footer: 0.1,
};

function getRegionWeight(label: string): number {
    return REGION_WEIGHTS[label] ?? 0.1;
}

function rotateImageData(imageData: ImageData, degrees: number): ImageData {
    if (!degrees) return imageData;
    const radians = (degrees * Math.PI) / 180;
    const sin = Math.abs(Math.sin(radians));
    const cos = Math.abs(Math.cos(radians));
    const newWidth = Math.floor(imageData.width * cos + imageData.height * sin);
    const newHeight = Math.floor(imageData.width * sin + imageData.height * cos);

    const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height);
    const srcCtx = srcCanvas.getContext("2d")!;
    srcCtx.putImageData(imageData, 0, 0);

    const rotated = new OffscreenCanvas(newWidth, newHeight);
    const ctx = rotated.getContext("2d")!;
    ctx.translate(newWidth / 2, newHeight / 2);
    ctx.rotate(radians);
    ctx.drawImage(srcCanvas, -imageData.width / 2, -imageData.height / 2);

    return ctx.getImageData(0, 0, newWidth, newHeight);
}

async function recognizeMacroRegions(
    imageData: ImageData,
    macroRegions: Array<{ id: string; label: string; bbox: BoundingBox; order: number }>
): Promise<Map<string, string>> {
    const savedConfig = structuredClone(OCRService.getConfig());
    OCRService.setConfig({
        layout: { enabled: false },
        table: { enabled: false },
        fallback: { enabled: false },
        rotation: { enabled: false },
        rectification: { enabled: false },
    });

    const results = new Map<string, string>();

    try {
        for (const region of macroRegions) {
            const cropped = cropImageData(imageData, region.bbox);
            const result = await OCRService.recognize(cropped);
            results.set(region.id, result.text ?? "");
        }
    } finally {
        OCRService.setConfig(savedConfig);
    }

    return results;
}

async function computeMacroRegionMetrics(
    imageData: ImageData,
    groundTruthRegions: GroundTruthRegion[] | undefined,
    rotation: number | undefined
): Promise<{ weightedCER: number; weightedWER: number; regionScores: RegionScore[] } | null> {
    if (!groundTruthRegions || groundTruthRegions.length === 0) return null;

    const gtTextById = new Map(
        groundTruthRegions.map((r) => [r.id, { text: r.text, label: r.label }])
    );

    const rotatedImage = rotateImageData(imageData, rotation ?? 0);
    const macroRegions = buildMacroRegions(rotatedImage.width, rotatedImage.height).map(
        (macro) => {
            const gtEntry = gtTextById.get(macro.id);
            return {
                id: macro.id,
                label: gtEntry?.label ?? macro.label,
                bbox: macro.bbox,
                order: macro.order,
            };
        }
    );

    const ocrTexts = await recognizeMacroRegions(rotatedImage, macroRegions);

    const regionScores: RegionScore[] = macroRegions.map((region) => {
        const ocrText = (ocrTexts.get(region.id) ?? "").trim();
        const groundTruth = gtTextById.get(region.id)?.text ?? "";
        const cer = calculateCER(ocrText, groundTruth);
        const wer = calculateWER(ocrText, groundTruth);
        return {
            id: region.id,
            label: region.label,
            weight: getRegionWeight(region.label),
            ocrText,
            groundTruth,
            cer,
            wer,
        };
    });

    const totalWeight = regionScores.reduce((sum, r) => sum + r.weight, 0);
    const safeWeight = totalWeight > 0 ? totalWeight : 1;

    const weightedCER =
        regionScores.reduce((sum, r) => sum + r.weight * r.cer, 0) / safeWeight;
    const weightedWER =
        regionScores.reduce((sum, r) => sum + r.weight * r.wer, 0) / safeWeight;

    return { weightedCER, weightedWER, regionScores };
}

// =============================================================================
// Bayesian Optimization (Discrete Parameter Space)
// =============================================================================

type ParameterDimension = {
    path: string;
    values: Array<number | boolean | string>;
};

function linspace(min: number, max: number, steps: number): number[] {
    if (steps <= 0) return [];
    if (steps === 1) return [min];
    const values: number[] = [];
    const step = (max - min) / (steps - 1);
    for (let i = 0; i < steps; i++) {
        const value = min + step * i;
        values.push(Math.round(value * 1000) / 1000);
    }
    return values;
}

function getValuesForConfig(
    config: ParameterConfigMap[string]
): Array<number | boolean | string> {
    if (!config.enabled) return [];
    if (isNumberConfig(config)) {
        return linspace(config.min, config.max, config.steps);
    }
    if (isEnumConfig(config)) {
        return config.selectedValues;
    }
    if (isBooleanConfig(config)) {
        return [true, false];
    }
    return [];
}

function buildParameterDimensions(
    configs: ParameterConfigMap
): ParameterDimension[] {
    const dimensions: ParameterDimension[] = [];
    for (const [path, config] of Object.entries(configs)) {
        if (!config.enabled) continue;
        const values = getValuesForConfig(config);
        if (values.length === 0) continue;
        dimensions.push({ path, values });
    }
    return dimensions;
}

function parameterSpaceSize(dimensions: ParameterDimension[]): number {
    if (dimensions.length === 0) return 1;
    return dimensions.reduce((product, dim) => product * dim.values.length, 1);
}

function randomPermutation(dimensions: ParameterDimension[]): ParameterPermutation {
    if (dimensions.length === 0) return [];
    return dimensions.map((dim) => {
        const index = Math.floor(Math.random() * dim.values.length);
        return { path: dim.path, value: dim.values[index] };
    });
}

function permutationKey(permutation: ParameterPermutation): string {
    return permutation
        .map((p) => `${p.path}=${String(p.value)}`)
        .sort()
        .join("|");
}

function normalizePermutation(
    permutation: ParameterPermutation,
    dimensions: ParameterDimension[]
): number[] {
    if (dimensions.length === 0) return [];
    return dimensions.map((dim) => {
        const item = permutation.find((p) => p.path === dim.path);
        const index = item ? dim.values.indexOf(item.value) : 0;
        if (dim.values.length <= 1) return 0;
        return Math.max(0, index) / (dim.values.length - 1);
    });
}

class GaussianProcess {
    private lengthScale: number;
    private variance: number;
    private noise: number;
    private X: number[][] = [];
    private y: number[] = [];
    private KInv: number[][] | null = null;

    constructor(lengthScale = 0.5, variance = 1.0, noise = 0.1) {
        this.lengthScale = lengthScale;
        this.variance = variance;
        this.noise = noise;
    }

    kernel(x1: number[], x2: number[]): number {
        let sqDist = 0;
        for (let i = 0; i < x1.length; i++) {
            const diff = (x1[i] - x2[i]) / this.lengthScale;
            sqDist += diff * diff;
        }
        return this.variance * Math.exp(-0.5 * sqDist);
    }

    addObservation(x: number[], y: number): void {
        this.X.push(x);
        this.y.push(y);
        this.KInv = null;
    }

    private computeKernelInverse(): void {
        const n = this.X.length;
        if (n === 0) return;

        const K: number[][] = [];
        for (let i = 0; i < n; i++) {
            K[i] = [];
            for (let j = 0; j < n; j++) {
                let value = this.kernel(this.X[i], this.X[j]);
                if (i === j) value += this.noise;
                K[i][j] = value;
            }
        }

        this.KInv = this.invertMatrix(K);
    }

    private invertMatrix(matrix: number[][]): number[][] {
        const n = matrix.length;
        const augmented = matrix.map((row, i) => {
            const newRow = [...row];
            for (let j = 0; j < n; j++) newRow.push(i === j ? 1 : 0);
            return newRow;
        });

        for (let i = 0; i < n; i++) {
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
                    maxRow = k;
                }
            }
            [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

            const pivot = augmented[i][i];
            if (Math.abs(pivot) < 1e-10) {
                augmented[i][i] += 0.01;
            }

            for (let j = 0; j < 2 * n; j++) {
                augmented[i][j] /= augmented[i][i];
            }

            for (let k = 0; k < n; k++) {
                if (k === i) continue;
                const factor = augmented[k][i];
                for (let j = 0; j < 2 * n; j++) {
                    augmented[k][j] -= factor * augmented[i][j];
                }
            }
        }

        return augmented.map((row) => row.slice(n));
    }

    predict(x: number[]): { mean: number; variance: number } {
        if (this.X.length === 0) {
            return { mean: 0, variance: this.variance };
        }

        if (!this.KInv) this.computeKernelInverse();
        const n = this.X.length;
        const kStar = this.X.map((xi) => this.kernel(x, xi));

        let mean = 0;
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < n; j++) {
                sum += (this.KInv as number[][])[i][j] * this.y[j];
            }
            mean += kStar[i] * sum;
        }

        let variance = this.kernel(x, x);
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < n; j++) {
                sum += (this.KInv as number[][])[i][j] * kStar[j];
            }
            variance -= kStar[i] * sum;
        }

        return { mean, variance: Math.max(0.0001, variance) };
    }
}

function erf(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const abs = Math.abs(x);
    const t = 1.0 / (1.0 + p * abs);
    const y =
        1.0 -
        (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
            Math.exp(-abs * abs);
    return sign * y;
}

function expectedImprovement(
    gp: GaussianProcess,
    x: number[],
    bestY: number
): number {
    const { mean, variance } = gp.predict(x);
    const std = Math.sqrt(variance);
    if (std < 1e-8) return 0;

    const z = (bestY - mean) / std;
    const cdf = 0.5 * (1 + erf(z / Math.sqrt(2)));
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    return (bestY - mean) * cdf + std * pdf;
}

function suggestNextPermutation(
    gp: GaussianProcess,
    dimensions: ParameterDimension[],
    bestScore: number,
    candidateSamples: number,
    seen: Set<string>
): ParameterPermutation {
    let bestEI = -Infinity;
    let bestCandidate: ParameterPermutation | null = null;
    const safeBest = Number.isFinite(bestScore) ? bestScore : 1;

    for (let i = 0; i < candidateSamples; i++) {
        const candidate = randomPermutation(dimensions);
        const key = permutationKey(candidate);
        if (seen.has(key)) continue;
        const normalized = normalizePermutation(candidate, dimensions);
        const ei = expectedImprovement(gp, normalized, safeBest);
        if (ei > bestEI) {
            bestEI = ei;
            bestCandidate = candidate;
        }
    }

    if (bestCandidate) return bestCandidate;
    return randomPermutation(dimensions);
}

// =============================================================================
// Composable
// =============================================================================

export function useTuningRunner() {
    const state = useTuningState();
    const fileSaver = useFileSaver();

    async function saveRunJson(
        runDirectory: string,
        filename: string,
        payload: unknown
    ): Promise<boolean> {
        try {
            return await fileSaver.saveJson(
                filename,
                JSON.stringify(payload, null, 2),
                {
                    directory: runDirectory,
                    allowDownloadFallback: false,
                }
            );
        } catch (error) {
            console.error("[TuningRunner] Failed to serialize/save run snapshot:", error);
            return false;
        }
    }

    async function saveRunMeta(
        runDirectory: string,
        runStartedAt: string,
        totalIterations: number,
        initialSamples: number,
        candidateSamples: number
    ): Promise<void> {
        const metaPayload = {
            runDirectory,
            startedAt: runStartedAt,
            selectedEngine: state.selectedEngine.value,
            scoringMode: state.scoringMode.value,
            optimizerSettings: {
                ...state.optimizerSettings.value,
                totalIterations,
                initialSamples,
                candidateSamples,
            },
            parameterConfigs: state.parameterConfigs.value,
            images: state.imagesWithGroundTruth.value.map((img) => ({
                filename: img.filename,
                groundTruthSource: img.groundTruthSource ?? null,
            })),
        };

        const ok = await saveRunJson(runDirectory, "run_meta.json", metaPayload);
        if (!ok) {
            console.warn(
                `[TuningRunner] Could not persist run metadata for ${runDirectory}`
            );
        }
    }

    async function saveRunInputs(runDirectory: string): Promise<void> {
        try {
            const images = state.imagesWithGroundTruth.value;
            const serializedImages = await Promise.all(
                images.map(async (img) => ({
                    filename: img.filename,
                    mimeType: img.file.type || "application/octet-stream",
                    dataUrl: await fileToDataUrl(img.file),
                    groundTruth: img.groundTruth,
                    groundTruthRegions: img.groundTruthRegions,
                    groundTruthMeta: img.groundTruthMeta,
                    groundTruthSource: img.groundTruthSource ?? null,
                }))
            );

            const ok = await saveRunJson(runDirectory, "run_inputs.json", {
                savedAt: new Date().toISOString(),
                images: serializedImages,
            });

            if (!ok) {
                console.warn(
                    `[TuningRunner] Could not persist run inputs for ${runDirectory}`
                );
            }
        } catch (error) {
            console.warn("[TuningRunner] Failed to save run input snapshot:", error);
        }
    }

    async function saveIterationSnapshots(
        runDirectory: string,
        runStartedAt: string,
        totalIterations: number,
        completedIterations: number,
        result: IterationResult
    ): Promise<void> {
        const runSnapshot = state.runState.value;

        await saveRunJson(runDirectory, formatIterationFilename(result.id + 1), {
            runDirectory,
            runStartedAt,
            savedAt: new Date().toISOString(),
            completedIterations,
            totalIterations,
            result,
            bestResult: runSnapshot.bestResult,
        });

        await saveRunJson(runDirectory, "all_results.json", {
            runDirectory,
            runStartedAt,
            savedAt: new Date().toISOString(),
            completedIterations,
            totalIterations,
            status: runSnapshot.status,
            results: runSnapshot.results,
            bestResult: runSnapshot.bestResult,
        });

        if (runSnapshot.bestResult) {
            await saveRunJson(runDirectory, "current_best.json", {
                runDirectory,
                runStartedAt,
                savedAt: new Date().toISOString(),
                completedIterations,
                totalIterations,
                bestResult: runSnapshot.bestResult,
            });
        }
    }

    function evaluateIterationScores(imageScores: ImageScore[]): {
        averageCER: number;
        averageWER: number;
        combinedScore: number;
        legacyCombinedScore: number;
        averageLengthRatio: number;
        medianLengthRatio: number;
        emptyOutputRate: number;
        veryShortOutputRate: number;
        averageUnderproductionRate: number;
        feasible: boolean;
    } {
        const averageCER =
            imageScores.length > 0
                ? imageScores.reduce((sum, score) => sum + score.cer, 0) / imageScores.length
                : 1;
        const averageWER =
            imageScores.length > 0
                ? imageScores.reduce((sum, score) => sum + score.wer, 0) / imageScores.length
                : 1;
        const legacyCombinedScore = calculateCombinedScore(averageCER, averageWER);

        const robust = calculateRobustCombinedScore(
            imageScores.map((score) => ({
                cer: score.cer,
                wer: score.wer,
                lengthRatio: score.lengthRatio ?? 0,
                underproductionRate: score.underproductionRate ?? 1,
                isEmptyOutput: score.isEmptyOutput ?? true,
                isVeryShortOutput: score.isVeryShortOutput ?? true,
            }))
        );

        // Custom WER Scoring: drop worst image, average remaining WERs
        if (state.scoringMode.value === "customWER" && imageScores.length > 1) {
            const sortedWERs = imageScores
                .map(s => s.wer)
                .sort((a, b) => b - a); // descending
            const kept = sortedWERs.slice(1); // drop worst
            const customWER = kept.reduce((sum, w) => sum + w, 0) / kept.length;
            return {
                averageCER,
                averageWER,
                combinedScore: customWER,
                legacyCombinedScore,
                averageLengthRatio: robust.averageLengthRatio,
                medianLengthRatio: robust.medianLengthRatio,
                emptyOutputRate: robust.emptyOutputRate,
                veryShortOutputRate: robust.veryShortOutputRate,
                averageUnderproductionRate: robust.averageUnderproductionRate,
                feasible: robust.feasible,
            };
        }

        return {
            averageCER,
            averageWER,
            combinedScore: robust.score,
            legacyCombinedScore,
            averageLengthRatio: robust.averageLengthRatio,
            medianLengthRatio: robust.medianLengthRatio,
            emptyOutputRate: robust.emptyOutputRate,
            veryShortOutputRate: robust.veryShortOutputRate,
            averageUnderproductionRate: robust.averageUnderproductionRate,
            feasible: robust.feasible,
        };
    }

    type RunExecutionOptions = {
        runDirectory: string;
        runStartedAt: string;
        dimensions: ParameterDimension[];
        totalIterations: number;
        initialSamples: number;
        candidateSamples: number;
        startIteration: number;
        initialResults: IterationResult[];
        nextIterationId: number;
    };

    type ResumeMetaFile = {
        runDirectory?: unknown;
        startedAt?: unknown;
        selectedEngine?: unknown;
        scoringMode?: unknown;
        optimizerSettings?: {
            iterations?: unknown;
            totalIterations?: unknown;
            initialSamples?: unknown;
            candidateSamples?: unknown;
        };
        parameterConfigs?: unknown;
        images?: Array<{ filename?: unknown; groundTruthSource?: unknown }>;
    };

    type ResumeResultsFile = {
        totalIterations?: unknown;
        results?: unknown;
    };

    type ResumeInputImage = {
        filename: string;
        mimeType: string;
        dataUrl: string;
        groundTruth: string | null;
        groundTruthRegions?: GroundTruthRegion[];
        groundTruthMeta?: GroundTruthMeta;
        groundTruthSource?: "txt" | "gt.json" | null;
    };

    type ResumeInputsFile = {
        images?: unknown;
    };

    type ResumeLoadResult =
        | {
            ok: true;
            runDirectory: string;
            runStartedAt: string;
            selectedEngine: EngineType;
            scoringMode: ScoringMode;
            parameterConfigs: ParameterConfigMap;
            totalIterations: number;
            initialSamples: number;
            candidateSamples: number;
            results: IterationResult[];
            requiredImageNames: string[];
            resumeInputImages: ResumeInputImage[];
        }
        | {
            ok: false;
            error: string;
        };

    function isValidRunDirectory(directory: string): boolean {
        return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(directory);
    }

    function getFolderNameFromSelection(files: File[]): string | null {
        for (const file of files) {
            const relativePath =
                (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
            if (!relativePath) continue;
            const [folder] = relativePath.split("/");
            if (folder) return folder;
        }
        return null;
    }

    function isImageFile(file: File): boolean {
        return (
            file.type.startsWith("image/") ||
            /\.(jpg|jpeg|png|gif|bmp|webp|tiff?)$/i.test(file.name)
        );
    }

    async function parseGroundTruth(
        textFile?: File,
        gtJsonFile?: File
    ): Promise<{
        groundTruth: string | null;
        groundTruthRegions?: GroundTruthRegion[];
        groundTruthMeta?: GroundTruthMeta;
        groundTruthSource?: "txt" | "gt.json";
    }> {
        if (gtJsonFile) {
            try {
                const raw = await gtJsonFile.text();
                const parsed = JSON.parse(raw) as {
                    fullText?: string;
                    image?: { width: number; height: number };
                    rotation?: number;
                    rectificationApplied?: boolean;
                    layoutModelId?: string;
                    regions?: Array<{
                        id: string;
                        label: string;
                        bbox: { x: number; y: number; width: number; height: number };
                        text?: string;
                        order?: number;
                        source?: string;
                    }>;
                };

                const regions = (parsed.regions ?? [])
                    .filter((r) => r && r.bbox && typeof r.text === "string")
                    .map((r) => ({
                        id: r.id,
                        label: r.label,
                        bbox: r.bbox,
                        text: r.text ?? "",
                        order: r.order,
                        source: r.source,
                    }));

                const fullText =
                    typeof parsed.fullText === "string"
                        ? parsed.fullText
                        : regions.map((r) => r.text).join("\n").trim();

                return {
                    groundTruth: fullText ?? null,
                    groundTruthRegions: regions,
                    groundTruthMeta: parsed.image
                        ? {
                            width: parsed.image.width,
                            height: parsed.image.height,
                            rotation: parsed.rotation,
                            rectificationApplied: parsed.rectificationApplied,
                            layoutModelId: parsed.layoutModelId,
                        }
                        : undefined,
                    groundTruthSource: "gt.json",
                };
            } catch (error) {
                console.warn("[TuningRunner] Failed to parse .gt.json while resuming:", error);
            }
        }

        if (textFile) {
            const groundTruth = await textFile.text();
            return {
                groundTruth,
                groundTruthSource: "txt",
            };
        }

        return { groundTruth: null };
    }

    function normalizeFilename(name: string): string {
        return name.trim().toLowerCase();
    }

    async function restoreImagesFromResumeInputs(
        resumeInputImages: ResumeInputImage[],
        requiredImageNames: string[]
    ): Promise<{ success: boolean; error?: string }> {
        if (resumeInputImages.length === 0) {
            return { success: false };
        }

        const byFilename = new Map(
            resumeInputImages.map((img) => [normalizeFilename(img.filename), img])
        );

        const selected = requiredImageNames.length > 0
            ? requiredImageNames
                .map((filename) => byFilename.get(normalizeFilename(filename)) ?? null)
                .filter((img): img is ResumeInputImage => Boolean(img))
            : resumeInputImages;

        if (requiredImageNames.length > 0) {
            const selectedNames = new Set(
                selected.map((img) => normalizeFilename(img.filename))
            );
            const missingImages = requiredImageNames.filter(
                (name) => !selectedNames.has(normalizeFilename(name))
            );
            if (missingImages.length > 0) {
                return { success: false };
            }
        }

        if (selected.length === 0) {
            return { success: false };
        }

        state.clearImages();
        for (const saved of selected) {
            const file = dataUrlToFile(saved.dataUrl, saved.filename, saved.mimeType);
            if (!file) {
                return {
                    success: false,
                    error: `Gespeichertes Bild konnte nicht rekonstruiert werden: ${saved.filename}`,
                };
            }

            if (!saved.groundTruth) {
                return {
                    success: false,
                    error: `Ground Truth fehlt im gespeicherten Resume-Bild: ${saved.filename}`,
                };
            }

            const tuningImage: TuningImage = {
                file,
                url: URL.createObjectURL(file),
                filename: saved.filename,
                groundTruth: saved.groundTruth,
                groundTruthRegions: saved.groundTruthRegions,
                groundTruthMeta: saved.groundTruthMeta,
                groundTruthSource: saved.groundTruthSource ?? undefined,
                hasGroundTruth: true,
                groundTruthChecked: true,
            };
            state.addImage(tuningImage);
        }

        return { success: true };
    }

    async function restoreImagesFromFolderFiles(
        files: File[],
        requiredImageNames: string[]
    ): Promise<{ success: boolean; error?: string }> {
        const imageFiles = files.filter(isImageFile);
        if (imageFiles.length === 0) {
            return {
                success: false,
                error: "Keine Bilddateien im ausgewählten Ordner gefunden.",
            };
        }

        const imageByName = new Map<string, File>();
        for (const file of imageFiles) {
            imageByName.set(normalizeFilename(file.name), file);
        }

        const selectedImageFiles = requiredImageNames.length > 0
            ? requiredImageNames
                .map((name) => imageByName.get(normalizeFilename(name)) ?? null)
                .filter((file): file is File => Boolean(file))
            : imageFiles;

        if (requiredImageNames.length > 0) {
            const selectedNames = new Set(
                selectedImageFiles.map((file) => normalizeFilename(file.name))
            );
            const missingImages = requiredImageNames.filter(
                (name) => !selectedNames.has(normalizeFilename(name))
            );
            if (missingImages.length > 0) {
                return {
                    success: false,
                    error: `Diese Run-Bilder fehlen im Ordner: ${missingImages.slice(0, 3).join(", ")}`,
                };
            }
        }

        if (selectedImageFiles.length === 0) {
            return {
                success: false,
                error: "Die für den Run benötigten Bilder sind im ausgewählten Ordner nicht vorhanden.",
            };
        }

        const textFiles = files.filter((f) => f.name.toLowerCase().endsWith(".txt"));
        const gtJsonFiles = files.filter((f) => f.name.toLowerCase().endsWith(".gt.json"));

        const textFileMap = new Map<string, File>();
        for (const tf of textFiles) {
            const baseName = tf.name.replace(/\.txt$/i, "");
            textFileMap.set(normalizeFilename(baseName), tf);
        }

        const gtJsonMap = new Map<string, File>();
        for (const gf of gtJsonFiles) {
            const baseName = gf.name.replace(/\.gt\.json$/i, "");
            gtJsonMap.set(normalizeFilename(baseName), gf);
        }

        state.clearImages();
        const missingGt: string[] = [];

        for (const imageFile of selectedImageFiles) {
            const baseName = imageFile.name.replace(/\.[^.]+$/, "");
            const key = normalizeFilename(baseName);
            const gt = await parseGroundTruth(textFileMap.get(key), gtJsonMap.get(key));
            if (!gt.groundTruth) {
                missingGt.push(imageFile.name);
                continue;
            }

            const tuningImage: TuningImage = {
                file: imageFile,
                url: URL.createObjectURL(imageFile),
                filename: imageFile.name,
                groundTruth: gt.groundTruth,
                groundTruthRegions: gt.groundTruthRegions,
                groundTruthMeta: gt.groundTruthMeta,
                groundTruthSource: gt.groundTruthSource,
                hasGroundTruth: true,
                groundTruthChecked: true,
            };
            state.addImage(tuningImage);
        }

        if (missingGt.length > 0) {
            state.clearImages();
            return {
                success: false,
                error: `Für diese Bilder fehlt Ground Truth: ${missingGt.slice(0, 3).join(", ")}`,
            };
        }

        return { success: true };
    }

    async function restoreResumeImages(
        files: File[],
        requiredImageNames: string[],
        resumeInputImages: ResumeInputImage[]
    ): Promise<{ success: boolean; error?: string }> {
        const fromSavedInputs = await restoreImagesFromResumeInputs(
            resumeInputImages,
            requiredImageNames
        );
        if (fromSavedInputs.success || fromSavedInputs.error) {
            return fromSavedInputs;
        }

        return restoreImagesFromFolderFiles(files, requiredImageNames);
    }

    async function loadResumeFromFolder(files: File[]): Promise<ResumeLoadResult> {
        if (files.length === 0) {
            return { ok: false, error: "Kein Ordner ausgewählt." };
        }

        const runMetaFile = files.find((file) => file.name === "run_meta.json");
        const allResultsFile = files.find((file) => file.name === "all_results.json");
        const runInputsFile = files.find((file) => file.name === "run_inputs.json");

        if (!runMetaFile || !allResultsFile) {
            return {
                ok: false,
                error: "Ordner enthält nicht `run_meta.json` und `all_results.json`.",
            };
        }

        let meta: ResumeMetaFile;
        let allResults: ResumeResultsFile;
        let runInputs: ResumeInputsFile | null = null;
        try {
            meta = JSON.parse(await runMetaFile.text()) as ResumeMetaFile;
            allResults = JSON.parse(await allResultsFile.text()) as ResumeResultsFile;
            if (runInputsFile) {
                runInputs = JSON.parse(await runInputsFile.text()) as ResumeInputsFile;
            }
        } catch {
            return { ok: false, error: "Run-Dateien konnten nicht gelesen/geparst werden." };
        }

        const folderName = getFolderNameFromSelection(files);
        const runDirectory =
            typeof meta.runDirectory === "string" ? meta.runDirectory : folderName;
        if (!runDirectory || !isValidRunDirectory(runDirectory)) {
            return { ok: false, error: "Ungültiger Run-Ordnername." };
        }

        const selectedEngine = meta.selectedEngine;
        if (selectedEngine !== "paddleocr" && selectedEngine !== "tesseract") {
            return { ok: false, error: "Ungültige Engine in run_meta.json." };
        }
        const scoringMode: ScoringMode = meta.scoringMode === "regions" ? "regions"
            : meta.scoringMode === "customWER" ? "customWER" : "fulltext";

        if (
            !meta.parameterConfigs ||
            typeof meta.parameterConfigs !== "object" ||
            Array.isArray(meta.parameterConfigs)
        ) {
            return { ok: false, error: "Ungültige Parameter-Konfiguration in run_meta.json." };
        }

        const parsedResults = Array.isArray(allResults.results)
            ? (allResults.results as IterationResult[])
            : [];
        const results = [...parsedResults].sort((a, b) => a.id - b.id);

        const optimizerSettings = meta.optimizerSettings ?? {};
        const totalFromSnapshot =
            typeof allResults.totalIterations === "number" && Number.isFinite(allResults.totalIterations)
                ? allResults.totalIterations
                : null;
        const totalFromMeta =
            typeof optimizerSettings.totalIterations === "number" && Number.isFinite(optimizerSettings.totalIterations)
                ? optimizerSettings.totalIterations
                : null;
        const totalFromIterations =
            typeof optimizerSettings.iterations === "number" && Number.isFinite(optimizerSettings.iterations)
                ? optimizerSettings.iterations
                : null;
        const totalIterations = Math.floor(totalFromSnapshot ?? totalFromMeta ?? totalFromIterations ?? 0);
        if (totalIterations <= 0) {
            return { ok: false, error: "Ungültige Gesamtanzahl Iterationen im Run." };
        }

        const initialSamplesRaw =
            typeof optimizerSettings.initialSamples === "number" &&
            Number.isFinite(optimizerSettings.initialSamples)
                ? optimizerSettings.initialSamples
                : 1;
        const candidateSamplesRaw =
            typeof optimizerSettings.candidateSamples === "number" &&
            Number.isFinite(optimizerSettings.candidateSamples)
                ? optimizerSettings.candidateSamples
                : 600;
        const initialSamples = Math.min(
            Math.max(1, Math.floor(initialSamplesRaw)),
            totalIterations
        );
        const candidateSamples = Math.max(50, Math.floor(candidateSamplesRaw));

        const requiredImageNames = (meta.images ?? [])
            .map((img) => (typeof img.filename === "string" ? img.filename : null))
            .filter((name): name is string => Boolean(name));

        const fallbackImageNamesFromResults =
            requiredImageNames.length > 0
                ? []
                : Array.from(
                    new Set(
                        results.flatMap((result) =>
                            result.imageScores.map((score) => score.filename)
                        )
                    )
                );

        const parsedResumeInputImages = Array.isArray(runInputs?.images)
            ? (runInputs.images as ResumeInputImage[]).filter(
                (item) =>
                    item &&
                    typeof item.filename === "string" &&
                    typeof item.mimeType === "string" &&
                    typeof item.dataUrl === "string"
            )
            : [];

        return {
            ok: true,
            runDirectory,
            runStartedAt:
                typeof meta.startedAt === "string"
                    ? meta.startedAt
                    : new Date().toISOString(),
            selectedEngine,
            scoringMode,
            parameterConfigs: meta.parameterConfigs as ParameterConfigMap,
            totalIterations,
            initialSamples,
            candidateSamples,
            results,
            requiredImageNames:
                requiredImageNames.length > 0
                    ? requiredImageNames
                    : fallbackImageNamesFromResults,
            resumeInputImages: parsedResumeInputImages,
        };
    }

    async function executeRun(options: RunExecutionOptions): Promise<void> {
        const imagesWithGt = state.imagesWithGroundTruth.value;
        if (imagesWithGt.length === 0) {
            state.errorRun("Keine Bilder mit Ground Truth gefunden");
            return;
        }

        // Initialize OCR
        try {
            await OCRService.init(state.selectedEngine.value);
        } catch (error) {
            state.errorRun(`OCR-Initialisierung fehlgeschlagen: ${error}`);
            return;
        }

        // Preload images
        const imageDataMap = new Map<string, ImageData>();
        try {
            for (const img of imagesWithGt) {
                const imageData = await loadImageData(img.url);
                imageDataMap.set(img.filename, imageData);
            }
        } catch (error) {
            state.errorRun(`Bild-Laden fehlgeschlagen: ${error}`);
            return;
        }

        let iterationId = options.nextIterationId;
        const gp = new GaussianProcess(0.5, 1.0, 0.1);
        const seen = new Set<string>();
        let bestScore = Number.POSITIVE_INFINITY;
        let lastEngineSignature: string | null = null;

        for (const existing of options.initialResults) {
            seen.add(permutationKey(existing.parameters));
            if (options.dimensions.length > 0) {
                gp.addObservation(
                    normalizePermutation(existing.parameters, options.dimensions),
                    existing.combinedScore
                );
            }
            if (existing.combinedScore < bestScore) {
                bestScore = existing.combinedScore;
            }
        }

        for (let i = options.startIteration; i < options.totalIterations; i++) {
            if (abortController.value?.signal.aborted) {
                break;
            }

            await waitForUnpause();

            if (abortController.value?.signal.aborted) {
                break;
            }

            let permutation: ParameterPermutation = [];
            if (options.dimensions.length === 0) {
                permutation = [];
            } else if (i < options.initialSamples) {
                permutation = randomPermutation(options.dimensions);
            } else {
                permutation = suggestNextPermutation(
                    gp,
                    options.dimensions,
                    bestScore,
                    options.candidateSamples,
                    seen
                );
            }

            let attempt = 0;
            while (
                options.dimensions.length > 0 &&
                seen.has(permutationKey(permutation)) &&
                attempt < 20
            ) {
                permutation = randomPermutation(options.dimensions);
                attempt++;
            }

            seen.add(permutationKey(permutation));
            state.setCurrentPermutation(permutation);

            try {
                OCRService.resetConfig();
                OCRService.setConfig({ engine: state.selectedEngine.value });
                if (permutation.length > 0) {
                    const partialConfig = permutationToPartialConfig(permutation);
                    OCRService.setConfig(partialConfig);
                }
                const currentConfig = OCRService.getConfig();
                const engineSignature =
                    currentConfig.engine === "paddleocr"
                        ? `paddleocr|${currentConfig.paddleocr.version}|${currentConfig.paddleocr.language}|${currentConfig.paddleocr.useWebGPU}`
                        : "tesseract";

                if (engineSignature !== lastEngineSignature) {
                    await OCRService.unload();
                    await OCRService.init(currentConfig.engine);
                    lastEngineSignature = engineSignature;
                }

                const imageScores: ImageScore[] = [];

                for (const img of imagesWithGt) {
                    const imageData = imageDataMap.get(img.filename);
                    if (!imageData || !img.groundTruth) continue;

                    const result = await OCRService.recognize(imageData);
                    const ocrText = result.text;
                    let cer = calculateCER(ocrText, img.groundTruth);
                    let wer = calculateWER(ocrText, img.groundTruth);
                    let regionScores: RegionScore[] | undefined = undefined;
                    if (state.scoringMode.value === "regions") {
                        const regionMetrics = await computeMacroRegionMetrics(
                            imageData,
                            img.groundTruthRegions,
                            img.groundTruthMeta?.rotation
                        );
                        if (regionMetrics) {
                            cer = regionMetrics.weightedCER;
                            wer = regionMetrics.weightedWER;
                            regionScores = regionMetrics.regionScores;
                        }
                    }
                    const lengthDiagnostics = calculateLengthDiagnostics(
                        ocrText,
                        img.groundTruth
                    );
                    const layout = result.layout ?? undefined;

                    imageScores.push({
                        filename: img.filename,
                        ocrText,
                        groundTruth: img.groundTruth,
                        cer,
                        wer,
                        ocrLength: lengthDiagnostics.ocrLength,
                        groundTruthLength: lengthDiagnostics.groundTruthLength,
                        lengthRatio: lengthDiagnostics.lengthRatio,
                        underproductionRate: lengthDiagnostics.underproductionRate,
                        isEmptyOutput: lengthDiagnostics.isEmptyOutput,
                        isVeryShortOutput: lengthDiagnostics.isVeryShortOutput,
                        regionScores,
                        layout,
                    });

                    state.updateImageOcrResult(img.filename, ocrText, cer, wer, layout);
                    await sleep(0);
                }

                const evaluated = evaluateIterationScores(imageScores);

                const result: IterationResult = {
                    id: iterationId++,
                    parameters: permutation,
                    imageScores,
                    averageCER: evaluated.averageCER,
                    averageWER: evaluated.averageWER,
                    combinedScore: evaluated.combinedScore,
                    legacyCombinedScore: evaluated.legacyCombinedScore,
                    averageLengthRatio: evaluated.averageLengthRatio,
                    medianLengthRatio: evaluated.medianLengthRatio,
                    emptyOutputRate: evaluated.emptyOutputRate,
                    veryShortOutputRate: evaluated.veryShortOutputRate,
                    averageUnderproductionRate: evaluated.averageUnderproductionRate,
                    feasible: evaluated.feasible,
                    timestamp: Date.now(),
                };

                state.addResult(result);
                if (options.dimensions.length > 0) {
                    gp.addObservation(
                        normalizePermutation(permutation, options.dimensions),
                        evaluated.combinedScore
                    );
                }
                if (evaluated.combinedScore < bestScore) {
                    bestScore = evaluated.combinedScore;
                }

                await saveIterationSnapshots(
                    options.runDirectory,
                    options.runStartedAt,
                    options.totalIterations,
                    i + 1,
                    result
                );

                await sleep(10);
            } catch (error) {
                console.error("[TuningRunner] Iteration error:", error);
            } finally {
                state.incrementCompleted();
            }
        }

        if (abortController.value?.signal.aborted) {
            state.setStatus("idle");
        } else {
            state.completeRun();
        }

        state.setCurrentPermutation(null);
        abortController.value = null;
    }

    /**
     * Start the tuning run
     */
    async function start(): Promise<void> {
        if (state.runState.value.status !== "idle") {
            console.warn("[TuningRunner] Cannot start: not idle");
            return;
        }

        const imagesWithGt = state.imagesWithGroundTruth.value;
        if (imagesWithGt.length === 0) {
            state.errorRun("Keine Bilder mit Ground Truth gefunden");
            return;
        }

        const dimensions = buildParameterDimensions(state.parameterConfigs.value);
        const spaceSize = parameterSpaceSize(dimensions);
        const optimizer = state.optimizerSettings.value;
        const safeIterations = Math.max(1, Math.floor(optimizer.iterations));
        const totalIterations =
            dimensions.length === 0 ? 1 : Math.min(safeIterations, spaceSize);
        const initialSamples = Math.min(
            Math.max(1, Math.floor(optimizer.initialSamples)),
            totalIterations
        );
        const candidateSamples = Math.max(50, Math.floor(optimizer.candidateSamples));
        const runStartDate = new Date();
        const runStartedAt = runStartDate.toISOString();
        const runDirectory = formatRunDirectoryName(runStartDate);

        if (dimensions.length === 0) {
            console.warn("[TuningRunner] Keine Parameter aktiviert. Es läuft nur die Standard-Konfiguration.");
        } else if (spaceSize <= 1) {
            console.warn("[TuningRunner] Parameterraum hat nur 1 Kombination. Erhöhe Steps oder aktiviere weitere Parameter.");
        }

        // Initialize
        abortController.value = new AbortController();
        isPaused.value = false;
        state.startRun();
        state.setTotalPermutations(totalIterations);
        await saveRunMeta(
            runDirectory,
            runStartedAt,
            totalIterations,
            initialSamples,
            candidateSamples
        );
        await saveRunInputs(runDirectory);

        await executeRun({
            runDirectory,
            runStartedAt,
            dimensions,
            totalIterations,
            initialSamples,
            candidateSamples,
            startIteration: 0,
            initialResults: [],
            nextIterationId: 0,
        });
    }

    async function resumeFromFolderFiles(files: File[]): Promise<{ success: boolean; error?: string }> {
        if (state.runState.value.status !== "idle") {
            return { success: false, error: "Resume ist nur im Idle-Zustand möglich." };
        }

        const loaded = await loadResumeFromFolder(files);
        if (!loaded.ok) {
            return { success: false, error: loaded.error };
        }

        const restoreResult = await restoreResumeImages(
            files,
            loaded.requiredImageNames,
            loaded.resumeInputImages
        );
        if (!restoreResult.success) {
            return {
                success: false,
                error:
                    restoreResult.error ??
                    "Bilder und Ground Truth konnten für Resume nicht geladen werden.",
            };
        }

        state.setEngine(loaded.selectedEngine);
        state.setScoringMode(loaded.scoringMode);
        state.clearParameterConfigs();
        for (const [path, config] of Object.entries(loaded.parameterConfigs)) {
            state.setParameterConfig(path, config);
        }
        state.setOptimizerSettings({
            iterations: loaded.totalIterations,
            initialSamples: loaded.initialSamples,
            candidateSamples: loaded.candidateSamples,
        });

        const dimensions = buildParameterDimensions(loaded.parameterConfigs);
        const spaceSize = parameterSpaceSize(dimensions);
        const totalIterations =
            dimensions.length === 0
                ? 1
                : Math.min(loaded.totalIterations, spaceSize);
        const initialSamples = Math.min(
            Math.max(1, loaded.initialSamples),
            totalIterations
        );
        const candidateSamples = Math.max(50, loaded.candidateSamples);
        const resumedStartTimeRaw = Date.parse(loaded.runStartedAt);
        const resumedStartTime =
            Number.isFinite(resumedStartTimeRaw) ? resumedStartTimeRaw : Date.now();
        const totalPermutations = Math.max(totalIterations, loaded.results.length);

        isPaused.value = false;
        state.hydrateRunForResume(totalPermutations, loaded.results, resumedStartTime);

        if (loaded.results.length >= totalIterations) {
            abortController.value = null;
            state.completeRun();
            return { success: true };
        }

        const maxId = loaded.results.reduce((max, result) => Math.max(max, result.id), -1);
        abortController.value = new AbortController();

        await executeRun({
            runDirectory: loaded.runDirectory,
            runStartedAt: loaded.runStartedAt,
            dimensions,
            totalIterations,
            initialSamples,
            candidateSamples,
            startIteration: loaded.results.length,
            initialResults: loaded.results,
            nextIterationId: maxId + 1,
        });

        return { success: true };
    }

    /**
     * Pause the tuning run
     */
    function pause(): void {
        if (state.runState.value.status !== "running") return;
        isPaused.value = true;
        state.pauseRun();
    }

    /**
     * Resume the tuning run
     */
    function resume(): void {
        if (state.runState.value.status !== "paused") return;
        isPaused.value = false;
        state.resumeRun();
    }

    /**
     * Abort the tuning run
     */
    function abort(): void {
        abortController.value?.abort();
        isPaused.value = false;
        state.resetRun();
    }

    /**
     * Run a single iteration with specific parameters (for testing)
     */
    async function runSingle(permutation: ParameterPermutation): Promise<IterationResult | null> {
        const imagesWithGt = state.imagesWithGroundTruth.value;
        if (imagesWithGt.length === 0) return null;

        // Initialize OCR
        await OCRService.init(state.selectedEngine.value);

        // Apply config
        OCRService.resetConfig();
        OCRService.setConfig({ engine: state.selectedEngine.value });
        if (permutation.length > 0) {
            const partialConfig = permutationToPartialConfig(permutation);
            OCRService.setConfig(partialConfig);
        }
        const currentConfig = OCRService.getConfig();
        await OCRService.unload();
        await OCRService.init(currentConfig.engine);

        const imageScores: ImageScore[] = [];

        for (const img of imagesWithGt) {
            const imageData = await loadImageData(img.url);
            if (!img.groundTruth) continue;

            const result = await OCRService.recognize(imageData);
            const ocrText = result.text;
            let cer = calculateCER(ocrText, img.groundTruth);
            let wer = calculateWER(ocrText, img.groundTruth);
            let regionScores: RegionScore[] | undefined = undefined;
            if (state.scoringMode.value === "regions") {
                const regionMetrics = await computeMacroRegionMetrics(
                    imageData,
                    img.groundTruthRegions,
                    img.groundTruthMeta?.rotation
                );
                if (regionMetrics) {
                    cer = regionMetrics.weightedCER;
                    wer = regionMetrics.weightedWER;
                    regionScores = regionMetrics.regionScores;
                }
            }
            const lengthDiagnostics = calculateLengthDiagnostics(ocrText, img.groundTruth);
            const layout = result.layout ?? undefined;

            imageScores.push({
                filename: img.filename,
                ocrText,
                groundTruth: img.groundTruth,
                cer,
                wer,
                ocrLength: lengthDiagnostics.ocrLength,
                groundTruthLength: lengthDiagnostics.groundTruthLength,
                lengthRatio: lengthDiagnostics.lengthRatio,
                underproductionRate: lengthDiagnostics.underproductionRate,
                isEmptyOutput: lengthDiagnostics.isEmptyOutput,
                isVeryShortOutput: lengthDiagnostics.isVeryShortOutput,
                regionScores,
                layout,
            });
        }

        const evaluated = evaluateIterationScores(imageScores);

        return {
            id: 0,
            parameters: permutation,
            imageScores,
            averageCER: evaluated.averageCER,
            averageWER: evaluated.averageWER,
            combinedScore: evaluated.combinedScore,
            legacyCombinedScore: evaluated.legacyCombinedScore,
            averageLengthRatio: evaluated.averageLengthRatio,
            medianLengthRatio: evaluated.medianLengthRatio,
            emptyOutputRate: evaluated.emptyOutputRate,
            veryShortOutputRate: evaluated.veryShortOutputRate,
            averageUnderproductionRate: evaluated.averageUnderproductionRate,
            feasible: evaluated.feasible,
            timestamp: Date.now(),
        };
    }

    return {
        isPaused: readonly(isPaused),
        start,
        resumeFromFolderFiles,
        pause,
        resume,
        abort,
        runSingle,
    };
}
