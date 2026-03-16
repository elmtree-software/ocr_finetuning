# OCR Optimization — Run 2 Report

**Date:** February 27, 2026
**Engine:** Tesseract.js (Browser)
**Dataset:** 7 documents (cleaned, without perspectively distorted images)
**Scoring:** Custom WER (worst image dropped, 6 remaining averaged)
**Method:** Bayesian Optimization (Gaussian Process) with Playwright automation

---

## 1. Summary

| Metric | Value |
|--------|------|
| **Best Custom WER** | **34.85%** |
| Best Custom CER | 27.08% |
| Best Phase | Phase 2B (Layout + Rectification) |
| Total Iterations | ~519 |
| Runtime | ~10 hours |
| Improvement vs. Run 2 Baseline | -3.95 percentage points (10.2% relative) |
| Improvement vs. Run 1 Result | -12.43 percentage points (26.3% relative) |

---

## 2. Changes Compared to Run 1

Run 1 achieved 47.28% Custom WER on 10 images. Before Run 2, the following structural changes were made:

| Change | Before (Run 1) | After (Run 2) |
|----------|----------------|-----------------|
| **Scoring Metric** | combinedScore (weighted CER/WER + penalties) | Custom WER directly as combinedScore |
| **Dataset** | 10 images | 7 images (000013/14/15 removed) |
| **Custom WER** | Drop worst of 10, average 9 | Drop worst of 7, average 6 |
| **PSM Modes** | Hardcoded `SINGLE_LINE_REGION_TYPES` list | Flexible `regionOverrides` per region type |

**Code Changes (Part 1):**
- `config.ts` — Updated `DEFAULT_CONFIG` with Run 1 best values
- `pipeline.ts` — `regionOverrides` instead of hardcoded PSM list
- `tuning.ts` — `customWER` added as scoring mode
- `useTuningRunner.ts` — Return Custom WER as `combinedScore`
- `useParameterRegistry.ts` — PSM `regionOverrides` as tunable parameters
- `ResultsPanel.vue` — Custom WER/CER display
- `run-tuning.mjs` — Custom WER extraction and reporting

---

## 3. Phase Results

### Overview

```
Custom WER
  39% ┤ ■ ■
  38% ┤ ·····■
  37% ┤
  36% ┤                       ■·········■
  35% ┤             ■···■
  34% ┤
       Phase 0  1A  1B  2A  2B  3A  4A
```

| Phase | Category | Iter. | Custom WER | Custom CER | Delta vs. Baseline |
|-------|-----------|------:|------------|------------|-------------------|
| 0 | Baseline | 1 | 38.80% | 31.07% | — |
| 1A | PSM Core | 80 | 38.80% | 31.07% | 0.00pp |
| 1B | PSM Singleline + Confidence | 60 | 38.52% | 31.71% | -0.28pp |
| 2A | Preprocessing | 100 | 35.58% | 28.09% | -3.22pp |
| **2B** | **Layout + Rectification** | **80** | **34.85%** | **27.08%** | **-3.95pp** |
| 3A | Cross-Category (7 Params) | 101 | 35.74% | 30.11% | -3.06pp |
| 4A | Ultra-Fine (+-10%) | 97 | 35.65% | 28.95% | -3.15pp |

---

### Phase 0 — Baseline

New baseline after dataset cleanup and switch to Custom WER scoring.

**Custom WER: 38.80%** | CER: 31.07%

| Image | WER | CER | Len Ratio |
|------|----:|----:|----------:|
| got-a-letter-3jg7f5xs1egg1.jpg | 16.3% | 15.2% | 0.887 |
| got-a-letter-0uuhv5xs1egg1.jpg | 23.6% | 17.6% | 0.927 |
| IMG_0173.jpg | 33.3% | 29.8% | 0.757 |
| rechnung-schreiben-beispiel-muster.jpg | 43.5% | 28.8% | 0.925 |
| signal-2026-01-12-111456.jpg | 51.1% | 37.9% | 0.927 |
| 000017.jpg | 65.1% | 57.1% | 0.648 |
| ~~000011.jpg~~ | ~~65.8%~~ | ~~51.4%~~ | ~~0.799~~ |

*000011.jpg dropped (highest WER)*

---

### Phase 1A — PSM Core (80 iterations)

**Custom WER: 38.80%** — No improvement

Parameters: `psmModes.default`, `Title`, `Section-header`, `List-item`

**Result:** PSM-Default=6 (SINGLE_BLOCK) confirmed as optimal. Other PSM modes for titles, headers, and list items do not bring improvement.

---

### Phase 1B — PSM Singleline + Confidence (60 iterations)

**Custom WER: 38.52%** (-0.28pp) | Best iteration: #16

| Parameter | Before | After |
|-----------|--------|---------|
| Caption PSM | 7 (SINGLE_LINE) | **3** (FULLY_AUTO) |
| Footnote PSM | 7 (SINGLE_LINE) | **3** (FULLY_AUTO) |
| Page-header PSM | 7 (SINGLE_LINE) | **11** (SPARSE_TEXT) |
| output.minWordConfidence | 0.15 | **0.45** |

