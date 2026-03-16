/**
 * Handler Types and Interfaces
 */

/** Logger interface for consistent logging */
export interface Logger {
    info(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/** Default console logger */
export const defaultLogger: Logger = {
    info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
    debug: (msg, ...args) => console.log(`[DEBUG] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
};

/** Server context interface */
export interface ServerContext {
    app: "ocrfinetuning";
}
