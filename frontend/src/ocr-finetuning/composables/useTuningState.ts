/**
 * Tuning State Composable (Singleton)
 *
 * Central state management for the OCR finetuning tool.
 * Shared across all components.
 */

import { ref, computed, readonly, type DeepReadonly, type Ref } from "vue";
import type {
    TuningRunState,
    TuningStatus,
    ParameterPermutation,
    IterationResult,
    TuningImage,
    ParameterConfigMap,
    ParameterConfig,
    NumberParameterConfig,
    BooleanParameterConfig,
    EnumParameterConfig,
    OptimizerSettings,
    ScoringMode,
} from "../types/tuning";
import type { EngineType } from "@/services/ocr/types";
import type { LayoutResult } from "@/services/ocr/types";

// =============================================================================
// Singleton State
// =============================================================================

// Selected engine (not iterated)
const selectedEngine = ref<EngineType>("paddleocr");

// Parameter iteration configs
const parameterConfigs = ref<ParameterConfigMap>({});

// Optimizer settings
const optimizerSettings = ref<OptimizerSettings>({
    iterations: 60,
    initialSamples: 12,
    candidateSamples: 600,
});

// Scoring mode for quality evaluation
const scoringMode = ref<ScoringMode>("fulltext");

// Selected images
const images = ref<TuningImage[]>([]);

// Run state
const runState = ref<TuningRunState>({
    status: "idle",
    totalPermutations: 0,
    completedPermutations: 0,
    currentPermutation: null,
    results: [],
    bestResult: null,
    startTime: null,
    error: null,
});

// Selected result ID for comparison view
const selectedResultId = ref<number | null>(null);

// =============================================================================
// Computed
// =============================================================================

const isRunning = computed(
    () => runState.value.status === "running" || runState.value.status === "paused"
);

const canStart = computed(
    () =>
        images.value.length > 0 &&
        images.value.some((img) => img.hasGroundTruth) &&
        runState.value.status === "idle"
);

const imagesWithGroundTruth = computed(() =>
    images.value.filter((img) => img.hasGroundTruth)
);

const elapsedTime = computed(() => {
    if (!runState.value.startTime) return 0;
    return Date.now() - runState.value.startTime;
});

const estimatedTimeRemaining = computed(() => {
    const { completedPermutations, totalPermutations } = runState.value;
    if (completedPermutations === 0 || totalPermutations === 0) return null;

    const avgTimePerIteration = elapsedTime.value / completedPermutations;
    const remaining = totalPermutations - completedPermutations;
    return Math.round(avgTimePerIteration * remaining);
});

const progress = computed(() => {
    const { completedPermutations, totalPermutations } = runState.value;
    if (totalPermutations === 0) return 0;
    return (completedPermutations / totalPermutations) * 100;
});

const sortedResults = computed(() => {
    return [...runState.value.results].sort(
        (a, b) => a.combinedScore - b.combinedScore
    );
});

const selectedResult = computed(() => {
    if (selectedResultId.value === null) return null;
    return runState.value.results.find((r) => r.id === selectedResultId.value) ?? null;
});

// =============================================================================
// Actions
// =============================================================================

function setEngine(engine: EngineType): void {
    selectedEngine.value = engine;
}

function setParameterConfig(path: string, config: ParameterConfig): void {
    parameterConfigs.value = {
        ...parameterConfigs.value,
        [path]: config,
    };
}

function removeParameterConfig(path: string): void {
    const newConfigs = { ...parameterConfigs.value };
    delete newConfigs[path];
    parameterConfigs.value = newConfigs;
}

function clearParameterConfigs(): void {
    parameterConfigs.value = {};
}

function setOptimizerSettings(partial: Partial<OptimizerSettings>): void {
    optimizerSettings.value = {
        ...optimizerSettings.value,
        ...partial,
    };
}

function setScoringMode(mode: ScoringMode): void {
    scoringMode.value = mode;
}

function addImage(image: TuningImage): void {
    images.value = [...images.value, image];
}

function removeImage(filename: string): void {
    const img = images.value.find((i) => i.filename === filename);
    if (img?.url) {
        URL.revokeObjectURL(img.url);
    }
    images.value = images.value.filter((i) => i.filename !== filename);
}

function clearImages(): void {
    for (const img of images.value) {
        if (img.url) {
            URL.revokeObjectURL(img.url);
        }
    }
    images.value = [];
}

function updateImageOcrResult(
    filename: string,
    ocrResult: string,
    cer: number,
    wer: number,
    layout?: LayoutResult | null
): void {
    images.value = images.value.map((img) =>
        img.filename === filename
            ? {
                ...img,
                ocrResult,
                cer,
                wer,
                layout: layout === undefined ? img.layout : layout ?? undefined,
            }
            : img
    );
}

