#!/usr/bin/env node

import fs from "fs";
import path from "path";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tif", ".tiff"]);
const DEFAULT_RATIOS = { train: 0.6, val: 0.2, test: 0.2 };
const DEFAULT_SEED = 20260301;

function usage(exitCode = 0) {
    console.log(`Usage:
  node scripts/ocr-optimize/generate-split-manifest.mjs [options]

Options:
  --images-dir <path>       Directory with images and GT sidecars (default: ./ocr_trainingdata)
  --output <path>           Output manifest path (default: ./ocr_optimization/configs/run3_split_manifest.json)
  --overrides <path>        Optional JSON file with metadata overrides per image
  --seed <int>              Deterministic random seed (default: ${DEFAULT_SEED})
  --train <ratio>           Train split ratio (default: 0.6)
  --val <ratio>             Validation split ratio (default: 0.2)
  --test <ratio>            Test split ratio (default: 0.2)
  --include-script <name>   Include only script buckets (repeatable, default: print)
  --dry-run                 Do not write output; print summary only
  --help                    Show this help
`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const args = {
        imagesDir: "./ocr_trainingdata",
        output: "./ocr_optimization/configs/run3_split_manifest.json",
        overrides: null,
        seed: DEFAULT_SEED,
        ratios: { ...DEFAULT_RATIOS },
        includeScripts: ["print"],
        includeScriptExplicit: false,
        dryRun: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === "--help" || token === "-h") usage(0);
        if (token === "--dry-run") {
            args.dryRun = true;
            continue;
        }

        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
            throw new Error(`Missing value for ${token}`);
        }

        switch (token) {
            case "--images-dir":
                args.imagesDir = next;
                i++;
                break;
            case "--output":
                args.output = next;
                i++;
                break;
            case "--overrides":
                args.overrides = next;
                i++;
                break;
            case "--seed": {
                const parsed = Number.parseInt(next, 10);
                if (!Number.isFinite(parsed)) {
                    throw new Error(`Invalid --seed value: ${next}`);
                }
                args.seed = parsed;
                i++;
                break;
            }
            case "--train":
                args.ratios.train = parseRatio(next, "--train");
                i++;
                break;
            case "--val":
                args.ratios.val = parseRatio(next, "--val");
                i++;
                break;
            case "--test":
                args.ratios.test = parseRatio(next, "--test");
                i++;
                break;
            case "--include-script":
                if (!args.includeScriptExplicit) {
                    args.includeScripts = [];
                    args.includeScriptExplicit = true;
                }
                args.includeScripts.push(next.trim().toLowerCase());
                i++;
                break;
            default:
                throw new Error(`Unknown argument: ${token}`);
        }
    }

    args.includeScripts = Array.from(new Set(args.includeScripts.map((item) => item.trim().toLowerCase()).filter(Boolean)));
    delete args.includeScriptExplicit;
    normalizeRatios(args.ratios);
    return args;
}

