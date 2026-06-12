import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getDatabase, ref, set, onValue, onDisconnect, remove } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBHeinJrRrlXa0IqN8_82n0XtkQ2a9w4Rg",
    authDomain: "spiker-45a82.firebaseapp.com",
    databaseURL: "https://spiker-45a82-default-rtdb.firebaseio.com",
    projectId: "spiker-45a82",
    storageBucket: "spiker-45a82.firebasestorage.app",
    messagingSenderId: "408879159265",
    appId: "1:408879159265:web:1b89adc89a2d4c15f1e4a0"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// --- ESTADO DEL USUARIO ---
let myUsername = localStorage.getItem("spiker_username") || "";
let myPeerId = null;

// --- ELEMENTOS DOM ---
const loginContainer = document.getElementById('login-container');
const lobbyContainer = document.getElementById('lobby-container');
const gameContainer = document.getElementById('game-container');
const innerLobby = document.getElementById('inner-lobby');
const usernameInput = document.getElementById('username-input');
const btnLogin = document.getElementById('btn-login');

// Context Menu y Listas
const contextMenu = document.getElementById('context-menu');
const listRed = document.getElementById('list-red');
const listSpect = document.getElementById('list-spect');
const listBlue = document.getElementById('list-blue');

// --- VARIABLES P2P (Topología Estrella) ---
const peer = new Peer();
let isHost = false;
let hostConn = null; // Si soy invitado, esta es mi conexión al host
let guestConns = {}; // Si soy host, aquí guardo las conexiones de los invitados

// Estado de la sala (El Host es la fuente de la verdad)
let roomState = {
    matchStarted: false,
    players: {} // { peerId: { name, team: 'spect'|'red'|'blue', admin: boolean, ping: number } }
};

// Inputs remotos
let allRemoteKeys = {}; // { peerId: { keys... } }

// --- 1. SISTEMA DE LOGIN ---
if (myUsername) {
    showPublicLobby();
} else {
    loginContainer.classList.remove('hidden');
}

btnLogin.addEventListener('click', () => {
    const val = usernameInput.value.trim();
    if (val.length > 0) {
        myUsername = val;
        localStorage.setItem("spiker_username", myUsername);
        showPublicLobby();
    }
});

function showPublicLobby() {
    loginContainer.classList.add('hidden');
    lobbyContainer.classList.remove('hidden');
    document.getElementById('welcome-text').innerText = `Hola, ${myUsername} | Salas Públicas`;
}

peer.on('open', (id) => {
    myPeerId = id;
    document.getElementById('my-id').value = id;
});

// --- 2. FIREBASE: LISTA DE SALAS ---
const roomsRef = ref(db, 'rooms');
let myRoomRef = null;

onValue(roomsRef, (snapshot) => {
    const roomListElement = document.getElementById('room-list');
    roomListElement.innerHTML = '';
    const rooms = snapshot.val();

    if (!rooms) {
        roomListElement.innerHTML = '<li style="color: #888; text-align: center; padding: 10px;">No hay salas activas.</li>';
        return;
    }

    for (const peerId in rooms) {
        const room = rooms[peerId];
        const li = document.createElement('li');
        li.className = 'room-item';
        li.innerHTML = `
            <span><strong>${room.name}</strong> (${room.hostName})</span>
            <span>🇺🇾 | <button class="btn-join" data-id="${peerId}">Unirse</button></span>
        `;
        roomListElement.appendChild(li);
    }

    document.querySelectorAll('.btn-join').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const remoteId = e.target.getAttribute('data-id');
            joinRoom(remoteId);
        });
    });
});

// --- 3. CREAR SALA Y CONECTAR ---
document.getElementById('btn-host').addEventListener('click', () => {
    const roomName = document.getElementById('room-name').value || "Sala de " + myUsername;
    
    myRoomRef = ref(db, 'rooms/' + myPeerId);
    set(myRoomRef, { name: roomName, hostId: myPeerId, hostName: myUsername, timestamp: Date.now() });
    onDisconnect(myRoomRef).remove();

    isHost = true;
    document.getElementById('room-title-display').innerText = roomName;
    document.getElementById('btn-start-match').classList.remove('hidden'); // Solo host puede iniciar
    
    // Me agrego a mi propio state
    roomState.players[myPeerId] = { name: myUsername, team: 'red', admin: true, ping: 0 };
    
    enterInnerLobby();
});

