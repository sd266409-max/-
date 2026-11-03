const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 세션 설정
const sessionMiddleware = session({
  secret: 'fishing-game-secret-key-1234',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24시간 유효
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// 데이터 저장소 (메모리 방식)
const usersDB = {}; // { username: { passwordHash, gold, inventory, currentRodId, ownedRods } }
const activePlayers = {}; // { socketId: { username, position, ... } }

// 회원가입 API
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력해주세요.' });
  }

  if (usersDB[username]) {
    return res.status(400).json({ success: false, message: '이미 존재하는 아이디입니다.' });
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  usersDB[username] = {
    username,
    passwordHash,
    gold: 50,
    inventory: [],
    currentRodId: 'basic',
    ownedRods: ['basic']
  };

  res.json({ success: true, message: '회원가입이 완료되었습니다.' });
});

// 로그인 API
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const user = usersDB[username];
  if (!user) {
    return res.status(400).json({ success: false, message: '존재하지 않는 아이디입니다.' });
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    return res.status(400).json({ success: false, message: '비밀번호가 일치하지 않습니다.' });
  }

  req.session.user = {
    username: user.username,
    gold: user.gold,
    inventory: user.inventory,
    currentRodId: user.currentRodId,
    ownedRods: user.ownedRods
  };

  res.json({
    success: true,
    message: '로그인 성공',
    user: req.session.user
  });
});

// 현재 세션 상태 확인 API
app.get('/api/me', (req, res) => {
  if (req.session.user && usersDB[req.session.user.username]) {
    const user = usersDB[req.session.user.username];
    res.json({
      loggedIn: true,
      user: {
        username: user.username,
        gold: user.gold,
        inventory: user.inventory,
        currentRodId: user.currentRodId,
        ownedRods: user.ownedRods
      }
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// 로그아웃 API
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: '로그아웃 되었습니다.' });
});

// Socket.IO 세션 공유
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

io.on('connection', (socket) => {
  const sess = socket.request.session;
  const username = sess.user ? sess.user.username : `게스트_${socket.id.substring(0, 4)}`;

  socket.on('joinGame', (data) => {
    activePlayers[socket.id] = {
      id: socket.id,
      username: username,
      position: data?.position || { x: 0, y: 0.8, z: 4 },
      rotationY: 0
    };

    socket.broadcast.emit('playerJoined', activePlayers[socket.id]);
    socket.emit('currentPlayers', activePlayers);
  });

  socket.on('playerMove', (movementData) => {
    if (activePlayers[socket.id]) {
      activePlayers[socket.id].position = movementData.position;
      activePlayers[socket.id].rotationY = movementData.rotationY;

      socket.broadcast.emit('playerMoved', {
        id: socket.id,
        position: movementData.position,
        rotationY: movementData.rotationY
      });
    }
  });

  socket.on('disconnect', () => {
    delete activePlayers[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
