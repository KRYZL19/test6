// =================================================================
// 1. IMPORTS UND SERVER-SETUP
// =================================================================
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Sagt dem Server, wo er die Client-Dateien (index.html etc.) findet.
// Erstellen Sie einen Ordner namens 'public' und legen Sie Ihre HTML-Datei dort hinein.
app.use(express.static('public'));


// =================================================================
// 2. GLOBALE VARIABLEN UND SPIEL-ZUSTAND
// =================================================================
// WICHTIG: Wir speichern ALLES in diesem 'rooms'-Objekt.
// Keine globalen 'players' oder 'ball' Variablen mehr!
const rooms = {};


// =================================================================
// 3. SERVER-LOGIK BEI NEUER VERBINDUNG
// =================================================================
io.on('connection', (socket) => {
    console.log(`✅ Client verbunden: ${socket.id}`);

    // Sende dem neuen Client sofort die aktuelle Raumliste
    socket.emit('updateRoomList', rooms);

    // --- Lobby und Raum-Management ---

    socket.on('createRoom', (data) => {
        const roomId = data.roomId;
        console.log(`➡️ Empfange 'createRoom'-Anfrage für Raum: "${roomId}"`);

        if (rooms[roomId]) {
            console.log(`❌ Fehler: Raum "${roomId}" existiert bereits.`);
            socket.emit('roomError', 'Dieser Raumname existiert bereits!');
            return;
        }

        socket.join(roomId);
        rooms[roomId] = {
            playerCount: 1,
            players: {
                [socket.id]: { number: 1, y: 250, score: 0 }
            },
            // Jeder Raum bekommt seinen eigenen Ball!
            ball: { x: 400, y: 300, radius: 12, dx: 7, dy: 7 },
            // Spiel läuft noch nicht, erst wenn Spieler 2 beitritt
            interval: null
        };
        console.log(`🟢 Raum "${roomId}" wurde von ${socket.id} erstellt.`);

        socket.emit('roomCreated', { roomId: roomId });
        socket.emit('playerNumber', 1);

        // Alle Clients über den neuen Raum informieren
        io.emit('updateRoomList', rooms);
    });

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        console.log(`➡️ ${socket.id} versucht, Raum "${roomId}" beizutreten.`);

        const room = rooms[roomId];
        if (!room) {
            socket.emit('roomError', 'Raum nicht gefunden.');
            return;
        }
        if (room.playerCount >= 2) {
            socket.emit('roomError', 'Dieser Raum ist bereits voll.');
            return;
        }

        socket.join(roomId);
        room.playerCount++;
        room.players[socket.id] = { number: 2, y: 250, score: 0 };
        console.log(`🟢 ${socket.id} ist Raum "${roomId}" beigetreten. Spieleranzahl: ${room.playerCount}`);


        socket.emit('playerNumber', 2);
        
        // Sende die aktualisierte Liste an ALLE Clients
        io.emit('updateRoomList', rooms);
        
        // Das Spiel kann jetzt starten!
        const initialState = {
            players: room.players,
            ball: room.ball
        };
        io.to(roomId).emit('startGame', initialState);

        // Starte die Spiellogik speziell für diesen Raum
        startGameLoop(roomId);
    });

    socket.on('leaveRoom', (data) => {
        const roomId = data.roomId;
        if (rooms[roomId]) {
            socket.leave(roomId);
            console.log(`🚪 ${socket.id} hat Raum "${roomId}" verlassen.`);
            // Hier Logik zum Aufräumen, falls Spieler den Raum verlässt...
        }
    });


    // --- Spiel-Logik ---

    socket.on('paddleMove', (data) => {
        const roomId = data.roomId;
        if (rooms[roomId] && rooms[roomId].players[socket.id]) {
            rooms[roomId].players[socket.id].y = data.y;
        }
    });


    // --- Verbindung trennen ---

    socket.on('disconnect', () => {
        console.log(`❌ Client getrennt: ${socket.id}`);
        // WICHTIG: Finde den Raum, in dem der Spieler war, und räume ihn auf.
        for (const roomId in rooms) {
            if (rooms[roomId].players[socket.id]) {
                const room = rooms[roomId];
                console.log(`Spieler ${socket.id} wird aus Raum ${roomId} entfernt.`);
                
                // Stoppe die Spiellogik für diesen Raum
                if (room.interval) {
                    clearInterval(room.interval);
                }

                delete rooms[roomId]; // Einfachste Lösung: Raum komplett löschen
                // Informiere andere Clients, dass der Raum weg ist
                io.emit('updateRoomList', rooms);
                // Optional: Sende dem verbleibenden Spieler eine Nachricht
                io.to(roomId).emit('gameOver', 'Dein Gegner hat das Spiel verlassen');
                break;
            }
        }
    });
});


// =================================================================
// 4. SPIEL-LOGIK (GAME LOOP)
// =================================================================
function startGameLoop(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    console.log(`🚀 Starte Game Loop für Raum: ${roomId}`);

    room.interval = setInterval(() => {
        if (room.playerCount < 2) {
            // Beende den Loop, wenn ein Spieler geht
            clearInterval(room.interval);
            return;
        }

        const ball = room.ball;
        const players = room.players;

        // Ball bewegen
        ball.x += ball.dx;
        ball.y += ball.dy;

        // Kollision mit oberer/unterer Wand
        if (ball.y + ball.radius > 600 || ball.y - ball.radius < 0) {
            ball.dy *= -1;
        }

        // Kollision mit Schlägern
        for (const socketId in players) {
            const player = players[socketId];
            let paddleX = (player.number === 1) ? 10 + 15 : 800 - 15 - 10;

            if (
                ball.x - ball.radius < paddleX + 15 &&
                ball.x + ball.radius > paddleX &&
                ball.y > player.y &&
                ball.y < player.y + 100
            ) {
                ball.dx *= -1;
            }
        }

        // Punkt erzielt?
        if (ball.x + ball.radius < 0) { // Spieler 2 punktet
            Object.values(players).find(p => p.number === 2).score++;
            resetBall(ball);
        }
        if (ball.x - ball.radius > 800) { // Spieler 1 punktet
            Object.values(players).find(p => p.number === 1).score++;
            resetBall(ball);
        }

        // Sende den neuen Spielzustand NUR an die Spieler in diesem Raum
        io.to(roomId).emit('gameState', { players, ball });

    }, 1000 / 60); // ~60 FPS
}

function resetBall(ball) {
    ball.x = 400;
    ball.y = 300;
    ball.dx = (Math.random() > 0.5 ? 1 : -1) * 7;
    ball.dy = (Math.random() > 0.5 ? 1 : -1) * 7;
}


// =================================================================
// 5. SERVER STARTEN
// =================================================================
server.listen(PORT, () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
});