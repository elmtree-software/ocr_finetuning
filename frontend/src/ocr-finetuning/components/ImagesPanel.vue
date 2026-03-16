<script setup lang="ts">
import { ref, computed } from "vue";
import { useTuningState } from "../composables/useTuningState";
import ImageThumbnail from "./ImageThumbnail.vue";
import type { TuningImage, GroundTruthRegion, GroundTruthMeta } from "../types/tuning";
import { buildMacroRegions, MACRO_REGION_DEFS } from "../utils/macro-layout";
import { OCRService } from "@/services/ocr";
import { rectify } from "@/services/ocr/rectification";

const { images, addImage, removeImage, clearImages, runState, selectedEngine } = useTuningState();

const fileInputRef = ref<HTMLInputElement | null>(null);
const folderInputRef = ref<HTMLInputElement | null>(null);
const isDragging = ref(false);
const showLayout = ref(true);
const isGeneratingGt = ref(false);
const gtProgress = ref({ current: 0, total: 0, filename: "" });
const isGeneratingTxt = ref(false);
const txtProgress = ref({ current: 0, total: 0, filename: "" });
const txtError = ref<string | null>(null);

const LMSTUDIO_MODEL = "qwen/qwen3-vl-8b";
const DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234/v1";
const LMSTUDIO_ENDPOINT_STORAGE_KEY = "ocrfinetuning.lmstudio.endpoint";

const isDisabled = computed(() => runState.value.status !== "idle");
const canGenerateGt = computed(
    () => images.value.length > 0 && runState.value.status === "idle"
);
const canGenerateTxt = computed(
    () => images.value.length > 0 && runState.value.status === "idle"
);

// Check if File System Access API is available
const hasFileSystemAccess = "showOpenFilePicker" in window && "showDirectoryPicker" in window;

// Cached directory handle for auto-loading ground truth files (.gt.json / .txt)
let cachedDirHandle: FileSystemDirectoryHandle | null = null;

/**
 * Open file picker - if File System Access API available, will auto-load .gt.json/.txt files
 */
async function openFileDialog() {
    if (hasFileSystemAccess) {
        await openWithFileSystemAccess();
    } else {
        folderInputRef.value?.click();
    }
}

/**
 * Open files using File System Access API with automatic .gt.json/.txt loading
 */
async function openWithFileSystemAccess() {
    try {
        // Let user pick image files
        const fileHandles = await (window as any).showOpenFilePicker({
            multiple: true,
            types: [
                {
                    description: "Bilder",
                    accept: {
                        "image/*": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif"],
                    },
                },
            ],
        });

        if (fileHandles.length === 0) return;

        // Now request directory access to load .gt.json/.txt files
        // Use startIn with the first file handle to open in the same directory
        let dirHandle: FileSystemDirectoryHandle | null = cachedDirHandle;

        if (!dirHandle) {
            try {
                dirHandle = await (window as any).showDirectoryPicker({
                    mode: "read",
                    startIn: fileHandles[0],
                });
                cachedDirHandle = dirHandle;
            } catch (err: any) {
                if (err.name === "AbortError") {
                    // User cancelled directory picker - still process images without ground truth
                    console.log("[ImagesPanel] Directory access denied, loading images without ground truth");
                }
            }
        }

        // Build maps of ground truth files if we have directory access
        const textFiles = new Map<string, File>();
        const gtJsonFiles = new Map<string, File>();
        const sidecarLookupPerformed = Boolean(dirHandle);
        if (dirHandle) {
            try {
                for await (const entry of (dirHandle as any).values()) {
                    if (entry.kind !== "file") continue;
                    const lower = entry.name.toLowerCase();
                    if (lower.endsWith(".txt") || lower.endsWith(".gt.json")) {
                        const file = await entry.getFile();
                        const baseName = lower.endsWith(".txt")
                            ? file.name.replace(/\.txt$/i, "").toLowerCase()
                            : file.name.replace(/\.gt\.json$/i, "").toLowerCase();
                        if (lower.endsWith(".txt")) {
                            textFiles.set(baseName, file);
                        } else {
                            gtJsonFiles.set(baseName, file);
                        }
                    }
                }
            } catch (err) {
                console.warn("[ImagesPanel] Could not read directory:", err);
            }
        }

        // Process each selected image
        for (const fileHandle of fileHandles) {
            const file = await fileHandle.getFile();

            // Skip non-images
            if (!file.type.startsWith("image/") && !/\.(jpg|jpeg|png|gif|bmp|webp|tiff?)$/i.test(file.name)) {
                continue;
            }

            // Skip if already added
            if (images.value.some((img) => img.filename === file.name)) {
                continue;
            }

            // Find matching .gt.json or .txt file
            const baseName = file.name.replace(/\.[^.]+$/, "").toLowerCase();
            const matchingTextFile = textFiles.get(baseName);
            const matchingGtJsonFile = gtJsonFiles.get(baseName);

            const gt = await loadGroundTruth(matchingTextFile, matchingGtJsonFile);

            const tuningImage: TuningImage = {
                file,
                url: URL.createObjectURL(file),
                filename: file.name,
                groundTruth: gt.groundTruth,
                groundTruthRegions: gt.groundTruthRegions,
                groundTruthMeta: gt.groundTruthMeta,
                groundTruthSource: gt.groundTruthSource,
                hasGroundTruth: gt.groundTruth !== null,
                groundTruthChecked: sidecarLookupPerformed,
            };

            addImage(tuningImage);
        }
    } catch (err: any) {
        if (err.name !== "AbortError") {
            console.warn("[ImagesPanel] File picker failed, falling back to input:", err);
            folderInputRef.value?.click();
        }
    }
}

