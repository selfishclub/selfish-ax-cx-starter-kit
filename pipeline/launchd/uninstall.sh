#!/bin/bash
# 맥 자동 시작 해제 — 등록한 셋(수집기·브리핑·학습)을 멈추고 설정 파일을 지운다. 키트 파일은 건드리지 않는다.
set -uo pipefail
for name in cx.starter-kit.collector cx.starter-kit.briefing cx.starter-kit.learn; do
  launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$name.plist"
done
echo "해제했습니다. 수집기는 꺼졌고, 브리핑과 학습은 더 이상 자동으로 돌지 않습니다."
