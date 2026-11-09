# pipeline/ — v2 · 셀피쉬클럽이 실제로 돌리는 코드

> 카카오 채널 문의 → 가리기 → 맥락 읽기 → AI 초안 → 슬랙 카드 → **사람이 버튼** → 발송.
> 개인정보 · 비밀값 · 채널 ID · 운영자 이름 · 우리 정책 원문만 걷어내고, 구조와 코드는 운영 저장소 그대로예요 (2026-11-09).
> AX 살롱 투표는 2등이었지만, 응원해 주신 마음에 감사해서 공개해요. 저희 맥 · 카카오 채널 · 슬랙 기준으로 짠 코드라 **안 돌아가는 자리가 있으면 각자 버전에 맞춰 고쳐 쓰세요.** 멈춘 화면을 Claude Code에 붙여 넣고 「여기서 멈춰, 고쳐 줘」라고 하면 돼요.

## 받으면 10분 안에

```bash
cd pipeline
npm install
npx playwright install chromium        # 카카오를 읽을 브라우저 (한 번만)
npm run check                          # 슬랙 · 카카오 없이 「정책 → 초안」 한 바퀴. 가상 정책(policy/answers.sample.md)으로 돌아요
```

`npm run check`가 초안 JSON을 찍으면 뼈대는 다 돌아가는 거예요. 그다음:

```bash
cp ../.env.example ../.env.local       # 키트 루트에. 값은 직접 넣어요 (슬랙 토큰 2개 · 채널)
npm run cx:sample                      # 가짜 문의 1건 → 초안 → 슬랙 카드. 버튼 세 개를 눌러 보세요
npm run login                          # 창이 뜨면 카카오에 직접 로그인 (비밀번호는 어디에도 저장 안 함)
npm run cx                             # 내 채널의 안 읽은 문의를 한 번 읽어 카드로
npm run cx:watch                       # 5분마다 (맥 자동 시작은 launchd/)
```

실제 발송은 `CX_SEND_ENABLED=false`로 **꺼진 채** 시작해요. 카드에서 「이대로 보내기」를 눌러도 기록만 남아요. 며칠 써 보고 `true`로 바꾸세요.

> **초안 AI** — `CX_AI_PROVIDER=cli`(기본)는 터미널의 `claude` 명령(Claude Code CLI)을 써요. 데스크톱 앱만 있고 CLI가 없으면 `npm i -g @anthropic-ai/claude-code`로 설치하거나, `api`로 바꾸고 `ANTHROPIC_API_KEY`를 넣어요. `claude`가 없으면 초안기는 멈추지 않고 모든 문의를 「확인 필요」 카드로 올려요.

## 파일이 곧 구조도

```
pipeline/
├── run.js                 한 바퀴: 수집 → 초안 → 카드 → 버튼 대기.  --watch  --sample  --limit N  --show
├── login.js               카카오 로그인 창 (사람이 직접). 세션은 auth-state/ 에 (깃 제외)
├── filters.json           메뉴 버튼 이름 · 자동 답장 첫 문장 — 내 채널에 맞게 고침
├── src/
│   ├── config.js          키트 루트 .env.local 읽기 · 경로 · 필요한 값 검사
│   ├── sources/kakao.js   관리자 화면 읽기 (Playwright · 안 읽은 방만 · 새 문의/앞선 대화 가르기 · 세션 만료 감지 · 답 보내기)
│   ├── sources/gmail.js   틀만 — 새 채널 붙이는 법의 예
│   ├── mask.js            이름 · 번호 · 이메일 · 긴 숫자 · 금액 가리기 (AI 와 슬랙이 보기 전에)
│   ├── draft.js           정책 문서 + 최근 보낸 답 10건 → 초안 JSON (needsHuman · category · summary · contextSummary · draft · reason) · 새는 말 검사
│   ├── deliver.js         초안 → 슬랙 카드 → 기록. 실패해도 문의를 잃지 않음 (다시 올릴 목록)
│   ├── slack.js           카드 · 버튼(이대로 · 고쳐서 · 건너뛰기) · 상태 갱신 · 운영 알림
│   ├── store.js           카드 · 결정 기록 (cx-data/state.json, 깃 제외)
│   ├── filters.js         filters.json → 정규식
│   ├── status.js          대시보드용 상태 한 줄 (Supabase, 선택)
│   └── providers/cli.js · api.js   Claude Code 구독(claude -p) / Claude API
├── tools/
│   ├── check.js           받은 직후 점검 — 정책 → 초안 한 바퀴
│   ├── extract-history.js · summarize-history.js   보낸 답 이력 뽑기(가린 사본) → cx-policy-from-history 스킬 재료
│   └── debug-selectors.js · debug-grid.js   카카오 화면이 바뀌었을 때 선택자 찾기
├── briefing.mjs           매일 9시 아침 브리핑 (어제 카드 · 답 안 한 것 · 제안 한 줄)
├── learn.mjs              일요일 22시 주 1회 학습 → 정책 수정안 PR (사람이 Merge)
└── launchd/               맥 로그인 시 자동 시작 · 해제
```

문의 하나가 지나가는 아홉 칸은 [`docs/02_구조_한_장.md`](../docs/02_구조_한_장.md). 바꿔 끼울 곳은 `sources/kakao.js`의 **읽기(collect · checkAnswered)**와 **보내기(send)**뿐이에요.

## 내 것으로 바꾸는 순서

