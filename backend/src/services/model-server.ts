/**
 * Simple HTTP server for serving static files (model files).
 * Runs alongside the WebSocket server on a different port.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { createReadStream, statSync, existsSync } from "fs";
import { extname, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

/** Model server handle for shutdown */
export interface ModelServerHandle {
    server: Server;
    close: () => Promise<void>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Models directory is at backend/models/
const MODELS_DIR = resolve(__dirname, "..", "..", "models");

// MIME types for model files
const MIME_TYPES: Record<string, string> = {
    ".json": "application/json",
    ".onnx": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".txt": "text/plain",
    // Tesseract.js files
    ".js": "application/javascript",
    ".wasm": "application/wasm",
    ".traineddata": "application/octet-stream",
};

/**
 * Create an HTTP server that serves static model files.
 * Returns a handle with the server and a close function for graceful shutdown.
 */
export function createModelServer(port: number, host: string = "127.0.0.1"): Promise<ModelServerHandle> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // CORS headers (frontend runs on a different port during development).
        //
        // Note: onnxruntime-web reads `Content-Length` to decide whether it needs to stream very large model files.
        // For cross-origin requests, the header must be explicitly exposed.
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
        res.setHeader("Access-Control-Expose-Headers", "Content-Length, Accept-Ranges");
        // Required for COEP (Cross-Origin-Embedder-Policy: require-corp) - allows cross-origin loading
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

        // Handle CORS preflight
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        // Only handle GET requests
        if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Method not allowed");
            return;
        }

        const url = req.url || "/";

        // Parse URL and remove query string
        const urlPath = url.split("?")[0];

        // Check if requesting a model file
        if (!urlPath.startsWith("/models/")) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
            return;
        }

        // Map URL to file path
        const relativePathRaw = urlPath.slice("/models/".length);

        let relativePathDecoded: string;
        try {
            relativePathDecoded = decodeURIComponent(relativePathRaw);
        } catch {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad request");
            return;
        }

        // Security: block null bytes and normalize separators
        if (relativePathDecoded.includes("\0")) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad request");
            return;
        }

        // Treat backslashes like slashes so Windows-style traversal can't bypass checks.
        const relativePathNormalized = relativePathDecoded.replace(/\\/g, "/").replace(/^\/+/, "");

        // Resolve path and ensure it stays within MODELS_DIR (prevents absolute paths + ../ traversal).
        const filePath = resolve(MODELS_DIR, relativePathNormalized);
        const modelsRoot = MODELS_DIR.endsWith(sep) ? MODELS_DIR : `${MODELS_DIR}${sep}`;
        if (filePath !== MODELS_DIR && !filePath.startsWith(modelsRoot)) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Forbidden");
            return;
        }

        // Check if file exists
        if (!existsSync(filePath)) {
            console.log(`[ModelServer] 404: ${filePath}`);
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
            return;
        }

        // Get file stats
        try {
            const stats = statSync(filePath);
            if (!stats.isFile()) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not found");
                return;
            }

            // Determine MIME type
            const ext = extname(filePath).toLowerCase();
            const mimeType = MIME_TYPES[ext] || "application/octet-stream";

            // Set content headers
            res.writeHead(200, {
                "Content-Type": mimeType,
                "Content-Length": stats.size,
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=31536000", // Cache for 1 year (models don't change)
            });

            // Stream the file
            const stream = createReadStream(filePath);
            stream.pipe(res);

            stream.on("error", (err) => {
                console.error(`[ModelServer] Error streaming ${filePath}:`, err);
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "text/plain" });
                }
                res.end("Internal server error");
            });

        } catch (err) {
            console.error(`[ModelServer] Error reading ${filePath}:`, err);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal server error");
        }
    });

    return new Promise<ModelServerHandle>((resolvePromise, reject) => {
        server.on("error", reject);
        server.listen(port, host, () => {
            console.log(`[ModelServer] Model server listening on http://${host}:${port}/models/`);
            resolvePromise({
                server,
                close: () => new Promise<void>((resolveClose, rejectClose) => {
                    server.close((err) => {
                        if (err) {
                            rejectClose(err);
                        } else {
                            console.log("[ModelServer] Model server closed");
                            resolveClose();
                        }
                    });
                }),
            });
        });
    });
}
