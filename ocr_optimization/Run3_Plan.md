# OCR Optimization — Plan Run 3: Validation & Generalization

## 0. Objective

Run 3 aims to demonstrate whether the Run 2 parameters (`Custom WER 34.85%` on 7 images) generalize to new document photos.

Core Principles:
- No more "apples-to-oranges" comparisons.
- Consistent metrics across all splits and configurations.
- Strict holdout (`test` set) that never enters the optimization loop.

---

## 1. Evaluation Protocol (fixed for all comparisons)

From Run 3 onwards, these metrics apply:
- `WER_mean`: Mean WER across **all** images in the split (Primary Metric).
- `WER_drop1`: WER with the worst-performing image dropped (Secondary Metric for robustness analysis).
- `CER_mean`: Mean CER (Secondary Metric).

Rule:
- Decisions (better/worse) are based only on `WER_mean`.
- `WER_drop1` is reported only for context, never as an optimization target.

---

## 2. Dataset Plan

Target Scope:
- 12–18 new images in addition to the existing 7.
- Focus on printed documents (primary use case).
- Handwriting only as a separate bucket (do not mix with print).

Mandatory Buckets (new images):
- Source: At least 3 sources (e.g., different smartphone, webcam/laptop, scanner app).
- Document Type: At least 4 types (letter, invoice/form, dense page, small text like label/business card).
- Capture Condition: At least 3 conditions (good/frontal, shadow/gradient, slight perspective, low contrast).

Ground Truth:
- Per image: `*.jpg|png`, `*.txt`, `*.gt.json`.
- Quality Check: Proofread each GT against the original image.

---

## 3. Split Strategy

Recommended split for the combined print dataset:
- `train`: 60%
- `val`: 20%
- `test`: 20%

Rules:
- Split **stratified** by source + document type + condition.
- `test` is fixed beforehand and not touched until the final comparison.
- If handwriting is included:
  - Either exclude it completely from optimization.
  - Or maintain it as a separate reporting track (`handwriting_report_only`).

Artifact:
- `ocr_optimization/configs/run3_split_manifest.json` with fixed assignment of each file to `train|val|test`.

---

## 4. Phase A — Pure Validation Without New Tuning

First, evaluate only; no optimization yet.

To compare:
- `Config A`: Run 2 best configuration.
- `Config B`: Conservative configuration (mean values).
- `Config C`: Current defaults.

Output per Config:
- `WER_mean`, `WER_drop1`, `CER_mean` on `train`, `val`, `test`.
- Per-document table for `test`.

Decision Rule after Phase A:
- If `Config A` is clearly best on `test` (at least `0.5` percentage points ahead of B and C): No major Run 3 tuning needed.
- If `Config B` is better on `test` than A: Overfitting risk confirmed, prioritize conservative direction.
- If A/B/C are close on `test` (`<0.5` pp): Consider Run 2 stable, perform only mini-tuning.

---

## 5. Phase B — Run 3 Tuning (only if necessary)

Optimization:
- Target Metric: `WER_mean` on `train`.
- Control Metric: `WER_mean` on `val` (log at every evaluation step).
- `test` remains untouched.

Search Space:
- Focus on known sensitive parameters:
  - `cannyLow`, `cannyHigh`
  - `regionPadding`, `internalPadding`
  - `detectionThreshold`
  - `minCapitalHeightPx`, `maxScale`
  - `clahe.tileSize`
- Vary PSM/Output parameters only finely around Run 2 values.

Early Stopping (Robust):
- `patience`: 12 validation evaluation points.
- `min_delta`: 0.3 percentage points (`WER_mean`).
- Stop only if no validation improvement > `min_delta` within `patience`.

Timeout/Cancellation:
- End run with documented status, do not silently discard.
- Mark incomplete runs explicitly (`incomplete=true`).

---

## 6. Stability Check of Final Candidates

For the top 3 configurations from Phase B:
- Re-evaluate each configuration 3 times (same split).
- Mean and range (`max-min`) for `WER_mean` on `val` and `test`.

Selection Rule:
- The winner is the configuration with the best **mean** `test.WER_mean`.
- In case of a tie (`<0.3` pp): The more stable configuration (smaller range) wins.

---

## 7. Decision Matrix

After Run 3:
- Case 1: `test.WER_mean` improves over Run 2 by >= `1.0` pp
  - Adopt new configuration as default.
- Case 2: Improvement < `1.0` pp, but more stable (lower range)
  - Optional adoption, mark as "more stable variant".
- Case 3: No gain on `test` or regression
  - Retain Run 2 configuration.

---

## 8. Technical To-dos Before Start

Status (as of 2026-03-01):
- [x] `run-tuning.mjs` extended:
  - Loading by split (`train|val|test`) from manifest.
  - Separate output of split metrics (`metricsBySplit`).
- [x] Unified result format:
  - per split: `werMean`, `werDrop1`, `cerMean`, `cerDrop1`, `perDocument`.
- [x] Helper script implemented:
  - `scripts/ocr-optimize/evaluate-config.mjs` for Phase A comparison (A/B/C).
- [x] Helper script implemented:
  - `scripts/ocr-optimize/generate-split-manifest.mjs` for stratified split generation.
- [~] Optional:
  - [x] Example `evaluate-config` input created: `ocr_optimization/configs/run3_evaluate_configs.example.json`
  - [x] `run3_split_manifest.json` generated from real image stock (`ocr_trainingdata`, 31 images, 19/6/6).

---

## 9. Concrete Run Order

1. Collect new images and finalize GT.
2. Create and freeze the split manifest.
3. Phase A: A/B/C comparison on all splits.
4. Decision: Is Run 3 tuning necessary?
5. If yes: Phase B with robust early stopping.
6. Top 3 stability check (3 repetitions).
7. Final decision via matrix (Section 7).
8. Final report with test set results.
