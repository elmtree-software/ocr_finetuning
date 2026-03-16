/**
 * Layout Detection
 *
 * YOLO-based document layout detection using Transformers.js.
 * Includes NMS (Non-Maximum Suppression) and XY-Cut reading order.
 */

import { AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";
import type { LayoutResult, LayoutRegion, LayoutLabel, BoundingBox } from "./types";
import { LAYOUT_LABELS } from "./types";
import { getConfig, MODEL_PATHS } from "./config";

// =============================================================================
// Model State
// =============================================================================

let model: any = null;
let processor: any = null;
let loadPromise: Promise<void> | null = null;

// =============================================================================
// Model Loading
// =============================================================================

export async function loadLayoutModel(): Promise<void> {
    if (model && processor) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        console.log("[Layout] Loading model...");

        const [loadedModel, loadedProcessor] = await Promise.all([
            AutoModel.from_pretrained(MODEL_PATHS.layout.modelId, { dtype: "fp32" }),
            AutoProcessor.from_pretrained(MODEL_PATHS.layout.modelId),
        ]);

        model = loadedModel;
        processor = loadedProcessor;
        console.log("[Layout] Model ready");
    })().catch((err) => {
        // Reset loadPromise on error so retry is possible
        loadPromise = null;
        throw err;
    });

    return loadPromise;
}

export function isLayoutModelLoaded(): boolean {
    return model !== null && processor !== null;
}

export function unloadLayoutModel(): void {
    model = null;
    processor = null;
    loadPromise = null;
    console.log("[Layout] Model unloaded");
}

// =============================================================================
// Layout Detection
// =============================================================================

export async function detectLayout(imageSource: string | Blob | HTMLCanvasElement): Promise<LayoutResult> {
    await loadLayoutModel();

    const config = getConfig();

    // Load image
    let image: Awaited<ReturnType<typeof RawImage.read>>;
    if (typeof imageSource === "string") {
        image = await RawImage.read(imageSource);
    } else if (imageSource instanceof Blob) {
        const url = URL.createObjectURL(imageSource);
        try {
            image = await RawImage.read(url);
        } finally {
            URL.revokeObjectURL(url);
        }
    } else {
        const dataUrl = imageSource.toDataURL("image/png");
        image = await RawImage.read(dataUrl);
    }

    // Process image
    const processed = await processor!(image);
    const { pixel_values, reshaped_input_sizes } = processed;

    // Run inference
    const { output0 } = await model!({ images: pixel_values });

    // Process predictions manually
    const predictions = output0.tolist()[0] as number[][];

    // Handle different formats of reshaped_input_sizes
    let sizes: number[];
    try {
        if (Array.isArray(reshaped_input_sizes)) {
            sizes = (reshaped_input_sizes as any).flat();
        } else if (reshaped_input_sizes && typeof (reshaped_input_sizes as any).tolist === "function") {
            sizes = (reshaped_input_sizes as any).tolist().flat();
        } else if (reshaped_input_sizes && (reshaped_input_sizes as any).data) {
            sizes = Array.from((reshaped_input_sizes as any).data);
        } else {
            sizes = [image.height, image.width];
        }
    } catch (e) {
        console.warn("[Layout] Failed to parse reshaped_input_sizes, using fallback", e);
        sizes = [image.height, image.width];
    }

    if (!sizes || sizes.length < 2 || !sizes[0] || !sizes[1]) {
        sizes = [image.height, image.width];
    }
    const [newHeight, newWidth] = sizes;
    const scaleX = image.width / newWidth;
    const scaleY = image.height / newHeight;

    const regions: LayoutRegion[] = [];

    for (const [xmin, ymin, xmax, ymax, score, id] of predictions) {
        if (score < config.layout.detectionThreshold) continue;

        const labelId = Math.round(id);
        const label = LAYOUT_LABELS[labelId as keyof typeof LAYOUT_LABELS];

        if (!label) continue;

        // Ultra-safe sanitization: 2 pixel margin from edges
        const x = Math.floor(Math.max(2, Math.min(image.width - 10, xmin * scaleX)));
        const y = Math.floor(Math.max(2, Math.min(image.height - 10, ymin * scaleY)));
        const width = Math.ceil(Math.max(5, Math.min(image.width - x - 2, (xmax - xmin) * scaleX)));
        const height = Math.ceil(Math.max(5, Math.min(image.height - y - 2, (ymax - ymin) * scaleY)));

        regions.push({
            label,
            labelId,
            score,
            bbox: { x, y, width, height },
        });
    }

    // Apply NMS (only if needed, but keeping for safety if model doesn't do it)
    const filteredRegions = nonMaxSuppression(regions);

    // Sort by reading order
    const sortedRegions = sortByReadingOrder(filteredRegions, image.width);

    return {
        regions: sortedRegions,
        imageWidth: image.width,
        imageHeight: image.height,
    };
}

