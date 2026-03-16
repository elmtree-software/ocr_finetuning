# OCR Finetuning Utility Scripts

This directory contains utility scripts for managing models, performing offline tuning, and evaluating OCR performance outside of the browser UI.

## Getting Started: Starting Services

The easiest way to start the entire environment (frontend development server + backend sidecar) is:

```bash
bash scripts/start_all.sh
```

### Specialized Start Scripts

- **`scripts/start_node_backend.sh`**: Starts only the Node.js sidecar (WebSocket server and model server). Use this if you are serving the frontend via another method (e.g., Nginx) or just need the backend API.
- **`scripts/run_server.sh`**: A wrapper that allows passing explicit environment variables (like `SIDECAR_PORT`) to the backend.
- **`scripts/start_local_webserver.sh`**: Serves an existing production build (`frontend/dist`) using a simple HTTP server. Useful for verifying the final bundle.

## OCR Models and Assets

The application uses local OCR models to ensure privacy and low latency. These must be downloaded and installed before the first run.

```bash
# Install all default models (OpenCV + Paddle OCR ONNX)
npm --prefix backend run models:ocr
```

### Specific Model Management

- **`scripts/install_ocr_models.mjs`**: The underlying engine for model installation. It downloads pre-trained weights to `backend/models/`.
- **`scripts/sync-onnxruntime-web-assets.mjs`**: Copies the necessary WebAssembly binaries for ONNX Runtime from `node_modules` to `frontend/public/`. This is required for model execution in the browser.
- **`scripts/patch_tesseract_node_getcore.mjs`**: Optimizes how Tesseract.js loads its core in the Node.js environment.

## Evaluation and Tuning (Offline)

While the UI is great for interactive testing, large-scale optimization is better handled via scripts.

### Metric Evaluation
**`scripts/eval_ocr.mjs`**: Calculates CER and WER for a specific dataset split.
```bash
node scripts/eval_ocr.mjs --dataset b-mod_lines/train.easy --limit 100
```

### Headless Parameter Tuning
**`scripts/ocr_tuning.mjs`**: Uses Bayesian Optimization to find the best preprocessing parameters (CLAHE, contrast, etc.) by running thousands of OCR passes.
```bash
node scripts/ocr_tuning.mjs --iterations 100 --output tuning_results.json
```

**`scripts/layout_tuning.mjs`**: Specifically focuses on document layout parameters like NMS thresholds and reading order.
```bash
node scripts/layout_tuning.mjs --iterations 80 --output layout_tuning_results.json
```

### Advanced Optimization Pipeline
The `scripts/ocr-optimize/` directory contains tools for cross-category evaluation and split management:
- **`run-tuning.mjs`**: Orchestrates complex multi-phase tuning runs based on JSON configs.
- **`evaluate-config.mjs`**: Validates a specific parameter set against a test split to verify generalization.
- **`generate-split-manifest.mjs`**: Creates reproducible dataset splits from raw images and ground truth files.
