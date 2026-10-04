const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Sajikan file statis dari folder public
app.use(express.static('public'));

// Setup Kartu
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SUITS = ['♣','♦','♥','♠'];
const str = c => c.r * 4 + c.s;
const mk = s => {
    const su = s.slice(-1), r = s.slice(0, -1); 
    return {id: s, r: RANKS.indexOf(r), s: SUITS.indexOf(su), rank: r, suit: su};
};

function generateDeck() {
    let deck = [];
    for(let r of RANKS) {
        for(let s of SUITS) {
            deck.push(mk(r+s));
        }
    }
    // Kocok kartu (Fisher-Yates Shuffle)
    for(let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// Simpan state semua room di memori server
const rooms = {};
// Track pemain → kode room (supaya bisa cleanup saat disconnect)
const playerRoom = {};

function generateRoomCode() {
    let code;
    // Pastikan kode unik
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]);
    return code;
}

// Fungsi helper: keluarkan pemain dari room lama sebelum masuk room baru
function leaveCurrentRoom(socketId) {
    const oldCode = playerRoom[socketId];
    if (oldCode && rooms[oldCode]) {
        const oldRoom = rooms[oldCode];
        // Beritahu pemain lain di room lama
        const others = oldRoom.players.filter(id => id !== socketId);
        others.forEach(pid => {
            io.to(pid).emit('errorMsg', 'Lawan keluar dari room.');
            // Bersihkan mapping pemain lain juga
            delete playerRoom[pid];
        });
        delete rooms[oldCode];
        console.log(`Room ${oldCode} dihapus karena pemain ${socketId} keluar.`);
    }
    delete playerRoom[socketId];
}

// Helper: kirim gameState ke semua pemain di room
function broadcastGameState(code, extra) {
    const room = rooms[code];
    if (!room) return;
    room.players.forEach(pid => {
        const oppId = room.players.find(id => id !== pid);
        io.to(pid).emit('gameState', {
            hand: room.hands[pid],
            oppCount: oppId ? room.hands[oppId].length : 0,
            table: room.table,
            myTurn: room.turn === pid,
            passCount: room.passCount,
            reversed: room.reversed,
            ...extra
        });
    });
}