// =============================================================================
// Non-Maximum Suppression
// =============================================================================

function nonMaxSuppression(regions: LayoutRegion[]): LayoutRegion[] {
    if (regions.length === 0) return [];

    const config = getConfig();
    const { iouThreshold, containmentThreshold } = config.layout.nms;

    const sorted = [...regions].sort((a, b) => b.score - a.score);
    const kept: LayoutRegion[] = [];
    const suppressed = new Set<number>();

    for (let i = 0; i < sorted.length; i++) {
        if (suppressed.has(i)) continue;

        const current = sorted[i];
        kept.push(current);

        for (let j = i + 1; j < sorted.length; j++) {
            if (suppressed.has(j)) continue;

            const other = sorted[j];
            const iou = calculateIoU(current.bbox, other.bbox);

            if (
                iou > iouThreshold ||
                containsRegion(current.bbox, other.bbox, containmentThreshold) ||
                containsRegion(other.bbox, current.bbox, containmentThreshold)
            ) {
                suppressed.add(j);
            }
        }
    }

    return kept;
}

function calculateIoU(a: BoundingBox, b: BoundingBox): number {
    const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const intersection = xOverlap * yOverlap;

    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    const union = areaA + areaB - intersection;

    return union > 0 ? intersection / union : 0;
}

function containsRegion(outer: BoundingBox, inner: BoundingBox, threshold: number): boolean {
    const xOverlap = Math.max(0, Math.min(outer.x + outer.width, inner.x + inner.width) - Math.max(outer.x, inner.x));
    const yOverlap = Math.max(0, Math.min(outer.y + outer.height, inner.y + inner.height) - Math.max(outer.y, inner.y));
    const intersection = xOverlap * yOverlap;
    const innerArea = inner.width * inner.height;

    return innerArea > 0 && intersection / innerArea >= threshold;
}

// =============================================================================
// Reading Order (XY-Cut)
// =============================================================================

function sortByReadingOrder(regions: LayoutRegion[], imageWidth: number): LayoutRegion[] {
    if (regions.length <= 1) return regions;

    const config = getConfig();

    if (!config.layout.xyCut.enabled) {
        return [...regions].sort((a, b) => a.bbox.y - b.bbox.y);
    }

    const { minGapThreshold, spanningThreshold, maxDepth } = config.layout.xyCut;

    // Phase 1: Pre-masking - separate spanning elements
    const spanningWidth = imageWidth * spanningThreshold;
    const masked: LayoutRegion[] = [];
    const unmasked: LayoutRegion[] = [];

    for (const region of regions) {
        if (region.bbox.width >= spanningWidth) {
            masked.push(region);
        } else {
            unmasked.push(region);
        }
    }

    if (unmasked.length === 0) {
        return [...masked].sort((a, b) => a.bbox.y - b.bbox.y);
    }

    // Phase 2: Recursive XY-Cut
    const orderedUnmasked = xyCutSort(unmasked, minGapThreshold, maxDepth, 0);

    // Phase 3: Re-map masked elements
    return remapMaskedElements(orderedUnmasked, masked);
}

