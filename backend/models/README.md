# Local OCR models (not committed)

This directory contains downloaded OCR assets that are intentionally not committed to Git.

## Install OCR assets

From repo root:

```bash
npm --prefix backend run models:ocr
```

Install only specific variants:

```bash
npm --prefix backend run models:ocr:opencv
npm --prefix backend run models:ocr:paddle
```

Installed files are placed under:

- `backend/models/opencv/`
- `backend/models/paddleocr-onnx/`

## Notes

- These assets are loaded by the local Node sidecar model server.
- After installing or updating models, restart the backend and refresh the frontend.
