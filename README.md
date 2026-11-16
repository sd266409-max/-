# 🐉 블록 드래곤 헌터 서버

## 폴더 구조
```
block-dragon-hunter/
├─ package.json
├─ server.js          ← 서버 (정적 파일 + WebSocket 멀티플레이)
├─ admins.json        ← (선택) 추가 관리자 목록
└─ public/
   └─ index.html      ← 게임 파일
```

## 실행
```bash
npm install
npm start
```
브라우저에서 http://localhost:3000 접속 → 왼쪽 위 **🌐 접속 (목록)** 버튼 → 서버 주소가 자동으로 입력되어 있으니 **연결**.
(같은 서버에서 페이지를 열면 자동으로 연결을 시도합니다.)

## 환경 변수
| 이름 | 기본값 | 설명 |
|---|---|---|
| PORT | 3000 | 서버 포트 |
| MAX_PLAYERS | 50 | 최대 동시 접속자 |

## 추가 관리자 (선택) — admins.json
```json
{ "민수": { "code": "ABC234", "rank": 1 } }
```
rank: 1 수습 / 2 상급 / 3 총관리자

## 통신 규약
- 클라 → 서버: `state`, `gate`, `chat`
- 서버 → 클라: `welcome`, `join`, `sync`, `leave`, `gates`, `chat`

## 배포 참고
WebSocket 상시 연결이 필요하므로 Render, Railway, Fly.io, VPS 같은 "계속 켜져 있는" 서버에 올려야 합니다.
(Vercel / Netlify 같은 서버리스에서는 동작하지 않습니다.) HTTPS 로 서비스하면 클라이언트가 자동으로 wss:// 를 사용합니다.
