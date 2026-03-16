/**
 * Entry point for the Node.js sidecar backend.
 */

import { SidecarServer } from "./server.js";
import { createModelServer, type ModelServerHandle } from "./services/model-server.js";

// Model server port (HTTP for static files)
const MODEL_SERVER_PORT = parseInt(process.env.MODEL_SERVER_PORT || "8767", 10);

// Handle graceful shutdown
let server: SidecarServer | null = null;
let modelServerHandle: ModelServerHandle | null = null;

async function shutdown(signal: string): Promise<void> {
    console.log(`\nReceived ${signal}, shutting down...`);

    // Close WebSocket server
    if (server) {
        await server.stop();
    }

    // Close model server
    if (modelServerHandle) {
        try {
            await modelServerHandle.close();
        } catch (err) {
            console.warn("[ModelServer] Error closing:", err);
        }
    }

    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Main
async function main(): Promise<void> {
    console.log("=".repeat(50));
    console.log("OCR Finetuning Sidecar - Node.js Backend");
    console.log("=".repeat(50));
    console.log("");

    // Start the model server first (HTTP for static files)
    try {
        modelServerHandle = await createModelServer(MODEL_SERVER_PORT);
    } catch (error) {
        console.warn("[ModelServer] Failed to start model server:", error);
        console.warn("[ModelServer] OCR models will not be available locally");
    }

    server = new SidecarServer();

    try {
        await server.start();
        console.log("");
        console.log("Server is ready. Press Ctrl+C to stop.");
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
