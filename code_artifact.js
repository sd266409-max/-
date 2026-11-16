// ============================================================================
// 블록 드래곤 헌터 (Block Dragon Hunter) - 전용 WebSocket 멀티플레이 서버
// 실행 방법:
//   1. Node.js 설치 후 터미널에서 `npm init -y && npm install ws` 실행
//   2. 같은 폴더에 `server.js`와 게임 파일(`block-dragon-hunter.html`) 배치
//   3. `node server.js` 실행 후 브라우저에서 `http://localhost:3000` 접속
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'block-dragon-hunter.html');

// ----------------------------------------------------------------------------
// 1. 기본 관리자 계정 검증 테이블 (클라이언트와 동일한 권한 동기화)
// ----------------------------------------------------------------------------
const BASE_ADMINS = {
  '선우': { code: '53NFUW', rank: 3 },
  '선준': { code: '6LL8EJ', rank: 3 },
  '학준': { code: 'FRF42Z', rank: 2 },
  '진우': { code: 'RFWM6N', rank: 2 },
  '안녕': { code: 'CJGGNY', rank: 1 }
};

function verifyAdminRank(nick, code) {
  const n = String(nick || '').trim();
  const c = String(code || '').trim().toUpperCase();
  if (BASE_ADMINS[n] && BASE_ADMINS[n].code === c) {
    return BASE_ADMINS[n].rank;
  }
  return 0;
}

// ----------------------------------------------------------------------------
// 2. HTTP 정적 파일 서버 (게임 HTML 파일 제공 + 상태 확인 API)
// ----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  try {
    // 서버 상태 확인용 엔드포인트
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'ok',
        players: players.size,
        uptime: Math.floor(process.uptime())
      }));
      return;
    }

    // 기본 접속 시 게임 HTML 파일 반환
    if (req.url === '/' || req.url === '/index.html' || req.url === '/block-dragon-hunter.html') {
      fs.readFile(HTML_FILE, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('block-dragon-hunter.html 파일을 server.js와 같은 폴더에 넣어주세요.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    console.error('[HTTP Error]', err);
    res.writeHead(500);
    res.end('Internal Server Error');
  }
});

// ----------------------------------------------------------------------------
// 3. WebSocket 실시간 멀티플레이 동기화 서버
// ----------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

// 접속 중인 플레이어 상태 저장소: Map<playerId, PlayerState>
const players = new Map();
// 4대 성문(북, 동, 남, 서) 서버 공용 상태
const gates = { N: true, E: true, S: true, W: true };

let nextPlayerId = 1;

// 특정 클라이언트를 제외한 모든 접속자에게 브로드캐스트
function broadcast(payload, excludeId = null) {
  const raw = JSON.stringify(payload);
  for (const [id, p] of players.entries()) {
    if (id !== excludeId && p.ws.readyState === 1) {
      p.ws.send(raw);
    }
  }
}

// 전체 접속자에게 브로드캐스트
function broadcastAll(payload) {
  broadcast(payload, null);
}

