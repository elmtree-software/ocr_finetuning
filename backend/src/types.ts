/**
 * Type definitions for the OCR finetuning Node.js sidecar backend.
 */

/**
 * Message envelope for WebSocket communication.
 * Matches the Python MessageEnvelope dataclass.
 */
export interface MessageEnvelope {
    type: string;
    session_id: string;
    msg_id: string;
    payload: Record<string, unknown>;
    stream_id?: string;
    seq?: number;
}

/**
 * Parse a JSON string into a MessageEnvelope.
 */
export function parseEnvelope(raw: string): MessageEnvelope {
    const data = JSON.parse(raw);
    return {
        type: data.type,
        session_id: data.session_id,
        msg_id: data.msg_id,
        payload: data.payload ?? {},
        stream_id: data.stream_id,
        seq: data.seq,
    };
}

/**
 * Serialize a MessageEnvelope to JSON string.
 */
export function serializeEnvelope(envelope: MessageEnvelope): string {
    const obj: Record<string, unknown> = {
        type: envelope.type,
        session_id: envelope.session_id,
        msg_id: envelope.msg_id,
        payload: envelope.payload,
    };
    if (envelope.stream_id !== undefined) {
        obj.stream_id = envelope.stream_id;
    }
    if (envelope.seq !== undefined) {
        obj.seq = envelope.seq;
    }
    return JSON.stringify(obj);
}

/**
 * Create a new MessageEnvelope.
 */
export function createEnvelope(
    type: string,
    sessionId: string,
    msgId: string,
    payload: Record<string, unknown>,
    options?: { streamId?: string; seq?: number }
): MessageEnvelope {
    return {
        type,
        session_id: sessionId,
        msg_id: msgId,
        payload,
        stream_id: options?.streamId,
        seq: options?.seq,
    };
}

/**
 * Server configuration.
 */
export interface ServerConfig {
    host: string;
    port: number;
    pingIntervalMs: number;
    pingTimeoutMs: number;
}

/**
 * Default server configuration.
 */
export const DEFAULT_CONFIG: ServerConfig = {
    host: "127.0.0.1",
    port: 8766,
    pingIntervalMs: 60000,
    pingTimeoutMs: 30000,
};
