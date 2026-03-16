#!/bin/bash
export SIDECAR_HOST=127.0.0.1
export SIDECAR_PORT=8766
cd "$(dirname "$0")/../backend"
npm run dev
