/**
 * OCR Service Types
 *
 * Unified type definitions for the OCR pipeline.
 * All types in one place - no re-exports, no legacy types.
 */

// =============================================================================
// Geometry
// =============================================================================

export interface BoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Point2D {
    x: number;
    y: number;
}

export interface DocumentCorners {
    topLeft: Point2D;
    topRight: Point2D;
    bottomRight: Point2D;
    bottomLeft: Point2D;
}

// =============================================================================
// OCR Results
// =============================================================================

export interface OCRWord {
    text: string;
    confidence: number; // 0-1
    bbox: BoundingBox;
}

export interface OCRLine {
    text: string;
    confidence: number; // 0-1
    bbox?: BoundingBox;
    words?: OCRWord[];
}

export interface OCRResult {
    text: string;
    confidence: number; // 0-1
    lines?: OCRLine[];
    words?: OCRWord[];
}

// =============================================================================
// Layout Detection
// =============================================================================

export const LAYOUT_LABELS = {
    0: "Caption",
    1: "Footnote",
    2: "Formula",
    3: "List-item",
    4: "Page-footer",
    5: "Page-header",
    6: "Picture",
    7: "Section-header",
    8: "Table",
    9: "Text",
    10: "Title",
} as const;

export type LayoutLabel = (typeof LAYOUT_LABELS)[keyof typeof LAYOUT_LABELS];

export interface LayoutRegion {
    label: LayoutLabel;
    labelId: number;
    score: number;
    bbox: BoundingBox;
}

export interface LayoutResult {
    regions: LayoutRegion[];
    imageWidth: number;
    imageHeight: number;
}

// =============================================================================
// Region OCR Results
// =============================================================================

export interface RegionOCRResult {
    region: LayoutRegion;
    text: string;
    confidence: number;
    lines: Array<{ text: string; confidence: number }>;
    isTable?: boolean;
    tableData?: TableResult;
}

export interface TableCell {
    text: string;
    confidence: number;
    row: number;
    col: number;
    bbox: BoundingBox;
}

export interface TableResult {
    cells: TableCell[];
    rows: number;
    cols: number;
    markdown: string;
    tsv: string;
}

// =============================================================================
// Rectification
// =============================================================================

export interface RectificationResult {
    image: ImageData;
    documentFound: boolean;
    confidence: number;
    corners?: DocumentCorners;
    processingTime: number;
}

// =============================================================================
// Preprocessing
// =============================================================================

export interface PreprocessingResult {
    image: ImageData;
    wasProcessed: boolean;
    processingTime: number;
}

// =============================================================================
// Pipeline
// =============================================================================

export interface PipelineResult {
    /** Full recognized text */
    text: string;
    /** Alias for text for compatibility with old pipeline */
    fullText: string;
    /** Overall confidence (0-1) */
    confidence: number;
    /** Per-region results (if layout detection was used) */
    regions?: RegionOCRResult[];
    /** Detected tables */
    tables?: TableResult[];
    /** Layout detection result */
    layout?: LayoutResult;
    /** Detected rotation (degrees) */
    rotation: number;
    /** Whether rectification was applied */
    rectificationApplied: boolean;
    /** Processing timings */
    timings: PipelineTimings;
}

export interface PipelineTimings {
    total: number;
    rectification?: number;
    preprocessing?: number;
    layout?: number;
    ocr?: number;
    rotation?: number;
}

// =============================================================================
// Engine
// =============================================================================

export type EngineType = "tesseract" | "paddleocr";

export interface EngineOptions {
    languages?: string[];
    psm?: number;
    dpi?: number;
    onProgress?: (progress: number) => void;
}

export interface EngineCapabilities {
    name: string;
    languages: string[];
    supportsGPU: boolean;
    supportsWordBboxes: boolean;
    supportsLineBboxes: boolean;
    modelSizeMB: number;
}

// =============================================================================
// Input Types
// =============================================================================

export type ImageInput = ImageData | Blob | HTMLCanvasElement | OffscreenCanvas;

// =============================================================================
// Progress Callback
// =============================================================================

export type ProgressCallback = (stage: string, progress: number) => void;
