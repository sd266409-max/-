const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Render의 환경 변수 PORT 사용 (기본값 3000)
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// public 폴더의 정적 파일(index.html 등) 서버에서 로드
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 메모리 기반 플레이어 데이터 저장소
const players = {};

// Socket.IO 데이터 통신 처리
io.on('connection', (socket) => {
  console.log(`[접속] 플레이어 연결: ${socket.id}`);

  // 게임 접속 핸들러
  socket.on('joinGame', (data) => {
    players[socket.id] = {
      id: socket.id,
      gold: data?.gold || 50,
      currentRodId: data?.currentRodId || "basic",
      position: data?.position || { x: 0, y: 0.8, z: 4 },
      rotationY: 0
    };

    // 기존 유저들에게 새 유저 알림
    socket.broadcast.emit('playerJoined', players[socket.id]);
    // 접속한 유저에게 전체 유저 데이터 전달
    socket.emit('currentPlayers', players);
  });

  // 이동 동기화
  socket.on('playerMove', (movementData) => {
    if (players[socket.id]) {
      players[socket.id].position = movementData.position;
      players[socket.id].rotationY = movementData.rotationY;
      
      socket.broadcast.emit('playerMoved', {
        id: socket.id,
        position: movementData.position,
        rotationY: movementData.rotationY
      });
    }
  });

  // 접속 종료 핸들러
  socket.on('disconnect', () => {
    console.log(`[해제] 플레이어 퇴장: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// 기본 경로 요청 시 index.html 렌더링
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`서버가 성공적으로 포트 ${PORT}에서 실행되었습니다.`);
});