| Image | WER | CER | Delta WER |
|------|----:|----:|----------:|
| got-a-letter-3jg7f5xs1egg1.jpg | 16.3% | 15.2% | 0.0pp |
| got-a-letter-0uuhv5xs1egg1.jpg | 22.9% | 18.7% | -0.7pp |
| IMG_0173.jpg | 32.4% | 30.5% | -1.0pp |
| rechnung-schreiben-beispiel-muster.jpg | 43.5% | 29.4% | 0.0pp |
| signal-2026-01-12-111456.jpg | 51.5% | 39.2% | +0.4pp |
| 000017.jpg | 64.7% | 57.2% | -0.4pp |
| ~~000011.jpg~~ | ~~65.8%~~ | ~~52.2%~~ | — |

**Insight:** Marginal improvement. The higher `minWordConfidence` (0.45 instead of 0.15) filters out unreliable words and slightly improves overall quality.

---

### Phase 2A — Preprocessing (100 iterations)

**Custom WER: 35.58%** (-3.22pp) | Best iteration: #78

| Parameter | Before | After |
|-----------|--------|---------|
| contrastBoost | 1.2 | **1.149** |
| clahe.clipLimit | 0.5 | **0.5** (unchanged) |
| clahe.tileSize | 24 | **32** |
| dpiScaling.maxScale | 2.5 | **3.25** |
| dpiScaling.minCapitalHeightPx | 35 | **46** |

| Image | WER | CER | Delta WER |
|------|----:|----:|----------:|
| got-a-letter-3jg7f5xs1egg1.jpg | 16.6% | 15.3% | +0.3pp |
| got-a-letter-0uuhv5xs1egg1.jpg | 22.1% | 16.7% | -1.5pp |
| IMG_0173.jpg | 32.4% | 28.7% | -1.0pp |
| rechnung-schreiben-beispiel-muster.jpg | 42.9% | 29.7% | -0.6pp |
| 000011.jpg | 44.3% | 38.2% | -21.4pp |
| signal-2026-01-12-111456.jpg | 55.2% | 39.9% | +4.1pp |
| ~~000017.jpg~~ | ~~55.9%~~ | ~~49.7%~~ | — |

**Insight:** Significant jump due to less aggressive contrast, larger CLAHE tiles, and stronger DPI upscaling. 000011.jpg improves dramatically from 65.8% to 44.3% WER (-21.4pp). The dropped image changes from 000011 to 000017.

---

### Phase 2B — Layout + Rectification (80 iterations) — BEST

**Custom WER: 34.85%** (-3.95pp) | Best iteration: #13

| Parameter | Before | After |
|-----------|--------|---------|
| layout.regionPadding | 20 | **14** |
| layout.internalPadding | 5 | **4** |
| layout.detectionThreshold | 0.1 | **0.175** |
| rectification.cannyLow | 162.5 | **195.5** |
| rectification.cannyHigh | 87.5 | **96.333** |

| Image | WER | CER | Delta WER vs. Baseline |
|------|----:|----:|----------:|
| got-a-letter-3jg7f5xs1egg1.jpg | 16.3% | 15.2% | 0.0pp |
| got-a-letter-0uuhv5xs1egg1.jpg | 24.0% | 18.1% | +0.4pp |
| IMG_0173.jpg | 31.4% | 29.6% | -1.9pp |
| rechnung-schreiben-beispiel-muster.jpg | 43.5% | 29.5% | 0.0pp |
| signal-2026-01-12-111456.jpg | 38.1% | 28.2% | **-13.1pp** |
| 000011.jpg | 56.0% | 41.9% | -9.8pp |
| ~~000017.jpg~~ | ~~63.6%~~ | ~~55.4%~~ | — |

**Insight:** Less padding (14 instead of 20) and a slightly higher detection threshold (0.175 instead of 0.1) combined with adjusted edge detection (cannyLow/High) bring the best overall performance. The signal image improves dramatically by 13.1 percentage points.

---

### Phase 3A — Cross-Category (101/120 iterations, timeout)

**Custom WER: 35.74%** (+0.89pp vs Phase 2B) — No improvement

7 parameters simultaneously optimized. The 7D search space was too large for 101 iterations. Regression in got-a-letter-3jg7f (WER 16.3% → 20.6%).

---

### Phase 4A — Ultra-Fine Tuning (97/100 iterations, timeout)

**Custom WER: 35.65%** (+0.80pp vs Phase 2B) — No improvement

5 parameters with ±10% range around Phase 2B best values. Confirms convergence: Phase 2B values are already close to the local optimum.

---

## 4. Per-Image Analysis

### Improvement Progress per Image (WER)