wss.on('connection', (ws, req) => {
  const id = 'P_' + (nextPlayerId++);
  const ip = req.socket.remoteAddress || 'unknown';

  const playerState = {
    id,
    ws,
    nick: '게스트',
    rank: 0,
    lv: 1,
    x: 0,
    y: 0,
    z: 0,
    face: 0,
    sword: 0,
    armor: 0,
    god: false,
    supGear: false,
    adminGun: '',
    riding: false,
    dragR: 0,
    dragEl: '',
    lastPing: Date.now()
  };

  players.set(id, playerState);
  console.log(`[접속] ${id} (${ip}) - 현재 동시 접속자: ${players.size}명`);

  // 1) 신규 접속자에게 자신의 ID, 현재 접속자 목록, 성문 상태 전송
  const snapshotList = [];
  for (const [pid, p] of players.entries()) {
    if (pid !== id) {
      const { ws: _ignore, ...publicData } = p;
      snapshotList.push(publicData);
    }
  }

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    players: snapshotList,
    gates
  }));

  // 2) 기존 유저들에게 새 플레이어 입장 알림
  const { ws: _ignore, ...myPublic } = playerState;
  broadcast({ type: 'join', player: myPublic }, id);

  // 3) 클라이언트 메시지 처리
  ws.on('message', (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());
      playerState.lastPing = Date.now();

      switch (msg.type) {
        // 위치, 장비, 드래곤 상태 실시간 업데이트
        case 'state': {
          const verifiedRank = verifyAdminRank(msg.nick, msg.code);
          playerState.nick = String(msg.nick || '게스트').slice(0, 12);
          playerState.rank = verifiedRank > 0 ? verifiedRank : (Number(msg.rank) || 0);
          playerState.lv = Math.max(1, Math.min(1000, Number(msg.lv) || 1));
          playerState.x = Number(msg.x) || 0;
          playerState.y = Number(msg.y) || 0;
          playerState.z = Number(msg.z) || 0;
          playerState.face = Number(msg.face) || 0;
          playerState.sword = Number(msg.sword) || 0;
          playerState.armor = Number(msg.armor) || 0;
          playerState.god = !!msg.god;
          playerState.supGear = !!msg.supGear && playerState.rank >= 3;
          playerState.adminGun = playerState.rank >= 3 ? String(msg.adminGun || '') : '';
          playerState.riding = !!msg.riding;
          playerState.dragR = Number(msg.dragR) || 0;
          playerState.dragEl = String(msg.dragEl || '');
          break;
        }

        // 채팅 및 관리자 전체 공지
        case 'chat': {
          const text = String(msg.text || '').trim().slice(0, 120);
          if (!text) break;
          const isNotice = !!msg.notice && playerState.rank >= 3;
          broadcastAll({
            type: 'chat',
            id,
            nick: playerState.nick,
            rank: playerState.rank,
            text,
            notice: isNotice
          });
          break;
        }

        // 성문 개폐 동기화 (N, E, S, W 또는 ALL)
        case 'gate': {
          if (msg.gate === 'ALL' && playerState.rank >= 3) {
            const openState = !!msg.open;
            gates.N = gates.E = gates.S = gates.W = openState;
          } else if (['N', 'E', 'S', 'W'].includes(msg.gate)) {
            gates[msg.gate] = typeof msg.open === 'boolean' ? msg.open : !gates[msg.gate];
          }
          broadcastAll({ type: 'gates', gates, by: playerState.nick });
          break;
        }

        // 공격·드래곤 필살기 이펙트 중계
        case 'fx': {
          broadcast({
            type: 'fx',
            id,
            kind: String(msg.kind || 'ult'),
            el: String(msg.el || ''),
            x: Number(msg.x) || 0,
            y: Number(msg.y) || 0,
            z: Number(msg.z) || 0
          }, id);
          break;
        }
      }
    } catch (err) {
      // 잘못된 JSON 패킷 무시
    }
  });

  // 4) 연결 종료 처리
  ws.on('close', () => {
    players.delete(id);
    console.log(`[퇴장] ${id} (${playerState.nick}) - 남은 접속자: ${players.size}명`);
    broadcastAll({ type: 'leave', id, nick: playerState.nick });
  });

  ws.on('error', () => {
    players.delete(id);
  });
});

// ----------------------------------------------------------------------------
// 4. 틱 루프 (초당 15회 전체 플레이어 위치/상태 브로드캐스트 & 타임아웃 정리)
// ----------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  const list = [];

  for (const [id, p] of players.entries()) {
    // 20초 이상 응답 없는 유령 세션 정리
    if (now - p.lastPing > 20000) {
      try { p.ws.terminate(); } catch (_) {}
      players.delete(id);
      broadcastAll({ type: 'leave', id, nick: p.nick });
      continue;
    }
    const { ws: _ignore, ...publicData } = p;
    list.push(publicData);
  }

  if (list.length > 0) {
    broadcastAll({ type: 'sync', players: list });
  }
}, 66);

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🐉 블록 드래곤 헌터 멀티플레이 서버 가동 중!`);
  console.log(`🌐 접속 주소: http://localhost:${PORT}`);
  console.log(`====================================================`);
});