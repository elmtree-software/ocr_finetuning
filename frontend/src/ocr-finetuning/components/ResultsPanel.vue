<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useTuningState } from "../composables/useTuningState";
import { useTuningRunner } from "../composables/useTuningRunner";
import { useFileSaver } from "../composables/useFileSaver";
import { formatErrorRate } from "../utils/cer-wer";
import { generateConfigExport, generateAllResultsTs, generateFilename } from "../utils/config-export";
import type { IterationResult } from "../types/tuning";

const state = useTuningState();
const runner = useTuningRunner();
const fileSaver = useFileSaver();

const isCurrentParamsExpanded = ref(false);
const showSaveToast = ref(false);
const saveToastMessage = ref("");
const resumeFolderInput = ref<HTMLInputElement | null>(null);

// Watch for save success and show toast
watch(fileSaver.lastSaveSuccess, (success) => {
    if (success) {
        const methodText = success.method === "websocket" ? "gespeichert" : "heruntergeladen";
        saveToastMessage.value = `${success.filename} ${methodText}`;
        showSaveToast.value = true;
        setTimeout(() => {
            showSaveToast.value = false;
            fileSaver.clearLastSaveSuccess();
        }, 3000);
    }
});

// Computed
const status = computed(() => state.runState.value.status);
const progress = computed(() => state.progress.value);
const completedCount = computed(() => state.runState.value.completedPermutations);
const totalCount = computed(() => state.runState.value.totalPermutations);
const bestResult = computed(() => state.runState.value.bestResult);
const sortedResults = computed(() => state.sortedResults.value);
const currentPermutation = computed(() => state.runState.value.currentPermutation);
const scoringModeLabel = computed(() =>
    state.scoringMode.value === "regions" ? "Regionen"
    : state.scoringMode.value === "customWER" ? "Custom WER (drop worst)"
    : "Volltext"
);

const canStart = computed(() =>
    state.canStart.value && state.optimizerSettings.value.iterations > 0
);
const startDisabledReason = computed(() => {
    if (canStart.value) return "";
    if (state.images.value.length === 0) return "Bitte zuerst Bilder laden.";
    if (state.imagesWithGroundTruth.value.length === 0) {
        return "Kein Bild mit Ground Truth gefunden (.gt.json/.txt im gleichen Ordner erforderlich).";
    }
    if (state.optimizerSettings.value.iterations <= 0) return "Iterationen müssen > 0 sein.";
    return "Start derzeit nicht möglich.";
});
const isRunning = computed(() => status.value === "running");
const isPaused = computed(() => status.value === "paused");
const isCompleted = computed(() => status.value === "completed");
const hasResults = computed(() => sortedResults.value.length > 0);
const selectedResultId = computed(() => state.selectedResultId.value);
const selectedResult = computed(() => state.selectedResult.value);

