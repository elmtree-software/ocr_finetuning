<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { ParameterMetadata, NumberParameterConfig, EnumParameterConfig } from "../types/tuning";
import { useTuningState, isNumberConfig, isEnumConfig } from "../composables/useTuningState";
import { linspace } from "../composables/usePermutationGenerator";
import { DEFAULT_CONFIG } from "@/services/ocr/config";

interface Props {
    parameter: ParameterMetadata;
}

const props = defineProps<Props>();

const { parameterConfigs, setParameterConfig, removeParameterConfig, selectedEngine } =
    useTuningState();

// Get default value from DEFAULT_CONFIG using dot notation path
function getDefaultValue(path: string): unknown {
    const keys = path.split(".");
    let current: unknown = DEFAULT_CONFIG;

    for (const key of keys) {
        if (current && typeof current === "object" && key in current) {
            current = (current as Record<string, unknown>)[key];
        } else {
            return undefined;
        }
    }

    return current;
}

const defaultValue = computed(() => {
    const val = getDefaultValue(props.parameter.path);
    if (val === undefined || val === null) return "-";
    return String(val);
});

// Local state for editing
const localMin = ref(props.parameter.min ?? 0);
const localMax = ref(props.parameter.max ?? 1);
const localSteps = ref(3);
const localSelectedValues = ref<string[]>([]);

// Check if this parameter is visible for current engine
const isVisible = computed(() => {
    if (!props.parameter.engineSpecific) return true;
    return props.parameter.engineSpecific === selectedEngine.value;
});

// Get current config for this parameter
const currentConfig = computed(() => {
    return parameterConfigs.value[props.parameter.path];
});

const isEnabled = computed(() => {
    return currentConfig.value?.enabled ?? false;
});

// Preview of values that will be iterated
const valuePreview = computed(() => {
    if (!isEnabled.value) return "";

    if (props.parameter.type === "number") {
        const values = linspace(localMin.value, localMax.value, localSteps.value);
        if (values.length <= 5) {
            return values.join(", ");
        }
        return `${values[0]}, ${values[1]}, ..., ${values[values.length - 1]}`;
    }

    if (props.parameter.type === "boolean") {
        return "true, false";
    }

    if (props.parameter.type === "enum") {
        return localSelectedValues.value.join(", ") || "-";
    }

    return "";
});

// Initialize local state from config
watch(
    currentConfig,
    (config) => {
        if (config && isNumberConfig(config)) {
            localMin.value = config.min;
            localMax.value = config.max;
            localSteps.value = config.steps;
        }
        if (config && isEnumConfig(config)) {
            localSelectedValues.value = [...config.selectedValues];
        }
    },
    { immediate: true }
);

// Toggle enabled state
function toggleEnabled() {
    if (isEnabled.value) {
        removeParameterConfig(props.parameter.path);
    } else {
        // Enable with appropriate config
        if (props.parameter.type === "number") {
            const config: NumberParameterConfig = {
                enabled: true,
                min: props.parameter.min ?? 0,
                max: props.parameter.max ?? 1,
                steps: 3,
            };
            localMin.value = config.min;
            localMax.value = config.max;
            localSteps.value = config.steps;
            setParameterConfig(props.parameter.path, config);
        } else if (props.parameter.type === "boolean") {
            setParameterConfig(props.parameter.path, { enabled: true });
        } else if (props.parameter.type === "enum") {
            const allValues = props.parameter.options ?? [];
            localSelectedValues.value = [...allValues];
            const config: EnumParameterConfig = {
                enabled: true,
                selectedValues: allValues,
            };
            setParameterConfig(props.parameter.path, config);
        }
    }
}

// Update number config
function updateNumberConfig() {
    if (!isEnabled.value) return;

    const config: NumberParameterConfig = {
        enabled: true,
        min: localMin.value,
        max: localMax.value,
        steps: Math.max(1, Math.min(20, localSteps.value)),
    };
    setParameterConfig(props.parameter.path, config);
}

// Update enum config
function updateEnumConfig() {
    if (!isEnabled.value) return;

    const config: EnumParameterConfig = {
        enabled: true,
        selectedValues: localSelectedValues.value,
    };
    setParameterConfig(props.parameter.path, config);
}

// Toggle enum value
function toggleEnumValue(value: string) {
    if (localSelectedValues.value.includes(value)) {
        localSelectedValues.value = localSelectedValues.value.filter((v) => v !== value);
    } else {
        localSelectedValues.value = [...localSelectedValues.value, value];
    }
    updateEnumConfig();
}
</script>

<template>
    <div v-if="isVisible" class="px-3 py-2 border-b border-gray-700 last:border-b-0">
        <!-- Parameter Header -->
        <div class="flex items-center gap-2">
            <input
                type="checkbox"
                :checked="isEnabled"
                class="w-4 h-4 flex-shrink-0 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-800"
                @change="toggleEnabled"
            />
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <span class="text-sm text-gray-200">{{ parameter.label }}</span>
                    <!-- Show default value when not enabled -->
                    <span
                        v-if="!isEnabled"
                        class="text-xs text-gray-500 font-mono"
                        :title="'Standardwert: ' + defaultValue"
                    >
                        = {{ defaultValue }}
                    </span>
                </div>
                <p class="text-xs text-gray-500 truncate" :title="parameter.description">
                    {{ parameter.description }}
                </p>
            </div>
        </div>

        <!-- Number Controls -->
        <div
            v-if="isEnabled && parameter.type === 'number'"
            class="mt-2 pl-6 space-y-1"
        >
            <!-- Grid layout for controls -->
            <div class="grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
                <div class="flex items-center gap-1">
                    <label class="text-gray-400">Min:</label>
                    <input
                        v-model.number="localMin"
                        type="number"
                        :step="parameter.step"
                        class="w-14 px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-gray-200 text-xs"
                        @change="updateNumberConfig"
                    />
                </div>
                <div class="flex items-center gap-1">
                    <label class="text-gray-400">Max:</label>
                    <input
                        v-model.number="localMax"
                        type="number"
                        :step="parameter.step"
                        class="w-14 px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-gray-200 text-xs"
                        @change="updateNumberConfig"
                    />
                </div>
                <div class="flex items-center gap-1">
                    <label class="text-gray-400">Steps:</label>
                    <input
                        v-model.number="localSteps"
                        type="number"
                        min="1"
                        max="20"
                        class="w-10 px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-gray-200 text-xs"
                        @change="updateNumberConfig"
                    />
                </div>
            </div>

            <!-- Value Preview -->
            <div class="text-xs text-gray-500">
                {{ valuePreview }}
            </div>
        </div>

        <!-- Boolean Info -->
        <div
            v-if="isEnabled && parameter.type === 'boolean'"
            class="mt-1 pl-6 text-xs text-gray-500"
        >
            Iteriert: true, false
        </div>

        <!-- Enum Controls -->
        <div
            v-if="isEnabled && parameter.type === 'enum'"
            class="mt-2 pl-6"
        >
            <div class="flex flex-wrap gap-2">
                <label
                    v-for="option in parameter.options"
                    :key="option"
                    class="flex items-center gap-1 text-xs cursor-pointer"
                >
                    <input
                        type="checkbox"
                        :checked="localSelectedValues.includes(option)"
                        class="w-3 h-3 rounded border-gray-600 bg-gray-700 text-blue-500"
                        @change="toggleEnumValue(option)"
                    />
                    <span class="text-gray-300">{{ option }}</span>
                </label>
            </div>
        </div>
    </div>
</template>
