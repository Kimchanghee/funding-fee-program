#!/bin/bash
# funding-fee-program: production server + cloudflare quick tunnel
set -e

CLOUDFLARED="/c/Users/HOME/AppData/Local/Microsoft/WinGet/Packages/Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe/cloudflared.exe"
PROJECT_DIR="d:/Dithub/funding-fee-program"
PORT=3000
TUNNEL_LOG="/tmp/cloudflared-tunnel.log"

cd "$PROJECT_DIR"

# Kill existing processes
taskkill //F //IM node.exe 2>/dev/null || true
sleep 2

# Start production server in background
echo "[1/2] Starting production server on port $PORT..."
npm start &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w '' http://localhost:$PORT 2>/dev/null; then
    echo "[1/2] Server ready on localhost:$PORT"
    break
  fi
  sleep 1
done

# Start quick tunnel
echo "[2/2] Starting Cloudflare Quick Tunnel..."
"$CLOUDFLARED" tunnel --url http://localhost:$PORT 2>&1 | tee "$TUNNEL_LOG" &
TUNNEL_PID=$!

# Wait for tunnel URL
echo "Waiting for tunnel URL..."
for i in $(seq 1 30); do
  URL=$(grep -o 'https://[a-z-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
  if [ -n "$URL" ]; then
    echo ""
    echo "========================================"
    echo "  TUNNEL URL: $URL"
    echo "========================================"
    echo ""
    break
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  echo "ERROR: Failed to get tunnel URL"
  exit 1
fi

# Keep running
echo "Press Ctrl+C to stop both server and tunnel"
wait
