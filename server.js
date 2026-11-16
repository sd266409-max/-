'use strict';

/**
 * 블록 드래곤 헌터 - 멀티플레이 서버
 *
 *  - public/ 폴더의 정적 파일(index.html)을 서빙
 *  - 같은 포트에서 WebSocket 멀티플레이 처리
 *      클라이언트 -> 서버 : state(내 상태, 초당 15회) / gate(성문 개폐) / chat(채팅·공지)
 *      서버 -> 클라이언트 : welcome / join / sync / leave / gates / chat
 *
 *  실행:  npm install  →  npm start   (기본 포트 3000)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 50;
const TICK_MS = 66; // 약 15Hz
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// 관리자 계정 (닉네임 + 코드가 맞아야 관리자 표시/공지 권한 인정)
//   rank 3 = 총관리자, 2 = 상급 관리자, 1 = 수습 관리자
//   추가 관리자는 admins.json 에 { "닉네임": { "code": "ABC123", "rank": 1 } } 형식으로 적으면 됩니다.
// ---------------------------------------------------------------------------
function loadExtraAdmins() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'admins.json'), 'utf8');
    const json = JSON.parse(raw);
    const out = {};
    for (const [nick, info] of Object.entries(json)) {
      if (info && typeof info.code === 'string' && [1, 2, 3].includes(info.rank)) {
        out[nick] = { code: info.code.trim().toUpperCase(), rank: info.rank };
      }
    }
    return out;
  } catch (_) {
    return {};
  }
}

const ADMINS = Object.assign({}, loadExtraAdmins(), {
  '선우': { code: '53NFUW', rank: 3 },
  '선준': { code: '6LL8EJ', rank: 3 },
  '학준': { code: 'FRF42Z', rank: 2 },
  '진우': { code: 'RFWM6N', rank: 2 },
  '안녕': { code: 'CJGGNY', rank: 1 },
});

function verifyRank(nick, code) {
  const info = ADMINS[nick];
  if (!info) return 0;
  return info.code === String(code || '').trim().toUpperCase() ? info.rank : 0;
}

// ---------------------------------------------------------------------------
// 입력 검증 도구
// ---------------------------------------------------------------------------
const num = (v, lo, hi, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const int = (v, lo, hi, d = 0) => Math.round(num(v, lo, hi, d));
// 클라이언트가 닉네임/공지를 innerHTML 로 그리기 때문에 태그 문자는 서버에서 제거
const cleanText = (v, max) =>
  String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>&]/g, '').trim().slice(0, max);
const cleanNick = (v) => cleanText(v, 12).replace(/["'`\\]/g, '').trim();

const DRAGON_ELEMENTS = new Set([
  '불', '얼음', '번개', '독', '땅', '바람', '암흑', '빛', '용암', '빙하', '전설의', '고대의',
]);
const ADMIN_DRAGONS = { '수호의': 1, '천왕의': 2, '창세의': 3 }; // 필요한 최소 관리자 등급

function cleanDragonEl(el, rank) {
  if (!el) return '';
  if (ADMIN_DRAGONS[el]) return rank >= ADMIN_DRAGONS[el] ? el : '';
  return DRAGON_ELEMENTS.has(el) ? el : '';
}

// ---------------------------------------------------------------------------
// 게임 상태
// ---------------------------------------------------------------------------
const players = new Map(); // id -> player
const gates = { N: true, E: true, S: true, W: true };

function newPlayer(ws) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    ws,
    joined: false, // 첫 state 를 받으면 true (그때 닉네임을 알 수 있음)
    alive: true,
    lastChat: 0,
    rateStart: 0,
    rateCount: 0,
    nick: '게스트', rank: 0, lv: 1,
    x: 0, y: 0, z: 0, face: 0,
    sword: 0, armor: 0, god: false, supGear: false, adminGun: '',
    riding: false, dragR: 0, dragEl: '',
  };
}

function view(p) {
  return {
    id: p.id, nick: p.nick, rank: p.rank, lv: p.lv,
    x: p.x, y: p.y, z: p.z, face: p.face,
    sword: p.sword, armor: p.armor, god: p.god, supGear: p.supGear, adminGun: p.adminGun,
    riding: p.riding, dragR: p.dragR, dragEl: p.dragEl,
  };
}

// 총관리자 비밀 성역(y≈120)에 있는 플레이어는 총관리자에게만 보임
const visibleTo = (viewer, p) => p.y <= 100 || viewer.rank >= 3;

function applyState(p, m) {
  p.nick = cleanNick(m.nick) || '게스트';
  p.rank = verifyRank(p.nick, m.code);
  p.lv = int(m.lv, 1, 1000, 1);
  p.x = num(m.x, -1000, 1000);
  p.y = num(m.y, -10, 200);
  p.z = num(m.z, -1000, 1000);
  p.face = num(m.face, -10, 10);
  p.sword = int(m.sword, 0, 9);
  p.armor = int(m.armor, 0, 7);
  p.god = !!m.god && p.lv >= 1000;
  p.supGear = p.rank >= 3 && !!m.supGear;
  p.adminGun = p.rank >= 3 && (m.adminGun === 'rapid' || m.adminGun === 'sniper') ? m.adminGun : '';
  p.riding = !!m.riding;
  p.dragEl = cleanDragonEl(m.dragEl, p.rank);
  p.dragR = p.dragEl ? int(m.dragR, 0, 8) : 0;
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj, exceptWs) {
  const data = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws !== exceptWs && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

// ---------------------------------------------------------------------------
// HTTP (정적 파일)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, players: [...players.values()].filter((p) => p.joined).length }));
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.close(1013, 'server full');
    return;
  }

  const p = newPlayer(ws);
  players.set(p.id, p);

  send(ws, {
    type: 'welcome',
    id: p.id,
    players: [...players.values()].filter((o) => o !== p && o.joined && visibleTo(p, o)).map(view),
    gates,
  });

  ws.on('pong', () => { p.alive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;

    // 초당 메시지 수 제한 (스팸 방지)
    const now = Date.now();
    if (now - p.rateStart > 1000) { p.rateStart = now; p.rateCount = 0; }
    if (++p.rateCount > 40) return;

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'state': {
        applyState(p, msg);
        if (!p.joined) {
          p.joined = true;
          for (const o of players.values()) {
            if (o !== p && o.joined && visibleTo(o, p)) send(o.ws, { type: 'join', player: view(p) });
          }
        }
        break;
      }

      case 'gate': {
        if (!p.joined) break;
        if (typeof msg.open !== 'boolean') break;
        if (msg.gate === 'ALL') {
          for (const k of Object.keys(gates)) gates[k] = msg.open;
        } else if (Object.prototype.hasOwnProperty.call(gates, msg.gate)) {
          gates[msg.gate] = msg.open;
        } else {
          break;
        }
        broadcast({ type: 'gates', gates });
        break;
      }

      case 'chat': {
        if (!p.joined) break;
        if (now - p.lastChat < 700) break;
        p.lastChat = now;
        const isNotice = !!msg.notice && p.rank >= 3; // 공지는 총관리자만
        const text = cleanText(msg.text, isNotice ? 200 : 80);
        if (!text) break;
        // 공지는 보낸 사람 화면에 이미 떠 있으므로 보낸 사람 제외
        broadcast({ type: 'chat', nick: p.nick, text, notice: isNotice }, isNotice ? ws : undefined);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    players.delete(p.id);
    if (p.joined) broadcast({ type: 'leave', id: p.id, nick: p.nick });
  });

  ws.on('error', () => {});
});

// 모든 접속자에게 주기적으로 다른 플레이어 상태 전송
setInterval(() => {
  const joined = [...players.values()].filter((p) => p.joined);
  if (joined.length < 2) return;
  const views = joined.map((p) => [p, view(p)]);
  for (const viewer of joined) {
    const list = views.filter(([p]) => p !== viewer && visibleTo(viewer, p)).map(([, v]) => v);
    send(viewer.ws, { type: 'sync', players: list });
  }
}, TICK_MS);

// 끊긴 연결 정리 (30초마다 ping)
const heartbeat = setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false;
    try { p.ws.ping(); } catch (_) {}
  }
}, 30000);

function shutdown() {
  clearInterval(heartbeat);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`🐉 블록 드래곤 헌터 서버 실행 중 → http://localhost:${PORT}`);
});
