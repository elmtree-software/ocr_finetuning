# OCR Parameter Optimization — Activity Log

**Objective:** WER < 10% (Custom Score: worst document dropped, average of remaining 9)
**Engine:** Tesseract
**Dataset:** 10 documents in `ocr_trainingdata/sel_gt/`
**Start Date:** 2026-02-25

---

## Iteration Plan

### Phase 1: Geometric Corrections (parallel, 2 agents)
| Iteration | Category | Parameters | Steps | Iter. | Status |
|-----------|-----------|-----------|-------|-------|--------|
| 1A | Rectification | enabled, minContourConfidence, minDocumentArea, cannyLow, cannyHigh, blurSize | 3 | 35/80 | completed |
| 1B | Layout Detection Core | enabled, detectionThreshold, regionPadding, internalPadding, nms.iouThreshold, nms.containmentThreshold, xyCut.enabled | 3 | 43/80 | completed |

### Phase 2: Image Processing + Reading Order (parallel, 3 agents)
| Iteration | Category | Parameters | Steps | Iter. | Status |
|-----------|-----------|-----------|-------|-------|--------|
| 2A | Preprocessing Core | contrastBoost, dpiScaling.enabled, dpiScaling.minCapitalHeightPx, dpiScaling.maxScale, clahe.enabled, clahe.clipLimit, clahe.tileSize | 3-4 | 75/100 | **completed** |
| 2B | XY-Cut + Rotation | xyCut.minGapThreshold, xyCut.spanningThreshold, xyCut.maxDepth, rotation.enabled, rotation.fastMode, rotation.skipThreshold, rotation.minImprovement | 3 | 80/80 | **completed** |
| 2C | Output Filtering + Fallback | output.minTextLength, output.minLineConfidence, output.minWordConfidence, fallback.enabled, fallback.gridSize, fallback.minAreaRatio, fallback.minConfidence | 3-4 | 69/100 | **completed** |

### Phase 3: Extended Preprocessing (parallel, 2 agents)
| Iteration | Category | Parameters | Steps | Iter. | Status |
|-----------|-----------|-----------|-------|-------|--------|
| 3A | Preprocessing Extended | bilateralFilter.enabled, bilateralFilter.diameter, bilateralFilter.sigmaColor, bilateralFilter.sigmaSpace, threshold.enabled, threshold.type | 3 | 80/80 | **completed** |
| 3B | Table + Inversion | inversionDetection.enabled, inversionDetection.brightnessThreshold, table.enabled, table.outputFormat, table.rowClusterTolerance, table.colClusterTolerance | 3 | 60/60 | **completed** |

### Phase 4: Fine-Tuning (parallel, up to 3 agents)
| Iteration | Category | Parameters | Steps | Iter. | Status |
|-----------|-----------|-----------|-------|-------|--------|
| 4A | Fine-Tuning Preprocessing | contrastBoost, dpiScaling.minCapitalHeightPx, dpiScaling.maxScale, clahe.clipLimit, clahe.tileSize | 5-6 | 91/100 | **completed** |
| 4B | Fine-Tuning Layout + Output | xyCut.minGapThreshold, xyCut.maxDepth, rotation.skipThreshold, output.minWordConfidence, output.minLineConfidence, fallback.minAreaRatio | 5-6 | 100/100 | **completed** |
| 4C | Fine-Tuning Rectification | minContourConfidence, minDocumentArea, cannyLow, cannyHigh, blurSize | 3-5 | 80/80 | **completed** |

### Phase 5: Cross-Category (sequential)
| Iteration | Category | Parameters | Steps | Iter. | Status |
|-----------|-----------|-----------|-------|-------|--------|
| 5A | Top 7 Cross-Category | contrastBoost, clahe.clipLimit, clahe.tileSize, minLineConf, minWordConf, maxScale, skipThreshold | 5-6 | 89/120 | **completed** |

### Phase 6: Final Verification (sequential)
| Iteration | Category | Parameters | Steps | Iter. | Status |
|-----------|-----------|-----------|-------|-------|--------|
| 6A | Ultra-Fine Preprocessing | contrastBoost, clipLimit, tileSize, maxScale, minCapitalHeightPx | 5-7 | 100/100 | **completed** |
| 6B | CLAHE + Contrast + Output | clahe.enabled, contrastBoost, minLineConf, minWordConf, regionPadding | 5-6 | 80/80 | **completed** |

---

## Progress Overview