/**
 * Clear cached directory handle (e.g., when changing folders)
 */
function clearDirectoryCache() {
    cachedDirHandle = null;
}

async function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;

    await processFiles(Array.from(files), { sidecarLookupPerformed: false });

    // Reset input so the same files can be selected again
    input.value = "";
}

async function handleFolderSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;

    await processFiles(Array.from(files), { sidecarLookupPerformed: true });
    input.value = "";
}

async function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragging.value = false;

    const files = event.dataTransfer?.files;
    if (!files) return;

    await processFiles(Array.from(files));
}

function handleDragOver(event: DragEvent) {
    event.preventDefault();
    isDragging.value = true;
}

function handleDragLeave() {
    isDragging.value = false;
}

async function processFiles(
    files: File[],
    options?: { sidecarLookupPerformed?: boolean }
) {
    // Separate image files and text files
    const imageFiles = files.filter((f) =>
        f.type.startsWith("image/") || /\.(jpg|jpeg|png|gif|bmp|webp|tiff?)$/i.test(f.name)
    );
    const textFiles = files.filter((f) => f.name.endsWith(".txt"));
    const gtJsonFiles = files.filter((f) => f.name.endsWith(".gt.json"));

    // Create a map of text files by base name
    const textFileMap = new Map<string, File>();
    for (const tf of textFiles) {
        const baseName = tf.name.replace(/\.txt$/i, "");
        textFileMap.set(baseName.toLowerCase(), tf);
    }

    // Create a map of gt.json files by base name
    const gtJsonMap = new Map<string, File>();
    for (const gf of gtJsonFiles) {
        const baseName = gf.name.replace(/\.gt\.json$/i, "");
        gtJsonMap.set(baseName.toLowerCase(), gf);
    }

    // Process each image
    const sidecarLookupPerformed =
        options?.sidecarLookupPerformed ?? (textFiles.length > 0 || gtJsonFiles.length > 0);
    for (const imageFile of imageFiles) {
        // Skip if already added
        if (images.value.some((img) => img.filename === imageFile.name)) {
            continue;
        }

        // Find matching ground truth
        const baseName = imageFile.name.replace(/\.[^.]+$/, "");
        const matchingTextFile = textFileMap.get(baseName.toLowerCase());
        const matchingGtJsonFile = gtJsonMap.get(baseName.toLowerCase());
        const gt = await loadGroundTruth(matchingTextFile, matchingGtJsonFile);

        const tuningImage: TuningImage = {
            file: imageFile,
            url: URL.createObjectURL(imageFile),
            filename: imageFile.name,
            groundTruth: gt.groundTruth,
            groundTruthRegions: gt.groundTruthRegions,
            groundTruthMeta: gt.groundTruthMeta,
            groundTruthSource: gt.groundTruthSource,
            hasGroundTruth: gt.groundTruth !== null,
            groundTruthChecked: sidecarLookupPerformed,
        };

        addImage(tuningImage);
    }
}

