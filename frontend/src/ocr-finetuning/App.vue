<script setup lang="ts">
import ParametersPanel from "./components/ParametersPanel.vue";
import ImagesPanel from "./components/ImagesPanel.vue";
import ResultsPanel from "./components/ResultsPanel.vue";
</script>

<template>
    <div class="min-h-screen bg-gray-900 text-gray-100">
        <!-- Header -->
        <header class="bg-gray-800 border-b border-gray-700 px-6 py-4">
            <h1 class="text-xl font-semibold text-white">
                OCR Parameter Finetuning
            </h1>
            <p class="text-sm text-gray-400 mt-1">
                Optimiere OCR-Parameter durch systematische Tests gegen Ground Truth
            </p>
        </header>

        <!-- Main Layout: Three Panels -->
        <main class="flex h-[calc(100vh-5rem)]">
            <!-- Left Panel: Parameters -->
            <aside class="w-80 flex-shrink-0 border-r border-gray-700 overflow-hidden flex flex-col">
                <ParametersPanel />
            </aside>

            <!-- Center Panel: Images -->
            <section class="flex-1 min-w-0 overflow-hidden flex flex-col">
                <ImagesPanel />
            </section>

            <!-- Right Panel: Results -->
            <aside class="w-96 flex-shrink-0 border-l border-gray-700 overflow-hidden flex flex-col">
                <ResultsPanel />
            </aside>
        </main>
    </div>
</template>

<style scoped>
/* Additional scoped styles if needed */
</style>
