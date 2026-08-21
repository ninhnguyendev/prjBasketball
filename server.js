const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const players = {};
const lobbies = {};
const matchmakingQueues = { 1: [], 2: [], 3: [] };

function generateLobbyId() {
    return 'LOBBY_' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    socket.on('registerUser', (username) => {
        players[socket.id] = {
            id: socket.id,
            username: username,
            lobbyId: null,
            status: 'IDLE',
            coins: 1000,
            skinCourt: 'classic',
            skinBall: 'classic',
            skinPlayer: 'classic'
        };
        socket.emit('registered', { socketId: socket.id, username, coins: 1000 });
    });

    socket.on('createLobby', (mode = 1) => {
        const player = players[socket.id];
        if (!player) return;

        const lobbyId = generateLobbyId();
        const lobby = {
            id: lobbyId,
            host: socket.id,
            mode: mode,
            members: [socket.id],
            isSearching: false
        };

        lobbies[lobbyId] = lobby;
        player.lobbyId = lobbyId;
        player.status = 'IN_LOBBY';

        socket.join(lobbyId);
        io.to(lobbyId).emit('lobbyUpdated', getLobbyData(lobby));
    });

    socket.on('invitePlayer', (targetUsername) => {
        const hostPlayer = players[socket.id];
        if (!hostPlayer || !hostPlayer.lobbyId) return;

        const lobby = lobbies[hostPlayer.lobbyId];
        const targetSocketId = Object.keys(players).find(
            id => players[id].username.toLowerCase() === targetUsername.toLowerCase()
        );

        if (!targetSocketId) return socket.emit('alert', `Không tìm thấy "${targetUsername}"!`);

        const targetPlayer = players[targetSocketId];
        if (targetPlayer.status !== 'IDLE') return socket.emit('alert', `Nhiều khả năng người chơi đang bận!`);

        io.to(targetSocketId).emit('receiveInvite', {
            lobbyId: lobby.id,
            from: hostPlayer.username,
            mode: lobby.mode
        });
        socket.emit('alert', `Đã gửi lời mời tới ${targetUsername}!`);
    });

    socket.on('acceptInvite', (lobbyId) => {
        const lobby = lobbies[lobbyId];
        const player = players[socket.id];
        if (!lobby || !player) return socket.emit('alert', 'Phòng không tồn tại!');

        player.lobbyId = lobbyId;
        player.status = 'IN_LOBBY';
        lobby.members.push(socket.id);
        socket.join(lobbyId);

        io.to(lobbyId).emit('lobbyUpdated', getLobbyData(lobby));
    });

    socket.on('startMatchmaking', () => {
        const player = players[socket.id];
        if (!player || !player.lobbyId) return;

        const lobby = lobbies[player.lobbyId];
        if (lobby.host !== socket.id) return socket.emit('alert', 'Chỉ chủ phòng mới tìm trận được!');

        lobby.isSearching = true;
        io.to(lobby.id).emit('searchStatus', true);

        matchmakingQueues[lobby.mode].push(lobby.id);
        checkMatchmaking(lobby.mode);
    });

    // Mua vật phẩm từ Shop
    socket.on('buyItem', ({ type, id, price }) => {
        const p = players[socket.id];
        if (!p) return;
        if (p.coins >= price) {
            p.coins -= price;
            if (type === 'court') p.skinCourt = id;
            if (type === 'ball') p.skinBall = id;
            if (type === 'player') p.skinPlayer = id;
            socket.emit('itemPurchased', { coins: p.coins, type, id });
        } else {
            socket.emit('alert', 'Không đủ Coins!');
        }
    });

    // Đồng bộ di chuyển & kỹ năng Dribble (Phím Q)
    socket.on('playerMove', (data) => {
        const player = players[socket.id];
        if (player && player.lobbyId) {
            socket.to(player.lobbyId).emit('remotePlayerMove', {
                id: socket.id,
                ...data
            });
        }
    });

    // Đồng bộ Ném bóng & Kick-off
    socket.on('shootBall', (ballData) => {
        const player = players[socket.id];
        if (player && player.lobbyId) {
            io.to(player.lobbyId).emit('ballShot', ballData);
        }
    });

    socket.on('triggerKickoff', (kickoffData) => {
        const player = players[socket.id];
        if (player && player.lobbyId) {
            io.to(player.lobbyId).emit('kickoffReset', kickoffData);
        }
    });

    socket.on('disconnect', () => {
        const player = players[socket.id];
        if (player && player.lobbyId) {
            const lobby = lobbies[player.lobbyId];
            if (lobby) {
                lobby.members = lobby.members.filter(id => id !== socket.id);
                if (lobby.members.length === 0) delete lobbies[player.lobbyId];
                else io.to(lobby.id).emit('lobbyUpdated', getLobbyData(lobby));
            }
        }
        delete players[socket.id];
    });
});

function getLobbyData(lobby) {
    return {
        id: lobby.id,
        host: lobby.host,
        mode: lobby.mode,
        isSearching: lobby.isSearching,
        members: lobby.members.map(id => ({
            id: id,
            username: players[id] ? players[id].username : 'Unknown',
            skins: {
                court: players[id]?.skinCourt || 'classic',
                ball: players[id]?.skinBall || 'classic',
                player: players[id]?.skinPlayer || 'classic'
            }
        }))
    };
}

function checkMatchmaking(mode) {
    const queue = matchmakingQueues[mode];
    if (queue.length >= 2) {
        const l1 = lobbies[queue.shift()];
        const l2 = lobbies[queue.shift()];

        if (l1 && l2) {
            const gameRoomId = 'GAME_' + Date.now();
            const gameData = {
                roomId: gameRoomId,
                mode: mode,
                courtSkin: players[l1.host]?.skinCourt || 'classic',
                teamBlue: l1.members.map(id => ({ id, username: players[id].username, skin: players[id].skinPlayer, ballSkin: players[id].skinBall })),
                teamRed: l2.members.map(id => ({ id, username: players[id].username, skin: players[id].skinPlayer, ballSkin: players[id].skinBall }))
            };

            l1.members.concat(l2.members).forEach(socketId => {
                const s = io.sockets.sockets.get(socketId);
                if (s) {
                    s.leave(l1.id); s.leave(l2.id);
                    s.join(gameRoomId);
                    players[socketId].lobbyId = gameRoomId;
                    players[socketId].status = 'IN_GAME';
                }
            });

            io.to(gameRoomId).emit('matchFound', gameData);
            delete lobbies[l1.id]; delete lobbies[l2.id];
        }
    }
}

server.listen(3000, () => console.log(`🚀 Server đang chạy tại: http://localhost:3000`));