| Image | Baseline | Phase 2B (Best) | Delta |
|------|------:|------:|------:|
| got-a-letter-3jg7f5xs1egg1.jpg | 16.3% | 16.3% | 0.0pp |
| got-a-letter-0uuhv5xs1egg1.jpg | 23.6% | 24.0% | +0.4pp |
| IMG_0173.jpg | 33.3% | 31.4% | -1.9pp |
| signal-2026-01-12-111456.jpg | 51.1% | 38.1% | **-13.1pp** |
| rechnung-schreiben-beispiel-muster.jpg | 43.5% | 43.5% | 0.0pp |
| 000011.jpg | 65.8% | 56.0% | -9.8pp |
| 000017.jpg | 65.1% | 63.6% | -1.5pp |

### Image Categories

**Good (WER < 25%):**
- `got-a-letter-3jg7f5xs1egg1.jpg` — Consistently best result (16.3%), no optimization room
- `got-a-letter-0uuhv5xs1egg1.jpg` — Stable at 22–24%

**Medium (WER 25–45%):**
- `IMG_0173.jpg` — Slightly improved (33.3% → 31.4%)
- `signal-2026-01-12-111456.jpg` — **Largest winner** (51.1% → 38.1%, -13.1pp)
- `rechnung-schreiben-beispiel-muster.jpg` — Unchanged at 43.5%

**Challenging (WER > 50%):**
- `000011.jpg` — Improved (65.8% → 56.0%), but remains problematic
- `000017.jpg` — Barely improved (65.1% → 63.6%), consistently worst image

---

## 5. Optimal Parameters (Run 2)

```json
{
    "rectification": {
        "cannyLow": 195.5,
        "cannyHigh": 96.333
    },
    "preprocessing": {
        "contrastBoost": 1.149,
        "dpiScaling": {
            "minCapitalHeightPx": 46,
            "maxScale": 3.25
        },
        "clahe": {
            "tileSize": 32
        }
    },
    "layout": {
        "detectionThreshold": 0.175,
        "regionPadding": 14,
        "internalPadding": 4,
        "psmModes": {
            "regionOverrides": {
                "Caption": 3,
                "Footnote": 3,
                "Page-header": 11
            }
        }
    },
    "output": {
        "minWordConfidence": 0.45
    }
}
```

### Parameter Changes Run 1 → Run 2

| Parameter | Run 1 | Run 2 | Direction |
|-----------|------:|------:|----------|
| cannyLow | 162.5 | 195.5 | +20% higher |
| cannyHigh | 87.5 | 96.333 | +10% higher |
| contrastBoost | 1.2 | 1.149 | -4% lower |
| minCapitalHeightPx | 35 | 46 | +31% higher |
| maxScale | 2.5 | 3.25 | +30% higher |
| tileSize | 24 | 32 | +33% larger |
| detectionThreshold | 0.1 | 0.175 | +75% higher |
| regionPadding | 20 | 14 | -30% smaller |
| internalPadding | 5 | 4 | -20% smaller |
| minWordConfidence | 0.15 | 0.45 | +200% higher |

---

## 6. Insights

### What Worked
1. **Fixing Scoring Mismatch** was the most important structural change. The optimizer now directly minimizes Custom WER instead of an indirect combinedScore.
2. **Dataset Cleanup** (removed 3 perspective images) lowered the baseline from ~58% to 38.8% and allowed the optimizer to find more meaningful improvements.
3. **Sequential Phase Optimization** (preprocessing first, then layout) was more effective than cross-category optimization.
4. **Layout Parameters** (regionPadding, detectionThreshold) and **Rectification** (cannyLow/High) had the largest single effect.

### What Did Not Work
1. **PSM Modes** had minimal impact (-0.28pp through Phase 1B).
2. **Cross-Category Optimization** (Phase 3A, 7 parameters) did not converge — 7D space was too large for ~100 iterations.
3. **Ultra-Fine Tuning** (Phase 4A, ±10%) could not improve upon Phase 2B — values were already near the optimum.

### Convergence Confirmation
Phases 3A and 4A confirm that Phase 2B values represent a robust local optimum. Further parametric optimization yields no additional value.

---

## 7. Comparison Run 1 → Run 2

| Metric | Run 1 | Run 2 |
|--------|------:|------:|
| Dataset | 10 images | 7 images |
| Scoring | combinedScore | customWER |
| Baseline WER | 57.99% | 38.80% |
| **Best WER** | **47.28%** | **34.85%** |
| Total Iterations | ~1569 | ~519 |
| Phases | 7 | 7 |
| Efficiency (pp/100 iter.) | 0.68 | 0.76 |

Run 2 was **67% more efficient** (fewer iterations) and achieved a **26% better result** than Run 1 — primarily due to fixing the scoring mismatch and dataset cleanup.

---

## 8. Next Steps

1. **Analyze 000017.jpg** — Consistently worst image (WER ~63%). May require image-specific preprocessing.
2. **PaddleOCR Comparison** — Current optimization only affects Tesseract. PaddleOCR v5 might perform significantly better on the same images.
3. **Ensemble Approach** — Combine Tesseract + PaddleOCR, choose best result per region.
4. **More Training Data** — 7 images is a small dataset. Overfitting to these specific images is possible.