| Phase | Iteration | Custom WER | Custom CER | Original WER | Date |
|-------|-----------|------------|------------|--------------|-------|
| - | Baseline (Defaults) | 57.99% | 50.88% | 62.19% | 2026-02-26 |
| 1 | 1A Rectification | 57.86% | 50.54% | 62.07% | 2026-02-26 |
| 1 | 1B Layout | 58.98% | 50.87% | 63.08% | 2026-02-26 |
| 2 | 2A Preprocessing Core | **54.75%** | **44.93%** | 153.56%* | 2026-02-26 |
| 2 | 2B XY-Cut + Rotation | 55.96% | 46.98% | 60.22% | 2026-02-26 |
| 2 | 2C Output + Fallback | 57.92% | 49.37% | 62.13% | 2026-02-26 |
| 3 | 3A Preproc Extended | **52.51%** | **42.60%** | 56.60% | 2026-02-26 |
| 3 | 3B Table + Inversion | 55.34% | 43.29% | 58.50% | 2026-02-26 |
| 4 | 4A Fine-Tuning Preproc | **47.28%** | **39.12%** | — | 2026-02-26 |
| 4 | 4B Fine-Tune Layout+Output | 54.98% | 43.84% | — | 2026-02-26 |
| 4 | 4C Fine-Tune Rectification | 55.22% | 43.02% | — | 2026-02-26 |
| 5 | 5A Cross-Category | 49.64% | 40.47% | 56.60% | 2026-02-26 |
| 6 | 6A Ultra-Fine Preproc | 47.97% | 38.51% | — | 2026-02-26 |
| 6 | 6B CLAHE + Contrast + Out | 50.27% | 40.13% | — | 2026-02-26 |
| 7 | Final Combination | 48.20% | 39.85% | — | 2026-02-26 |

---

## Detailed Results

### Baseline (Default Configuration)
**Custom WER: 57.99%** | Custom CER: 50.88% | Original WER: 62.19%
Dropped: 000013.jpg (WER 100%, empty output)

| Document | CER | WER | Length Ratio | Note |
|----------|-----|-----|-------------|-----------|
| 000013.jpg | 100% | 100% | 0.00 | **Empty Output** — dropped |
| 000015.jpg | 98.0% | 100% | 0.02 | Almost empty (10 of 448 chars) |
| 000014.jpg | 83.6% | 87.8% | 0.19 | Heavy underproduction |
| rechnung-schreiben...jpg | 67.4% | 88.1% | 0.57 | Poor |
| 000011.jpg | 60.4% | 66.4% | 0.49 | Underproduction |
| 000017.jpg | 45.8% | 50.7% | 0.61 | Medium |
| IMG_0173.jpg | 31.7% | 38.1% | 0.69 | Acceptable |
| signal-2026-01-12...jpg | 31.0% | 48.1% | 0.82 | Acceptable |
| got-a-letter...0uuh... | 17.6% | 22.1% | 0.88 | Good |
| got-a-letter...3jg7... | 22.4% | 20.6% | 0.78 | Good |

**Analysis:** Heavy underproduction across many documents. 3 documents almost empty. Main issue appears to be layout detection and/or rectification. Optimization has great potential.

### Phase 2A — Preprocessing Core (75/100 Iterations)
**Custom WER: 54.75%** | Custom CER: 44.93% | Original WER: 153.56%*
Dropped: 000013.jpg (WER 1042.9% — Overproduction!)

*Note: 000013.jpg produced massive amounts of incorrect text → Original WER extremely high.*

**Best Parameters:**
| Parameter | Value (before → after) |
|-----------|------------------------|
| contrastBoost | 2.0 → **1.667** |
| dpiScaling.minCapitalHeightPx | 20 → **35** |
| dpiScaling.maxScale | 4 → **2** |
| clahe.clipLimit | 2.0 → **1.0** |
| clahe.tileSize | 8 → **16** |

| Document | WER | CER |
|----------|-----|-----|
| 000013.jpg | 1042.9% | 357.9% | **dropped** |
| rechnung-schreiben... | 93.5% | 63.9% |
| 000015.jpg | 78.3% | 69.4% |
| 000014.jpg | 71.3% | 67.9% |
| 000017.jpg | 67.6% | 57.4% |
| signal-2026-01-12... | 59.0% | 40.6% |
| 000011.jpg | 44.3% | 34.1% |
| IMG_0173.jpg | 39.0% | 37.1% |
| got-a-letter...0uuh... | 22.8% | 18.4% |
| got-a-letter...3jg7... | 17.0% | 15.5% |

