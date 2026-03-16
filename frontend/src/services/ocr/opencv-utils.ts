/**
 * OpenCV Utilities
 * 
 * Shared utility functions for OpenCV operations.
 */

import { getCV } from "./opencv-loader";

/**
 * Convert an OpenCV Mat to ImageData.
 * Handles both grayscale and color images.
 */
export function matToImageData(mat: any): ImageData {
    const cv = getCV();
    let rgba: any;
    
    if (mat.channels() === 1) {
        rgba = new cv.Mat();
        cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
    } else if (mat.channels() === 3) {
        rgba = new cv.Mat();
        cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
    } else {
        rgba = mat.clone();
    }

    const imageData = new ImageData(
        new Uint8ClampedArray(rgba.data),
        rgba.cols,
        rgba.rows
    );

    rgba.delete();
    return imageData;
}
