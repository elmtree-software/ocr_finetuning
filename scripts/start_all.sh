#!/bin/bash
# Start all services (Node backend + Frontend dev server)
# Press Ctrl+C to stop all services

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."

echo "=========================================="
echo "  OCR Finetuning - Starting All Services"
echo "=========================================="
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Stopping all services..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
    echo "All services stopped."
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start Node backend
echo "[1/2] Starting Node Backend (backend)..."
cd "$PROJECT_ROOT/backend"
npm run dev &
BACKEND_PID=$!

# Give backend a moment to start
sleep 2

# Start Frontend
echo "[2/2] Starting Frontend (Vite dev server)..."
cd "$PROJECT_ROOT/frontend"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "=========================================="
echo "  Services running:"
echo "  - Backend:  ws://localhost:8766"
echo "  - Frontend: http://localhost:5173"
echo ""
echo "  Press Ctrl+C to stop all services"
echo "=========================================="

# Wait for both processes
wait $BACKEND_PID $FRONTEND_PID
