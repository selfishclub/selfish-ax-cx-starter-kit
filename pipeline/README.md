# pipeline/ — v2 자리

> **AX 살롱 VOL.01(2026-11-07)에서 1등 하면 여기에 실제 코드가 들어와요.**
> v1만으로도 `START_HERE.md` 프롬프트 B · C로 내 채널에 맞는 수집기를 Claude Code가 짜게 할 수 있어요. 저희도 그렇게 만들었어요.

## v2에 들어올 것

셀피쉬클럽이 실제로 돌리는 코드를 개인정보 · 비밀값 · 채널 ID · 회원 정보를 걷어내고 그대로 공개해요.

```
pipeline/
├── run.js                 수집 → 초안 → 카드 → 버튼 대기.  --sample  --watch  --limit N  --show
├── src/
│   ├── config.js          .env.local 읽기 · 경로
│   ├── store.js           카드 · 결정 기록 (cx-data/, 깃 제외)
│   ├── mask.js            이름 · 번호 · 이메일 · 긴 숫자 · 금액 가리기
│   ├── draft.js           정책 문서 + 최근 보낸 답 10건 → 초안(JSON 스키마: needsHuman · category · summary · contextSummary · draft · reason)
│   ├── deliver.js         초안 → 슬랙 카드 → 기록. 실패해도 문의를 잃지 않음(재시도 목록)
│   ├── slack.js           카드 · 버튼(이대로 · 고쳐서 · 건너뛰기) · 상태 갱신
│   ├── status.js          살아 있는지 (대시보드용)
│   ├── sources/kakao.js   카카오 채널 관리자 화면 읽기 (Playwright · 안 읽은 것만 · 새 문의/앞선 대화 가르기 · 세션 만료 감지)
│   ├── sources/gmail.js   틀만 (새 채널 붙이는 법의 예)
│   └── providers/cli.js · api.js   Claude Code 구독(API 키 없이) / Claude API
├── tools/extract-history.js · summarize-history.js   보낸 답 이력 뽑기(가린 사본) → cx-policy-from-history 재료
├── briefing.mjs           매일 9시 아침 브리핑 (슬랙)
├── learn.mjs              일요일 22시 주 1회 학습 → PR
├── launchd/               맥 로그인 시 자동 시작 · 해제
└── login.js               카카오 로그인 창 띄우기 (사람이 직접 로그인)
```

## 받으면 10분 안에

```bash
cp .env.example .env.local        # 값은 직접 넣기 (슬랙 토큰 2개 · 채널)
npm install
npm run cx:sample                 # 카카오 접속 없이 가짜 문의 1건 → 초안 → 슬랙 카드
```

카드가 뜨면 버튼 세 개를 눌러 보세요. 실제 발송은 `CX_SEND_ENABLED=false`로 꺼진 채 시작해요.

## v2 없이 v1로 가려면

`START_HERE.md`의 프롬프트 B(상황 · 할 일 · 의도 · 걱정)와 C(설계 승인 → 뼈대 → 샘플 한 바퀴)로, `docs/02_구조_한_장.md`와 `docs/03_우리가_겪은_실패.md`를 읽힌 채 Claude Code에 짜게 하면 돼요. 위 파일 구조를 그대로 요구해도 좋아요.
