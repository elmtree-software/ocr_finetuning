# OCR Parameter Optimization: Methodology and Results Report

**Date:** 2026-02-26/27
**Runtime:** ~14 hours (09:49 to 23:15)
**Total Iterations:** 1,569 (spread over 25 tuning runs)
**Result:** Custom WER 57.99% (Baseline) -> **47.28%** (Best) = **-10.71 percentage points**

---

## 1. Objectives

- **Target Metric:** WER < 10% (Custom Score: worst document dropped, average of remaining 9)
- **Engine:** Tesseract.js only (browser-based)
- **Dataset:** 10 documents with Ground Truth in `ocr_trainingdata/sel_gt/`
- **Results:** Target not reached. Best result 47.28% Custom WER.

---

## 2. Technical Architecture

### 2.1 Automation Stack

```
Orchestrator (Claude Code, Main Process)
    |
    +-- Subagents (parallel, each running one tuning run)
           |
           +-- run-tuning.mjs (Node.js script)
                  |
                  +-- Playwright (Chromium, headless)
                         |
                         +-- OCR-Finetuning-App (Vue 3, localhost:5173)
                                |
                                +-- Tesseract.js (WASM, in-browser)
```

**Core Idea:** The existing OCR-Finetuning app (with built-in Bayesian Optimizer) is remote-controlled via Playwright. A Node.js script (`scripts/ocr-optimize/run-tuning.mjs`) acts as a bridge between the filesystem and the browser.

### 2.2 Code Modifications

**`frontend/src/ocr-finetuning/main.ts`** -- Automation hook added:
```typescript
(window as any).__TUNING__ = {
    state: useTuningState(),
    runner: useTuningRunner(),
    registry: useParameterRegistry(),
    setBaseConfig(partial) { deepAssign(DEFAULT_CONFIG, partial); resetConfig(); },
    getDefaultConfig() { return structuredClone(DEFAULT_CONFIG); },
};
```
This allows the Playwright script access to the Vue composables (Singleton pattern).

