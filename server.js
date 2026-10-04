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

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('Pemain terhubung:', socket.id);

    // 1. Membuat Room
    socket.on('createRoom', () => {
        const code = generateRoomCode();
        rooms[code] = {
            players: [socket.id],
            state: 'waiting',
            hands: {},
            table: null,
            turn: null,
            passCount: 0
        };
        socket.join(code);
        socket.emit('roomCreated', code);
    });

    // 2. Gabung ke Room
    socket.on('joinRoom', (code) => {
        const room = rooms[code];
        if (room && room.players.length === 1 && room.state === 'waiting') {
            room.players.push(socket.id);
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
            room.players.forEach(pid => {
                const oppId = room.players.find(id => id !== pid);
                io.to(pid).emit('gameState', {
                    hand: room.hands[pid],
                    oppCount: room.hands[oppId].length,
                    table: room.table,
                    myTurn: room.turn === pid,
                    passCount: room.passCount
                });
            });

        } else {
            socket.emit('errorMsg', 'Kode salah, room penuh, atau sedang bermain.');
        }
    });

    // 3. Menurunkan Kartu
    socket.on('playCard', ({ code, cards }) => {
        const room = rooms[code];
        if(!room || room.turn !== socket.id) return; // Abaikan jika bukan gilirannya
        
        // Hapus kartu dari tangan pemain
        const myHand = room.hands[socket.id];
        const cardIds = cards.map(c => c.id);
        room.hands[socket.id] = myHand.filter(c => !cardIds.includes(c.id));
        
        // Update kartu di meja
        room.table = {
            cards: cards,
            by: socket.id
        };
        
        // Reset pass count karena ada yang turun kartu
        room.passCount = 0;
        
        // Ganti giliran ke lawan
        const oppId = room.players.find(id => id !== socket.id);
        room.turn = oppId;
        
        // Cek kondisi menang
        if(room.hands[socket.id].length === 0) {
            io.to(code).emit('gameOver', { winner: socket.id });
            delete rooms[code]; // Hapus room jika selesai
            return;
        }

        // Broadcast state terbaru ke masing-masing pemain
        room.players.forEach(pid => {
            io.to(pid).emit('gameState', {
                hand: room.hands[pid],
                oppCount: room.hands[room.players.find(id => id !== pid)].length,
                table: room.table,
                myTurn: room.turn === pid,
                passCount: room.passCount
            });
        });
    });

    // 4. Melewati Giliran (Pass)
    socket.on('pass', (code) => {
        const room = rooms[code];
        if(!room || room.turn !== socket.id) return;
        
        room.passCount++;
        const oppId = room.players.find(id => id !== socket.id);
        
        // Jika 1 pemain (lawan) pass, meja dibersihkan dan yang barusan main dapat giliran bebas
        if (room.passCount >= 1) {
            room.table = null; 
            room.turn = oppId; // Giliran kembali ke pemain yang terakhir buang kartu
            room.passCount = 0;
        }

        room.players.forEach(pid => {
            io.to(pid).emit('gameState', {
                hand: room.hands[pid],
                oppCount: room.hands[room.players.find(id => id !== pid)].length,
                table: room.table,
                myTurn: room.turn === pid,
                passCount: room.passCount,
                passed: true
            });
        });
    });

    // 5. Pemain Keluar / Disconnect
    socket.on('disconnect', () => {
        console.log('Pemain terputus:', socket.id);
        for(let code in rooms) {
            if(rooms[code].players.includes(socket.id)) {
                io.to(code).emit('errorMsg', 'Lawan terputus koneksinya dari permainan.');
                delete rooms[code];
            }
        }
    });
});

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
