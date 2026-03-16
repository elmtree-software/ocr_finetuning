/**
 * Permutation Generator Composable
 *
 * Generates cartesian product of parameter configurations.
 * Uses generators for memory efficiency with large permutation counts.
 */

import { computed } from "vue";
import { useTuningState, isNumberConfig, isBooleanConfig, isEnumConfig } from "./useTuningState";
import type {
    ParameterPermutation,
    ParameterValue,
    ParameterConfigMap,
} from "../types/tuning";

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate evenly spaced values between min and max.
 * Similar to numpy.linspace.
 */
export function linspace(min: number, max: number, steps: number): number[] {
    if (steps <= 0) return [];
    if (steps === 1) return [min];

    const values: number[] = [];
    const step = (max - min) / (steps - 1);

    for (let i = 0; i < steps; i++) {
        // Round to avoid floating point precision issues
        const value = min + step * i;
        values.push(Math.round(value * 1000) / 1000);
    }

    return values;
}

/**
 * Get all values to iterate for a parameter configuration.
 */
function getValuesForConfig(
    path: string,
    config: ParameterConfigMap[string]
): (number | boolean | string)[] {
    if (!config.enabled) {
        return [];
    }

    if (isNumberConfig(config)) {
        return linspace(config.min, config.max, config.steps);
    }

    if (isEnumConfig(config)) {
        return config.selectedValues;
    }

    // Boolean config - iterate over [true, false]
    return [true, false];
}

/**
 * Calculate total permutation count without generating them.
 */
export function calculatePermutationCount(configs: ParameterConfigMap): number {
    const enabledConfigs = Object.entries(configs).filter(
        ([_, config]) => config.enabled
    );

    if (enabledConfigs.length === 0) {
        return 1; // Default config only
    }

    let count = 1;
    for (const [path, config] of enabledConfigs) {
        const values = getValuesForConfig(path, config);
        if (values.length > 0) {
            count *= values.length;
        }
    }

    return count;
}

/**
 * Generator function for cartesian product of parameter values.
 * Memory efficient - generates one permutation at a time.
 */
export function* generatePermutations(
    configs: ParameterConfigMap
): Generator<ParameterPermutation, void, undefined> {
    const enabledConfigs = Object.entries(configs).filter(
        ([_, config]) => config.enabled
    );

    // If no parameters enabled, yield empty permutation (use defaults)
    if (enabledConfigs.length === 0) {
        yield [];
        return;
    }

    // Build value arrays for each parameter
    const parameterArrays: { path: string; values: (number | boolean | string)[] }[] = [];

    for (const [path, config] of enabledConfigs) {
        const values = getValuesForConfig(path, config);
        if (values.length > 0) {
            parameterArrays.push({ path, values });
        }
    }

    // If all enabled parameters have empty value arrays
    if (parameterArrays.length === 0) {
        yield [];
        return;
    }

    // Generate cartesian product using iterative approach
    const indices = new Array(parameterArrays.length).fill(0);

    while (true) {
        // Build current permutation from indices
        const permutation: ParameterPermutation = parameterArrays.map(
            ({ path, values }, i) => ({
                path,
                value: values[indices[i]],
            })
        );

        yield permutation;

        // Increment indices (like counting in mixed radix)
        let carry = true;
        for (let i = parameterArrays.length - 1; i >= 0 && carry; i--) {
            indices[i]++;
            if (indices[i] < parameterArrays[i].values.length) {
                carry = false;
            } else {
                indices[i] = 0;
            }
        }

        // If we carried past the first index, we're done
        if (carry) {
            break;
        }
    }
}

/**
 * Convert permutation to array for synchronous iteration.
 * Use only for small permutation counts.
 */
export function collectPermutations(
    configs: ParameterConfigMap
): ParameterPermutation[] {
    return Array.from(generatePermutations(configs));
}

// =============================================================================
// Composable
// =============================================================================

export function usePermutationGenerator() {
    const { parameterConfigs } = useTuningState();

    const permutationCount = computed(() =>
        calculatePermutationCount(parameterConfigs.value)
    );

    const isLargePermutationCount = computed(() => permutationCount.value > 100);

    const isVeryLargePermutationCount = computed(
        () => permutationCount.value > 1000
    );

    const getPermutationIterator = (): Generator<
        ParameterPermutation,
        void,
        undefined
    > => {
        return generatePermutations(parameterConfigs.value);
    };

    const getAllPermutations = (): ParameterPermutation[] => {
        return collectPermutations(parameterConfigs.value);
    };

    /**
     * Get a human-readable description of the permutation count.
     */
    const permutationDescription = computed(() => {
        const configs = parameterConfigs.value;
        const enabledConfigs = Object.entries(configs).filter(
            ([_, config]) => config.enabled
        );

        if (enabledConfigs.length === 0) {
            return "1 Iteration (Standard-Konfiguration)";
        }

        const parts: string[] = [];
        for (const [path, config] of enabledConfigs) {
            const values = getValuesForConfig(path, config);
            if (values.length > 0) {
                const paramName = path.split(".").pop() ?? path;
                parts.push(`${values.length} ${paramName}`);
            }
        }

        const count = permutationCount.value;
        const breakdown = parts.join(" × ");

        return `${count} Iterationen (${breakdown})`;
    });

    return {
        permutationCount,
        permutationDescription,
        isLargePermutationCount,
        isVeryLargePermutationCount,
        getPermutationIterator,
        getAllPermutations,
        linspace,
    };
}