type GroundTruthLoadResult = {
    groundTruth: string | null;
    groundTruthRegions?: GroundTruthRegion[];
    groundTruthMeta?: GroundTruthMeta;
    groundTruthSource?: "txt" | "gt.json";
};

async function loadGroundTruth(
    textFile?: File,
    gtJsonFile?: File
): Promise<GroundTruthLoadResult> {
    if (gtJsonFile) {
        try {
            const raw = await gtJsonFile.text();
            const parsed = JSON.parse(raw) as {
                fullText?: string;
                image?: { width: number; height: number };
                rotation?: number;
                rectificationApplied?: boolean;
                layoutModelId?: string;
                regions?: Array<{
                    id: string;
                    label: string;
                    bbox: { x: number; y: number; width: number; height: number };
                    text?: string;
                    order?: number;
                    source?: string;
                }>;
            };

            const regions = (parsed.regions ?? [])
                .filter((r) => r && r.bbox && typeof r.text === "string")
                .map((r) => ({
                    id: r.id,
                    label: r.label,
                    bbox: r.bbox,
                    text: r.text ?? "",
                    order: r.order,
                    source: r.source,
                }));

            const fullText = typeof parsed.fullText === "string"
                ? parsed.fullText
                : regions.map((r) => r.text).join("\n").trim();

            return {
                groundTruth: fullText ?? null,
                groundTruthRegions: regions,
                groundTruthMeta: parsed.image
                    ? {
                        width: parsed.image.width,
                        height: parsed.image.height,
                        rotation: parsed.rotation,
                        rectificationApplied: parsed.rectificationApplied,
                        layoutModelId: parsed.layoutModelId,
                    }
                    : undefined,
                groundTruthSource: "gt.json",
            };
        } catch (err) {
            console.warn("[ImagesPanel] Failed to parse .gt.json:", err);
        }
    }

    if (textFile) {
        const groundTruth = await textFile.text();
        return {
            groundTruth,
            groundTruthSource: "txt",
        };
    }

    return { groundTruth: null };
}

function handleRemove(filename: string) {
    removeImage(filename);
}

function handleClearAll() {
    clearImages();
    clearDirectoryCache();
}

async function loadImageData(url: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                reject(new Error("Could not get canvas context"));
                return;
            }
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            resolve(imageData);
        };
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = url;
    });
}

async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read image file"));
        reader.readAsDataURL(file);
    });
}


function getMacroMaxTokens(label: string): number {
    if (label === "Body") return 6000;
    if (label === "Header" || label === "Footer") return 1200;
    return 2000;
}

function rotateCanvasElement(canvas: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
    if (!degrees) return canvas;

    const radians = (degrees * Math.PI) / 180;
    const sin = Math.abs(Math.sin(radians));
    const cos = Math.abs(Math.cos(radians));

    const newWidth = Math.floor(canvas.width * cos + canvas.height * sin);
    const newHeight = Math.floor(canvas.width * sin + canvas.height * cos);

    const rotated = document.createElement("canvas");
    rotated.width = newWidth;
    rotated.height = newHeight;

    const ctx = rotated.getContext("2d");
    if (!ctx) return canvas;

    ctx.translate(newWidth / 2, newHeight / 2);
    ctx.rotate(radians);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);

    return rotated;
}

function cropCanvas(
    canvas: HTMLCanvasElement,
    bbox: { x: number; y: number; width: number; height: number }
): HTMLCanvasElement {
    const crop = document.createElement("canvas");
    const x = Math.max(0, Math.floor(bbox.x));
    const y = Math.max(0, Math.floor(bbox.y));
    const width = Math.max(1, Math.min(canvas.width - x, Math.ceil(bbox.width)));
    const height = Math.max(1, Math.min(canvas.height - y, Math.ceil(bbox.height)));

    crop.width = width;
    crop.height = height;
    const ctx = crop.getContext("2d");
    if (!ctx) return crop;

    ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    return crop;
}

function getLmStudioBaseUrl(): string {
    const storedEndpoint = window.localStorage
        .getItem(LMSTUDIO_ENDPOINT_STORAGE_KEY)
        ?.trim();
    const envEndpoint = import.meta.env.VITE_LMSTUDIO_ENDPOINT?.trim();
    const endpoint = storedEndpoint || envEndpoint || DEFAULT_LMSTUDIO_ENDPOINT;
    return endpoint.replace(/\/$/, "");
}

