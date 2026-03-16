/**
 * Document Rectification
 *
 * Perspective correction using OpenCV.js for document images.
 * Pipeline: Grayscale → Blur → Canny → Contours → Perspective Transform
 */

import type { RectificationResult, DocumentCorners, Point2D, ImageInput } from "./types";
import { getConfig } from "./config";
import { toImageData } from "./engine";
import { loadOpenCV, getCV } from "./opencv-loader";

// =============================================================================
// OpenCV Types
// =============================================================================

interface OpenCVJS {
    Mat: new () => CVMat;
    MatVector: new () => CVMatVector;
    Size: new (width: number, height: number) => CVSize;
    cvtColor: (src: CVMat, dst: CVMat, code: number) => void;
    GaussianBlur: (src: CVMat, dst: CVMat, ksize: CVSize, sigmaX: number) => void;
    Canny: (src: CVMat, dst: CVMat, threshold1: number, threshold2: number) => void;
    dilate: (src: CVMat, dst: CVMat, kernel: CVMat) => void;
    findContours: (src: CVMat, contours: CVMatVector, hierarchy: CVMat, mode: number, method: number) => void;
    contourArea: (contour: CVMat) => number;
    arcLength: (curve: CVMat, closed: boolean) => number;
    approxPolyDP: (curve: CVMat, approxCurve: CVMat, epsilon: number, closed: boolean) => void;
    getPerspectiveTransform: (src: CVMat, dst: CVMat) => CVMat;
    warpPerspective: (src: CVMat, dst: CVMat, M: CVMat, dsize: CVSize, flags?: number, borderMode?: number) => void;
    matFromArray: (rows: number, cols: number, type: number, array: number[]) => CVMat;
    matFromImageData: (imageData: ImageData) => CVMat;
    getStructuringElement: (shape: number, size: CVSize) => CVMat;
    adaptiveThreshold: (src: CVMat, dst: CVMat, maxValue: number, adaptiveMethod: number, thresholdType: number, blockSize: number, C: number) => void;
    convexHull: (points: CVMat, hull: CVMat, clockwise?: boolean, returnPoints?: boolean) => void;
    COLOR_RGBA2GRAY: number;
    COLOR_GRAY2RGBA: number;
    RETR_EXTERNAL: number;
    CHAIN_APPROX_SIMPLE: number;
    CV_32FC2: number;
    INTER_LINEAR: number;
    BORDER_CONSTANT: number;
    MORPH_RECT: number;
    ADAPTIVE_THRESH_GAUSSIAN_C: number;
    THRESH_BINARY: number;
}

interface CVMat {
    rows: number;
    cols: number;
    data: Uint8Array;
    data32S: Int32Array;
    data32F: Float32Array;
    channels: () => number;
    delete: () => void;
}

interface CVMatVector {
    size: () => number;
    get: (index: number) => CVMat;
    delete: () => void;
}

interface CVSize {
    width: number;
    height: number;
}

// OpenCV is now managed by shared loader in opencv-loader.ts

// =============================================================================
// Public API
// =============================================================================