function parseRatio(value, flag) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid ratio for ${flag}: ${value}`);
    }
    return parsed;
}

function normalizeRatios(ratios) {
    const sum = ratios.train + ratios.val + ratios.test;
    if (!Number.isFinite(sum) || sum <= 0) {
        throw new Error("Split ratios must sum to a positive value.");
    }
    ratios.train /= sum;
    ratios.val /= sum;
    ratios.test /= sum;
}

function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function mulberry32(seed) {
    let t = seed >>> 0;
    return () => {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffleDeterministic(items, seed) {
    const rng = mulberry32(seed);
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function roundedTargets(total, ratios) {
    if (total <= 0) {
        return { train: 0, val: 0, test: 0 };
    }
    const raw = {
        train: total * ratios.train,
        val: total * ratios.val,
        test: total * ratios.test,
    };
    const targets = {
        train: Math.floor(raw.train),
        val: Math.floor(raw.val),
        test: Math.floor(raw.test),
    };

    let assigned = targets.train + targets.val + targets.test;
    const remainders = [
        ["train", raw.train - targets.train],
        ["val", raw.val - targets.val],
        ["test", raw.test - targets.test],
    ].sort((a, b) => b[1] - a[1]);

    let idx = 0;
    while (assigned < total) {
        const split = remainders[idx % remainders.length][0];
        targets[split] += 1;
        assigned += 1;
        idx += 1;
    }

    return targets;
}

function classifySource(filename) {
    const f = filename.toLowerCase();
    if (f.startsWith("signal-")) return "signal_mobile";
    if (f.startsWith("img_")) return "phone_camera";
    if (/^\d{6}\./.test(f)) return "batch_capture";
    if (f.includes("screenshot") || f.startsWith("chunk")) return "digital_capture";
    if (f.includes("got-a-letter")) return "web_photo";
    if (f.includes("rechnung-schreiben")) return "template_sample";
    return "other";
}

function classifyDocumentType(filename, fullText = "") {
    const f = filename.toLowerCase();
    const text = fullText.toLowerCase();

    if (/rechnung|invoice|receipt|nettosumme|endbetrag|kundennummer/.test(text) || f.includes("rechnung")) {
        return "invoice_form";
    }
    if (/zeugnis|grundschule|school|gifted|klassenarbeit|elternversammlung/.test(text)) {
        return "school_document";
    }
    if (/beitragsservice|agentur für arbeit|techniker|darmkrebs|zahlungserinnerung|bundesagentur/.test(text)) {
        return "official_letter";
    }
    if (/lieferschein|packliste|bestell/.test(text)) {
        return "shipping_document";
    }
    if (text.length > 8000) {
        return "dense_page";
    }
    if (text.length < 900 || f.includes("chunk") || f.includes("bill_screenshot")) {
        return "small_text";
    }
    return "general_letter";
}

function classifyCondition(filename, info) {
    const f = filename.toLowerCase();
    const rotation = Number.isFinite(info.rotation) ? Number(info.rotation) : 0;
    const minDim = Math.min(info.width || 0, info.height || 0);
    const textLength = info.fullText ? info.fullText.length : 0;

    if (rotation === 90 || rotation === 270) return "rotated";
    if (rotation === 180) return "upside_down";
    if (f.includes("screenshot") || f.endsWith(".png") || f.startsWith("chunk")) return "digital_clean";
    if (f.includes("_002") || f.includes("_003")) return "mobile_variant";
    if (minDim > 0 && minDim < 850) return "low_resolution";
    if (textLength > 8000) return "dense_text";
    return "standard";
}

function classifyScript(filename) {
    const f = filename.toLowerCase();

    if (f.includes("handwriting")) {
        return "handwriting";
    }
    return "print";
}

function loadOverrides(overridesPath) {
    if (!overridesPath) return new Map();
    const parsed = JSON.parse(fs.readFileSync(path.resolve(overridesPath), "utf-8"));
    const map = new Map();

    if (Array.isArray(parsed)) {
        for (const row of parsed) {
            if (!row || typeof row.filename !== "string") continue;
            map.set(row.filename.toLowerCase(), row);
        }
        return map;
    }

    if (parsed && typeof parsed === "object") {
        if (parsed.images && typeof parsed.images === "object") {
            for (const [filename, value] of Object.entries(parsed.images)) {
                if (!filename || !value || typeof value !== "object") continue;
                map.set(filename.toLowerCase(), { filename, ...value });
            }
            return map;
        }

        for (const [filename, value] of Object.entries(parsed)) {
            if (!filename || !value || typeof value !== "object") continue;
            map.set(filename.toLowerCase(), { filename, ...value });
        }
    }

    return map;
}

function loadDataset(imagesDir, overrides) {
    const absDir = path.resolve(imagesDir);
    const entries = fs.readdirSync(absDir, { withFileTypes: true });

    const images = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => !name.includes(":Zone.Identifier"))
        .filter((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b));

    const result = [];
    for (const filename of images) {
        const baseName = filename.replace(/\.[^.]+$/, "");
        const gtPath = path.join(absDir, `${baseName}.gt.json`);
        const txtPath = path.join(absDir, `${baseName}.txt`);

        if (!fs.existsSync(gtPath) && !fs.existsSync(txtPath)) continue;

        let fullText = "";
        let width = null;
        let height = null;
        let rotation = 0;

        if (fs.existsSync(gtPath)) {
            try {
                const gt = JSON.parse(fs.readFileSync(gtPath, "utf-8"));
                fullText = typeof gt.fullText === "string" ? gt.fullText : "";
                width = Number.isFinite(gt?.image?.width) ? Number(gt.image.width) : null;
                height = Number.isFinite(gt?.image?.height) ? Number(gt.image.height) : null;
                rotation = Number.isFinite(gt?.rotation) ? Number(gt.rotation) : 0;
            } catch {
                fullText = "";
            }
        }

        if (!fullText && fs.existsSync(txtPath)) {
            fullText = fs.readFileSync(txtPath, "utf-8");
        }

        const inferred = {
            filename,
            source: classifySource(filename),
            documentType: classifyDocumentType(filename, fullText),
            condition: classifyCondition(filename, { fullText, width, height, rotation }),
            script: classifyScript(filename),
            fullTextLength: fullText.length,
            image: {
                width,
                height,
                rotation,
            },
        };

        const override = overrides.get(filename.toLowerCase());
        const merged = override ? { ...inferred, ...override, filename } : inferred;
        result.push(merged);
    }

    return result;
}

function buildAssignments(items, ratios, seed) {
    const assignments = new Map();
    const globalTargets = roundedTargets(items.length, ratios);
    const globalCounts = { train: 0, val: 0, test: 0 };

    const byStratum = new Map();
    for (const item of items) {
        const key = `${item.source}|${item.documentType}|${item.condition}`;
        if (!byStratum.has(key)) byStratum.set(key, []);
        byStratum.get(key).push(item);
    }

    const strata = Array.from(byStratum.entries())
        .map(([key, rows]) => [key, shuffleDeterministic(rows, seed ^ hashString(key))])
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    for (const [key, stratumItems] of strata) {
        const localTargets = roundedTargets(stratumItems.length, ratios);
        const queue = [];
        for (const split of ["train", "val", "test"]) {
            for (let i = 0; i < localTargets[split]; i++) {
                queue.push(split);
            }
        }

        let cursor = 0;
        for (const item of stratumItems) {
            let preferred = queue[cursor] || "train";
            cursor += 1;

            if (globalCounts[preferred] >= globalTargets[preferred]) {
                const candidates = ["train", "val", "test"].sort((a, b) => {
                    const remainingA = globalTargets[a] - globalCounts[a];
                    const remainingB = globalTargets[b] - globalCounts[b];
                    return remainingB - remainingA;
                });
                preferred = candidates[0];
            }

            assignments.set(item.filename, preferred);
            globalCounts[preferred] += 1;
        }
    }

    rebalanceAssignments(assignments, items, globalCounts, globalTargets, seed);

    return {
        assignments,
        globalTargets,
        globalCounts,
    };
}

function rebalanceAssignments(assignments, items, globalCounts, globalTargets, seed) {
    const itemsByFilename = new Map(items.map((item) => [item.filename, item]));

    const deficiency = (split) => globalTargets[split] - globalCounts[split];
    const surplus = (split) => globalCounts[split] - globalTargets[split];

    let guard = 0;
    while (guard < 10000) {
        guard += 1;
        const underfull = ["train", "val", "test"].filter((split) => deficiency(split) > 0);
        if (underfull.length === 0) break;

        underfull.sort((a, b) => deficiency(b) - deficiency(a));
        const targetSplit = underfull[0];

        const donors = ["train", "val", "test"].filter((split) => surplus(split) > 0);
        if (!donors.length) break;

        donors.sort((a, b) => surplus(b) - surplus(a));

        let moved = false;
        for (const donor of donors) {
            const candidates = Array.from(assignments.entries())
                .filter(([, split]) => split === donor)
                .map(([filename]) => itemsByFilename.get(filename))
                .filter(Boolean)
                .sort((a, b) => {
                    const keyA = `${a.source}|${a.documentType}|${a.condition}|${a.filename}`;
                    const keyB = `${b.source}|${b.documentType}|${b.condition}|${b.filename}`;
                    return hashString(keyA + String(seed)) - hashString(keyB + String(seed));
                });

            if (!candidates.length) continue;

            const chosen = candidates[0];
            assignments.set(chosen.filename, targetSplit);
            globalCounts[donor] -= 1;
            globalCounts[targetSplit] += 1;
            moved = true;
            break;
        }

        if (!moved) break;
    }
}

function countBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
        const key = keyFn(item);
        map.set(key, (map.get(key) || 0) + 1);
    }
    return Object.fromEntries(Array.from(map.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const overrides = loadOverrides(args.overrides);

    const allItems = loadDataset(args.imagesDir, overrides);
    if (!allItems.length) {
        throw new Error(`No images with ground truth found in ${path.resolve(args.imagesDir)}`);
    }

    const filtered = allItems.filter((item) => args.includeScripts.includes(String(item.script).toLowerCase()));
    if (!filtered.length) {
        throw new Error(
            `No images left after script filter [${args.includeScripts.join(", ")}].`
        );
    }

    const { assignments, globalTargets, globalCounts } = buildAssignments(filtered, args.ratios, args.seed);

    const splitBuckets = {
        train: [],
        val: [],
        test: [],
    };

    const images = [...filtered]
        .sort((a, b) => a.filename.localeCompare(b.filename))
        .map((item) => {
            const split = assignments.get(item.filename) || "train";
            splitBuckets[split].push(item.filename);
            return {
                filename: item.filename,
                split,
                script: item.script,
                source: item.source,
                documentType: item.documentType,
                condition: item.condition,
                fullTextLength: item.fullTextLength,
                image: item.image,
            };
        });

    for (const split of ["train", "val", "test"]) {
        splitBuckets[split].sort((a, b) => a.localeCompare(b));
    }

    const output = {
        schema: "ocr-run3-split-manifest/v1",
        createdAt: new Date().toISOString(),
        seed: args.seed,
        imagesDir: args.imagesDir,
        ratios: args.ratios,
        filters: {
            includeScripts: args.includeScripts,
            overridesFile: args.overrides ? path.resolve(args.overrides) : null,
        },
        summary: {
            totalImages: images.length,
            splitTargets: globalTargets,
            splitCounts: globalCounts,
            byScript: countBy(images, (item) => item.script),
            bySource: countBy(images, (item) => item.source),
            byDocumentType: countBy(images, (item) => item.documentType),
            byCondition: countBy(images, (item) => item.condition),
            strataCount: new Set(images.map((item) => `${item.source}|${item.documentType}|${item.condition}`)).size,
        },
        splits: splitBuckets,
        images,
    };

    console.log(`[generate-split-manifest] Dataset images: ${allItems.length}`);
    console.log(`[generate-split-manifest] Filtered images: ${images.length}`);
    console.log(
        `[generate-split-manifest] Split counts train/val/test: ${splitBuckets.train.length}/${splitBuckets.val.length}/${splitBuckets.test.length}`
    );

    if (args.dryRun) {
        console.log("[generate-split-manifest] Dry run, no file written.");
        return;
    }

    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
    console.log(`[generate-split-manifest] Wrote ${outputPath}`);
}

try {
    main();
} catch (error) {
    console.error("[generate-split-manifest] Fatal error:", error instanceof Error ? error.message : error);
    process.exit(1);
}
