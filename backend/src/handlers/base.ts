/**
 * Base Handler with shared functionality
 */

import { v4 as uuidv4 } from "uuid";
import type WebSocket from "ws";
import type { MessageEnvelope } from "../types.js";
import { serializeEnvelope, createEnvelope } from "../types.js";
import type { Logger, ServerContext } from "./types.js";
import { defaultLogger } from "./types.js";

/**
 * Base handler class with shared WebSocket communication methods.
 */
export class BaseHandler {
    protected ws: WebSocket;
    protected server: ServerContext;
    protected logger: Logger;

    constructor(ws: WebSocket, server: ServerContext, logger: Logger = defaultLogger) {
        this.ws = ws;
        this.server = server;
        this.logger = logger;
    }

    /**
     * Send a message envelope over WebSocket.
     */
    protected send(envelope: MessageEnvelope): void {
        if (this.ws.readyState === 1) { // WebSocket.OPEN
            this.ws.send(serializeEnvelope(envelope));
        }
    }

    /**
     * Send an acknowledgment for a message.
     */
    protected async sendAck(source: MessageEnvelope): Promise<void> {
        const ack = createEnvelope(
            "ack",
            source.session_id,
            uuidv4(),
            { acknowledged: source.msg_id },
            { streamId: source.stream_id, seq: source.seq }
        );
        this.send(ack);
    }

    /**
     * Send an error message.
     */
    protected async sendError(sessionId: string, message: string): Promise<void> {
        const error = createEnvelope(
            "error",
            sessionId,
            uuidv4(),
            { message }
        );
        this.send(error);
    }

}