function imageDataToHtmlCanvas(imageData: ImageData): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

async function callLmStudioOcr(
    dataUrl: string,
    label: string,
    isTable?: boolean,
    customPrompt?: string,
    options?: { maxTokens?: number; debugLabel?: string }
): Promise<string> {
    const prompt = customPrompt ?? (isTable
        ? `Lies den Text in diesem Tabellenbild. Gib nur den erkannten Text zurück, nutze Zeilenumbrüche. Wenn kein Text erkennbar ist, gib eine leere Antwort. Keine Erklärungen.`
        : `Lies den Text in diesem Bildbereich (Label: ${label}). Gib nur den erkannten Text zurück, inklusive Zeilenumbrüchen. Wenn kein Text erkennbar ist, gib eine leere Antwort. Keine Erklärungen.`);
    const maxTokens = options?.maxTokens ?? 256;

    const basePayload = {
        model: LMSTUDIO_MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
    };

    const messageVariants = [
        [
            {
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: dataUrl } },
                ],
            },
        ],
    ];

    let lastError: string | null = null;

    for (const messages of messageVariants) {
        try {
            const baseUrl = getLmStudioBaseUrl();
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...basePayload,
                    messages,
                }),
            });

            if (!response.ok) {
                const message = await response.text();
                console.error(
                    "[ImagesPanel] LM Studio error:",
                    response.status,
                    message,
                    options?.debugLabel ? `(image: ${options.debugLabel})` : ""
                );
                lastError = `LM Studio OCR failed: ${response.status} ${message}`;
                continue;
            }

            const data = await response.json();
            if (data?.error?.message) {
                lastError = `LM Studio OCR error: ${data.error.message}`;
                continue;
            }
            const message = data?.choices?.[0]?.message?.content;
            if (Array.isArray(message)) {
                const textParts = message
                    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
                    .filter((part: string) => part.length > 0);
                return textParts.join("\n").trim();
            }

            if (typeof message === "string") {
                const cleaned = message.trim().replace(/^["'`]/, "").replace(/["'`]$/, "");
                const lower = cleaned.toLowerCase();
                if (
                    lower === "kein text erkannt" ||
                    lower === "kein text" ||
                    lower === "no text" ||
                    lower === "no text detected" ||
                    lower === label.toLowerCase()
                ) {
                    return "";
                }
                return cleaned;
            }
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
    }

    throw new Error(lastError ?? "LM Studio OCR failed");
}


async function generateGroundTruthForImage(image: TuningImage, rectificationEnabled: boolean) {
    const imageData = await loadImageData(image.url);
    const config = OCRService.getConfig();
    let baseImage = imageData;
    let rectificationApplied = false;

    if (rectificationEnabled) {
        const rectified = await rectify(imageData);
        if (rectified.documentFound) {
            baseImage = rectified.image;
            rectificationApplied = true;
        }
    }

    let rotation = 0;
    if (config.rotation.enabled) {
        const rotationResult = await OCRService.recognize(baseImage);
        rotation = rotationResult.rotation ?? 0;
    }

    const baseCanvas = imageDataToHtmlCanvas(baseImage);
    const rotatedCanvas = rotateCanvasElement(baseCanvas, rotation);
    const macroRegions = buildMacroRegions(rotatedCanvas.width, rotatedCanvas.height);

    const regions = [];
    for (const region of macroRegions) {
        const crop = cropCanvas(rotatedCanvas, region.bbox);
        const dataUrl = crop.toDataURL("image/png");
        const text = await callLmStudioOcr(
            dataUrl,
            region.label,
            false,
            undefined,
            { maxTokens: getMacroMaxTokens(region.label), debugLabel: `${image.filename} :: ${region.label}` }
        );
        regions.push({
            id: region.id,
            label: region.label,
            score: 1,
            bbox: region.bbox,
            text,
            confidence: undefined,
            lines: [],
            isTable: false,
            table: null,
            order: region.order,
            source: "macro-fixed",
        });
    }

    const fullText = regions
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((region) => (region.text ?? "").trim())
        .filter((text) => text.length > 0)
        .join("\n");

    return {
        schema: "elmtree-gt/v2",
        createdAt: new Date().toISOString(),
        image: {
            filename: image.filename,
            width: rotatedCanvas.width,
            height: rotatedCanvas.height,
        },
        engine: "lmstudio",
        textModel: LMSTUDIO_MODEL,
        layoutModelId: "macro-fixed-v1",
        rotation,
        rectificationApplied,
        fullText,
        macroLayout: {
            type: "fixed-v1",
            regions: MACRO_REGION_DEFS,
        },
        regions,
    };
}

