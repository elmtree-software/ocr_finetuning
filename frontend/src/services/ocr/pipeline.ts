/**
 * OCR Pipeline
 *
 * Orchestrates the full OCR pipeline:
 * Rectification → Preprocessing → Layout Detection → OCR
 */

import type {
    PipelineResult,
    PipelineTimings,
    RegionOCRResult,
    LayoutRegion,
    TableResult,
    TableCell,
    ImageInput,
    ProgressCallback,
    BoundingBox,
} from "./types";
import { getConfig } from "./config";
import { getEngine, toImageData, toBlob, imageDataToCanvas } from "./engine";
import { rectify } from "./rectification";
import { preprocess } from "./preprocessing";
import { detectLayout, loadLayoutModel, getTextRegions, getTableRegions, findUncoveredAreas } from "./layout";

// =============================================================================
// Pipeline Execution
// =============================================================================

export async function runPipeline(
    image: ImageInput,
    options?: {
        languages?: string[];
        onProgress?: ProgressCallback;
    }
): Promise<PipelineResult> {
    const config = getConfig();
    const onProgress = options?.onProgress;
    const languages = options?.languages ?? ["deu", "eng"];

    const timings: PipelineTimings = { total: 0 };
    const t0 = performance.now();
    let lastMark = t0;

    const mark = (name: keyof PipelineTimings) => {
        const now = performance.now();
        timings[name] = now - lastMark;
        lastMark = now;
        if (config.debug.logTiming) {
            console.log(`[Pipeline] ${name}: ${timings[name]!.toFixed(0)}ms`);
        }
    };

    onProgress?.("loading", 0);

    // Convert input to ImageData
    let imageData = await toImageData(image);

    // === Step 1: Rectification ===
    let rectificationApplied = false;
    if (config.rectification.enabled) {
        onProgress?.("rectification", 0.05);
        const rectResult = await rectify(imageData);
        if (rectResult.documentFound) {
            imageData = rectResult.image;
            rectificationApplied = true;
            if (config.debug.verbose) {
                console.log(`[Pipeline] Rectification applied (conf=${(rectResult.confidence * 100).toFixed(1)}%)`);
            }
        }
        mark("rectification");
    }

    // === Step 2: Preprocessing ===
    onProgress?.("preprocessing", 0.1);
    const prepResult = await preprocess(imageData);
    if (prepResult.wasProcessed) {
        imageData = prepResult.image;
    }
    mark("preprocessing");

    // Create canvas from processed image
    let canvas = imageDataToCanvas(imageData);

    // === Step 3: Get OCR Engine ===
    onProgress?.("engine", 0.12);
    const engine = await getEngine();

    // === Step 4: Rotation Detection ===
    let rotation = 0;
    if (config.rotation.enabled) {
        onProgress?.("rotation", 0.15);
        rotation = await detectBestRotation(canvas, engine, languages);
        if (rotation !== 0) {
            canvas = rotateCanvas(canvas, rotation);
            imageData = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
        }
        mark("rotation");
    }

    // === Step 5: Layout Detection or Simple OCR ===
    if (config.layout.enabled) {
        return await runLayoutPipeline(canvas, engine, languages, {
            rotation,
            rectificationApplied,
            timings,
            t0,
            onProgress,
        });
    } else {
        return await runSimplePipeline(canvas, engine, languages, {
            rotation,
            rectificationApplied,
            timings,
            t0,
            onProgress,
        });
    }
}

// =============================================================================
// Layout-Aware Pipeline
// =============================================================================