// Estimated time remaining
const estimatedTimeRemaining = computed(() => {
    const ms = state.estimatedTimeRemaining.value;
    if (!ms) return null;

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `~${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
        return `~${minutes}m ${seconds % 60}s`;
    }
    return `~${seconds}s`;
});

// Actions
function handleStart() {
    runner.start();
}

function handleResumeFolderPick() {
    if (status.value !== "idle") return;
    resumeFolderInput.value?.click();
}

async function handleResumeFolderSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    if (files.length === 0) return;

    const result = await runner.resumeFromFolderFiles(files);
    if (!result.success && result.error) {
        window.alert(result.error);
    }

    input.value = "";
}

function handlePause() {
    runner.pause();
}

function handleResume() {
    runner.resume();
}

function handleAbort() {
    runner.abort();
}

function handleReset() {
    state.resetRun();
}

function selectResult(result: IterationResult) {
    state.setSelectedResultId(selectedResultId.value === result.id ? null : result.id);
}

async function exportBestConfig() {
    if (!bestResult.value) return;

    const imageNames = state.images.value.map((i) => i.filename);
    const content = generateConfigExport(
        bestResult.value.parameters,
        {
            images: imageNames,
            cer: bestResult.value.averageCER,
            wer: bestResult.value.averageWER,
            date: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
        bestResult.value.imageScores
    );

    const filename = generateFilename(imageNames, "best.ts");
    await fileSaver.saveConfig(filename, content);
}

async function exportAllResults() {
    const imageNames = state.images.value.map((i) => i.filename);
    const content = generateAllResultsTs(sortedResults.value, imageNames);
    const filename = generateFilename(imageNames, "all.ts");
    await fileSaver.saveConfig(filename, content);
}

async function exportSelectedResult() {
    if (!selectedResult.value) return;

    const imageNames = state.images.value.map((i) => i.filename);
    const content = generateConfigExport(
        selectedResult.value.parameters,
        {
            images: imageNames,
            cer: selectedResult.value.averageCER,
            wer: selectedResult.value.averageWER,
            date: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
        selectedResult.value.imageScores
    );

    const filename = generateFilename(imageNames, `result_${selectedResult.value.id}.ts`);
    await fileSaver.saveConfig(filename, content);
}

function formatParameters(result: { readonly parameters: readonly { readonly path: string; readonly value: string | number | boolean }[] }): string {
    if (result.parameters.length === 0) return "Standard-Konfiguration";
    return result.parameters
        .map((p) => `${p.path.split(".").pop()}: ${p.value}`)
        .join(", ");
}

function formatRatio(value?: number | null): string {
    if (value === undefined || value === null || !Number.isFinite(value)) return "n/a";
    return `${(value * 100).toFixed(0)}%`;
}
</script>

<template>
    <div class="flex flex-col h-full bg-gray-900 relative">
        <input
            ref="resumeFolderInput"
            type="file"
            webkitdirectory
            directory
            multiple
            class="hidden"
            @change="handleResumeFolderSelected"
        >

        <!-- Save Success Toast -->
        <Transition
            enter-active-class="transition-all duration-300 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0 -translate-y-2"
            enter-to-class="opacity-100 translate-y-0"
            leave-from-class="opacity-100 translate-y-0"
            leave-to-class="opacity-0 -translate-y-2"
        >
            <div
                v-if="showSaveToast"
                class="absolute top-2 left-2 right-2 z-10 px-4 py-2 bg-green-600 text-white text-sm rounded-md shadow-lg flex items-center gap-2"
            >
                <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
                <span class="truncate">{{ saveToastMessage }}</span>
            </div>
        </Transition>

        <!-- Header -->
        <div class="p-4 border-b border-gray-700">
            <div class="mb-3 flex items-center justify-between gap-2">
                <h2 class="text-lg font-semibold text-white">Ergebnisse</h2>
                <div class="text-xs px-2 py-1 rounded bg-gray-800 text-gray-300 border border-gray-700">
                    Bewertung: {{ scoringModeLabel }}
                </div>
            </div>

            <!-- Progress -->
            <div class="mb-4">
                <div class="flex justify-between text-sm text-gray-400 mb-1">
                    <span>{{ completedCount }} / {{ totalCount }}</span>
                    <span v-if="estimatedTimeRemaining && isRunning">
                        {{ estimatedTimeRemaining }}
                    </span>
                </div>
                <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div
                        class="h-full bg-blue-500 transition-all duration-300"
                        :style="{ width: `${progress}%` }"
                    />
                </div>
            </div>

            <!-- Control Buttons -->
            <div class="flex gap-2">
                <!-- Start -->
                <button
                    v-if="status === 'idle'"
                    :disabled="!canStart"
                    :title="!canStart ? startDisabledReason : ''"
                    class="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-md transition-colors"
                    @click="handleStart"
                >
                    Start
                </button>
                <button
                    v-if="status === 'idle'"
                    class="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
                    @click="handleResumeFolderPick"
                >
                    Resume
                </button>

                <!-- Pause/Resume -->
                <button
                    v-if="isRunning"
                    class="flex-1 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white text-sm font-medium rounded-md transition-colors"
                    @click="handlePause"
                >
                    Pause
                </button>
                <button
                    v-if="isPaused"
                    class="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-md transition-colors"
                    @click="handleResume"
                >
                    Fortsetzen
                </button>

                <!-- Abort -->
                <button
                    v-if="isRunning || isPaused"
                    class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-md transition-colors"
                    @click="handleAbort"
                >
                    Abbrechen
                </button>

                <!-- Reset -->
                <button
                    v-if="isCompleted"
                    class="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-md transition-colors"
                    @click="handleReset"
                >
                    Zurücksetzen
                </button>
            </div>
        </div>

        <!-- Current Permutation (Collapsible) -->
        <div
            v-if="currentPermutation && (isRunning || isPaused)"
            class="border-b border-gray-700 bg-gray-800"
        >
            <div
                class="px-4 py-2 flex items-center justify-between cursor-pointer hover:bg-gray-750"
                @click="isCurrentParamsExpanded = !isCurrentParamsExpanded"
            >
                <div class="text-xs text-gray-500">Aktuelle Parameter:</div>
                <svg
                    class="w-4 h-4 text-gray-500 transition-transform"
                    :class="{ 'rotate-180': isCurrentParamsExpanded }"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
            </div>
            <!-- Collapsed view -->
            <div v-if="!isCurrentParamsExpanded" class="px-4 pb-2 text-sm text-gray-300 truncate">
                {{ currentPermutation.length === 0 ? "Standard" : currentPermutation.map(p => `${p.path.split('.').pop()}=${p.value}`).join(', ') }}
            </div>
            <!-- Expanded view -->
            <div v-else class="px-4 pb-3 space-y-1">
                <div v-if="currentPermutation.length === 0" class="text-sm text-gray-400">
                    Standard-Konfiguration
                </div>
                <div
                    v-for="param in currentPermutation"
                    :key="param.path"
                    class="text-xs flex justify-between"
                >
                    <span class="text-gray-500">{{ param.path }}</span>
                    <span class="text-gray-300 font-mono">{{ param.value }}</span>
                </div>
            </div>
        </div>

        <!-- Best Result Card -->
        <div
            v-if="bestResult"
            class="mx-4 mt-4 p-4 bg-green-900/30 border border-green-700 rounded-lg"
        >
            <div class="text-sm font-medium text-green-400 mb-2">Bestes Ergebnis</div>
            <div class="flex gap-6 text-sm">
                <div>
                    <span class="text-gray-500">CER:</span>
                    <span class="text-green-400 font-medium ml-1">
                        {{ formatErrorRate(bestResult.averageCER) }}
                    </span>
                </div>
                <div>
                    <span class="text-gray-500">WER:</span>
                    <span class="text-green-400 font-medium ml-1">
                        {{ formatErrorRate(bestResult.averageWER) }}
                    </span>
                </div>
            </div>
            <div class="flex gap-6 text-xs mt-2">
                <div>
                    <span class="text-gray-500">Len:</span>
                    <span class="text-gray-300 ml-1">
                        {{ formatRatio(bestResult.medianLengthRatio) }}
                    </span>
                </div>
                <div>
                    <span class="text-gray-500">Leer:</span>
                    <span class="text-gray-300 ml-1">
                        {{ formatRatio(bestResult.emptyOutputRate) }}
                    </span>
                </div>
                <div>
                    <span class="text-gray-500">Qualität:</span>
                    <span
                        class="ml-1 font-medium"
                        :class="bestResult.feasible ? 'text-green-300' : 'text-yellow-300'"
                    >
                        {{ bestResult.feasible ? "ok" : "kritisch" }}
                    </span>
                </div>
            </div>
            <div class="text-xs text-gray-500 mt-2 truncate">
                {{ formatParameters(bestResult) }}
            </div>
        </div>

        <!-- Results List -->
        <div class="flex-1 overflow-y-auto px-4 py-2">
            <div v-if="!hasResults && status === 'idle'" class="text-center text-gray-500 py-8">
                Starte einen Durchlauf um Ergebnisse zu sehen
            </div>

            <div v-else class="space-y-2">
                <div
                    v-for="(result, index) in sortedResults.slice(0, 50)"
                    :key="result.id"
                    class="p-3 bg-gray-800 rounded-lg cursor-pointer hover:bg-gray-750 transition-colors"
                    :class="{ 'ring-2 ring-blue-500': selectedResultId === result.id }"
                    @click="selectResult(result)"
                >
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <span class="text-xs text-gray-500">#{{ index + 1 }}</span>
                            <span
                                class="text-[10px] px-1.5 py-0.5 rounded"
                                :class="result.feasible ? 'bg-green-900/40 text-green-300' : 'bg-yellow-900/40 text-yellow-300'"
                            >
                                {{ result.feasible ? "ok" : "kritisch" }}
                            </span>
                        </div>
                        <div class="flex gap-4 text-xs">
                            <span>
                                CER: <span class="text-gray-300">{{ formatErrorRate(result.averageCER) }}</span>
                            </span>
                            <span>
                                WER: <span class="text-gray-300">{{ formatErrorRate(result.averageWER) }}</span>
                            </span>
                            <span>
                                Len: <span class="text-gray-300">{{ formatRatio(result.medianLengthRatio) }}</span>
                            </span>
                            <span>
                                Leer: <span class="text-gray-300">{{ formatRatio(result.emptyOutputRate) }}</span>
                            </span>
                        </div>
                    </div>

                    <!-- Expanded Details -->
                    <div
                        v-if="selectedResultId === result.id"
                        class="mt-3 pt-3 border-t border-gray-700"
                    >
                        <div class="text-xs text-gray-500 mb-2">Parameter:</div>
                        <div
                            v-if="result.parameters.length === 0"
                            class="text-xs text-gray-400"
                        >
                            Standard-Konfiguration
                        </div>
                        <div v-else class="space-y-1">
                            <div
                                v-for="param in result.parameters"
                                :key="param.path"
                                class="text-xs"
                            >
                                <span class="text-gray-500">{{ param.path }}:</span>
                                <span class="text-gray-300 ml-1">{{ param.value }}</span>
                            </div>
                        </div>

                        <div class="text-xs text-gray-500 mt-3 mb-2">Pro Bild:</div>
                        <div class="space-y-1">
                            <div
                                v-for="score in result.imageScores"
                                :key="score.filename"
                                class="text-xs flex justify-between"
                            >
                                <span class="text-gray-400 truncate mr-2">{{ score.filename }}</span>
                                <span class="text-gray-300">
                                    {{ formatErrorRate(score.cer) }} / {{ formatErrorRate(score.wer) }}
                                </span>
                            </div>
                        </div>

                        <!-- Export this result button -->
                        <button
                            class="mt-3 w-full px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors"
                            @click.stop="exportSelectedResult"
                        >
                            Dieses Ergebnis exportieren
                        </button>
                    </div>
                </div>

                <div
                    v-if="sortedResults.length > 50"
                    class="text-center text-xs text-gray-500 py-2"
                >
                    +{{ sortedResults.length - 50 }} weitere Ergebnisse
                </div>
            </div>
        </div>

        <!-- Export Buttons -->
        <div
            v-if="hasResults"
            class="p-4 border-t border-gray-700 space-y-2"
        >
            <button
                :disabled="!bestResult || fileSaver.isSaving.value"
                class="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-md transition-colors"
                @click="exportBestConfig"
            >
                Beste Config exportieren (.ts)
            </button>
            <button
                :disabled="fileSaver.isSaving.value"
                class="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-medium rounded-md transition-colors"
                @click="exportAllResults"
            >
                Alle Ergebnisse exportieren (.ts)
            </button>
        </div>
    </div>
</template>

<style scoped>
.bg-gray-750 {
    background-color: rgb(55, 65, 81);
}
</style>