async function saveJsonFile(
    dirHandle: FileSystemDirectoryHandle | null,
    filename: string,
    content: string
): Promise<void> {
    if (dirHandle) {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
    }

    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

async function saveTextFile(
    dirHandle: FileSystemDirectoryHandle | null,
    filename: string,
    content: string
): Promise<void> {
    if (dirHandle) {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
    }

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

async function generateGroundTruth(): Promise<void> {
    if (!canGenerateGt.value || isGeneratingGt.value) return;

    isGeneratingGt.value = true;
    gtProgress.value = { current: 0, total: images.value.length, filename: "" };

    const previousConfig = structuredClone(OCRService.getConfig());
    try {
        OCRService.setConfig({ engine: selectedEngine.value });
        OCRService.setConfig({ layout: { enabled: false }, table: { enabled: false }, rectification: { enabled: false } });

        const total = images.value.length;
        for (let i = 0; i < total; i++) {
            const img = images.value[i];
            gtProgress.value = { current: i + 1, total, filename: img.filename };

            const gt = await generateGroundTruthForImage(img, previousConfig.rectification.enabled);
            const baseName = img.filename.replace(/\.[^.]+$/, "");
            const filename = `${baseName}.gt.json`;
            await saveJsonFile(null, filename, JSON.stringify(gt, null, 2));

            await new Promise((r) => setTimeout(r, 0));
        }
    } finally {
        OCRService.resetConfig();
        OCRService.setConfig(previousConfig);
        isGeneratingGt.value = false;
        gtProgress.value = { current: 0, total: 0, filename: "" };
    }
}

async function generatePlainTextFiles(): Promise<void> {
    if (!canGenerateTxt.value || isGeneratingTxt.value) return;

    isGeneratingTxt.value = true;
    txtProgress.value = { current: 0, total: images.value.length, filename: "" };
    txtError.value = null;

    try {
        const total = images.value.length;
        for (let i = 0; i < total; i++) {
            const img = images.value[i];
            txtProgress.value = { current: i + 1, total, filename: img.filename };

            const dataUrl = await fileToDataUrl(img.file);
            console.log("[ImagesPanel] LM Studio fulltext:", img.filename, {
                sizeBytes: img.file.size,
                dataUrlLength: dataUrl.length,
            });
            const text = await callLmStudioOcr(
                dataUrl,
                "Dokument",
                false,
                "Lies den gesamten Text dieses Dokuments. Gib nur den Text zurück, inklusive Zeilenumbrüchen. Wenn kein Text erkennbar ist, gib eine leere Antwort. Keine Erklärungen.",
                { maxTokens: 10000, debugLabel: img.filename }
            );

            const baseName = img.filename.replace(/\.[^.]+$/, "");
            const filename = `${baseName}.txt`;
            await saveTextFile(null, filename, text);

            await new Promise((r) => setTimeout(r, 0));
        }
    } catch (err) {
        txtError.value = err instanceof Error ? err.message : String(err);
    } finally {
        isGeneratingTxt.value = false;
        txtProgress.value = { current: 0, total: 0, filename: "" };
    }
}

</script>

<template>
    <div class="flex flex-col h-full bg-gray-900">
        <!-- Header -->
        <div class="p-4 border-b border-gray-700 flex items-center justify-between">
            <div>
                <h2 class="text-lg font-semibold text-white">Bilder</h2>
                <p class="text-sm text-gray-400">
                    {{ images.length }} Bilder, {{ images.filter(i => i.hasGroundTruth).length }} mit Ground Truth
                </p>
            </div>

            <div class="flex items-center gap-3 flex-wrap justify-end">
                <label class="flex items-center gap-2 text-xs text-gray-300">
                    <input
                        v-model="showLayout"
                        type="checkbox"
                        class="h-3.5 w-3.5 rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500"
                    />
                    Regionen anzeigen
                </label>
                <button
                    :disabled="!canGenerateGt || isGeneratingGt"
                    class="px-3 py-2 text-sm text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-md transition-colors disabled:opacity-50"
                    @click="generateGroundTruth"
                    title="Erzeuge automatische Ground-Truth JSON Dateien"
                >
                    GT JSON erzeugen
                </button>
                <button
                    :disabled="!canGenerateTxt || isGeneratingTxt"
                    class="px-3 py-2 text-sm text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-md transition-colors disabled:opacity-50"
                    @click="generatePlainTextFiles"
                    title="Erzeuge pro Bild eine .txt Datei mit Volltext"
                >
                    TXT Volltext erzeugen
                </button>
                <button
                    v-if="images.length > 0"
                    :disabled="isDisabled"
                    class="px-3 py-2 text-sm text-gray-400 hover:text-red-400 hover:bg-gray-800 rounded-md transition-colors disabled:opacity-50"
                    @click="handleClearAll"
                >
                    Alle entfernen
                </button>
                <button
                    :disabled="isDisabled"
                    class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
                    @click="openFileDialog"
                >
                    Bilder auswählen
                </button>
            </div>
        </div>

        <!-- Drop Zone / Image Grid -->
        <div
            class="flex-1 overflow-y-auto p-4"
            :class="{
                'bg-blue-900/20 border-2 border-dashed border-blue-500': isDragging,
            }"
            @drop="handleDrop"
            @dragover="handleDragOver"
            @dragleave="handleDragLeave"
        >
            <div
                v-if="isGeneratingGt"
                class="mb-4 px-3 py-2 rounded border border-blue-700 bg-blue-900/20 text-xs text-blue-200"
            >
                Generiere Ground Truth: {{ gtProgress.current }}/{{ gtProgress.total }}
                <span v-if="gtProgress.filename">– {{ gtProgress.filename }}</span>
            </div>
            <div
                v-if="isGeneratingTxt"
                class="mb-4 px-3 py-2 rounded border border-emerald-700 bg-emerald-900/20 text-xs text-emerald-200"
            >
                Generiere TXT Volltext: {{ txtProgress.current }}/{{ txtProgress.total }}
                <span v-if="txtProgress.filename">– {{ txtProgress.filename }}</span>
            </div>
            <div
                v-if="txtError"
                class="mb-4 px-3 py-2 rounded border border-red-700 bg-red-900/20 text-xs text-red-200"
            >
                {{ txtError }}
            </div>

            <!-- Empty State -->
            <div
                v-if="images.length === 0"
                class="h-full flex flex-col items-center justify-center text-center"
            >
                <svg
                    class="w-16 h-16 text-gray-600 mb-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.5"
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                </svg>
                <h3 class="text-lg font-medium text-gray-300 mb-2">
                    Keine Bilder ausgewählt
                </h3>

                <p class="text-sm text-gray-400 mb-4 max-w-md">
                    Wähle nur Bilder aus. Passende Ground-Truth-Dateien (.gt.json oder .txt) werden automatisch im gleichen Ordner gesucht.
                </p>

                <button
                    class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
                    @click="openFileDialog"
                >
                    Bilder auswählen
                </button>

                <p v-if="hasFileSystemAccess" class="text-xs text-gray-500 mt-3 max-w-sm">
                    Nach der Bildauswahl wirst du nach Ordnerzugriff gefragt, um die .gt.json/.txt Dateien zu laden.
                </p>
                <p v-else class="text-xs text-gray-500 mt-3 max-w-sm">
                    Wähle einen Ordner mit Bildern und Ground Truth Dateien (.gt.json/.txt). Es werden nur Bilder geladen.
                </p>

                <p class="text-xs text-gray-600 mt-4">
                    Oder Dateien hierher ziehen
                </p>
            </div>

            <!-- Image Grid -->
            <div
                v-else
                class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
            >
                <ImageThumbnail
                    v-for="image in images"
                    :key="image.filename"
                    :image="image"
                    :show-layout="showLayout"
                    @remove="handleRemove"
                />
            </div>
        </div>

        <!-- Hidden File Input -->
        <input
            ref="fileInputRef"
            type="file"
            multiple
            accept="image/*"
            class="hidden"
            @change="handleFileSelect"
        />
        <input
            ref="folderInputRef"
            type="file"
            webkitdirectory
            directory
            multiple
            class="hidden"
            @change="handleFolderSelect"
        />
    </div>
</template>
