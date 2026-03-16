/**
 * Image Preprocessing (OpenCV-based)
 * 
 * High-performance image enhancement for OCR using OpenCV.js.
 * Pipeline: DPI Scaling → Inversion Fix → Grayscale → CLAHE → Contrast → Bilateral Filter → Thresholding
 */

import type { PreprocessingResult } from "./types";
import { getConfig } from "./config";
import { loadOpenCV, getCV } from "./opencv-loader";
import { matToImageData } from "./opencv-utils";

// =============================================================================
// DPI Scaling & Inversion Detection
// =============================================================================

/**
 * Minimum capital letter height in pixels for good OCR quality.
 * Tesseract works best with text at ~300 DPI, which typically means
 * capital letters should be at least 20px tall.
 */
const MIN_CAPITAL_HEIGHT_PX = 20;

/**
 * Estimates the average "capital letter height" in an image.
 * Uses a simple heuristic: analyzes vertical runs of dark pixels.
 * Returns an estimate in pixels.
 */
function estimateCapitalHeight(imageData: ImageData): number {
    const { width, height, data } = imageData;
    
    // Sample columns across the image
    const sampleCols = Math.min(20, Math.floor(width / 10));
    const colStep = Math.floor(width / (sampleCols + 1));
    
    const runLengths: number[] = [];
    
    for (let colIdx = 1; colIdx <= sampleCols; colIdx++) {
        const x = colIdx * colStep;
        let inDarkRun = false;
        let runStart = 0;
        
        for (let y = 0; y < height; y++) {
            const idx = (y * width + x) * 4;
            // Calculate grayscale value
            const gray = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            const isDark = gray < 128;
            
            if (isDark && !inDarkRun) {
                inDarkRun = true;
                runStart = y;
            } else if (!isDark && inDarkRun) {
                const runLength = y - runStart;
                // Filter out noise (too short) and lines (too long)
                if (runLength >= 5 && runLength <= height * 0.3) {
                    runLengths.push(runLength);
                }
                inDarkRun = false;
            }
        }
    }
    
    if (runLengths.length === 0) {
        // No text detected, return a safe default
        return MIN_CAPITAL_HEIGHT_PX;
    }
    
    // Use median of run lengths as estimate
    runLengths.sort((a, b) => a - b);
    return runLengths[Math.floor(runLengths.length / 2)];
}

/**
 * Scales up an image if the estimated text height is below the minimum.
 * This improves OCR accuracy for small text.
 */
export function ensureMinDPI(imageData: ImageData): { image: ImageData; scale: number } {
    const config = getConfig();
    
    if (!config.preprocessing.dpiScaling.enabled) {
        return { image: imageData, scale: 1 };
    }
    
    const estimatedHeight = estimateCapitalHeight(imageData);
    const minHeight = config.preprocessing.dpiScaling.minCapitalHeightPx;
    
    if (estimatedHeight >= minHeight) {
        return { image: imageData, scale: 1 };
    }
    
    const scale = Math.min(minHeight / estimatedHeight, config.preprocessing.dpiScaling.maxScale);
    
    if (scale <= 1.05) {
        // Not worth scaling for tiny improvements
        return { image: imageData, scale: 1 };
    }
    
    const newWidth = Math.round(imageData.width * scale);
    const newHeight = Math.round(imageData.height * scale);
    
    // Use OffscreenCanvas for high-quality scaling
    const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height);
    const srcCtx = srcCanvas.getContext("2d")!;
    srcCtx.putImageData(imageData, 0, 0);
    
    const dstCanvas = new OffscreenCanvas(newWidth, newHeight);
    const dstCtx = dstCanvas.getContext("2d")!;
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.imageSmoothingQuality = "high";
    dstCtx.drawImage(srcCanvas, 0, 0, newWidth, newHeight);
    
    return {
        image: dstCtx.getImageData(0, 0, newWidth, newHeight),
        scale,
    };
}

/**
 * Calculates the average brightness of an image (0-255).
 */