async function runLayoutPipeline(
    canvas: OffscreenCanvas,
    engine: Awaited<ReturnType<typeof getEngine>>,
    languages: string[],
    context: {
        rotation: number;
        rectificationApplied: boolean;
        timings: PipelineTimings;
        t0: number;
        onProgress?: ProgressCallback;
    }
): Promise<PipelineResult> {
    const config = getConfig();
    const { timings, t0, onProgress, rotation, rectificationApplied } = context;
    let lastMark = performance.now();

    const mark = (name: keyof PipelineTimings) => {
        const now = performance.now();
        timings[name] = now - lastMark;
        lastMark = now;
    };

    onProgress?.("layout", 0.2);

    // Load layout model and detect
    await loadLayoutModel();
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const layout = await detectLayout(blob);
    mark("layout");

    onProgress?.("ocr", 0.35);

    // Get text and table regions
    const textRegions = getTextRegions(layout);
    const tableRegions = config.table.enabled ? getTableRegions(layout) : [];

    if (config.debug.verbose) {
        console.log(`[Pipeline] Layout: ${layout.regions.length} total, ${textRegions.length} text, ${tableRegions.length} tables`);
    }

    // Find uncovered areas for fallback OCR
    const uncoveredAreas = findUncoveredAreas(layout);
    const fallbackRegions: LayoutRegion[] = uncoveredAreas.map((bbox) => ({
        label: "Text" as const,
        labelId: 9,
        score: 0.1,
        bbox,
    }));

    // Process regions
    const regionResults: RegionOCRResult[] = [];
    const tables: TableResult[] = [];
    const totalRegions = textRegions.length + tableRegions.length + fallbackRegions.length;
    let processedCount = 0;

    // OCR text regions
    for (const region of textRegions) {
        const result = await ocrRegion(canvas, region, engine, languages);
        if (result.text) {
            regionResults.push(result);
        }
        processedCount++;
        onProgress?.("ocr", 0.35 + (0.55 * processedCount) / Math.max(totalRegions, 1));
    }

    // Process tables
    for (const tableRegion of tableRegions) {
        const tableResult = await processTable(canvas, tableRegion, engine, languages);
        tables.push(tableResult);

        const tableText = config.table.outputFormat === "markdown"
            ? tableResult.markdown
            : config.table.outputFormat === "tsv"
                ? tableResult.tsv
                : tableResult.cells.map((c) => c.text).join(" ");

        const avgConf = tableResult.cells.length > 0
            ? tableResult.cells.reduce((sum, c) => sum + c.confidence, 0) / tableResult.cells.length
            : 0;

        regionResults.push({
            region: tableRegion,
            text: tableText,
            confidence: avgConf,
            lines: [],
            isTable: true,
            tableData: tableResult,
        });

        processedCount++;
        onProgress?.("ocr", 0.35 + (0.55 * processedCount) / Math.max(totalRegions, 1));
    }

    // Fallback OCR for uncovered areas
    for (const fallbackRegion of fallbackRegions) {
        const result = await ocrRegion(canvas, fallbackRegion, engine, languages);
        if (result.text && result.confidence >= config.fallback.minConfidence) {
            regionResults.push(result);
            if (config.debug.verbose) {
                console.log(`[Pipeline] Fallback found text: "${result.text.substring(0, 50)}..."`);
            }
        }
        processedCount++;
        onProgress?.("ocr", 0.35 + (0.55 * processedCount) / Math.max(totalRegions, 1));
    }

    // Sort results by Y position
    regionResults.sort((a, b) => a.region.bbox.y - b.region.bbox.y);

    // Combine results
    const fullText = regionResults.map((r) => r.text).join("\n\n");
    const avgConfidence = regionResults.length > 0
        ? regionResults.reduce((sum, r) => sum + r.confidence, 0) / regionResults.length
        : 0;

    mark("ocr");
    timings.total = performance.now() - t0;

    onProgress?.("done", 1);

    if (config.debug.logTiming) {
        console.log("[Pipeline] Total:", timings);
    }

    return {
        text: fullText,
        fullText: fullText,
        confidence: avgConfidence,
        regions: regionResults,
        tables,
        layout,
        rotation,
        rectificationApplied,
        timings,
    };
}

// =============================================================================
// Simple Pipeline (no layout detection)
// =============================================================================

