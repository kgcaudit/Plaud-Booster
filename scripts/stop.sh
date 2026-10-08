#!/usr/bin/env bash
pkill -f "python -m app.server" && echo "작업대를 껐습니다" || echo "켜져 있지 않습니다"