function calculateAverageBrightness(imageData: ImageData): number {
    const { data } = imageData;
    let sum = 0;
    const pixelCount = data.length / 4;
    
    for (let i = 0; i < data.length; i += 4) {
        // Luminance formula: 0.299*R + 0.587*G + 0.114*B
        sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    
    return sum / pixelCount;
}

/**
 * Detects if an image has inverted colors (light text on dark background)
 * and fixes it by inverting. Tesseract 4.x+ has issues with inverted images.
 */
export function detectAndFixInversion(imageData: ImageData): { image: ImageData; wasInverted: boolean } {
    const config = getConfig();
    
    if (!config.preprocessing.inversionDetection.enabled) {
        return { image: imageData, wasInverted: false };
    }
    
    const avgBrightness = calculateAverageBrightness(imageData);
    const threshold = config.preprocessing.inversionDetection.brightnessThreshold;
    
    if (avgBrightness >= threshold) {
        // Image is bright enough, no inversion needed
        return { image: imageData, wasInverted: false };
    }
    
    // Invert the image
    const { width, height, data } = imageData;
    const newData = new Uint8ClampedArray(data.length);
    
    for (let i = 0; i < data.length; i += 4) {
        newData[i] = 255 - data[i];         // R
        newData[i + 1] = 255 - data[i + 1]; // G
        newData[i + 2] = 255 - data[i + 2]; // B
        newData[i + 3] = data[i + 3];       // A (keep alpha)
    }
    
    return {
        image: new ImageData(newData, width, height),
        wasInverted: true,
    };
}

// =============================================================================
// Public API
// =============================================================================

export async function preprocess(imageData: ImageData): Promise<PreprocessingResult> {
    const startTime = performance.now();
    const config = getConfig();

    // Input validation: skip processing for invalid images
    if (imageData.width <= 0 || imageData.height <= 0) {
        return {
            image: imageData,
            wasProcessed: false,
            processingTime: 0,
        };
    }

    if (!config.preprocessing.enabled) {
        return {
            image: imageData,
            wasProcessed: false,
            processingTime: 0,
        };
    }

    let currentImage = imageData;
    let wasProcessed = false;

    // 0a. DPI Scaling (before OpenCV processing)
    const dpiResult = ensureMinDPI(currentImage);
    if (dpiResult.scale > 1) {
        currentImage = dpiResult.image;
        wasProcessed = true;
        if (config.debug.verbose) {
            console.log(`[Preprocessing] DPI scaling applied: ${dpiResult.scale.toFixed(2)}x`);
        }
    }

    // 0b. Inversion Detection & Fix
    const inversionResult = detectAndFixInversion(currentImage);
    if (inversionResult.wasInverted) {
        currentImage = inversionResult.image;
        wasProcessed = true;
        if (config.debug.verbose) {
            console.log("[Preprocessing] Image inversion corrected");
        }
    }

    await loadOpenCV();
    const cv = getCV();

    let src = cv.matFromImageData(currentImage);
    let dst = new cv.Mat();

    try {
        // 1. Grayscale
        if (config.preprocessing.grayscale) {
            cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY);
            src.delete();
            src = dst;
            dst = new cv.Mat();
        }

        // 2. CLAHE
        if (config.preprocessing.clahe.enabled) {
            const clipLimit = config.preprocessing.clahe.clipLimit || 2.0;
            const tileSize = config.preprocessing.clahe.tileSize || 8;
            const clahe = new cv.CLAHE(clipLimit, new cv.Size(tileSize, tileSize));

            // Ensure src is grayscale for CLAHE
            if (src.channels() > 1) {
                const gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                src.delete();
                src = gray;
            }

            clahe.apply(src, dst);
            src.delete();
            src = dst;
            dst = new cv.Mat();
            clahe.delete();
        }

        // 3. Contrast Boost
        if (config.preprocessing.contrastBoost !== 1.0) {
            src.convertTo(dst, -1, config.preprocessing.contrastBoost, 0);
            src.delete();
            src = dst;
            dst = new cv.Mat();
        }

        // 4. Bilateral Filter
        if (config.preprocessing.bilateralFilter.enabled) {
            const { diameter, sigmaColor, sigmaSpace } = config.preprocessing.bilateralFilter;
            // Bilateral filter usually wants COLOR (or 1 channel), but OpenCV JS can be picky
            cv.bilateralFilter(src, dst, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
            src.delete();
            src = dst;
            dst = new cv.Mat();
        }

        // 5. Thresholding
        if (config.preprocessing.threshold.enabled) {
            const { type, value } = config.preprocessing.threshold;

            // Ensure grayscale
            if (src.channels() > 1) {
                const gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                src.delete();
                src = gray;
            }

            if (type === "otsu") {
                cv.threshold(src, dst, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
            } else if (type === "binary") {
                cv.threshold(src, dst, value, 255, cv.THRESH_BINARY);
            } else if (type === "adaptive") {
                cv.adaptiveThreshold(src, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);
            }

            src.delete();
            src = dst;
            dst = new cv.Mat();
        }

        // Convert back to ImageData
        const processedImageData = matToImageData(src);

        return {
            image: processedImageData,
            wasProcessed: true,
            processingTime: performance.now() - startTime,
        };
    } finally {
        src.delete();
        dst.delete();
    }
}

// Re-export for external use
export { calculateAverageBrightness, estimateCapitalHeight };