interface XYCutNode {
    regions: LayoutRegion[];
    children: XYCutNode[];
}

function xyCutSort(
    regions: LayoutRegion[],
    minGapThreshold: number,
    maxDepth: number,
    depth: number
): LayoutRegion[] {
    if (regions.length <= 1 || depth >= maxDepth) {
        return [...regions].sort((a, b) => a.bbox.y - b.bbox.y);
    }

    const horizontalCut = findBestCut(regions, "horizontal");
    const verticalCut = findBestCut(regions, "vertical");

    let bestCut: { position: number; gap: number; direction: "horizontal" | "vertical" } | null = null;

    if (horizontalCut.gap >= minGapThreshold && verticalCut.gap >= minGapThreshold) {
        bestCut = horizontalCut.gap >= verticalCut.gap
            ? { ...horizontalCut, direction: "horizontal" }
            : { ...verticalCut, direction: "vertical" };
    } else if (horizontalCut.gap >= minGapThreshold) {
        bestCut = { ...horizontalCut, direction: "horizontal" };
    } else if (verticalCut.gap >= minGapThreshold) {
        bestCut = { ...verticalCut, direction: "vertical" };
    }

    if (!bestCut) {
        return [...regions].sort((a, b) => a.bbox.y - b.bbox.y);
    }

    const { above, below } = splitRegions(regions, bestCut.position, bestCut.direction);

    if (above.length === 0 || below.length === 0) {
        return [...regions].sort((a, b) => a.bbox.y - b.bbox.y);
    }

    const sortedAbove = xyCutSort(above, minGapThreshold, maxDepth, depth + 1);
    const sortedBelow = xyCutSort(below, minGapThreshold, maxDepth, depth + 1);

    return [...sortedAbove, ...sortedBelow];
}

function findBestCut(
    regions: LayoutRegion[],
    direction: "horizontal" | "vertical"
): { position: number; gap: number } {
    if (regions.length < 2) return { position: 0, gap: 0 };

    const events: { pos: number; type: "start" | "end" }[] = [];

    for (const r of regions) {
        if (direction === "horizontal") {
            events.push({ pos: r.bbox.y, type: "start" });
            events.push({ pos: r.bbox.y + r.bbox.height, type: "end" });
        } else {
            events.push({ pos: r.bbox.x, type: "start" });
            events.push({ pos: r.bbox.x + r.bbox.width, type: "end" });
        }
    }

    events.sort((a, b) => a.pos - b.pos);

    let activeCount = 0;
    let bestGap = 0;
    let bestPosition = 0;
    let gapStart = 0;

    for (const event of events) {
        if (activeCount === 0 && event.type === "start") {
            const gap = event.pos - gapStart;
            if (gap > bestGap) {
                bestGap = gap;
                bestPosition = gapStart + gap / 2;
            }
        }

        if (event.type === "start") {
            activeCount++;
        } else {
            activeCount--;
            if (activeCount === 0) {
                gapStart = event.pos;
            }
        }
    }

    return { position: bestPosition, gap: bestGap };
}

function splitRegions(
    regions: LayoutRegion[],
    position: number,
    direction: "horizontal" | "vertical"
): { above: LayoutRegion[]; below: LayoutRegion[] } {
    const above: LayoutRegion[] = [];
    const below: LayoutRegion[] = [];

    for (const r of regions) {
        const center = direction === "horizontal"
            ? r.bbox.y + r.bbox.height / 2
            : r.bbox.x + r.bbox.width / 2;

        if (center < position) {
            above.push(r);
        } else {
            below.push(r);
        }
    }

    return { above, below };
}