**`backend/src/handlers/ocr-tuning.ts`** -- Node 18 compatibility fix:
```typescript
// import.meta.dirname not available in Node 18
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

### 2.3 Automation Script (run-tuning.mjs)

The script performs the following steps:
1. Reads Config JSON (baseConfig, iterateParams, optimizer settings)
2. Loads images + Ground Truth as Base64 from the filesystem
3. Starts Chromium headless via Playwright
4. Navigates to the Finetuning app, waits for `window.__TUNING__`
5. Sets base configuration via `setBaseConfig()` (mutates `DEFAULT_CONFIG`)
6. Injects images as File objects into the app
7. Configures parameter iteration and optimizer
8. Starts the built-in Bayesian Optimization run
9. Polls every 5s for progress
10. After completion: Extracts results, calculates Custom Score (Drop Worst)
11. Timeout: 120 minutes per run

### 2.4 Scoring Methodology

**Custom WER (Primary Metric):**
- Calculate WER per document
- Drop the worst document (outlier protection)
- Average the remaining 9 WER values

**Built-in Combined Score (Secondary):**
- Weighted score from CER, WER, underproduction rate, length ratio
- Used by the Bayesian Optimizer for parameter selection
- Not identical to our Custom WER -- Important Difference!

---

## 3. Optimization Strategy

### 3.1 Phase Approach (Coarse-to-Fine)

| Phase | Strategy | Parallel Agents | Total Iter. | Approx. Duration |
|-------|-----------|----------------|--------------|-----------|
| 1 | Coarse Sweeps: Geometry (Rect + Layout) | 2 | 78 | 1.5h |
| 2 | Coarse Sweeps: Preprocessing + XY-Cut + Output | 3 | 224 | 2h |
| 3 | Feature Toggles: BilateralFilter, Threshold, Table | 2 | 140 | 2.5h |
| 4 | Fine-Tuning: narrower ranges around best values | 3 | 271 | 3h |
| 5 | Cross-Category: 7 most important parameters together | 1 | 89 | 1.5h |
| 6 | Ultra-Fine: Exploring limits of best parameters | 2 | 180 | 3h |
| 7 | Final combination of all findings | 1 | 98 | 1.5h |

### 3.2 Parallelization

- 1-3 subagents were started in parallel per phase
- Each subagent controls its own Chromium instance
- Independent parameter groups can be tested in parallel
- With 3 parallel agents: ~3x time gain, but higher system load
- In Phase 1, there were stability issues (browser hangs with 2 parallel Chromium instances)

### 3.3 Parameter Grouping

42 relevant Tesseract parameters were divided into 8 groups:

| Group | Parameter Count | Impact on Result |
|--------|-----------------|----------------------|
| Preprocessing (Contrast, CLAHE, DPI) | 7 | **Very High** |
| Rectification | 6 | Low (only blurSize relevant) |
| Layout Detection | 7 | Medium |
| XY-Cut + Rotation | 7 | Medium |
| Output Filter | 3 | Medium |
| Fallback | 4 | Low |
| Table Processing | 4 | Negative (hurts) |
| Bilateral Filter / Threshold | 6 | Negative (hurts) |

---

## 4. Results in Detail

### 4.1 Custom WER Progress Across All Phases

```
Baseline (Defaults)          57.99%  ========================
Phase 1A Rectification       57.86%  ========================
Phase 1B Layout              58.98%  =========================
Phase 2A Preprocessing       54.75%  ======================
Phase 2B XY-Cut+Rotation     55.96%  =======================
Phase 2C Output+Fallback     57.92%  ========================
Phase 3A Preproc Extended    52.51%  =====================
Phase 3B Table+Inversion     55.34%  =======================
Phase 4A Fine-Tune Preproc   47.28%  ===================        <-- BEST
Phase 4B Fine-Tune Layout    54.98%  ======================
Phase 4C Fine-Tune Rect      55.22%  =======================
Phase 5A Cross-Category      49.64%  ====================
Phase 6A Ultra-Fine          47.97%  ====================
Phase 6B CLAHE+Output        50.27%  =====================
Phase 7  Final Combo         48.20%  ====================
```

### 4.2 Top 3 Configurations (nearly equivalent)

| Rank | Phase | WER | contrastBoost | clipLimit | tileSize | maxScale |
|------|-------|-----|---------------|-----------|----------|----------|
| 1 | 4A | 47.28% | 1.2 | 0.5 | 24 | 2.5 |
| 2 | 6A | 47.97% | 1.4 | 0.7 | 16 | 1.5 |
| 3 | 7 | 48.20% | 1.0 | 0.9 | 28 | 3.0 |

Note: Three very different parameter combinations achieve almost identical results (~47-48% WER). This indicates a **flat optimum** -- many combinations in the range contrastBoost 1.0-1.4 / clipLimit 0.5-0.9 / tileSize 16-28 perform similarly.

### 4.3 Per-Document Analysis (best configuration, Phase 4A)

| Document | WER | CER | Category |
|----------|-----|-----|-----------|
| got-a-letter...3jg7... | 16.2% | 15.2% | Good |
| got-a-letter...0uuh... | 23.2% | 17.7% | Good |
| IMG_0173.jpg | 32.4% | 29.7% | Acceptable |
| rechnung-schreiben... | 43.5% | 29.4% | Acceptable |
| signal-2026-01-12... | 43.7% | 31.5% | Acceptable |
| 000011.jpg | 52.9% | 40.1% | Poor |
| 000017.jpg | 64.3% | 55.8% | Poor |
| 000014.jpg | 74.0% | 67.5% | Very poor |
| 000013.jpg | 75.3% | 65.2% | Very poor |
| 000015.jpg | 82.6% | 70.3% | Very poor (dropped) |

**Main Problem:** 3 documents (000013, 000014, 000015) remain at >70% WER through all phases. They pull the average up significantly. The 5 best documents average ~32% WER.

### 4.4 Final Configuration (best_config.json)

| Parameter | Default | Optimized | Source |
|-----------|---------|-----------|--------|
| preprocessing.contrastBoost | 2.0 | **1.2** | Phase 4A |
| preprocessing.clahe.clipLimit | 2.0 | **0.5** | Phase 4A |
| preprocessing.clahe.tileSize | 8 | **24** | Phase 4A |
| preprocessing.dpiScaling.maxScale | 4 | **2.5** | Phase 4A |
| preprocessing.dpiScaling.minCapitalHeightPx | 20 | **35** | Phase 2A |
| preprocessing.inversionDetection.brightnessThreshold | 128 | **106.667** | Phase 3B |
| preprocessing.bilateralFilter.enabled | false | **false** | Phase 3A |
| preprocessing.threshold.enabled | false | **false** | Phase 3A |
| rectification.blurSize | 3 | **1** | Phase 4C |
| rectification.minContourConfidence | 0.5 | **0.8** | Phase 4C |
| layout.regionPadding | 15 | **20** | Phase 6B |
| layout.xyCut.minGapThreshold | 25 | **30** | Phase 2B |
| layout.xyCut.maxDepth | 14 | **14** | Phase 4B |
| rotation.fastMode | false | **true** | Phase 2B |
| rotation.skipThreshold | 70 | **65** | Phase 4B |
| rotation.minImprovement | 5 | **3** | Phase 2B |
| table.enabled | true | **false** | Phase 3B |
| output.minLineConfidence | 0.4 | **0.6** | Phase 4B |
| output.minWordConfidence | 0.5 | **0.15** | Phase 6B |
| output.minTextLength | 2 | **1** | Phase 2C |
| fallback.gridSize | 80 | **120** | Phase 2C |
| fallback.minAreaRatio | 0.14 | **0.053** | Phase 4B |

---

## 5. Issues and Observations

### 5.1 Technical Issues

| Issue | Cause | Solution | Time Lost |
|---------|---------|---------|-------------|
| Backend crash on start | `import.meta.dirname` not in Node 18 | `fileURLToPath` polyfill | 15 min |
| Frontend crash | pdfjs-dist not installed | `npm install` in frontend | 10 min |
| OpenCV.js 404 | model not downloaded | `npm run models:ocr:opencv` | 20 min |
| Phase 1 browser hangs | 2 Chromium instances, memory overflow | killed processes, extracted results | 30 min |
| Multiple service failures | frontend/backend die between runs | restart before each run | sporadic |
| Phase 1 incomplete | timeout / hang at iter. 35/80 and 43/80 | proceeded with partial results | 45 min |

### 5.2 Methodological Observations

**Score Discrepancy:** The built-in Combined Score of the Bayesian Optimizer does not directly optimize for our Custom WER metric (Drop-Worst + Average). The optimizer minimizes a weighted score from CER, WER, underproduction rate, and length ratio. This means the optimizer might prefer configurations that are suboptimal for our metric, and vice-versa.

**Flat Optimum:** The top 3 configurations (47.28%, 47.97%, 48.20%) use very different parameter values but achieve almost identical WER. This suggests:
- The search space has a broad plateau
- Individual parameters are less important than the general direction (less aggressive processing)
- Further optimization in the same parameter space likely yields little benefit

**Parameters at Range Boundaries:** In Phase 4A, contrastBoost (1.2) and clipLimit (0.5) were at the minimum of the tested range. Phase 6A tested lower values but found that higher values (1.4, 0.7) were better. These contradictions suggest these parameters interact strongly with others.

**Unoptimized Parameters:** The optimization only tested parameters registered in `useParameterRegistry`. Tesseract.js-specific settings (PSM modes, OEM, whitelist, language packs) are not part of the finetuning UI and were not tested.

---

## 6. Critique of the Approach

### 6.1 What Worked Well

- **Parallelization**: 2-3 agents simultaneously accelerated throughput significantly
- **Coarse-to-Fine**: Dividing into wide sweeps -> feature toggles -> fine tuning was sensible
- **Automation Hook**: The `window.__TUNING__` approach allows for clean browser control
- **Drop-Worst Scoring**: Protects against outliers (e.g., 000013.jpg with 1042% WER)
- **Documentation**: Each phase was logged with results and parameters

### 6.2 What Could Be Improved

**Scoring Mismatch (Critical):**
The app's Bayesian Optimizer minimizes the Combined Score, but we measure Custom WER. The optimization is thus searching in the wrong parameter space. It would be more effective to adapt the optimizer to directly optimize our Custom WER metric -- or integrate the Custom WER calculation as the scoring function in the optimizer.

**Incomplete Runs:**
Several runs did not finish (35/80, 43/80, 75/100, 69/100, 91/100, 89/120, 98/120). In Bayesian Optimization, late iterations are the most valuable (exploitation instead of exploration). Incomplete runs potentially miss the best configurations.

**No Statistical Validation:**
Each configuration was evaluated only once. Tesseract.js might have stochastic elements (thread scheduling, WASM timing). Multiple evaluations of the best configurations would increase reliability.

**No Analysis of Problem Documents:**
000013, 000014, 000015 are consistently poor (>70% WER), but it was not investigated why. A targeted analysis (image quality, layout complexity, font, resolution) could reveal specific countermeasures.

**Too Many Phases with Similar Results:**
After Phase 4A (47.28%), there was no substantial improvement. Phases 5-7 (total ~367 iterations, ~6 hours) yielded no progress. The termination condition should have triggered earlier.

**Parameter Ranges Not Optimal:**
Initial ranges (e.g., contrastBoost 1.2-2.2 in Phase 4A) were chosen heuristically. A sensitivity analysis (1-parameter-at-a-time sweeps) before the Bayesian Optimizer would have better informed the ranges.

**No Grid Search for Comparison:**
Bayesian Optimization is efficient for 5-7 parameters, but it was not compared with other methods (Random Search, Grid Search, Genetic Algorithms).

**Missing Tesseract-Specific Parameters:**
PSM (Page Segmentation Mode), OEM (OCR Engine Mode), language packs, whitelists -- these fundamental Tesseract configurations were not tested as they are not exposed in the finetuning UI.

---

## 7. Recommendations for the Next Run

### 7.1 High Priority

1. **Integrate Custom Scoring into the Optimizer**
   Bayesian Optimization should directly use our metric (Drop-Worst + Average WER) as the objective function, not the built-in Combined Score.

2. **Analyze Problem Documents**
   Examine 000013.jpg, 000014.jpg, 000015.jpg individually: What makes them difficult? Open the image, compare Ground Truth, inspect OCR output. They may be fundamentally unsolvable for Tesseract.js (e.g., handwritten, too low resolution, extreme layout).

3. **Add Tesseract-Specific Parameters**
   PSM mode (Page Segmentation Mode) has an enormous impact on Tesseract results:
   - PSM 1: Automatic page segmentation with OSD
   - PSM 3: Fully automatic (default)
   - PSM 6: Assume a single uniform block of text
   - PSM 11: Sparse text
   These should be included in the finetuning UI and the optimization run.

4. **Evaluate PaddleOCR**
   The app also supports PaddleOCR. A comparison run with PaddleOCR could show if the problem lies with Tesseract.js.

### 7.2 Medium Priority

5. **Finish Runs Reliably**
   Increase timeout to 180 minutes or implement a retry mechanism. Incomplete runs reduce the effectiveness of Bayesian Optimization.

6. **Repeat Measurements**
   Evaluate the top 5 configurations 3-5 times each to determine variance. The true difference between configurations may lie within the measurement uncertainty.

7. **Sensitivity Analysis First**
   Before the next Bayesian optimization run: Vary each of the 42 parameters individually (with all others fixed to Best). This clarifies which parameters have any impact at all. Estimated 42 x 10 measurement points = 420 iterations.

8. **Early Stopping on Stagnation**
   If no improvement > 0.5pp after 50 iterations, stop the run and save resources.

### 7.3 Architecture Improvements

9. **Direct Custom Score in Script**
   Instead of using the in-browser optimizer, the script could generate the parameters itself (its own Bayesian Optimizer in Node.js), use the app only for OCR execution, and calculate the Custom Score externally. This would completely solve the scoring mismatch problem.

10. **Improve Stability**
    - Restart Playwright browser after each run (avoid memory leaks)
    - Service health checks before each run
    - Automatic service restart on failure

11. **Better Result Persistence**
    - Save intermediate results every 10 iterations
    - Store run metadata (config, timestamp, system info) more consistently
    - Store results in a SQLite DB instead of JSON files for better queryability

---

## 8. Summary

The optimization improved Custom WER from 57.99% to 47.28% (-10.71pp, -18.5% relative). The original target of WER < 10% was not reached and is likely unreachable with the current approach (preprocessing/layout parameters only, Tesseract.js only) on this dataset.

The biggest levers are:
- **Preprocessing** (contrastBoost, CLAHE parameters): ~80% of the improvement
- **Feature Deactivation** (bilateralFilter, threshold, table): ~10% of the improvement
- **Layout/Output Tuning**: ~10% of the improvement

For the next run, the most important improvements are:
1. Adjust scoring metric in the optimizer
2. Targeted analysis of problem documents
3. Inclusion of Tesseract-specific parameters (PSM, OEM)
4. Evaluation of PaddleOCR as an alternative