function joinRoom(hostId) {
    isHost = false;
    hostConn = peer.connect(hostId, { metadata: { name: myUsername } });
    
    hostConn.on('open', () => {
        enterInnerLobby();
    });

    hostConn.on('data', (data) => {
        if (data.type === 'state_update') {
            roomState = data.roomState;
            updateLobbyUI();
        } else if (data.type === 'game_tick') {
            syncGameTick(data);
        } else if (data.type === 'kicked') {
            alert("Has sido kickeado de la sala.");
            location.reload();
        }
    });

    hostConn.on('close', () => { alert("El Host cerró la sala."); location.reload(); });
}

// Host recibe conexiones
peer.on('connection', (conn) => {
    if (!isHost) return;
    
    conn.on('open', () => {
        const guestName = conn.metadata.name || "Anon";
        guestConns[conn.peer] = conn;
        roomState.players[conn.peer] = { name: guestName, team: 'spect', admin: false, ping: 45 };
        broadcastState();
    });

    conn.on('data', (data) => {
        if (data.type === 'keys') {
            allRemoteKeys[conn.peer] = data.keys;
        }
    });

    conn.on('close', () => {
        delete guestConns[conn.peer];
        delete roomState.players[conn.peer];
        delete allRemoteKeys[conn.peer];
        broadcastState();
    });
});

function broadcastState() {
    if (!isHost) return;
    updateLobbyUI();
    const data = { type: 'state_update', roomState };
    Object.values(guestConns).forEach(c => c.send(data));
}

// --- 4. INTERFAZ LOBBY (Haxball Style) ---
function enterInnerLobby() {
    lobbyContainer.classList.add('hidden');
    gameContainer.classList.remove('hidden');
    updateLobbyUI();
    if(isHost) startGameLoop(); // El host empieza a calcular físicas en background
}

