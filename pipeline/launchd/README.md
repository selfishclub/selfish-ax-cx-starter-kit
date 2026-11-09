# 맥 자동 시작

명령을 직접 치지 않아도 맥이 알아서 돌려 줘요. 스크립트를 한 번 실행해 두면 돼요.

| 무엇 | 언제 | 끄면 |
|---|---|---|
| 수집기 (`pipeline/run.js --watch`) | 맥에 로그인하면 바로. 죽으면 60초 뒤 다시. `CX_WATCH_MINUTES`분마다 카카오 확인 | 카카오 문의가 슬랙 카드로 안 와요 |
| 아침 브리핑 (`pipeline/briefing.mjs`) | 매일 오전 9시. 자고 있었으면 깨어난 뒤 | 슬랙에 브리핑이 안 올라와요 |
| 주 1회 학습 (`pipeline/learn.mjs`) | 일요일 밤 10시 | 정책 수정안 PR이 안 올라와요 (직접 `npm run learn`) |

카카오 로그인은 며칠마다 풀려요. 풀리면 운영 알림 채널에 「로그인이 풀렸어요」가 한 번 올라오고, `pipeline` 폴더에서 `npm run login`으로 창을 열어 다시 로그인하면 알아서 이어져요.

## 등록하기 전에 (한 번만)

1. 키트 루트에 `.env.local`이 있고 `KAKAO_CHANNEL_ID` · `SLACK_BOT_TOKEN` · `SLACK_APP_TOKEN` · `SLACK_CX_CHANNEL`이 채워져 있어야 해요.
2. `pipeline` 폴더에서 `npm install`과 `npx playwright install chromium`을 끝냈어야 해요.
3. `npm run login`으로 카카오에 한 번 로그인해 뒀어야 해요.

## 등록 · 해제 (키트 루트에서)

```bash
bash pipeline/launchd/install.sh
```

```bash
bash pipeline/launchd/uninstall.sh
```

## 잘 돌고 있는지 보기

- 기록: `~/Library/Logs/cx-starter-kit/` — 「카카오: N건」 「초안 완료 → 슬랙 발송」이 찍혀요.
- 슬랙 카드 채널에 카드가 오고, 운영 알림 채널에 아침 9시 브리핑이 오면 정상이에요.

## 알아둘 것

- 맥이 **잠들어 있는 동안에는** 수집기도 쉬어요. 24시간 돌리려면 잠자기를 끄거나 `caffeinate`를 써요.
- 초안은 `CX_AI_PROVIDER=cli`면 Claude Code 구독을 써요. 문의가 없으면 쓰는 것도 없어요.
- 되돌리기는 해제 명령 한 줄이에요. 맥의 다른 설정은 건드리지 않아요.
