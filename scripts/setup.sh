#!/usr/bin/env bash
# Codespace를 처음 만들 때 한 번: ffmpeg·파이썬 패키지 설치, 모델(약 1GB) 받기
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v ffmpeg >/dev/null; then
  sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg >/dev/null || echo "ffmpeg 설치 실패 — imageio-ffmpeg로 대신합니다"
fi
python -m pip install -q --upgrade pip
python -m pip install -q -r requirements-dev.txt
python -m app.engine setup models
echo "준비 완료 — bash scripts/start.sh 로 서버를 켭니다(Codespace에서는 자동)."
