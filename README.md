# OCR Finetuning

A standalone application for OCR parameter optimization, ground truth generation, and automated evaluation.

## Overview

Components:
- `frontend/`: Vue.js application (`/ocr_finetuning.html`) for visual finetuning and Ground Truth (GT) generation.
- `backend/`: Node.js sidecar (WebSocket + Model Server).
- `scripts/`: Tools for evaluation, tuning, model setup, and local orchestration.
- `ocr_trainingdata/`: Storage for training datasets and saved experiment runs.
- `ocr_optimization/`: Configurations and results for agentic parameter optimization.

Standard Ports:
- Frontend: `http://localhost:5173/ocr_finetuning.html`
- WebSocket Sidecar: `ws://127.0.0.1:8766`
- Model Server: `http://127.0.0.1:8767/models/`

## Prerequisites

- Node.js `>=18`
- npm
- Optional: [LM Studio](https://lmstudio.ai/) (OpenAI-compatible endpoint for GT extraction helper functions)

## Quickstart

```bash
# Install dependencies
npm install
npm --prefix backend install
npm --prefix frontend install

# Install OCR models and assets
npm --prefix backend run models:ocr

# Start all services
bash scripts/start_all.sh
```

After starting, open in your browser: `http://localhost:5173/ocr_finetuning.html`

## Typical Workflows

### 1) Ground Truth Generation in the UI

1. Load images (Drag & Drop or File Picker).
2. For region-based GT: Select **Create GT JSON**.
3. For full text: Select **Create TXT Fulltext**.

**Result:**
- `*.gt.json` and `*.txt` files are generated and downloaded via the browser.

### 2) Interactive OCR Finetuning in the UI

1. Load images and their corresponding Ground Truth.
2. Configure parameters and number of iterations.
3. Start Tuning.
4. Save results to `ocr_trainingdata/runs/` via the Sidecar as needed.

### 3) Script-based Tuning

OCR Tuning (Bayesian Optimization):
```bash
node scripts/ocr_tuning.mjs --iterations 100 --output tuning_results.json
```

Layout Tuning:
```bash
node scripts/layout_tuning.mjs --iterations 80 --output layout_tuning_results.json
```

Playwright-based UI Optimization:
```bash
node scripts/ocr-optimize/run-tuning.mjs ocr_optimization/configs/run2_phase2a_preprocessing.json
```

### 4) Evaluation

```bash
node scripts/eval_ocr.mjs --dataset b-mod_lines/train.easy --limit 100
```

## Useful Commands

Start Backend only:
```bash
bash scripts/start_node_backend.sh
```

Start Backend with explicit environment variables:
```bash
bash scripts/run_server.sh
```

Frontend Build:
```bash
npm --prefix frontend run build
```

Preview a production build:
```bash
bash scripts/start_local_webserver.sh
```

## Further Documentation

- `documentation/ocr_finetuning.md`: Technical architecture and details.
- `scripts/README.md`: Detailed guide for utility scripts.
- `backend/models/README.md`: Information about OCR model assets.
