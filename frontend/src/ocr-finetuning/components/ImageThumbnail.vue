<script setup lang="ts">
import { computed } from "vue";
import type { TuningImage } from "../types/tuning";
import { useTuningState } from "../composables/useTuningState";
import { formatErrorRate } from "../utils/cer-wer";

interface Props {
    image: TuningImage;
    showLayout?: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
    remove: [filename: string];
}>();

const { selectedResult } = useTuningState();

// Get score for this image from selected result (if any)
const selectedImageScore = computed(() => {
    if (!selectedResult.value) return null;
    return selectedResult.value.imageScores.find(
        (s) => s.filename === props.image.filename
    ) ?? null;
});

// Use selected result's OCR text if available, otherwise use current run's
const displayOcrText = computed(() => {
    if (selectedImageScore.value) return selectedImageScore.value.ocrText;
    return props.image.ocrResult;
});

const displayCer = computed(() => {
    if (selectedImageScore.value) return selectedImageScore.value.cer;
    return props.image.cer;
});

const displayWer = computed(() => {
    if (selectedImageScore.value) return selectedImageScore.value.wer;
    return props.image.wer;
});

const hasResults = computed(() => displayCer.value !== undefined);

const isShowingSelectedResult = computed(() => selectedImageScore.value !== null);

const cerClass = computed(() => {
    if (displayCer.value === undefined) return "";
    if (displayCer.value <= 0.05) return "text-green-400";
    if (displayCer.value <= 0.15) return "text-yellow-400";
    return "text-red-400";
});

const werClass = computed(() => {
    if (displayWer.value === undefined) return "";
    if (displayWer.value <= 0.1) return "text-green-400";
    if (displayWer.value <= 0.25) return "text-yellow-400";
    return "text-red-400";
});

const layoutForDisplay = computed(() => {
    if (selectedImageScore.value?.layout) return selectedImageScore.value.layout;
    return props.image.layout ?? null;
});

const showLayoutOverlay = computed(() => props.showLayout !== false);

const layoutRegions = computed(() => layoutForDisplay.value?.regions ?? []);

const layoutViewBox = computed(() => {
    const layout = layoutForDisplay.value;
    if (!layout) return "0 0 1 1";
    return `0 0 ${layout.imageWidth} ${layout.imageHeight}`;
});

const LABEL_COLORS: Record<string, string> = {
    Text: "#22c55e",
    Title: "#3b82f6",
    "Section-header": "#a855f7",
    "List-item": "#f97316",
    Caption: "#eab308",
    "Page-header": "#14b8a6",
    "Page-footer": "#0ea5e9",
    Footnote: "#f43f5e",
    Table: "#ef4444",
    Picture: "#8b5cf6",
    Formula: "#f59e0b",
};

function regionColor(label: string): string {
    return LABEL_COLORS[label] ?? "#94a3b8";
}

function labelFontSize(height: number): number {
    return Math.max(12, Math.min(24, Math.round(height * 0.12)));
}
</script>

<template>
    <div class="bg-gray-800 rounded-lg overflow-hidden border border-gray-700">
        <!-- Image -->
        <div class="relative aspect-[4/3] bg-gray-900">
            <img
                :src="image.url"
                :alt="image.filename"
                class="w-full h-full object-contain"
                loading="lazy"
            />

            <!-- Layout Overlay -->
            <svg
                v-if="showLayoutOverlay && layoutForDisplay"
                class="absolute inset-0 w-full h-full pointer-events-none"
                :viewBox="layoutViewBox"
                preserveAspectRatio="xMidYMid meet"
            >
                <g v-for="(region, idx) in layoutRegions" :key="`${region.label}-${idx}`">
                    <rect
                        :x="region.bbox.x"
                        :y="region.bbox.y"
                        :width="region.bbox.width"
                        :height="region.bbox.height"
                        :stroke="regionColor(region.label)"
                        :fill="regionColor(region.label)"
                        fill-opacity="0.08"
                        stroke-width="2"
                    />
                    <text
                        :x="region.bbox.x + 4"
                        :y="region.bbox.y + labelFontSize(region.bbox.height)"
                        :font-size="labelFontSize(region.bbox.height)"
                        fill="white"
                        stroke="rgba(0,0,0,0.6)"
                        stroke-width="2"
                        paint-order="stroke"
                    >
                        {{ region.label }}
                    </text>
                </g>
            </svg>

            <!-- Remove Button -->
            <button
                class="absolute top-2 right-2 p-1 bg-gray-900/80 hover:bg-red-600 rounded-full transition-colors"
                title="Entfernen"
                @click="emit('remove', image.filename)"
            >
                <svg class="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>

            <!-- No Ground Truth Warning -->
            <div
                v-if="!image.hasGroundTruth && image.groundTruthChecked"
                class="absolute bottom-2 left-2 right-2 px-2 py-1 bg-yellow-600/90 rounded text-xs text-white text-center"
                :title="'Gesucht im selben Ordner: ' + image.filename.replace(/\.[^.]+$/, '.gt.json oder .txt')"
            >
                Keine Ground Truth im gleichen Ordner gefunden
            </div>
        </div>

        <!-- Info -->
        <div class="p-3">
            <!-- Filename -->
            <div class="text-sm font-medium text-gray-200 truncate" :title="image.filename">
                {{ image.filename }}
            </div>

            <!-- Ground Truth Preview -->
            <div v-if="image.groundTruth" class="mt-2">
                <div class="text-xs text-gray-500 mb-1">Ground Truth:</div>
                <div
                    class="max-h-32 overflow-y-auto text-xs text-gray-400 bg-gray-900 rounded p-2 whitespace-pre-wrap break-words"
                >
                    {{ image.groundTruth }}
                </div>
            </div>

            <!-- OCR Result -->
            <div v-if="displayOcrText !== undefined" class="mt-2">
                <div class="text-xs text-gray-500 mb-1 flex items-center gap-2">
                    <span>OCR Ergebnis:</span>
                    <span
                        v-if="isShowingSelectedResult"
                        class="px-1.5 py-0.5 bg-blue-600 text-white rounded text-[10px]"
                    >
                        Ausgewähltes Ergebnis
                    </span>
                </div>
                <div
                    class="max-h-32 overflow-y-auto text-xs text-gray-400 bg-gray-900 rounded p-2 whitespace-pre-wrap break-words"
                    :class="{ 'ring-1 ring-blue-500': isShowingSelectedResult }"
                >
                    {{ displayOcrText }}
                </div>
            </div>

            <!-- Scores -->
            <div v-if="hasResults" class="mt-2 flex gap-4 text-xs">
                <div>
                    <span class="text-gray-500">CER:</span>
                    <span :class="cerClass" class="ml-1 font-medium">
                        {{ formatErrorRate(displayCer!) }}
                    </span>
                </div>
                <div>
                    <span class="text-gray-500">WER:</span>
                    <span :class="werClass" class="ml-1 font-medium">
                        {{ formatErrorRate(displayWer!) }}
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>
