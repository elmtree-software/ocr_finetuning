<script setup lang="ts">
import { computed } from "vue";
import { useTuningState } from "../composables/useTuningState";
import { useParameterRegistry } from "../composables/useParameterRegistry";
import { usePermutationGenerator } from "../composables/usePermutationGenerator";
import ParameterGroup from "./ParameterGroup.vue";
import type {
    ParameterGroup as ParameterGroupType,
    NumberParameterConfig,
    EnumParameterConfig,
    ParameterConfigMap,
    ScoringMode,
} from "../types/tuning";

const {
    selectedEngine,
    setEngine,
    parameterConfigs,
    setParameterConfig,
    removeParameterConfig,
    clearParameterConfigs,
    optimizerSettings,
    setOptimizerSettings,
    scoringMode,
    setScoringMode,
    runState,
} =
    useTuningState();
const { parametersByGroup, orderedGroups, getParametersForEngine } = useParameterRegistry();
const { permutationCount, permutationDescription, isLargePermutationCount, isVeryLargePermutationCount } =
    usePermutationGenerator();

// Filter parameters for current engine
const filteredParametersByGroup = computed(() => {
    const result = new Map<ParameterGroupType, typeof parametersByGroup.value extends Map<any, infer V> ? V : never>();
    const engineParams = getParametersForEngine(selectedEngine.value);
    const enginePaths = new Set(engineParams.map((p) => p.path));

    for (const [group, params] of parametersByGroup.value) {
        const filtered = params.filter((p) => enginePaths.has(p.path));
        if (filtered.length > 0) {
            result.set(group, filtered);
        }
    }

    return result;
});

// Set of enabled parameter paths
const enabledPaths = computed(() => {
    return new Set(
        Object.entries(parameterConfigs.value)
            .filter(([_, config]) => config.enabled)
            .map(([path]) => path)
    );
});

const isDisabled = computed(() => runState.value.status !== "idle");
const iterations = computed(() => optimizerSettings.value.iterations);
const initialSamples = computed(() => optimizerSettings.value.initialSamples);
const selectedScoringMode = computed(() => scoringMode.value);

type TuningPreset = {
    id: string;
    label: string;
    description: string;
    engine: "tesseract" | "paddleocr";
    optimizer: { iterations: number; initialSamples: number; candidateSamples: number };
    parameterConfigs: ParameterConfigMap;
};

const tuningPresets: TuningPreset[] = [
    {
        id: "tesseract-balanced",
        label: "Tesseract Balanced",
        description: "Volltext-stabil mit Fokus auf Vorverarbeitung und Recall.",
        engine: "tesseract",
        optimizer: { iterations: 80, initialSamples: 20, candidateSamples: 400 },
        parameterConfigs: {
            "preprocessing.contrastBoost": { enabled: true, min: 1.5, max: 2.5, steps: 3 },
            "preprocessing.dpiScaling.minCapitalHeightPx": { enabled: true, min: 18, max: 30, steps: 4 },
            "preprocessing.dpiScaling.maxScale": { enabled: true, min: 3, max: 5, steps: 3 },
            "preprocessing.clahe.enabled": { enabled: true },
            "preprocessing.threshold.enabled": { enabled: true },
            "output.minTextLength": { enabled: true, min: 1, max: 2, steps: 2 },
            "output.minLineConfidence": { enabled: true, min: 0.2, max: 0.45, steps: 4 },
        },
    },
    {
        id: "paddle-focus",
        label: "Paddle Focus",
        description: "Kleiner, sinnvoller Suchraum für Paddle-Detection/Recognition.",
        engine: "paddleocr",
        optimizer: { iterations: 120, initialSamples: 30, candidateSamples: 600 },
        parameterConfigs: {
            "paddleocr.language": { enabled: true, selectedValues: ["german", "latin"] },
            "paddleocr.detThreshold": { enabled: true, min: 0.2, max: 0.45, steps: 4 },
            "paddleocr.boxThreshold": { enabled: true, min: 0.45, max: 0.7, steps: 4 },
            "paddleocr.detInputSize": { enabled: true, min: 960, max: 1600, steps: 3 },
            "paddleocr.unclipRatio": { enabled: true, min: 1.6, max: 2.1, steps: 3 },
            "preprocessing.clahe.enabled": { enabled: true },
        },
    },
    {
        id: "recall-rescue",
        label: "Recall Rescue",
        description: "Gegen zu kurze/abgeschnittene OCR-Ausgaben.",
        engine: "tesseract",
        optimizer: { iterations: 120, initialSamples: 30, candidateSamples: 600 },
        parameterConfigs: {
            "layout.enabled": { enabled: true },
            "fallback.enabled": { enabled: true },
            "rotation.enabled": { enabled: true },
            "preprocessing.threshold.enabled": { enabled: true },
            "preprocessing.threshold.type": { enabled: true, selectedValues: ["otsu", "adaptive"] },
            "preprocessing.contrastBoost": { enabled: true, min: 1.25, max: 2.25, steps: 5 },
            "output.minTextLength": { enabled: true, min: 1, max: 2, steps: 2 },
            "output.minLineConfidence": { enabled: true, min: 0.15, max: 0.35, steps: 3 },
        },
    },
];

function handleEngineChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    setEngine(target.value as "tesseract" | "paddleocr");
    // Clear configs when engine changes as some parameters may no longer apply
    clearParameterConfigs();
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function handleIterationsChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const next = clamp(Math.floor(Number(target.value)), 1, 10000);
    setOptimizerSettings({ iterations: next });
}

function handleInitialSamplesChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const next = clamp(Math.floor(Number(target.value)), 1, 10000);
    setOptimizerSettings({ initialSamples: next });
}

function handleScoringModeChange(mode: ScoringMode) {
    if (isDisabled.value) return;
    setScoringMode(mode);
}

function handleToggleAll(group: ParameterGroupType, enabled: boolean) {
    const params = filteredParametersByGroup.value.get(group) ?? [];

    for (const param of params) {
        if (enabled) {
            // Enable parameter
            if (param.type === "number") {
                const config: NumberParameterConfig = {
                    enabled: true,
                    min: param.min ?? 0,
                    max: param.max ?? 1,
                    steps: 3,
                };
                setParameterConfig(param.path, config);
            } else if (param.type === "boolean") {
                setParameterConfig(param.path, { enabled: true });
            } else if (param.type === "enum") {
                const config: EnumParameterConfig = {
                    enabled: true,
                    selectedValues: param.options ?? [],
                };
                setParameterConfig(param.path, config);
            }
        } else {
            // Disable parameter
            removeParameterConfig(param.path);
        }
    }
}

function applyPreset(preset: TuningPreset) {
    if (isDisabled.value) return;

    setEngine(preset.engine);
    clearParameterConfigs();

    for (const [path, config] of Object.entries(preset.parameterConfigs)) {
        setParameterConfig(path, structuredClone(config));
    }

    setOptimizerSettings({
        iterations: preset.optimizer.iterations,
        initialSamples: preset.optimizer.initialSamples,
        candidateSamples: preset.optimizer.candidateSamples,
    });
}
</script>

