/**
 * OCR Tuning Handler
 *
 * Handles saving tuning results to the filesystem.
 */

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BaseHandler } from "./base.js";
import type { MessageEnvelope } from "../types.js";
import { createEnvelope } from "../types.js";

// Directory for tuning runs (project root / ocr_trainingdata/runs)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TUNING_RUNS_DIR = path.resolve(
    __dirname,
    "../../..",
    "ocr_trainingdata",
    "runs"
);

/**
 * Validate filename to prevent path traversal attacks
 */
function isValidFilename(filename: string): boolean {
    // Only allow alphanumeric, underscore, hyphen, and dots
    // Must not start with a dot (hidden files)
    // Must end with .ts or .json
    const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9_\-\.]*\.(ts|json)$/;

    if (!validPattern.test(filename)) {
        return false;
    }

    // Additional check for path traversal
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
        return false;
    }

    return true;
}

/**
 * Validate optional subdirectory name to prevent path traversal attacks.
 */
function isValidDirectory(directory: string): boolean {
    const normalized = directory.replace(/\\/g, "/");
    if (!normalized) return false;
    if (normalized.includes("..")) return false;
    if (normalized.startsWith("/") || normalized.endsWith("/")) return false;

    const parts = normalized.split("/");
    if (parts.length === 0) return false;

    return parts.every((part) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(part));
}

function resolveTargetDirectory(directory?: string): string | null {
    if (directory === undefined) {
        return TUNING_RUNS_DIR;
    }

    if (typeof directory !== "string" || !isValidDirectory(directory)) {
        return null;
    }

    const target = path.resolve(TUNING_RUNS_DIR, directory);
    const relative = path.relative(TUNING_RUNS_DIR, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return null;
    }

    return target;
}

export class OcrTuningHandler extends BaseHandler {
    /**
     * Handle save_tuning_result message
     */
    async handleSaveTuningResult(envelope: MessageEnvelope): Promise<void> {
        const { filename, content, directory } = envelope.payload as {
            filename: string;
            content: string;
            directory?: string;
        };

        // Validate filename
        if (!filename || typeof filename !== "string") {
            this.sendResponse(envelope.session_id, envelope.msg_id, {
                success: false,
                error: "Filename is required",
            });
            return;
        }

        if (!isValidFilename(filename)) {
            this.logger.warn(`Invalid filename rejected: ${filename}`);
            this.sendResponse(envelope.session_id, envelope.msg_id, {
                success: false,
                error: "Invalid filename format",
            });
            return;
        }

        // Validate content
        if (typeof content !== "string") {
            this.sendResponse(envelope.session_id, envelope.msg_id, {
                success: false,
                error: "Content is required",
            });
            return;
        }

        const targetDir = resolveTargetDirectory(directory);
        if (!targetDir) {
            this.logger.warn(`Invalid directory rejected: ${String(directory)}`);
            this.sendResponse(envelope.session_id, envelope.msg_id, {
                success: false,
                error: "Invalid directory format",
            });
            return;
        }

        try {
            // Ensure directory exists
            await fs.mkdir(targetDir, { recursive: true });

            // Write file
            const filepath = path.join(targetDir, filename);
            await fs.writeFile(filepath, content, "utf-8");

            this.logger.info(`Saved tuning result to: ${filepath}`);

            this.sendResponse(envelope.session_id, envelope.msg_id, {
                success: true,
                filepath,
            });
        } catch (error) {
            this.logger.error(`Failed to save tuning result: ${error}`);
            this.sendResponse(envelope.session_id, envelope.msg_id, {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    /**
     * Send response message
     */
    private sendResponse(
        sessionId: string,
        sourceMsgId: string,
        payload: { success: boolean; filepath?: string; error?: string }
    ): void {
        const response = createEnvelope(
            "save_tuning_result_response",
            sessionId,
            sourceMsgId, // Use the source msg_id so frontend can match the response
            payload
        );
        this.send(response);
    }
}
