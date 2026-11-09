#!/bin/bash
# 맥 자동 시작 등록 — 사람이 직접 실행한다. (맥의 예약 실행 설정을 바꾸는 일이라 AI 가 대신 실행하지 않는다)
#
#   등록:  bash pipeline/launchd/install.sh      (키트 루트에서)
#   해제:  bash pipeline/launchd/uninstall.sh
#
# 무엇이 등록되나
#   1. 수집기 (pipeline/run.js --watch)  맥에 로그인하면 켜지고, 죽으면 다시 켜진다. CX_WATCH_MINUTES 분마다 카카오를 확인
#   2. 아침 브리핑 (pipeline/briefing.mjs) 매일 오전 9시에 한 번. 맥이 자고 있었다면 깨어난 뒤에 돈다
#   3. 주 1회 학습 (pipeline/learn.mjs) 일요일 밤 10시. 지난 7일 대화·카드 결정 → 정책 수정안 PR(cx-learn)
#
# 어디서 도나 — 이 키트 폴더. 키트 루트의 .env.local 을 읽는다.
#   필요한 값: SLACK_BOT_TOKEN · SLACK_APP_TOKEN · KAKAO_CHANNEL_ID
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"      # 키트 루트
PIPE="$ROOT/pipeline"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/cx-starter-kit"
NODE_BIN="$(command -v node)"
CLAUDE_DIR="$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)")"

case "$ROOT" in *".claude/worktrees"*) echo "임시 작업 폴더에서는 등록하지 않습니다. 키트 폴더에서 실행해주세요."; exit 1;; esac
[ -f "$ROOT/.env.local" ] || { echo "$ROOT/.env.local 이 없습니다. cp .env.example .env.local 로 만들고 값을 넣어주세요."; exit 1; }
grep -q '^KAKAO_CHANNEL_ID=.\+' "$ROOT/.env.local" || { echo ".env.local 에 KAKAO_CHANNEL_ID 가 없습니다."; exit 1; }
grep -q '^SLACK_BOT_TOKEN=.\+' "$ROOT/.env.local" || echo "참고: .env.local 에 SLACK_BOT_TOKEN 이 없어 브리핑과 수집기가 슬랙에 올리지 못합니다."
grep -q '^SLACK_APP_TOKEN=.\+' "$ROOT/.env.local" || echo "참고: .env.local 에 SLACK_APP_TOKEN 이 없어 수집기가 슬랙 버튼을 받지 못합니다."
[ -d "$PIPE/auth-state/kakao-profile" ] || echo "참고: 카카오 로그인 세션이 아직 없습니다. 등록 뒤 pipeline 폴더에서 npm run login 을 한 번 실행해주세요."

mkdir -p "$AGENTS" "$LOGS"

write_plist() { # 이름 · 스크립트 · 추가 설정 · (선택) 스크립트에 줄 옵션
  local extra=""; [ -n "${4:-}" ] && extra="<string>$4</string>"
  cat > "$AGENTS/$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>WorkingDirectory</key><string>$PIPE</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$PIPE/$2</string>$extra</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$CLAUDE_DIR:$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.log</string>
  $3
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$1.plist"
}

write_plist "cx.starter-kit.collector" "run.js" "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer>" "--watch"
write_plist "cx.starter-kit.briefing" "briefing.mjs" "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>"
write_plist "cx.starter-kit.learn" "learn.mjs" "<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict>"

echo "등록했습니다. 수집기는 지금부터 켜져 있고, 브리핑은 매일 오전 9시, 학습은 일요일 밤 10시입니다."
echo "기록: $LOGS"
echo "해제: bash pipeline/launchd/uninstall.sh"
