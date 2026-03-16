/**
 * File Saver Composable
 *
 * Saves tuning results via WebSocket to backend,
 * with fallback to browser download.
 */

import { ref, readonly } from "vue";
import type {
    SaveTuningResultPayload,
    SaveTuningResultResponse,
} from "../types/tuning";

type SaveOptions = {
    preferDownload?: boolean;
    directory?: string;
    allowDownloadFallback?: boolean;
};

// =============================================================================
// WebSocket Connection
// =============================================================================

const ws = ref<WebSocket | null>(null);
const isConnected = ref(false);
const connectionError = ref<string | null>(null);

// Message response handlers
const pendingRequests = new Map<
    string,
    {
        resolve: (value: SaveTuningResultResponse) => void;
        reject: (error: Error) => void;
    }
>();

function getWebSocketUrl(): string {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    // In dev mode, use the Vite proxy
    if (import.meta.env.DEV) {
        return `${wsProtocol}//${window.location.host}/ws-node`;
    }

    // In production, connect directly
    return `ws://127.0.0.1:8766`;
}

function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (ws.value?.readyState === WebSocket.OPEN) {
            resolve();
            return;
        }

        const url = getWebSocketUrl();
        ws.value = new WebSocket(url);

        ws.value.onopen = () => {
            isConnected.value = true;
            connectionError.value = null;
            resolve();
        };

        ws.value.onerror = (event) => {
            connectionError.value = "WebSocket connection failed";
            reject(new Error("WebSocket connection failed"));
        };

        ws.value.onclose = () => {
            isConnected.value = false;
        };

        ws.value.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Handle save_tuning_result_response
                if (data.type === "save_tuning_result_response") {
                    const msgId = data.msg_id;
                    const pending = pendingRequests.get(msgId);
                    if (pending) {
                        pending.resolve(data.payload as SaveTuningResultResponse);
                        pendingRequests.delete(msgId);
                    }
                }
            } catch (e) {
                console.error("[FileSaver] Failed to parse message:", e);
            }
        };
    });
}

function disconnect(): void {
    if (ws.value) {
        ws.value.close();
        ws.value = null;
    }
    isConnected.value = false;
}

// =============================================================================
// Save Functions
// =============================================================================

function generateMsgId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Save file via WebSocket
 */
async function saveViaWebSocket(
    filename: string,
    content: string,
    directory?: string
): Promise<SaveTuningResultResponse> {
    await connect();

    if (!ws.value || ws.value.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
    }

    const msgId = generateMsgId();
    const sessionId = `tuning_${Date.now()}`;

    const message = {
        type: "save_tuning_result",
        session_id: sessionId,
        msg_id: msgId,
        payload: {
            filename,
            content,
            directory,
        } as SaveTuningResultPayload,
    };

    return new Promise((resolve, reject) => {
        // Set timeout for response
        const timeout = setTimeout(() => {
            pendingRequests.delete(msgId);
            reject(new Error("Save request timed out"));
        }, 10000);

        pendingRequests.set(msgId, {
            resolve: (response) => {
                clearTimeout(timeout);
                resolve(response);
            },
            reject: (error) => {
                clearTimeout(timeout);
                reject(error);
            },
        });

        ws.value!.send(JSON.stringify(message));
    });
}

/**
 * Save file via browser download (fallback)
 */
function saveViaBrowserDownload(filename: string, content: string): void {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}

// =============================================================================
// Composable
// =============================================================================

export function useFileSaver() {
    const isSaving = ref(false);
    const saveError = ref<string | null>(null);
    const lastSaveSuccess = ref<{ filename: string; method: "websocket" | "download" } | null>(null);

    /**
     * Save content to a file.
     * Tries WebSocket first, falls back to browser download.
     *
     * @param filename - Filename without path
     * @param content - File content
     * @param options - Save behavior and optional subdirectory for backend writes
     */
    async function save(
        filename: string,
        content: string,
        options: SaveOptions = {}
    ): Promise<{ success: boolean; filepath?: string; method: "websocket" | "download" }> {
        const preferDownload = options.preferDownload ?? false;
        const allowDownloadFallback = options.allowDownloadFallback ?? true;

        isSaving.value = true;
        saveError.value = null;
        lastSaveSuccess.value = null;

        try {
            // Try WebSocket if not preferring download
            if (!preferDownload) {
                try {
                    const response = await saveViaWebSocket(
                        filename,
                        content,
                        options.directory
                    );
                    if (response.success) {
                        lastSaveSuccess.value = { filename, method: "websocket" };
                        return {
                            success: true,
                            filepath: response.filepath,
                            method: "websocket",
                        };
                    } else {
                        throw new Error(response.error ?? "Save failed");
                    }
                } catch (wsError) {
                    console.warn(
                        "[FileSaver] WebSocket save failed:",
                        wsError
                    );
                }
            }

            if (!allowDownloadFallback) {
                throw new Error("WebSocket save failed and browser fallback is disabled");
            }

            // Fallback to browser download
            saveViaBrowserDownload(filename, content);
            lastSaveSuccess.value = { filename, method: "download" };
            return {
                success: true,
                method: "download",
            };
        } catch (error) {
            saveError.value = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                method: "download",
            };
        } finally {
            isSaving.value = false;
        }
    }

    /**
     * Save as TypeScript config file
     */
    async function saveConfig(
        filename: string,
        content: string,
        options: SaveOptions = {}
    ): Promise<boolean> {
        const result = await save(
            filename.endsWith(".ts") ? filename : `${filename}.ts`,
            content,
            options
        );
        return result.success;
    }

    /**
     * Save as JSON file
     */
    async function saveJson(
        filename: string,
        content: string,
        options: SaveOptions = {}
    ): Promise<boolean> {
        const result = await save(
            filename.endsWith(".json") ? filename : `${filename}.json`,
            content,
            options
        );
        return result.success;
    }

    /**
     * Force browser download (skip WebSocket)
     */
    function download(filename: string, content: string): void {
        saveViaBrowserDownload(filename, content);
    }

    /**
     * Clear the last save success notification
     */
    function clearLastSaveSuccess(): void {
        lastSaveSuccess.value = null;
    }

    return {
        isConnected: readonly(isConnected),
        connectionError: readonly(connectionError),
        isSaving: readonly(isSaving),
        saveError: readonly(saveError),
        lastSaveSuccess: readonly(lastSaveSuccess),
        connect,
        disconnect,
        save,
        saveConfig,
        saveJson,
        download,
        clearLastSaveSuccess,
    };
}
