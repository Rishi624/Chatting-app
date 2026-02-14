const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

io.on('connection', (socket) => {
    
    // --- 1. CREATE ROOM ---
    socket.on('create-room', ({ roomId, verifier, duressVerifier, salt }) => {
        if (rooms[roomId]) {
            socket.emit('error-msg', '⚠️ Room ID already exists!');
            return;
        }

        rooms[roomId] = {
            verifier, 
            duressVerifier, 
            salt,
            creationTime: Date.now()
        };

        socket.join(roomId);
        socket.emit('room-created', { creationTime: rooms[roomId].creationTime });

        // Auto-Destroy Room after 1 Hour
        setTimeout(() => {
            destroyRoom(roomId);
        }, 3600000);
    });

    // --- 2. JOIN CHECK (Step 1: Get Salt) ---
    socket.on('check-room', (roomId) => {
        if (!rooms[roomId]) {
            socket.emit('error-msg', '⚠️ Room does not exist!');
            return;
        }
        socket.emit('salt-response', rooms[roomId].salt);
    });

    // --- 3. VERIFY PASSWORD (Step 2: Check Hash) ---
    socket.on('join-verify', ({ roomId, passwordHashAttempt }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error-msg', '⚠️ Room invalid or expired.');
            return;
        }

        if (room.verifier === passwordHashAttempt) {
            // Real Password -> Real Mode
            socket.join(roomId);
            socket.emit('join-success', { mode: 'real', creationTime: room.creationTime });
            io.to(roomId).emit('user-joined');
        } 
        else if (room.duressVerifier === passwordHashAttempt) {
            // Duress Password -> Fake Mode
            socket.emit('join-success', { mode: 'duress', creationTime: room.creationTime });
        }
        else {
            socket.emit('error-msg', '❌ Wrong Password!');
        }
    });

    // --- 4. MESSAGING ---
    socket.on('chat-message', (data) => {
        // Forward message to others in the room
        socket.to(data.roomId).emit('receive-message', data);
    });

    // --- 5. INSTANT DESTRUCTION ---
    socket.on('destroy-room', (roomId) => {
        destroyRoom(roomId);
    });

    function destroyRoom(roomId) {
        if (rooms[roomId]) {
            console.log(`DESTROYING ROOM: ${roomId}`);
            // Force everyone to reload (clearing RAM)
            io.to(roomId).emit('force-disconnect'); 
            io.in(roomId).disconnectSockets();
            delete rooms[roomId];
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});