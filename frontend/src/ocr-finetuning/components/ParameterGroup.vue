<script setup lang="ts">
import { ref, computed } from "vue";
import type { ParameterMetadata, ParameterGroup } from "../types/tuning";
import { GROUP_LABELS } from "../composables/useParameterRegistry";
import ParameterRow from "./ParameterRow.vue";

interface Props {
    group: ParameterGroup;
    parameters: ParameterMetadata[];
    enabledPaths: Set<string>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
    "toggle-all": [group: ParameterGroup, enabled: boolean];
}>();

const isExpanded = ref(true);

const groupLabel = computed(() => GROUP_LABELS[props.group] ?? props.group);

const enabledCount = computed(() => {
    return props.parameters.filter((p) => props.enabledPaths.has(p.path)).length;
});

const allEnabled = computed(() => {
    return props.parameters.length > 0 && enabledCount.value === props.parameters.length;
});

const someEnabled = computed(() => {
    return enabledCount.value > 0 && enabledCount.value < props.parameters.length;
});

function toggleExpanded() {
    isExpanded.value = !isExpanded.value;
}

function toggleAll() {
    emit("toggle-all", props.group, !allEnabled.value);
}
</script>

<template>
    <div class="border-b border-gray-700 last:border-b-0">
        <!-- Group Header -->
        <div
            class="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-750 cursor-pointer select-none"
            @click="toggleExpanded"
        >
            <!-- Expand/Collapse Icon -->
            <svg
                class="w-4 h-4 text-gray-400 transition-transform"
                :class="{ 'rotate-90': isExpanded }"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 5l7 7-7 7"
                />
            </svg>

            <!-- Group Label -->
            <span class="flex-1 text-sm font-medium text-gray-200">
                {{ groupLabel }}
            </span>

            <!-- Enabled Count Badge -->
            <span
                v-if="enabledCount > 0"
                class="px-2 py-0.5 text-xs rounded-full bg-blue-600 text-white"
            >
                {{ enabledCount }}
            </span>

            <!-- Toggle All Checkbox -->
            <input
                type="checkbox"
                :checked="allEnabled"
                :indeterminate="someEnabled"
                class="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-800"
                @click.stop="toggleAll"
            />
        </div>

        <!-- Parameters -->
        <div v-show="isExpanded" class="bg-gray-850">
            <ParameterRow
                v-for="param in parameters"
                :key="param.path"
                :parameter="param"
            />
        </div>
    </div>
</template>

<style scoped>
.bg-gray-750 {
    background-color: rgb(55, 65, 81);
}

.bg-gray-850 {
    background-color: rgb(26, 32, 44);
}
</style>
