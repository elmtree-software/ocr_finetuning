/**
 * OCR Finetuning Tool - Entry Point
 */

import { createApp } from "vue";
import App from "./App.vue";
import "../styles/fonts.css";
import "../styles/tailwind.css";
import { useTuningState } from "./composables/useTuningState";
import { useTuningRunner } from "./composables/useTuningRunner";
import { useParameterRegistry } from "./composables/useParameterRegistry";
import { DEFAULT_CONFIG, resetConfig } from "@/services/ocr/config";

createApp(App).mount("#app");

// Deep-assign helper (mutates target in place)
function deepAssign(target: any, source: any): void {
    for (const key of Object.keys(source)) {
        if (
            typeof source[key] === "object" &&
            source[key] !== null &&
            !Array.isArray(source[key]) &&
            typeof target[key] === "object" &&
            target[key] !== null
        ) {
            deepAssign(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
}

// Expose composables for Playwright automation
(window as any).__TUNING__ = {
    state: useTuningState(),
    runner: useTuningRunner(),
    registry: useParameterRegistry(),
    /** Mutate DEFAULT_CONFIG so resetConfig() uses our base values */
    setBaseConfig(partial: Record<string, unknown>): void {
        deepAssign(DEFAULT_CONFIG, partial);
        resetConfig(); // apply to current config immediately
    },
    getDefaultConfig(): unknown {
        return structuredClone(DEFAULT_CONFIG);
    },
};
