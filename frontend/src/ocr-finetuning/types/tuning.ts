/**
 * OCR Finetuning Tool - Type Definitions
 */

import type { OCRConfig } from "@/services/ocr/config";
import type { LayoutResult, BoundingBox } from "@/services/ocr/types";

// =============================================================================
// Parameter Configuration
// =============================================================================

export type ParameterType = "number" | "boolean" | "enum";

export interface ParameterMetadata {
    /** Dot-notation path in OCRConfig, e.g. "paddleocr.detThreshold" */
    path: string;
    /** Display label */
    label: string;
    /** Parameter type */
    type: ParameterType;
    /** Grouping for UI accordion */
    group: ParameterGroup;
    /** Description in German */
    description: string;
    /** Only relevant for specific engine */
    engineSpecific?: "tesseract" | "paddleocr";
    /** For number type: minimum value */
    min?: number;
    /** For number type: maximum value */
    max?: number;
    /** For number type: step/precision */
    step?: number;
    /** For enum type: available options */
    options?: string[];
}

export type ParameterGroup =
    | "engine"
    | "paddleocr"
    | "rectification"
    | "preprocessing"
    | "layout"
    | "rotation"
    | "fallback"
    | "table"
    | "output";

// =============================================================================
// Parameter Iteration Configuration
// =============================================================================

export interface NumberParameterConfig {
    enabled: boolean;
    min: number;
    max: number;
    steps: number;
}

export interface BooleanParameterConfig {
    enabled: boolean;
}

export interface EnumParameterConfig {
    enabled: boolean;
    selectedValues: string[];
}

export type ParameterConfig =
    | NumberParameterConfig
    | BooleanParameterConfig
    | EnumParameterConfig;

/** Map of parameter path to its iteration config */
export type ParameterConfigMap = Record<string, ParameterConfig>;

// =============================================================================
// Optimizer Settings
// =============================================================================

export interface OptimizerSettings {
    iterations: number;
    initialSamples: number;
    candidateSamples: number;
}

export type ScoringMode = "fulltext" | "regions" | "customWER";

// =============================================================================
// Permutation Types
// =============================================================================

/** Single value assignment for a parameter */
export interface ParameterValue {
    path: string;
    value: number | boolean | string;
}

/** A complete parameter combination */
export type ParameterPermutation = ParameterValue[];

// =============================================================================
// Image & Ground Truth
// =============================================================================

export interface TuningImage {
    /** File object from input */
    file: File;
    /** Object URL for display */
    url: string;
    /** Image filename */
    filename: string;
    /** Ground truth text (from .txt file) */
    groundTruth: string | null;
    /** Ground truth regions (from .gt.json) */
    groundTruthRegions?: GroundTruthRegion[];
    /** Ground truth metadata (from .gt.json) */
    groundTruthMeta?: GroundTruthMeta;
    /** Ground truth source */
    groundTruthSource?: "txt" | "gt.json";
    /** Whether ground truth was loaded successfully */
    hasGroundTruth: boolean;
    /** Whether GT sidecar lookup was actually performed in the same selection context */
    groundTruthChecked?: boolean;
    /** OCR result from current/best run */
    ocrResult?: string;
    /** CER from current/best run */
    cer?: number;
    /** WER from current/best run */
    wer?: number;
    /** Latest layout detection result */
    layout?: LayoutResult;
}

export interface GroundTruthRegion {
    id: string;
    label: string;
    bbox: BoundingBox;
    text: string;
    order?: number;
    source?: string;
}

export interface GroundTruthMeta {
    width: number;
    height: number;
    rotation?: number;
    rectificationApplied?: boolean;
    layoutModelId?: string;
}

// =============================================================================
// Iteration Results
// =============================================================================

export interface ImageScore {
    filename: string;
    ocrText: string;
    groundTruth: string;
    cer: number;
    wer: number;
    /** Length of normalized OCR text */
    ocrLength?: number;
    /** Length of normalized ground truth text */
    groundTruthLength?: number;
    /** OCR length relative to ground truth length */
    lengthRatio?: number;
    /** Underproduction relative to GT length (0..1) */
    underproductionRate?: number;
    /** Whether OCR output is empty after normalization */
    isEmptyOutput?: boolean;
    /** Whether OCR output is very short (<10 chars) while GT is non-trivial */
    isVeryShortOutput?: boolean;
    regionScores?: RegionScore[];
    /** Layout detection result (if available) */
    layout?: LayoutResult;
}

export interface RegionScore {
    id: string;
    label: string;
    weight: number;
    ocrText: string;
    groundTruth: string;
    cer: number;
    wer: number;
}

export interface IterationResult {
    /** Unique iteration ID */
    id: number;
    /** Parameter values used */
    parameters: ParameterPermutation;
    /** Per-image scores */
    imageScores: ImageScore[];
    /** Average CER across all images */
    averageCER: number;
    /** Average WER across all images */
    averageWER: number;
    /** Combined score (for sorting) */
    combinedScore: number;
    /** Previous CER/WER-only score for comparison */
    legacyCombinedScore?: number;
    /** Average OCR/GT length ratio across documents */
    averageLengthRatio?: number;
    /** Median OCR/GT length ratio across documents */
    medianLengthRatio?: number;
    /** Share of docs with empty OCR output */
    emptyOutputRate?: number;
    /** Share of docs with very short OCR output */
    veryShortOutputRate?: number;
    /** Average underproduction rate across docs */
    averageUnderproductionRate?: number;
    /** Whether quality guardrails are satisfied */
    feasible?: boolean;
    /** Timestamp */
    timestamp: number;
}

// =============================================================================
// Tuning Run State
// =============================================================================

export type TuningStatus =
    | "idle"
    | "running"
    | "paused"
    | "completed"
    | "error";

export interface TuningRunState {
    /** Current status */
    status: TuningStatus;
    /** Total number of permutations */
    totalPermutations: number;
    /** Number of completed permutations */
    completedPermutations: number;
    /** Currently running permutation */
    currentPermutation: ParameterPermutation | null;
    /** All iteration results */
    results: IterationResult[];
    /** Best result so far */
    bestResult: IterationResult | null;
    /** Start time in ms */
    startTime: number | null;
    /** Error message if any */
    error: string | null;
}

// =============================================================================
// WebSocket Messages
// =============================================================================

export interface SaveTuningResultPayload {
    filename: string;
    content: string;
    directory?: string;
}

export interface SaveTuningResultResponse {
    success: boolean;
    filepath?: string;
    error?: string;
}

// =============================================================================
// Export Config
// =============================================================================

export interface ExportMetadata {
    /** Image filenames used */
    images: readonly string[];
    /** Best CER achieved */
    cer: number;
    /** Best WER achieved */
    wer: number;
    /** Export timestamp */
    date: string;
}

// =============================================================================
// Deep Partial for Config Updates
// =============================================================================

export type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type PartialOCRConfig = DeepPartial<OCRConfig>;