async function runSimplePipeline(
    canvas: OffscreenCanvas,
    engine: Awaited<ReturnType<typeof getEngine>>,
    languages: string[],
    context: {
        rotation: number;
        rectificationApplied: boolean;
        timings: PipelineTimings;
        t0: number;
        onProgress?: ProgressCallback;
    }
): Promise<PipelineResult> {
    const config = getConfig();
    const { timings, t0, onProgress, rotation, rectificationApplied } = context;

    onProgress?.("ocr", 0.5);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const result = await engine.recognize(blob, { languages });

    timings.ocr = performance.now() - (t0 + (timings.rectification ?? 0) + (timings.preprocessing ?? 0) + (timings.rotation ?? 0));
    timings.total = performance.now() - t0;

    onProgress?.("done", 1);

    return {
        text: result.text.trim(),
        fullText: result.text.trim(),
        confidence: result.confidence,
        rotation,
        rectificationApplied,
        timings,
    };
}

// =============================================================================
// Region OCR
// =============================================================================

/**
 * Determines the appropriate PSM (Page Segmentation Mode) for a region.
 * Uses per-region overrides from config, falling back to the default PSM.
 */
function getPsmForRegion(region: LayoutRegion, config: ReturnType<typeof getConfig>): number {
    const override = config.layout.psmModes.regionOverrides[region.label];
    if (override !== undefined) return override;
    return config.layout.psmModes.default;
}

async function ocrRegion(
    canvas: OffscreenCanvas,
    region: LayoutRegion,
    engine: Awaited<ReturnType<typeof getEngine>>,
    languages: string[]
): Promise<RegionOCRResult> {
    const config = getConfig();
    const padding = config.layout.regionPadding;

    // Ultra-safe crop: 2px margin from image edges to avoid Tesseract/Leptonica boundary errors
    const { x, y, width, height } = region.bbox;
    let cropX = Math.floor(Math.max(2, Math.min(canvas.width - 12, x - padding)));
    let cropY = Math.floor(Math.max(2, Math.min(canvas.height - 12, y - padding)));
    let cropW = Math.ceil(Math.min(canvas.width - cropX - 2, Math.max(10, width + padding * 2)));
    let cropH = Math.ceil(Math.min(canvas.height - cropY - 2, Math.max(10, height + padding * 2)));

    // Safety: Ensure at least size for Tesseract and add white padding
    // Tesseract needs a white border around text for reliable recognition
    const internalPadding = config.layout.internalPadding;
    const finalW = cropW + internalPadding * 2;
    const finalH = cropH + internalPadding * 2;

    const cropped = new OffscreenCanvas(finalW, finalH);
    const ctx = cropped.getContext("2d")!;

    // White background (required for Tesseract)
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, finalW, finalH);

    // Draw centered with padding
    ctx.drawImage(
        canvas,
        cropX, cropY, cropW, cropH,
        internalPadding, internalPadding, cropW, cropH
    );

    // Scaling up for better Tesseract quality & stability
    const upscale = 2;
    const scaledW = finalW * upscale;
    const scaledH = finalH * upscale;
    const scaledCanvas = new OffscreenCanvas(scaledW, scaledH);
    const scaledCtx = scaledCanvas.getContext("2d")!;

    scaledCtx.fillStyle = "white";
    scaledCtx.fillRect(0, 0, scaledW, scaledH);
    scaledCtx.imageSmoothingEnabled = true;
    scaledCtx.imageSmoothingQuality = "high";
    scaledCtx.drawImage(cropped, 0, 0, finalW, finalH, 0, 0, scaledW, scaledH);

    // Select appropriate PSM mode based on region type
    const psm = getPsmForRegion(region, config);

    const blob = await scaledCanvas.convertToBlob({ type: "image/png" });
    const result = await engine.recognize(blob, { languages, psm });

    // Extract and filter lines
    const lines: Array<{ text: string; confidence: number }> = [];
    const minConfidence = config.output.minLineConfidence;
    const minWordConfidence = config.output.minWordConfidence;

    if (result.lines && result.lines.length > 0) {
        for (const line of result.lines) {
            const text = Array.isArray(line.words) && line.words.length > 0
                ? line.words
                    .filter((word) => (word.confidence ?? 0) >= minWordConfidence)
                    .map((word) => word.text?.trim() ?? "")
                    .filter((word) => word.length > 0)
                    .join(" ")
                : line.text?.trim() || "";
            if (text.length >= config.output.minTextLength && line.confidence >= minConfidence) {
                lines.push({ text, confidence: line.confidence * 100 });
            }
        }
    } else if (result.text) {
        const textLines = result.text.split("\n").filter((t) => t.trim());
        for (const text of textLines) {
            if (text.length >= config.output.minTextLength) {
                lines.push({ text: text.trim(), confidence: result.confidence * 100 });
            }
        }
    }

    const fullText = lines.map((l) => l.text).join("\n");
    const avgConfidence = lines.length > 0
        ? lines.reduce((sum, l) => sum + l.confidence, 0) / lines.length / 100
        : 0;

    return {
        region,
        text: fullText,
        confidence: avgConfidence,
        lines,
    };
}

