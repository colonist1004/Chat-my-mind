# 💬 Chat My Mind

성격·말투·세계관을 마음대로 정한 **나만의 AI 캐릭터**와 대화하는 채팅 서비스입니다.
모바일과 PC 브라우저 어디서나 쓸 수 있고, 홈 화면에 앱처럼 설치(PWA)할 수 있습니다.
AI 는 Anthropic **Claude** 를 사용하며, 계정·캐릭터·대화는 모두 **서버에 저장**되어 어느 기기에서든 이어서 볼 수 있습니다.

## 기능

| 기능 | 내용 |
|---|---|
| 계정 | 회원가입·로그인, 초대 코드로 가입 제한, 비밀번호 변경, 첫 가입자는 관리자 |
| 캐릭터 만들기 | 이름, 사진/이모지, 한 줄 소개, 성격, 말투, 배경, 상황·세계관, 첫 메시지, 예시 대화, 태그 |
| 채팅 | 실시간 스트리밍 답변, `*행동*` 지문 표시, 다시 생성, 메시지 수정·삭제, 생성 중 멈추기(받은 부분 저장) |
| 대화 관리 | 캐릭터마다 여러 대화, 대화별 **유저 노트**(캐릭터가 항상 기억할 내용) |
| 내 페르소나 | 내 이름과 설명을 정하면 캐릭터가 그에 맞게 반응. `{{user}}`, `{{char}}` 치환 |
| 모델 설정 | Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5, 사고 깊이, 답변 길이, 최대 토큰 |
| 비용 보호 | 사용자당 하루 답변 수 제한, 허용 모델 지정, Claude API 키는 서버에만 보관 |
| 백업 | 캐릭터 파일 내보내기/가져오기, 내 데이터 전체 백업/복원, 서버 DB 백업 스크립트 |

## 배포

무료 서버(Oracle Cloud Always Free)에 올리는 방법은 **[DEPLOY.md](DEPLOY.md)** 에 단계별로 정리되어 있습니다.
요약하면 서버에서:

```bash
git clone https://github.com/colonist1004/Chat-my-mind.git && cd Chat-my-mind
cp .env.example .env && nano .env   # API 키, DOMAIN, INVITE_CODE 입력
docker compose up -d --build        # https://DOMAIN 으로 접속
```

## 로컬 개발

Node 22.13 이상 필요.

```bash
npm install
cp .env.example .env    # ANTHROPIC_API_KEY 입력 (DOMAIN 은 로컬에선 필요 없음)
npm run dev:server      # API 서버 → http://localhost:8787
npm run dev             # 화면 개발 서버 → http://localhost:5173 (같은 와이파이의 휴대폰에서도 접속 가능)
```

빌드된 화면까지 서버 하나로 띄우려면 `npm run build && npm start` 후 <http://localhost:8787>.

## 구조

```
server/
  index.js    API(로그인, 캐릭터, 대화, 스트리밍 답변, 백업)와 화면 제공
  ai.js       Claude API 호출(@anthropic-ai/sdk, 스트리밍·프롬프트 캐시·거절 시 대체 모델)
  prompt.js   캐릭터 정보 → 시스템 프롬프트
  db.js       SQLite(Node 내장) 테이블
  auth.js     비밀번호 해시(scrypt), 세션 쿠키, 시도 횟수 제한
  backup.js   실행 중 DB 백업
src/          화면(바닐라 JS + Vite): 로그인, 홈, 캐릭터 편집, 채팅, 설정
public/       PWA 매니페스트, 서비스 워커, 아이콘
Dockerfile, docker-compose.yml, Caddyfile   배포(자동 HTTPS)
```

## 환경 변수

`.env.example` 참고: `ANTHROPIC_API_KEY`, `DOMAIN`, `INVITE_CODE`, `ALLOW_SIGNUP`,
`DAILY_MESSAGE_LIMIT`, `DEFAULT_MODEL`, `ALLOWED_MODELS`, (선택) `PORT`, `DB_FILE`.
