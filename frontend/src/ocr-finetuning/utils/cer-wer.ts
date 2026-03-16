/**
 * CER/WER Calculation Utilities
 *
 * Character Error Rate (CER) and Word Error Rate (WER) calculation
 * using Levenshtein distance.
 */

/**
 * Calculate Levenshtein distance between two strings.
 * Uses dynamic programming with O(min(m,n)) space complexity.
 */
export function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Ensure a is the shorter string for space optimization
    if (a.length > b.length) {
        [a, b] = [b, a];
    }

    const m = a.length;
    const n = b.length;

    // Use single row optimization
    let prev = new Array(m + 1);
    let curr = new Array(m + 1);

    // Initialize first row
    for (let i = 0; i <= m; i++) {
        prev[i] = i;
    }

    // Fill the matrix
    for (let j = 1; j <= n; j++) {
        curr[0] = j;

        for (let i = 1; i <= m; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[i] = Math.min(
                prev[i] + 1, // deletion
                curr[i - 1] + 1, // insertion
                prev[i - 1] + cost // substitution
            );
        }

        // Swap rows
        [prev, curr] = [curr, prev];
    }

    return prev[m];
}

/**
 * Normalize text for comparison.
 * - Trim whitespace
 * - Normalize multiple spaces to single space
 * - Lowercase for case-insensitive comparison
 */
export function normalizeText(text: string): string {
    return text
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

/**
 * Split text into words for WER calculation.
 */
export function tokenizeWords(text: string): string[] {
    return normalizeText(text)
        .split(" ")
        .filter((w) => w.length > 0);
}

/**
 * Calculate Character Error Rate (CER).
 *
 * CER = Levenshtein(ocr, groundTruth) / len(groundTruth)
 *
 * @param ocr - OCR output text
 * @param groundTruth - Ground truth text
 * @returns CER as a value between 0 and 1 (or higher if very bad)
 */
export function calculateCER(ocr: string, groundTruth: string): number {
    const ocrNorm = normalizeText(ocr);
    const gtNorm = normalizeText(groundTruth);

    if (gtNorm.length === 0) {
        return ocrNorm.length === 0 ? 0 : 1;
    }

    const distance = levenshteinDistance(ocrNorm, gtNorm);
    return distance / gtNorm.length;
}

/**
 * Calculate Word Error Rate (WER).
 *
 * WER = Levenshtein(ocrWords, gtWords) / len(gtWords)
 *
 * @param ocr - OCR output text
 * @param groundTruth - Ground truth text
 * @returns WER as a value between 0 and 1 (or higher if very bad)
 */
export function calculateWER(ocr: string, groundTruth: string): number {
    const ocrWords = tokenizeWords(ocr);
    const gtWords = tokenizeWords(groundTruth);

    if (gtWords.length === 0) {
        return ocrWords.length === 0 ? 0 : 1;
    }

    // Calculate Levenshtein distance on word arrays
    const distance = levenshteinDistanceWords(ocrWords, gtWords);
    return distance / gtWords.length;
}

/**
 * Levenshtein distance for word arrays.
 */
function levenshteinDistanceWords(a: string[], b: string[]): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Ensure a is the shorter array for space optimization
    if (a.length > b.length) {
        [a, b] = [b, a];
    }

    const m = a.length;
    const n = b.length;

    let prev = new Array(m + 1);
    let curr = new Array(m + 1);

    for (let i = 0; i <= m; i++) {
        prev[i] = i;
    }

    for (let j = 1; j <= n; j++) {
        curr[0] = j;

        for (let i = 1; i <= m; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[i] = Math.min(
                prev[i] + 1,
                curr[i - 1] + 1,
                prev[i - 1] + cost
            );
        }

        [prev, curr] = [curr, prev];
    }

    return prev[m];
}

/**
 * Calculate combined score for sorting results.
 * Lower is better.
 *
 * @param cer - Character Error Rate
 * @param wer - Word Error Rate
 * @param cerWeight - Weight for CER (default 0.7)
 * @returns Combined score
 */
export function calculateCombinedScore(
    cer: number,
    wer: number,
    cerWeight: number = 0.7
): number {
    return cer * cerWeight + wer * (1 - cerWeight);
}

