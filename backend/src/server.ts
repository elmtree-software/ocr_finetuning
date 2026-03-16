/**
 * WebSocket server for the Node.js sidecar backend.
 * Ported from Python sidecar/server.py
 */

import { WebSocketServer, WebSocket } from "ws";
import { ConnectionHandler, type ServerContext } from "./handlers/index.js";
import { DEFAULT_CONFIG, type ServerConfig } from "./types.js";

/** Logger interface */
interface Logger {
    info(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/**
 * Sidecar WebSocket server.
 */
export class SidecarServer {
    private config: ServerConfig;
    private wss: WebSocketServer | null = null;
    private logger: Logger;

    constructor(options?: Partial<ServerConfig> & { logger?: Logger }) {
        // Resolve configuration from environment variables or defaults
        const envHost = process.env.SIDECAR_HOST;
        const envPort = process.env.SIDECAR_PORT;

        this.config = {
            host: envHost || options?.host || DEFAULT_CONFIG.host,
            port: envPort ? parseInt(envPort, 10) : (options?.port || DEFAULT_CONFIG.port),
            pingIntervalMs: options?.pingIntervalMs || DEFAULT_CONFIG.pingIntervalMs,
            pingTimeoutMs: options?.pingTimeoutMs || DEFAULT_CONFIG.pingTimeoutMs,
        };

        this.logger = options?.logger || {
            info: (msg, ...args) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`, ...args),
            debug: (msg, ...args) => {
                if (process.env.DEBUG) {
                    console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`, ...args);
                }
            },
            warn: (msg, ...args) => console.warn(`[WARN] ${new Date().toISOString()} ${msg}`, ...args),
            error: (msg, ...args) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, ...args),
        };

    }

    /**
     * Get the server context for handlers.
     */
    getContext(): ServerContext {
        return {
            app: "ocrfinetuning",
        };
    }

    /**
     * Start the WebSocket server.
     */
    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.wss = new WebSocketServer({
                    host: this.config.host,
                    port: this.config.port,
                });

                this.wss.on("listening", () => {
                    this.logger.info(
                        `Sidecar server listening on ws://${this.config.host}:${this.config.port}`
                    );
                    resolve();
                });

                this.wss.on("connection", (ws, req) => {
                    this.handleConnection(ws, req);
                });

                this.wss.on("error", (error) => {
                    this.logger.error("WebSocket server error:", error);
                    reject(error);
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
   * Handle a new client connection.
   */
    private handleConnection(ws: WebSocket, req: { socket: { remoteAddress?: string } }): void {
        const clientAddress = req.socket.remoteAddress || "unknown";
        this.logger.info(`Client connected: ${clientAddress}`);

        const handler = new ConnectionHandler(ws, this.getContext(), this.logger);

        // Track if connection is alive
        let isAlive = true;

        // Browser WebSockets automatically respond to ping frames at the protocol level
        // We just need to track pong responses
        ws.on("pong", () => {
            isAlive = true;
        });

        // Heartbeat interval - send ping and check if previous pong was received
        const heartbeatInterval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                clearInterval(heartbeatInterval);
                return;
            }

            if (!isAlive) {
                this.logger.warn("Ping timeout, closing connection");
                ws.terminate();
                clearInterval(heartbeatInterval);
                return;
            }

            // Mark as not alive, will be set to true when pong is received
            isAlive = false;
            ws.ping();
        }, this.config.pingIntervalMs);

        // Handle messages
        ws.on("message", async (data) => {
            try {
                const message = data.toString();
                await handler.handleMessage(message);
            } catch (error) {
                this.logger.error("Error handling message:", error);
            }
        });

        // Handle close
        ws.on("close", (code, reason) => {
            this.logger.info(`Client disconnected: ${code} ${reason.toString()}`);
            clearInterval(heartbeatInterval);
        });

        // Handle errors
        ws.on("error", (error) => {
            this.logger.error("WebSocket client error:", error);
        });
    }

    /**
     * Stop the WebSocket server.
     */
    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.wss) {
                // Close all connections
                this.wss.clients.forEach((client) => {
                    client.close(1000, "Server shutdown");
                });

                this.wss.close(() => {
                    this.logger.info("Server stopped");
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}