1. **정책 문서** — `START_HERE.md` 프롬프트 A(`cx-interview`)로 `policy/answers.md`를 만들면 초안기가 샘플 대신 그 파일을 읽어요. 보낸 답이 쌓여 있으면 `npm run history` → `cx-policy-from-history` 스킬.
2. **새면 안 되는 말** — `policy/leak-words.example.json`을 복사해 `policy/leak-words.json`에 우리 도구 · 업체 이름을 넣어요.
3. **필터** — `filters.json`에 내 채널의 메뉴 버튼 이름과 자동 답장 첫 문장을 넣어요. 안 넣으면 메뉴 클릭이 새 문의로 올라와요.
4. **우리 이름** — `.env.local`의 `CX_BRAND_NAME`. 초안 프롬프트 첫 줄 「당신은 ○○의 CX 담당자입니다」에 들어가요.
5. **카드 채널** — 슬랙 앱 만들기 → Socket Mode 켜기 → Bot Token(`xoxb-`) · App Token(`xapp-`) → `chat:write` · `channels:read` 권한 → 카드 채널에 초대. 디스코드 · 텔레그램으로 바꾸려면 `src/slack.js` 한 파일.

## Playwright가 아니어도 돼요 — 에고 라이트 · Aside

저희는 카카오 관리자 화면을 읽고 답을 입력하는 데 Playwright를 써요(무료 · 맥 · 윈도우 · 창 없이 밤에도). 브라우저를 대신 움직이는 도구는 바꿔 끼워도 돼요. 바뀌는 건 `sources/kakao.js`의 세 함수뿐이에요.

| 도구 | 성격 | 이런 분께 | 코드 변경 |
|---|---|---|---|
| **Playwright** (지금) | 뒷방에서 창 없이 일하는 직원. 5분마다 자동 | 24시간 자동으로 돌리고 싶을 때 | 0 |
| **ego lite** | 내 옆에서 화면을 같이 보는 브라우저. 로그인된 내 계정 그대로, Space라 내 탭 · 마우스 안 건드림 | 맥에서 Claude Code를 쓰고, 로그인 풀림을 눈으로 보고 싶을 때 | `$$eval` → `evaluate` 식으로 세 함수 반나절 |
| **Aside** | 로그인된 사이트에서 일하는 AI 브라우저. `aside repl`은 Playwright 호환 | 윈도우거나, 코드 없이 「읽어 와」로 시작하고 싶을 때 | 거의 그대로 (호출당 120초 제한) |

둘 다 앱에 로그인해 둔 세션을 CLI가 그대로 쓰는 걸 확인했어요. 비교는 [`docs/04_다른_채널_다른_도구.md`](../docs/04_다른_채널_다른_도구.md).

## 넘지 않는 선 (코드에 박혀 있는 것)

- **읽기 전용으로 시작** — 발송은 `CX_SEND_ENABLED=true`로 바꿔야 나가요. `--sample`은 절대 안 보내요.
- **마지막 버튼은 사람** — `send()`는 슬랙 버튼 핸들러에서만 불려요. 전량 자동 발송 경로가 없어요.
- **AI가 보기 전에 가려요** — `draft.js`는 `maskText()`를 거친 글만 모델에 보내요. 원본은 카카오 관리자 화면에만.
- **근거 없으면 안 써요** — 정책에 없으면 `needsHuman: true`. 내부 용어가 섞이면 초안을 비우고 사람에게.
- **비밀번호는 저장 안 함** — 로그인은 사람이 창에서. 세션 폴더(`auth-state/`) · 기록(`cx-data/`)은 깃이 무시해요.
- **문의를 잃지 않아요** — 카드를 못 올리면 다시 올릴 목록에 남겨 다음 바퀴에 먼저 올려요.

## 셀피쉬클럽 운영 코드에서 걷어낸 것

| 뺀 것 | 왜 | 대신 |
|---|---|---|
| 실제 답변 정책 2판 (`answers.md`) | 우리 CX 노하우 전부(환불 기한 · 가격 · 운영시간 · 121건의 표준 문장) | 가상 커뮤니티 샘플 `policy/answers.sample.md` + 발췌 `examples/selfishclub/` |
| 내부 도구 목록 (`leak-words.json`) | 우리 기술 스택이 그대로 보여요 | `policy/leak-words.example.json` |
| 마이페이지 챗봇 조각 5개 (worker · bridge · facts-check · geo-check · status) | 카카오 CX가 아니라 우리 사이트 내부 | 안 올려요 |
| 카카오 채널 ID · 슬랙 채널 ID · 맥 경로 · 운영자 이름 | 개인정보 · 우리 환경 | 전부 `.env.local` 값으로 · 「운영자」 |
| 카카오 메뉴 버튼 · 자동 답장 목록 | 우리 채널 것 | `filters.json` (내 것으로 바꿈) |

## 겪은 것

- 처음 돌리고 얼마 안 돼 멈췄는데, AI가 아니라 **카카오 로그인 세션**이 며칠마다 풀린 거였어요. 지금은 살아 있는 브라우저 폴더로 세션을 갱신하고, 풀리면 슬랙에 한 줄 와요.
- 방 단위로 중복을 막았더니 같은 방의 두 번째 문의가 영영 안 올라왔어요. 지금은 「방 + 새 문의 지문」이 카드 열쇠예요.
- 카드를 못 올리면 그 방은 이미 읽음이라 다음 바퀴에 안 보여요. 지금은 다시 올릴 목록에 남겨요.
- 더 보기: [`docs/03_우리가_겪은_실패.md`](../docs/03_우리가_겪은_실패.md)

## 이용 조건

[`LICENSE`](../LICENSE)와 같아요. 개인 학습용 또는 조직 내 사용만 허용해요. 그 밖의 용도(판매 · 유료 강의 · 컨설팅 · 교육 자료 · 재배포)는 허용하지 않아요. 소개할 땐 출처 한 줄: `셀피쉬클럽 CX 스타터 키트에서 시작했어요`.