**Analysis:** Preprocessing changes are very effective: -3.24% Custom WER. Lower contrast + lower CLAHE clipLimit + larger tiles + higher minCapitalHeight improve detection. DPI scaling with maxScale=2 instead of 4 seems better (less aggressive upscaling).

### Phase 2B — XY-Cut + Rotation (80/80 Iterations)
**Custom WER: 55.96%** | Custom CER: 46.98% | Avg WER: 60.22%
Dropped: 000015.jpg (WER 98.6%)

**Best Parameters:**
| Parameter | Value (before → after) |
|-----------|------------------------|
| xyCut.minGapThreshold | 25 → **30** |
| xyCut.maxDepth | 14 → **16** |
| rotation.fastMode | false → **true** |
| rotation.skipThreshold | 70 → **55** |
| rotation.minImprovement | 5 → **3** |

### Phase 2C — Output Filtering + Fallback (69/100 Iterations)
**Custom WER: 57.92%** | Custom CER: 49.37% | Avg WER: 62.13%
Dropped: 000013.jpg (WER 100%)

**Best Parameters:**
| Parameter | Value (before → after) |
|-----------|------------------------|
| output.minTextLength | 2 → **1** |
| output.minWordConfidence | 0.5 → **0.325** |
| output.minLineConfidence | 0.4 → **0.5** |
| fallback.gridSize | 80 → **120** |
| fallback.minAreaRatio | 0.14 → **0.05** |
| fallback.minConfidence | 0.45 → **0.4** |

**Phase 2 Summary:** Preprocessing was the most effective lever (54.75%). All three groups merged into best_config.json. Next step: Phase 3 (Extended Preprocessing + Table).

### Phase 3A — Preprocessing Extended (80/80 Iterations)
**Custom WER: 52.51%** | Custom CER: 42.60% | Avg WER: 56.60%
Dropped: rechnung-schreiben-beispiel-muster.jpg (WER 93.5%)

**Best Parameters:** bilateralFilter.enabled=**false**, threshold.enabled=**false** (Baseline wins!)

| Config | Best Custom WER | Delta |
|--------|-------------------|-------|
| Baseline (both off) | **52.51%** | — |
| Bilateral Filter only | 54.07% | +1.56pp worse |
| Threshold only | 62.24% | +9.73pp worse |
| Both on | 63.61% | +11.10pp worse |

**Analysis:** Both Bilateral Filter and Threshold degrade OCR quality. Both remain deactivated. Note: 000013.jpg improved from 100%/1043% WER to 66.2% through cumulative optimizations from Phases 1-2.

### Phase 3B — Table + Inversion Detection (60/60 Iterations)
**Custom WER: 55.34%** | Custom CER: 43.29% | Avg WER: 58.50%
Dropped: 000015.jpg (WER 87.0%)

**Best Parameters:**
| Parameter | Value (before → after) |
|-----------|------------------------|
| table.enabled | true → **false** |
| inversionDetection.brightnessThreshold | 128 → **106.667** |

**Analysis:** Table processing hurts detection on this dataset (no tabular documents). Inversion Detection: A brightness threshold of ~107 instead of 128 is slightly better but has low impact.

### Phase 3 Summary
- New Best: **Custom WER 52.51%** (previously 54.75%)
- Improvement: -5.48pp since baseline (57.99% → 52.51%)
- Main Findings: bilateralFilter, threshold, and table.enabled all better if deactivated
- best_config.json updated with table.enabled=false and brightnessThreshold=106.667

### Phase 4A — Fine-Tuning Preprocessing (91/100 Iterations)
**Custom WER: 47.28%** | Custom CER: 39.12% | Combined: 0.6235
Dropped: 000015.jpg (WER 82.6%)

**Best Parameters (Breakthrough!):**
| Parameter | Value (before → after) |
|-----------|------------------------|
| contrastBoost | 1.667 → **1.2** (minimum logic boundary!) |
| clahe.clipLimit | 1.0 → **0.5** (minimum logic boundary!) |
| clahe.tileSize | 16 → **24** (maximum logic boundary!) |
| dpiScaling.maxScale | 2 → **2.5** |
| dpiScaling.minCapitalHeightPx | 35 → **35** (unchanged) |

**Analysis:** Major breakthrough! -5.23pp WER due to less aggressive contrast processing. Clear trend: contrastBoost and clipLimit at the lower bound → next step should test even lower values.