// =============================================================================
// Table Processing
// =============================================================================

async function processTable(
    canvas: OffscreenCanvas,
    region: LayoutRegion,
    engine: Awaited<ReturnType<typeof getEngine>>,
    languages: string[]
): Promise<TableResult> {
    const config = getConfig();
    const padding = config.layout.regionPadding;

    // Crop table region
    const { x, y, width, height } = region.bbox;
    const cropX = Math.max(0, Math.floor(x - padding));
    const cropY = Math.max(0, Math.floor(y - padding));
    const cropW = Math.min(canvas.width - cropX, Math.ceil(width + padding * 2));
    const cropH = Math.min(canvas.height - cropY, Math.ceil(height + padding * 2));

    const cropped = new OffscreenCanvas(cropW, cropH);
    const ctx = cropped.getContext("2d")!;
    ctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    const blob = await cropped.convertToBlob({ type: "image/png" });
    const result = await engine.recognize(blob, { languages });

    // Simple cell extraction from words
    const cells: TableCell[] = [];

    if (result.words && result.words.length > 0) {
        // Cluster words into rows and columns
        const { rowClusters, colClusters } = clusterCells(
            result.words,
            config.table.rowClusterTolerance,
            config.table.colClusterTolerance
        );

        for (const word of result.words) {
            const row = findCluster(word.bbox.y + word.bbox.height / 2, rowClusters);
            const col = findCluster(word.bbox.x + word.bbox.width / 2, colClusters);

            cells.push({
                text: word.text,
                confidence: word.confidence,
                row,
                col,
                bbox: word.bbox,
            });
        }
    }

    const rows = cells.length > 0 ? Math.max(...cells.map((c) => c.row)) + 1 : 0;
    const cols = cells.length > 0 ? Math.max(...cells.map((c) => c.col)) + 1 : 0;

    // Generate output formats
    const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(""));
    for (const cell of cells) {
        if (grid[cell.row][cell.col]) {
            grid[cell.row][cell.col] += " " + cell.text;
        } else {
            grid[cell.row][cell.col] = cell.text;
        }
    }

    const markdown = gridToMarkdown(grid);
    const tsv = gridToTSV(grid);

    return { cells, rows, cols, markdown, tsv };
}

function clusterCells(
    words: Array<{ bbox: BoundingBox }>,
    rowTolerance: number,
    colTolerance: number
): { rowClusters: number[]; colClusters: number[] } {
    const rowPositions = words.map((w) => w.bbox.y + w.bbox.height / 2);
    const colPositions = words.map((w) => w.bbox.x + w.bbox.width / 2);

    const rowClusters = clusterPositions(rowPositions, rowTolerance);
    const colClusters = clusterPositions(colPositions, colTolerance);

    return { rowClusters, colClusters };
}

