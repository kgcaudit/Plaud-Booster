#!/usr/bin/env bash
# 작업대 서버를 백그라운드로 켠다. 이미 켜져 있으면 아무것도 하지 않는다.
cd "$(dirname "$0")/.."
PORT="${PB_PORT:-8765}"
if curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/system"; then
  echo "작업대가 이미 켜져 있습니다: 포트 ${PORT}"
  exit 0
fi
mkdir -p data
setsid nohup python -m app.server >> data/server.log 2>&1 < /dev/null &
for _ in $(seq 1 30); do
  sleep 1
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/system"; then
    echo "작업대를 켰습니다: 포트 ${PORT} (아래 「포트」 탭에서 열 수 있습니다)"
    exit 0
  fi
done
echo "서버가 뜨지 않았습니다. data/server.log 를 확인하세요." >&2
exit 1
