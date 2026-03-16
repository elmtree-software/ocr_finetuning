/**
 * Connection handler for WebSocket messages.
 * Ported from Python sidecar/handlers.py
 *
 * This is the main entry point that delegates to specialized handlers.
 */

import type WebSocket from "ws";
import { parseEnvelope, type MessageEnvelope } from "../types.js";

// Re-export types for external use
export { type Logger, type ServerContext, defaultLogger } from "./types.js";

// Import specialized handlers
import { OcrTuningHandler } from "./ocr-tuning.js";
import type { Logger, ServerContext } from "./types.js";
import { defaultLogger } from "./types.js";

/**
 * Handles WebSocket messages for a single client connection.
 * Delegates to specialized handlers for each message type.
 */
export class ConnectionHandler {
    private ws: WebSocket;
    private server: ServerContext;
    private logger: Logger;

    private ocrTuningHandler: OcrTuningHandler;

    constructor(ws: WebSocket, server: ServerContext, logger: Logger = defaultLogger) {
        this.ws = ws;
        this.server = server;
        this.logger = logger;

        this.ocrTuningHandler = new OcrTuningHandler(ws, server, logger);
    }

    /**
     * Handle an incoming message.
     */
    async handleMessage(raw: string): Promise<void> {
        let envelope: MessageEnvelope;
        try {
            envelope = parseEnvelope(raw);
        } catch (error) {
            this.logger.warn("Invalid JSON received:", raw.substring(0, 100));
            return;
        }

        this.logger.debug(`Received message type: ${envelope.type}`);

        switch (envelope.type) {
            case "save_tuning_result":
                await this.ocrTuningHandler.handleSaveTuningResult(envelope);
                break;

            // Ack
            case "ack":
                this.handleAck(envelope);
                break;

            default:
                this.logger.info(`Ignoring unsupported message type: ${envelope.type}`);
        }
    }

    /**
     * Handle ack messages.
     */
    private handleAck(envelope: MessageEnvelope): void {
        this.logger.debug(
            `Received ack for ${envelope.payload.acknowledged} (stream ${envelope.stream_id} seq ${envelope.seq})`
        );
    }
}