function clusterPositions(positions: number[], tolerance: number): number[] {
    const sorted = [...new Set(positions)].sort((a, b) => a - b);
    const clusters: number[] = [];
    let currentCluster = sorted[0];

    for (const pos of sorted) {
        if (pos - currentCluster > tolerance) {
            currentCluster = pos;
        }
        clusters.push(currentCluster);
    }

    // Create mapping from position to cluster index
    const clusterSet = [...new Set(clusters)].sort((a, b) => a - b);
    return positions.map((pos) => {
        const nearestCluster = clusterSet.reduce((a, b) =>
            Math.abs(b - pos) < Math.abs(a - pos) ? b : a
        );
        return clusterSet.indexOf(nearestCluster);
    });
}

function findCluster(position: number, clusters: number[]): number {
    // This is a simplified version - in production you'd want proper clustering
    return clusters[0] ?? 0;
}

function gridToMarkdown(grid: string[][]): string {
    if (grid.length === 0) return "";

    const lines: string[] = [];

    // Header
    lines.push("| " + grid[0].join(" | ") + " |");
    lines.push("| " + grid[0].map(() => "---").join(" | ") + " |");

    // Body
    for (let i = 1; i < grid.length; i++) {
        lines.push("| " + grid[i].join(" | ") + " |");
    }

    return lines.join("\n");
}

function gridToTSV(grid: string[][]): string {
    return grid.map((row) => row.join("\t")).join("\n");
}

// =============================================================================
// Rotation Detection
// =============================================================================

async function detectBestRotation(
    canvas: OffscreenCanvas,
    engine: Awaited<ReturnType<typeof getEngine>>,
    languages: string[]
): Promise<number> {
    const config = getConfig();

    if (!config.rotation.enabled) return 0;

    const angleStep = config.rotation.angleStep ?? 90;
    const angles = config.rotation.fastMode
        ? [0, 180]
        : Array.from({ length: Math.floor(360 / angleStep) }, (_, i) => i * angleStep);

    // Test 0°
    const blob0 = await canvas.convertToBlob({ type: "image/png" });
    const result0 = await engine.recognize(blob0, { languages });
    const conf0 = result0.confidence * 100;

    if (conf0 >= config.rotation.skipThreshold) {
        if (config.debug.verbose) {
            console.log(`[Pipeline] Rotation: 0° (conf=${conf0.toFixed(1)}% >= threshold)`);
        }
        return 0;
    }

    let bestRotation = 0;
    let bestConf = conf0;

    for (const angle of angles) {
        if (angle === 0) continue;

        const rotated = rotateCanvas(canvas, angle);
        const blob = await rotated.convertToBlob({ type: "image/png" });
        const result = await engine.recognize(blob, { languages });
        const conf = result.confidence * 100;

        if (config.debug.verbose) {
            console.log(`[Pipeline] Rotation test: ${angle}° = ${conf.toFixed(1)}%`);
        }

        if (conf > bestConf + config.rotation.minImprovement) {
            bestConf = conf;
            bestRotation = angle;
        }
    }

    if (config.debug.verbose) {
        console.log(`[Pipeline] Best rotation: ${bestRotation}° (conf=${bestConf.toFixed(1)}%)`);
    }

    return bestRotation;
}

function rotateCanvas(canvas: OffscreenCanvas, degrees: number): OffscreenCanvas {
    if (degrees === 0) return canvas;

    const radians = (degrees * Math.PI) / 180;
    const sin = Math.abs(Math.sin(radians));
    const cos = Math.abs(Math.cos(radians));

    const newWidth = Math.floor(canvas.width * cos + canvas.height * sin);
    const newHeight = Math.floor(canvas.width * sin + canvas.height * cos);

    const rotated = new OffscreenCanvas(newWidth, newHeight);
    const ctx = rotated.getContext("2d")!;

    ctx.translate(newWidth / 2, newHeight / 2);
    ctx.rotate(radians);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);

    return rotated;
}