function setStatus(status: TuningStatus): void {
    runState.value = { ...runState.value, status };
}

function setTotalPermutations(total: number): void {
    runState.value = { ...runState.value, totalPermutations: total };
}

function setCurrentPermutation(permutation: ParameterPermutation | null): void {
    runState.value = { ...runState.value, currentPermutation: permutation };
}

function incrementCompleted(): void {
    runState.value = {
        ...runState.value,
        completedPermutations: runState.value.completedPermutations + 1,
    };
}

function addResult(result: IterationResult): void {
    const newResults = [...runState.value.results, result];
    const bestResult =
        !runState.value.bestResult ||
        result.combinedScore < runState.value.bestResult.combinedScore
            ? result
            : runState.value.bestResult;

    runState.value = { ...runState.value, results: newResults, bestResult };
}

function startRun(): void {
    runState.value = {
        status: "running",
        totalPermutations: 0,
        completedPermutations: 0,
        currentPermutation: null,
        results: [],
        bestResult: null,
        startTime: Date.now(),
        error: null,
    };
}

function hydrateRunForResume(
    totalPermutations: number,
    results: IterationResult[],
    startTime: number | null = Date.now()
): void {
    const bestResult = results.reduce<IterationResult | null>((best, current) => {
        if (!best || current.combinedScore < best.combinedScore) {
            return current;
        }
        return best;
    }, null);

    runState.value = {
        status: "running",
        totalPermutations,
        completedPermutations: results.length,
        currentPermutation: null,
        results: [...results],
        bestResult,
        startTime,
        error: null,
    };
    selectedResultId.value = null;
}

function pauseRun(): void {
    runState.value = { ...runState.value, status: "paused" };
}

function resumeRun(): void {
    runState.value = { ...runState.value, status: "running" };
}

function completeRun(): void {
    runState.value = { ...runState.value, status: "completed" };
}

function errorRun(error: string): void {
    runState.value = { ...runState.value, status: "error", error };
}

function resetRun(): void {
    runState.value = {
        status: "idle",
        totalPermutations: 0,
        completedPermutations: 0,
        currentPermutation: null,
        results: [],
        bestResult: null,
        startTime: null,
        error: null,
    };
    selectedResultId.value = null;
}

function setSelectedResultId(id: number | null): void {
    selectedResultId.value = id;
}

// =============================================================================
// Composable Export
// =============================================================================

export function useTuningState() {
    return {
        // State (readonly)
        selectedEngine: readonly(selectedEngine) as DeepReadonly<Ref<EngineType>>,
        parameterConfigs: readonly(parameterConfigs) as DeepReadonly<
            Ref<ParameterConfigMap>
        >,
        optimizerSettings: readonly(optimizerSettings) as DeepReadonly<
            Ref<OptimizerSettings>
        >,
        scoringMode: readonly(scoringMode) as DeepReadonly<Ref<ScoringMode>>,
        images: readonly(images) as DeepReadonly<Ref<TuningImage[]>>,
        runState: readonly(runState) as DeepReadonly<Ref<TuningRunState>>,

        // Computed
        isRunning,
        canStart,
        imagesWithGroundTruth,
        elapsedTime,
        estimatedTimeRemaining,
        progress,
        sortedResults,
        selectedResult,
        selectedResultId: readonly(selectedResultId) as DeepReadonly<Ref<number | null>>,

        // Actions - Engine
        setEngine,

        // Actions - Parameters
        setParameterConfig,
        removeParameterConfig,
        clearParameterConfigs,
        setOptimizerSettings,
        setScoringMode,

        // Actions - Images
        addImage,
        removeImage,
        clearImages,
        updateImageOcrResult,

        // Actions - Run
        setStatus,
        setTotalPermutations,
        setCurrentPermutation,
        incrementCompleted,
        addResult,
        startRun,
        hydrateRunForResume,
        pauseRun,
        resumeRun,
        completeRun,
        errorRun,
        resetRun,

        // Actions - Selection
        setSelectedResultId,
    };
}

// =============================================================================
// Utility Type Guards
// =============================================================================

export function isNumberConfig(
    config: ParameterConfig
): config is NumberParameterConfig {
    return "steps" in config;
}

export function isBooleanConfig(
    config: ParameterConfig
): config is BooleanParameterConfig {
    return !("steps" in config) && !("selectedValues" in config);
}

export function isEnumConfig(
    config: ParameterConfig
): config is EnumParameterConfig {
    return "selectedValues" in config;
}