<template>
    <div class="flex flex-col h-full bg-gray-900">
        <!-- Header -->
        <div class="p-4 border-b border-gray-700">
            <h2 class="text-lg font-semibold text-white mb-3">Parameter</h2>

            <!-- Engine Selection -->
            <div class="mb-4">
                <label class="block text-sm text-gray-400 mb-1">OCR Engine</label>
                <select
                    :value="selectedEngine"
                    :disabled="isDisabled"
                    class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-md text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                    @change="handleEngineChange"
                >
                    <option value="paddleocr">PaddleOCR</option>
                    <option value="tesseract">Tesseract</option>
                </select>
                <p class="text-xs text-gray-500 mt-1">
                    Engine wird nicht iteriert
                </p>
            </div>

            <!-- Scoring Mode -->
            <div class="mb-4">
                <label class="block text-sm text-gray-400 mb-2">Bewertung</label>
                <div class="grid grid-cols-3 gap-2">
                    <button
                        :disabled="isDisabled"
                        class="px-3 py-2 rounded-md text-sm transition-colors disabled:opacity-50"
                        :class="selectedScoringMode === 'fulltext' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'"
                        @click="handleScoringModeChange('fulltext')"
                    >
                        Volltext
                    </button>
                    <button
                        :disabled="isDisabled"
                        class="px-3 py-2 rounded-md text-sm transition-colors disabled:opacity-50"
                        :class="selectedScoringMode === 'regions' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'"
                        @click="handleScoringModeChange('regions')"
                    >
                        Regionen
                    </button>
                    <button
                        :disabled="isDisabled"
                        class="px-3 py-2 rounded-md text-sm transition-colors disabled:opacity-50"
                        :class="selectedScoringMode === 'customWER' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'"
                        @click="handleScoringModeChange('customWER')"
                    >
                        Custom WER
                    </button>
                </div>
                <p class="text-xs text-gray-500 mt-1">
                    Custom WER: schlechtestes Bild streichen, Rest mitteln. Optimal für Optimierung.
                </p>
            </div>

            <!-- Presets -->
            <div class="mb-4">
                <label class="block text-sm text-gray-400 mb-2">Presets</label>
                <div class="space-y-2">
                    <button
                        v-for="preset in tuningPresets"
                        :key="preset.id"
                        :disabled="isDisabled"
                        class="w-full text-left px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md transition-colors disabled:opacity-50"
                        @click="applyPreset(preset)"
                    >
                        <div class="text-sm text-gray-200 font-medium">{{ preset.label }}</div>
                        <div class="text-xs text-gray-400 mt-0.5">{{ preset.description }}</div>
                    </button>
                </div>
            </div>

            <!-- Search Space Size -->
            <div
                class="p-3 rounded-md text-sm"
                :class="{
                    'bg-gray-800 text-gray-300': !isLargePermutationCount,
                    'bg-yellow-900/50 text-yellow-200': isLargePermutationCount && !isVeryLargePermutationCount,
                    'bg-red-900/50 text-red-200': isVeryLargePermutationCount,
                }"
            >
                <div class="font-medium">{{ permutationCount }} Kombinationen</div>
                <div class="text-xs opacity-75 mt-1">
                    {{ permutationDescription }}
                </div>
                <div v-if="isVeryLargePermutationCount" class="text-xs mt-2">
                    Warnung: Sehr viele Kombinationen. Reduziere Steps oder deaktiviere Parameter.
                </div>
            </div>

            <!-- Optimizer Settings -->
            <div class="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                    <label class="block text-xs text-gray-400 mb-1">Iterationen</label>
                    <input
                        type="number"
                        min="1"
                        step="1"
                        :value="iterations"
                        :disabled="isDisabled"
                        class="w-full px-2 py-1.5 bg-gray-800 border border-gray-600 rounded-md text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                        @change="handleIterationsChange"
                    />
                </div>
                <div>
                    <label class="block text-xs text-gray-400 mb-1">Initiale Samples</label>
                    <input
                        type="number"
                        min="1"
                        step="1"
                        :value="initialSamples"
                        :disabled="isDisabled"
                        class="w-full px-2 py-1.5 bg-gray-800 border border-gray-600 rounded-md text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                        @change="handleInitialSamplesChange"
                    />
                </div>
            </div>
        </div>

        <!-- Parameter Groups -->
        <div class="flex-1 overflow-y-auto">
            <ParameterGroup
                v-for="group in orderedGroups"
                v-show="filteredParametersByGroup.has(group)"
                :key="group"
                :group="group"
                :parameters="filteredParametersByGroup.get(group) ?? []"
                :enabled-paths="enabledPaths"
                @toggle-all="handleToggleAll"
            />
        </div>

        <!-- Footer Actions -->
        <div class="p-3 border-t border-gray-700">
            <button
                :disabled="isDisabled"
                class="w-full px-3 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-md transition-colors disabled:opacity-50"
                @click="clearParameterConfigs"
            >
                Alle Parameter zurücksetzen
            </button>
        </div>
    </div>
</template>