export async function rectify(image: ImageInput): Promise<RectificationResult> {
    const startTime = performance.now();
    const config = getConfig();

    if (!config.rectification.enabled) {
        const imageData = await toImageData(image);
        return {
            image: imageData,
            documentFound: false,
            confidence: 0,
            processingTime: 0,
        };
    }

    await loadOpenCV();
    const cv = getCV();

    const imageData = await toImageData(image);
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();

    try {
        // 1. Convert to grayscale
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        // 2. Gaussian blur
        const blurKernel = new cv.Size(config.rectification.blurSize, config.rectification.blurSize);
        cv.GaussianBlur(gray, blurred, blurKernel, 0);

        // 3. Edge detection or Thresholding
        if (config.rectification.useAdaptiveThreshold) {
            cv.adaptiveThreshold(blurred, edges, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);
        } else {
            cv.Canny(blurred, edges, config.rectification.cannyLow, config.rectification.cannyHigh);
        }

        // 4. Dilate to close gaps
        const dilateKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
        cv.dilate(edges, edges, dilateKernel);
        dilateKernel.delete();

        // 5. Find contours
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        // 6. Find largest quadrilateral
        const minArea = src.cols * src.rows * config.rectification.minDocumentArea;
        const documentContour = findDocumentContour(contours, minArea);

        if (!documentContour) {
            contours.delete();
            hierarchy.delete();
            return {
                image: imageData,
                documentFound: false,
                confidence: 0,
                processingTime: performance.now() - startTime,
            };
        }

        // 7. Order corners
        const corners = orderCornerPoints(documentContour.points);
        const confidence = Math.min(documentContour.area / (src.cols * src.rows) * 1.5, 0.95);

        if (confidence < config.rectification.minContourConfidence) {
            contours.delete();
            hierarchy.delete();
            return {
                image: imageData,
                documentFound: false,
                confidence,
                corners,
                processingTime: performance.now() - startTime,
            };
        }

        // 8. Calculate output size
        const { width, height } = calculateOutputSize(corners);

        // 9. Perspective transform
        const rectified = applyPerspectiveTransform(src, corners, width, height);

        // Convert back to ImageData
        const resultImageData = matToImageData(rectified);
        rectified.delete();
        contours.delete();
        hierarchy.delete();

        return {
            image: resultImageData,
            documentFound: true,
            confidence,
            corners,
            processingTime: performance.now() - startTime,
        };
    } finally {
        src.delete();
        gray.delete();
        blurred.delete();
        edges.delete();
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

function findDocumentContour(
    contours: CVMatVector,
    minArea: number
): { points: Point2D[]; area: number } | null {
    const cv = getCV();
    let bestContour: { points: Point2D[]; area: number } | null = null;
    let maxArea = 0;

    for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);

        if (area < minArea) continue;

        const perimeter = cv.arcLength(contour, true);
        const approx = new cv.Mat();

        // Use convex hull to smooth the contour
        const hull = new cv.Mat();
        cv.convexHull(contour, hull, false, true);

        cv.approxPolyDP(hull, approx, 0.02 * perimeter, true);

        if (approx.rows === 4 && area > maxArea) {
            maxArea = area;

            const points: Point2D[] = [];
            for (let j = 0; j < 4; j++) {
                points.push({
                    x: approx.data32S[j * 2],
                    y: approx.data32S[j * 2 + 1],
                });
            }

            bestContour = { points, area };
        } else if (approx.rows > 4 && area > maxArea * 0.8) {
            const approx2 = new cv.Mat();
            cv.approxPolyDP(hull, approx2, 0.04 * perimeter, true);
            if (approx2.rows === 4) {
                maxArea = area;
                const points: Point2D[] = [];
                for (let j = 0; j < 4; j++) {
                    points.push({
                        x: approx2.data32S[j * 2],
                        y: approx2.data32S[j * 2 + 1],
                    });
                }
                bestContour = { points, area };
            }
            approx2.delete();
        }

        hull.delete();
        approx.delete();
    }

    return bestContour;
}

function orderCornerPoints(points: Point2D[]): DocumentCorners {
    const sums = points.map((p, i) => ({ i, v: p.x + p.y }));
    const diffs = points.map((p, i) => ({ i, v: p.y - p.x }));

    sums.sort((a, b) => a.v - b.v);
    diffs.sort((a, b) => a.v - b.v);

    return {
        topLeft: points[sums[0].i],
        bottomRight: points[sums[3].i],
        topRight: points[diffs[0].i],
        bottomLeft: points[diffs[3].i],
    };
}

function calculateOutputSize(corners: DocumentCorners): { width: number; height: number } {
    const distance = (p1: Point2D, p2: Point2D) =>
        Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));

    const widthTop = distance(corners.topLeft, corners.topRight);
    const widthBottom = distance(corners.bottomLeft, corners.bottomRight);
    const heightLeft = distance(corners.topLeft, corners.bottomLeft);
    const heightRight = distance(corners.topRight, corners.bottomRight);

    return {
        width: Math.round(Math.max(widthTop, widthBottom)),
        height: Math.round(Math.max(heightLeft, heightRight)),
    };
}

function applyPerspectiveTransform(
    src: CVMat,
    corners: DocumentCorners,
    width: number,
    height: number
): CVMat {
    const cv = getCV();
    const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        corners.topLeft.x, corners.topLeft.y,
        corners.topRight.x, corners.topRight.y,
        corners.bottomRight.x, corners.bottomRight.y,
        corners.bottomLeft.x, corners.bottomLeft.y,
    ]);

    const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        width - 1, 0,
        width - 1, height - 1,
        0, height - 1,
    ]);

    const M = cv.getPerspectiveTransform(srcPoints, dstPoints);
    const dst = new cv.Mat();
    const dsize = new cv.Size(width, height);
    cv.warpPerspective(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT);

    srcPoints.delete();
    dstPoints.delete();
    M.delete();

    return dst;
}

function matToImageData(mat: CVMat): ImageData {
    const cv = getCV();
    let rgba: CVMat;
    if (mat.channels() === 1) {
        rgba = new cv.Mat();
        cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
    } else {
        rgba = mat;
    }

    const imageData = new ImageData(
        new Uint8ClampedArray(rgba.data),
        rgba.cols,
        rgba.rows
    );

    if (rgba !== mat) {
        rgba.delete();
    }

    return imageData;
}