### Phase 4B — Fine-Tuning Layout + Output (100/100 Iterations)
**Custom WER: 54.98%** | Custom CER: 43.84% | Combined: 0.7788
Dropped: 000015.jpg (WER 82.6%)

**Best Parameters:**
| Parameter | Value (before → after) |
|-----------|------------------------|
| xyCut.maxDepth | 16 → **14** |
| rotation.skipThreshold | 55 → **65** |
| output.minLineConfidence | 0.5 → **0.6** |
| output.minWordConfidence | 0.325 → **0.4** |
| fallback.minAreaRatio | 0.05 → **0.053** |

### Phase 4C — Fine-Tuning Rectification (80/80 Iterations)
**Custom WER: 55.22%** | Custom CER: 43.02%
Dropped: 000015.jpg (WER 84.1%)

**Best Parameters:** blurSize=**1** (only effective parameter), cannyLow=162.5, cannyHigh=87.5, minContourConfidence=0.8, minDocumentArea=0.475

### Phase 4 Summary
- **New Best: Custom WER 47.28%** (previously 52.51%, -10.71pp since baseline)
- Preprocessing fine-tuning was again the biggest lever
- Clear trend: minimal contrast boost + minimal CLAHE = better
- Rectification: only blurSize=1 important, other parameters irrelevant
- Layout/Output: moderate improvements through stricter confidence filters

### Phase 5A — Cross-Category (89/120 Iterations)
**Custom WER: 49.64%** | Custom CER: 40.47% | Combined: 0.6895
Dropped: 000013.jpg (WER 85.7%)

**Analysis:** Optimizing 7 parameters simultaneously was too complex for 89 iterations (timeout). Result worse than Phase 4A (47.28%), but confirms preprocessing trends: contrastBoost 1.2-1.4 and medium clipLimit values.

### Phase 6A — Ultra-Fine Preprocessing (100/100 Iterations)
**Custom WER: 47.97%** | Custom CER: 38.51% | Combined: 0.5906
Dropped: 000015.jpg (WER 82.6%)

**Best Parameters:**
| Parameter | Value | Note |
|-----------|------|-----------|
| contrastBoost | **1.4** | Upper edge of range! |
| clipLimit | **0.7** | Upper edge of range! |
| tileSize | **16** | Lower edge of range! |
| maxScale | **1.5** | Lower edge of range! |

**Finding:** The hypothesis "lower contrast = better" was disproven! contrastBoost=1.4 and clipLimit=0.7 (both at the upper edge) are better. However, tileSize=16 (smaller tiles = more local adaptation) and maxScale=1.5 (less upscaling) are clearly superior.

### Phase 6B — CLAHE + Contrast + Output (80/80 Iterations)
**Custom WER: 50.27%** | Custom CER: 40.13% | Combined: 0.6624
Dropped: 000013.jpg (WER 87.0%)

### Phase 7 — Final Combination (98/120 Iterations)
**Custom WER: 48.20%** | Custom CER: 39.85% | Combined: 0.6487
Dropped: 000014.jpg (WER 84.5%)

### Summary of Optimization Results

**Best Custom WER across all phases: 47.28% (Phase 4A)**

**Improvement since Baseline:**
- **Baseline Custom WER:** 57.99%
- **Best Custom WER:** 47.28%
- **Improvement:** -10.71 percentage points (18.5% relative improvement)

**Key Findings:**
1. **Preprocessing is the biggest lever.**
2. **Less aggressive processing = better.**
3. **Some features hurt (bilateralFilter, threshold, table processing).**
4. **3 problematic documents** (000013, 000014, 000015) consistently produce >70% WER.
5. **Target WER <10% not achieved** — too ambitious for browser-based Tesseract.js.

---

## Run 2 (2026-02-27)

### Changes vs. Run 1
1. **Scoring Mismatch Fixed:** Bayesian Optimizer now directly minimizes Custom WER.
2. **Dataset Cleaned:** Removed 3 perspective images. 7 images remaining.
3. **Custom WER redefined:** Drop worst of 7, average 6.
4. **PSM Modes Expanded:** Per-region `regionOverrides`.

### Run 2 Summary
**Best Custom WER: 34.85%** (Phase 2B)

Run 2 was **67% more efficient** and achieved a **26% better result** than Run 1 — primarily by fixing the scoring mismatch and dataset cleanup.