io.on('connection', (socket) => {
    console.log('Pemain terhubung:', socket.id);

    // 1. Membuat Room
    socket.on('createRoom', () => {
        // Keluarkan dari room lama jika ada
        leaveCurrentRoom(socket.id);

        const code = generateRoomCode();
        rooms[code] = {
            players: [socket.id],
            state: 'waiting',
            hands: {},
            table: null,
            turn: null,
            passCount: 0,
            reversed: false
        };
        playerRoom[socket.id] = code;
        socket.join(code);
        socket.emit('roomCreated', code);
        console.log(`Room ${code} dibuat oleh ${socket.id}`);
    });

    // 2. Gabung ke Room
    socket.on('joinRoom', (code) => {
        if (!code || typeof code !== 'string') {
            socket.emit('errorMsg', 'Kode room tidak valid.');
            return;
        }
        code = code.toUpperCase().trim();

        const room = rooms[code];
        if (!room) {
            socket.emit('errorMsg', 'Room tidak ditemukan. Cek kodenya lagi.');
            return;
        }
        if (room.state !== 'waiting') {
            socket.emit('errorMsg', 'Room sedang bermain. Tunggu sampai selesai.');
            return;
        }
        if (room.players.length >= 2) {
            socket.emit('errorMsg', 'Room sudah penuh.');
            return;
        }
        if (room.players.includes(socket.id)) {
            socket.emit('errorMsg', 'Anda sudah ada di room ini.');
            return;
        }

        // Keluarkan dari room lama jika ada
        leaveCurrentRoom(socket.id);

        // Cek apakah pemain pertama (pembuat room) masih terhubung
        const creatorId = room.players[0];
        const creatorSocket = io.sockets.sockets.get(creatorId);
        if (!creatorSocket || !creatorSocket.connected) {
            // Pembuat room sudah disconnect, hapus room zombie ini
            delete rooms[code];
            delete playerRoom[creatorId];
            socket.emit('errorMsg', 'Room sudah tidak aktif (pembuat room terputus). Minta kode baru.');
            return;
        }

        room.players.push(socket.id);
        playerRoom[socket.id] = code;
        socket.join(code);
        room.state = 'playing';
        
        // Bagi kartu untuk 2 pemain
        const deck = generateDeck();
        const hand1 = deck.slice(0, 26).sort((a,b) => str(a) - str(b));
        const hand2 = deck.slice(26, 52).sort((a,b) => str(a) - str(b));
        
        room.hands[room.players[0]] = hand1;
        room.hands[room.players[1]] = hand2;
        
        // Pemain pertama yang membuat room jalan duluan
        room.turn = room.players[0];

        // Beritahu kedua pemain bahwa game dimulai
        io.to(code).emit('gameStarted', { code });
        
        // Kirim state spesifik ke masing-masing pemain
        broadcastGameState(code);

        console.log(`Pemain ${socket.id} bergabung ke room ${code}. Game dimulai!`);
    });

    // 3. Menurunkan Kartu
    socket.on('playCard', ({ code, cards }) => {
        const room = rooms[code];
        if(!room || room.state !== 'playing' || room.turn !== socket.id) return;
        
        // Hapus kartu dari tangan pemain
        const myHand = room.hands[socket.id];
        if (!myHand) return;
        const cardIds = cards.map(c => c.id);
        room.hands[socket.id] = myHand.filter(c => !cardIds.includes(c.id));
        
        // Update kartu di meja
        room.table = {
            cards: cards,
            by: socket.id
        };
        
        // Cek revolusi (Four of a Kind)
        // Four of a Kind dalam game ini dimainkan sebagai 5 kartu (4 kembar + 1 kicker)
        if (cards.length === 5) {
            const cnt = {};
            cards.forEach(c => cnt[c.r] = (cnt[c.r] || 0) + 1);
            const groups = Object.entries(cnt).map(([r,k]) => ({r: +r, k})).sort((a,b) => b.k - a.k || b.r - a.r);
            if(groups[0].k === 4) {
                room.reversed = !room.reversed;
                console.log(`Revolusi di-trigger di room ${code}. State: ${room.reversed}`);
            }
        }
        
        // Reset pass count karena ada yang turun kartu
        room.passCount = 0;
        
        // Ganti giliran ke lawan
        const oppId = room.players.find(id => id !== socket.id);
        room.turn = oppId;
        
        // Cek kondisi menang
        if(room.hands[socket.id].length === 0) {
            io.to(code).emit('gameOver', { winner: socket.id });
            // Bersihkan mapping kedua pemain
            room.players.forEach(pid => delete playerRoom[pid]);
            delete rooms[code];
            console.log(`Game selesai di room ${code}. Pemenang: ${socket.id}`);
            return;
        }

        // Broadcast state terbaru
        broadcastGameState(code);
    });

    // 4. Melewati Giliran (Pass)
    socket.on('pass', (code) => {
        const room = rooms[code];
        if(!room || room.state !== 'playing' || room.turn !== socket.id) return;
        
        room.passCount++;
        const oppId = room.players.find(id => id !== socket.id);
        
        // Jika pemain pass, meja dibersihkan dan lawan dapat giliran bebas
        if (room.passCount >= 1) {
            room.table = null; 
            room.turn = oppId;
            room.passCount = 0;
        }

        broadcastGameState(code, { passed: true });
    });

    // 5. Chat / Emoji
    socket.on('chatMsg', ({ code, text }) => {
        if (!code || !text) return;
        const room = rooms[code];
        if(!room || !room.players.includes(socket.id)) return;
        io.to(code).emit('chatMsg', {
            from: socket.id,
            text: text.substring(0, 200), // limit panjang pesan
            ts: Date.now()
        });
    });

    // 6. Pemain Keluar / Disconnect
    socket.on('disconnect', () => {
        console.log('Pemain terputus:', socket.id);
        leaveCurrentRoom(socket.id);
    });
});

// Bersihkan room zombie secara berkala (setiap 60 detik)
setInterval(() => {
    for (const code in rooms) {
        const room = rooms[code];
        // Cek apakah semua pemain masih terhubung
        const allDisconnected = room.players.every(pid => {
            const s = io.sockets.sockets.get(pid);
            return !s || !s.connected;
        });
        if (allDisconnected) {
            room.players.forEach(pid => delete playerRoom[pid]);
            delete rooms[code];
            console.log(`Room zombie ${code} dibersihkan.`);
        }
    }
}, 60000);

// Menjalankan server pada port dinamis (untuk Railway/Render/dsb) atau 3000 untuk lokal
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`✅ Server Game Jendral Berjalan!`);
    console.log(`=========================================`);
    console.log(`Akses lokal   : http://localhost:${PORT}`);
    console.log(`Akses KANTOR/LAN: Cek IP Address komputer Anda.`);
    console.log(`Contoh        : http://192.168.x.x:${PORT}`);
    console.log(`=========================================`);
});