function updateLobbyUI() {
    listRed.innerHTML = ''; listSpect.innerHTML = ''; listBlue.innerHTML = '';
    
    for (const [id, player] of Object.entries(roomState.players)) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="flag">🇺🇾</span> <span style="flex:1; margin-left:10px;">${player.name}</span> <span style="color:#2ecc71; font-size:0.7rem;">${player.ping}ms</span>`;
        if (player.admin) li.classList.add('is-admin');
        
        // Context Menu trigger
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const amIAdmin = roomState.players[myPeerId]?.admin;
            if (amIAdmin) showContextMenu(e.pageX, e.pageY, id);
        });

        if (player.team === 'red') listRed.appendChild(li);
        else if (player.team === 'blue') listBlue.appendChild(li);
        else listSpect.appendChild(li);
    }
}

// --- CONTROLES DE ADMIN LOBBY ---
let selectedPlayerId = null;

function showContextMenu(x, y, playerId) {
    selectedPlayerId = playerId;
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.classList.remove('hidden');
}

document.addEventListener('click', () => contextMenu.classList.add('hidden'));

// Acciones del menu (Solo se ejecutan si soy host o si mando solicitud al host, simplificado: solo host por ahora o confía en la red P2P)
document.getElementById('cm-move-red').addEventListener('click', () => changeTeam(selectedPlayerId, 'red'));
document.getElementById('cm-move-spect').addEventListener('click', () => changeTeam(selectedPlayerId, 'spect'));
document.getElementById('cm-move-blue').addEventListener('click', () => changeTeam(selectedPlayerId, 'blue'));
document.getElementById('cm-admin').addEventListener('click', () => {
    if(!isHost) return;
    roomState.players[selectedPlayerId].admin = !roomState.players[selectedPlayerId].admin;
    broadcastState();
});
document.getElementById('cm-kick').addEventListener('click', () => {
    if(!isHost) return;
    if(guestConns[selectedPlayerId]) {
        guestConns[selectedPlayerId].send({type: 'kicked'});
        guestConns[selectedPlayerId].close();
    }
});
document.getElementById('cm-close').addEventListener('click', () => contextMenu.classList.add('hidden'));

function changeTeam(playerId, team) {
    if (!isHost) return; // Idealmente el cliente mandaría un request change_team
    if (roomState.players[playerId]) {
        roomState.players[playerId].team = team;
        broadcastState();
    }
}

// TOGGLE LOBBY ESCAPE
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lobbyContainer.classList.contains('hidden') === false) {
        innerLobby.classList.toggle('hidden');
    }
});

document.getElementById('btn-leave-room').addEventListener('click', () => location.reload());

// --- 5. LÓGICA DEL JUEGO (ADAPTADA PARA EQUIPOS) ---
// La lógica física es la misma que ya tenías, solo mapeamos inputs según el equipo.
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreDisplay = document.getElementById('score');

let ball = { x: 400, y: 100, vx: 0, vy: 0, radius: 15, bounce: 0.9, color: '#f1c40f' };
let p1 = { x: 150, y: 400, vx: 0, vy: 0, radius: 30, color: '#e74c3c', isSpiking: false, facingRight: true }; // Red
let p2 = { x: 650, y: 400, vx: 0, vy: 0, radius: 30, color: '#3498db', isSpiking: false, facingRight: false }; // Blue
let score1 = 0, score2 = 0;

const localKeys = {};
window.addEventListener('keydown', e => {
    localKeys[e.code] = true;
    if (!isHost && hostConn) hostConn.send({ type: 'keys', keys: localKeys });
});
window.addEventListener('keyup', e => {
    localKeys[e.code] = false;
    if (!isHost && hostConn) hostConn.send({ type: 'keys', keys: localKeys });
});

function getActiveKeysForTeam(team) {
    if (!isHost) return {};
    // Si yo (host) estoy en el equipo, uso mis teclas
    if (roomState.players[myPeerId].team === team) return localKeys;
    // Busco el primer jugador del equipo para darle control (1v1 por ahora)
    const playerId = Object.keys(roomState.players).find(id => roomState.players[id].team === team && id !== myPeerId);
    if (playerId && allRemoteKeys[playerId]) return allRemoteKeys[playerId];
    return {};
}

// Mantenemos la lógica de UpdatePlayer muy similar, aplicamos las keys recolectadas
function updatePlayer(p, keys, isP1) {
    // Lógica simplificada de físicas para no alargar:
    const speed = 1.2; const maxSpeed = 6;
    if (keys[isP1 ? 'KeyA' : 'ArrowLeft']) { p.vx -= speed; p.facingRight = false; }
    if (keys[isP1 ? 'KeyD' : 'ArrowRight']) { p.vx += speed; p.facingRight = true; }
    p.vx *= 0.85; // Fricción
    
    if (keys[isP1 ? 'KeyW' : 'ArrowUp'] && p.y >= 400 - p.radius) p.vy = -10; // Jump
    
    p.vy += 0.4; p.x += p.vx; p.y += p.vy; // Gravedad
    
    // Suelo
    if (p.y > 400 - p.radius) { p.y = 400 - p.radius; p.vy = 0; }
    
    // Limites de red y pared
    let minX = isP1 ? p.radius : 405 + p.radius;
    let maxX = isP1 ? 395 - p.radius : 800 - p.radius;
    if (p.x < minX) { p.x = minX; p.vx = 0; }
    if (p.x > maxX) { p.x = maxX; p.vx = 0; }
}

function gameLoop() {
    if (isHost) {
        const redKeys = getActiveKeysForTeam('red');
        const blueKeys = getActiveKeysForTeam('blue');
        
        updatePlayer(p1, redKeys, true);
        updatePlayer(p2, blueKeys, false);
        
        // Físicas de la pelota (simplificadas aquí para espacio, debes integrar las de tu versión original)
        ball.vy += 0.4; ball.x += ball.vx; ball.y += ball.vy;
        if(ball.y > 500) { ball.y = 100; ball.vy = 0; ball.vx = 0; ball.x = 400; } // Reset temporal
        
        // BROADCAST a invitados
        const tickData = { type: 'game_tick', ball, p1, p2, scores: {score1, score2} };
        Object.values(guestConns).forEach(c => c.send(tickData));
    }
    
    renderGame();
    requestAnimationFrame(gameLoop);
}

function syncGameTick(data) {
    ball = data.ball; p1 = data.p1; p2 = data.p2;
    scoreDisplay.innerText = `${data.scores.score1} - ${data.scores.score2}`;
}

function renderGame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Red
    ctx.fillStyle = '#ecf0f1'; ctx.fillRect(395, 350, 10, 150);
    // Ball
    ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2); ctx.fillStyle = ball.color; ctx.fill(); ctx.stroke();
    // Players
    ctx.beginPath(); ctx.arc(p1.x, p1.y, p1.radius, 0, Math.PI * 2); ctx.fillStyle = p1.color; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(p2.x, p2.y, p2.radius, 0, Math.PI * 2); ctx.fillStyle = p2.color; ctx.fill(); ctx.stroke();
}

function startGameLoop() {
    requestAnimationFrame(gameLoop);
}