function remapMaskedElements(ordered: LayoutRegion[], masked: LayoutRegion[]): LayoutRegion[] {
    if (masked.length === 0) return ordered;
    if (ordered.length === 0) return [...masked].sort((a, b) => a.bbox.y - b.bbox.y);

    const sortedMasked = [...masked].sort((a, b) => a.bbox.y - b.bbox.y);
    const result: LayoutRegion[] = [];
    let maskedIdx = 0;

    for (const region of ordered) {
        while (maskedIdx < sortedMasked.length) {
            const maskedRegion = sortedMasked[maskedIdx];
            const maskedBottom = maskedRegion.bbox.y + maskedRegion.bbox.height;

            if (maskedBottom <= region.bbox.y + region.bbox.height * 0.3) {
                result.push(maskedRegion);
                maskedIdx++;
            } else {
                break;
            }
        }

        result.push(region);
    }

    while (maskedIdx < sortedMasked.length) {
        result.push(sortedMasked[maskedIdx]);
        maskedIdx++;
    }

    return result;
}

// =============================================================================
// Region Filtering
// =============================================================================

export function getTextRegions(layout: LayoutResult): LayoutRegion[] {
    const config = getConfig();
    const textTypes = config.layout.textRegionTypes as readonly string[];
    return layout.regions.filter((r) => textTypes.includes(r.label));
}

export function getTableRegions(layout: LayoutResult): LayoutRegion[] {
    return layout.regions.filter((r) => r.label === "Table");
}

// =============================================================================
// Fallback Areas Detection
// =============================================================================

export function findUncoveredAreas(
    layout: LayoutResult
): BoundingBox[] {
    const config = getConfig();

    if (!config.fallback.enabled) return [];

    const { gridSize, minAreaRatio } = config.fallback;
    const { regions, imageWidth, imageHeight } = layout;

    if (regions.length === 0) {
        return [{ x: 0, y: 0, width: imageWidth, height: imageHeight }];
    }

    const gridCols = Math.ceil(imageWidth / gridSize);
    const gridRows = Math.ceil(imageHeight / gridSize);
    const covered = new Array(gridRows).fill(null).map(() => new Array(gridCols).fill(false));

    for (const region of regions) {
        const startCol = Math.floor(region.bbox.x / gridSize);
        const endCol = Math.ceil((region.bbox.x + region.bbox.width) / gridSize);
        const startRow = Math.floor(region.bbox.y / gridSize);
        const endRow = Math.ceil((region.bbox.y + region.bbox.height) / gridSize);

        for (let row = Math.max(0, startRow); row < Math.min(gridRows, endRow); row++) {
            for (let col = Math.max(0, startCol); col < Math.min(gridCols, endCol); col++) {
                covered[row][col] = true;
            }
        }
    }

    const uncoveredAreas: BoundingBox[] = [];
    const visited = new Array(gridRows).fill(null).map(() => new Array(gridCols).fill(false));

    for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
            if (!covered[row][col] && !visited[row][col]) {
                let maxRow = row, maxCol = col;

                while (maxCol + 1 < gridCols && !covered[row][maxCol + 1] && !visited[row][maxCol + 1]) {
                    maxCol++;
                }

                let canExpand = true;
                while (canExpand && maxRow + 1 < gridRows) {
                    for (let c = col; c <= maxCol; c++) {
                        if (covered[maxRow + 1][c] || visited[maxRow + 1][c]) {
                            canExpand = false;
                            break;
                        }
                    }
                    if (canExpand) maxRow++;
                }

                for (let r = row; r <= maxRow; r++) {
                    for (let c = col; c <= maxCol; c++) {
                        visited[r][c] = true;
                    }
                }

                const bbox: BoundingBox = {
                    x: col * gridSize,
                    y: row * gridSize,
                    width: Math.min((maxCol - col + 1) * gridSize, imageWidth - col * gridSize),
                    height: Math.min((maxRow - row + 1) * gridSize, imageHeight - row * gridSize),
                };

                const areaRatio = (bbox.width * bbox.height) / (imageWidth * imageHeight);
                if (areaRatio >= minAreaRatio) {
                    uncoveredAreas.push(bbox);
                }
            }
        }
    }

    return uncoveredAreas;
}