export interface LengthDiagnostics {
    ocrLength: number;
    groundTruthLength: number;
    lengthRatio: number;
    underproductionRate: number;
    isEmptyOutput: boolean;
    isVeryShortOutput: boolean;
}

export interface RobustScoreInput {
    cer: number;
    wer: number;
    lengthRatio: number;
    underproductionRate: number;
    isEmptyOutput: boolean;
    isVeryShortOutput: boolean;
}

export interface RobustScoreResult {
    score: number;
    feasible: boolean;
    averageLengthRatio: number;
    medianLengthRatio: number;
    emptyOutputRate: number;
    veryShortOutputRate: number;
    averageUnderproductionRate: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Calculate length and underproduction diagnostics on normalized text.
 */
export function calculateLengthDiagnostics(
    ocr: string,
    groundTruth: string
): LengthDiagnostics {
    const ocrNorm = normalizeText(ocr);
    const gtNorm = normalizeText(groundTruth);
    const ocrLength = ocrNorm.length;
    const groundTruthLength = gtNorm.length;
    const safeGroundTruthLength = Math.max(groundTruthLength, 1);
    const lengthRatio = ocrLength / safeGroundTruthLength;
    const underproductionRate = clamp(
        (groundTruthLength - ocrLength) / safeGroundTruthLength,
        0,
        1
    );
    const isEmptyOutput = ocrLength === 0;
    const veryShortThreshold = Math.max(10, Math.floor(groundTruthLength * 0.15));
    const isVeryShortOutput = ocrLength < veryShortThreshold && groundTruthLength >= 20;

    return {
        ocrLength,
        groundTruthLength,
        lengthRatio,
        underproductionRate,
        isEmptyOutput,
        isVeryShortOutput,
    };
}

/**
 * Robust optimization objective that penalizes underproduction/empty outputs.
 * Lower is better.
 */
export function calculateRobustCombinedScore(
    imageMetrics: RobustScoreInput[]
): RobustScoreResult {
    if (imageMetrics.length === 0) {
        return {
            score: 10,
            feasible: false,
            averageLengthRatio: 0,
            medianLengthRatio: 0,
            emptyOutputRate: 1,
            veryShortOutputRate: 1,
            averageUnderproductionRate: 1,
        };
    }

    const count = imageMetrics.length;
    const baseScore =
        imageMetrics.reduce(
            (sum, metric) =>
                sum +
                (0.6 * Math.min(metric.cer, 2.5) + 0.4 * Math.min(metric.wer, 2.5)),
            0
        ) / count;

    const averageLengthRatio =
        imageMetrics.reduce((sum, metric) => sum + metric.lengthRatio, 0) / count;
    const medianLengthRatio = median(imageMetrics.map((metric) => metric.lengthRatio));
    const averageUnderproductionRate =
        imageMetrics.reduce((sum, metric) => sum + metric.underproductionRate, 0) / count;
    const averageOverproductionRate =
        imageMetrics.reduce(
            (sum, metric) => sum + clamp(metric.lengthRatio - 1, 0, 2),
            0
        ) / count;
    const emptyOutputRate =
        imageMetrics.filter((metric) => metric.isEmptyOutput).length / count;
    const veryShortOutputRate =
        imageMetrics.filter((metric) => metric.isVeryShortOutput).length / count;

    const lengthShortfallPenalty = clamp((0.85 - medianLengthRatio) / 0.85, 0, 1.2);
    const score =
        baseScore +
        0.7 * averageUnderproductionRate +
        0.2 * averageOverproductionRate +
        0.5 * lengthShortfallPenalty +
        1.1 * emptyOutputRate +
        0.45 * veryShortOutputRate;

    const feasible =
        emptyOutputRate <= 0.25 &&
        medianLengthRatio >= 0.45 &&
        veryShortOutputRate <= 0.5 &&
        averageUnderproductionRate <= 0.65;

    return {
        score: feasible ? score : score + 0.8,
        feasible,
        averageLengthRatio,
        medianLengthRatio,
        emptyOutputRate,
        veryShortOutputRate,
        averageUnderproductionRate,
    };
}

/**
 * Format error rate as percentage string.
 */
export function formatErrorRate(rate: number): string {
    return `${(rate * 100).toFixed(2)}%`;
}
