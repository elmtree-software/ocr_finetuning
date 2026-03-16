/**
 * OpenCV.js Loader
 * 
 * Centralized loading for OpenCV.js to ensure a single instance
 * is used across the application.
 */

import { MODEL_PATHS } from "./config";

// =============================================================================
// OpenCV Types (Simplified for loader)
// =============================================================================

export interface OpenCVJS {
    Mat: any;
    MatVector: any;
    Size: any;
    [key: string]: any;
}

let cv: OpenCVJS | null = null;
let loadPromise: Promise<OpenCVJS> | null = null;

export async function loadOpenCV(): Promise<OpenCVJS> {
    if (cv) return cv;
    if (loadPromise) return loadPromise;

    loadPromise = new Promise((resolve, reject) => {
        if (typeof window !== "undefined" && (window as any).cv?.Mat) {
            const globalCV = (window as any).cv;
            // CRITICAL: Neutralize .then() to prevent Promise assimilation recursion
            if (typeof globalCV.then === "function") {
                try { globalCV.then = undefined; } catch { /* ignore */ }
            }
            cv = globalCV;
            resolve(cv!);
            return;
        }

        console.log("[OpenCV] Loading...");

        const script = document.createElement("script");
        script.src = MODEL_PATHS.opencv;
        script.async = true;

        const timeout = setTimeout(() => {
            reject(new Error("OpenCV load timeout"));
        }, 60000);

        script.onload = () => {
            const checkReady = () => {
                const globalCV = (window as any).cv;
                
                // Handle MODULARIZE builds where cv is a Promise-like object
                if (globalCV && typeof globalCV.then === "function" && !globalCV.Mat) {
                    // cv is still initializing (Promise-like), wait for it
                    // Note: OpenCV's .then() is a thenable, not a real Promise, so we wrap it
                    try {
                        globalCV.then((readyCV: any) => {
                            clearTimeout(timeout);
                            // Neutralize .then() on the resolved object too
                            if (typeof readyCV.then === "function") {
                                try { readyCV.then = undefined; } catch { /* ignore */ }
                            }
                            cv = readyCV;
                            console.log("[OpenCV] Ready (MODULARIZE)");
                            resolve(cv!);
                        });
                    } catch (err) {
                        clearTimeout(timeout);
                        reject(new Error(`OpenCV init failed: ${err}`));
                    }
                    return;
                }
                
                if (globalCV?.Mat) {
                    clearTimeout(timeout);

                    // CRITICAL: OpenCV.js includes a .then() property that causes infinite
                    // Promise resolution recursion if not neutralized.
                    if (typeof globalCV.then === "function") {
                        try { globalCV.then = undefined; } catch { /* ignore */ }
                    }

                    cv = globalCV;
                    console.log("[OpenCV] Ready");
                    resolve(cv!);
                } else {
                    setTimeout(checkReady, 100);
                }
            };
            checkReady();
        };

        script.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("OpenCV load failed"));
        };

        document.head.appendChild(script);
    });

    return loadPromise;
}

export function isOpenCVLoaded(): boolean {
    return cv !== null;
}

export function getCV(): OpenCVJS {
    if (!cv) throw new Error("OpenCV not loaded. Call loadOpenCV() first.");
    return cv;
}
