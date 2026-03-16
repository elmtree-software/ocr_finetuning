# OCR Finetuning Technical Documentation

The OCR Finetuning tool provides a lightweight, browser-based workflow for preparing Ground Truth (GT) and systematically evaluating OCR parameters.

## Architecture

The system consists of three main subsystems:

1.  **Frontend (Vue.js):** The primary user interface located at `frontend/ocr_finetuning.html`. It handles OCR execution (via Tesseract.js and ONNX Runtime), parameter tuning logic, and interactive GT generation.
2.  **Node.js Sidecar (WebSocket):** Listens on `ws://127.0.0.1:8766`. Its primary role is to bridge the browser environment with the local filesystem, allowing the application to persist tuning run artifacts to `ocr_trainingdata/runs/`.
3.  **Local Model Server (HTTP):** A simple static server running at `http://127.0.0.1:8767/models/`. It serves local OCR model files (e.g., ONNX models for PaddleOCR) to the frontend, bypassing CORS and allowing local-only model execution.

## Key Features

### Ground Truth Generation
- **Manual Layout Support:** Defines macro-regions (Header, Address, Meta, Body, Footer) to structure document content.
- **AI-Assisted GT:** Leverages an optional LM Studio endpoint (OpenAI-compatible) to perform "clean" text extraction from image crops, which a human can then verify and correct.
- **Formats:** Exports to JSON (`elmtree-gt/v2` schema) and plain text (`.txt`).

### Interactive Finetuning
- **Parameter Space:** Allows adjusting CLAHE (contrast enhancement), DPI scaling, and OCR engine-specific parameters.
- **Automated Loops:** Runs multiple OCR passes against Ground Truth images to calculate CER (Character Error Rate) and WER (Word Error Rate).
- **Visualization:** Displays diffs between predicted text and Ground Truth to highlight specific failure patterns.

## Configuration

- **LM Studio Endpoint:** Read from the `ocrfinetuning.lmstudio.endpoint` key in `localStorage`. If missing, it defaults to the `VITE_LMSTUDIO_ENDPOINT` environment variable or `http://127.0.0.1:1234/v1`.
- **Sidecar Port:** Configurable via `SIDECAR_PORT` environment variable (default: `8766`).
- **Model Server Port:** Configurable via `MODEL_SERVER_PORT` environment variable (default: `8767`).

## Data Storage

- **Ground Truth:** Saved as `.gt.json` (structured) or `.txt` (raw text).
- **Tuning Runs:** Saved under `ocr_trainingdata/runs/` as JSON files containing the parameter configuration and the resulting metrics.
- **Optimization Configs:** Stored in `ocr_optimization/configs/` for use with the headless optimization scripts.

## Setup for Development

To start the full development environment:
```bash
bash scripts/start_all.sh
```

To run only the backend services:
```bash
bash scripts/start_node_backend.sh
```

To preview a production build of the frontend:
```bash
bash scripts/start_local_webserver.sh
```
