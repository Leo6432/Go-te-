const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 4 thèmes "classiques" : nom = thème, sans limite de places
const THEMES = [
  { id: 'boisson',   label: 'Boisson',   emoji: '🥤' },
  { id: 'saucisson', label: 'Saucisson', emoji: '🥖' },
  { id: 'gateau',    label: 'Gâteau',    emoji: '🎂' },
  { id: 'chips',     label: 'Chips',     emoji: '🥨' },
];
// "Autre" est spécial : chacun crée sa propre entrée (1 personne) avec ce qu'il apporte
const AUTRE = { id: 'autre', label: 'Autre', emoji: '✨' };

// Normalisation : insensible à la casse ET aux accents (Léo == leo == LEO)
function normalize(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// ===== ÉTAT =====
const registeredNames = new Map();   // normalized -> displayName
const nameToSocket = new Map();      // displayName -> socketId | null
const groups = {};                   // themeId -> { members: [displayName] }
let autreGroups = [];                // [{ id, item, member: displayName }]
let autreSeq = 1;

THEMES.forEach(t => { groups[t.id] = { members: [] }; });

function activeCount() {
  let n = 0;
  nameToSocket.forEach(sid => { if (sid) n++; });
  return n;
}

function removeFromEverywhere(name) {
  THEMES.forEach(t => {
    groups[t.id].members = groups[t.id].members.filter(m => m !== name);
  });
  autreGroups = autreGroups.filter(g => g.member !== name);
}

function findMyLocation(name) {
  for (const t of THEMES) {
    if (groups[t.id].members.includes(name)) return { type: 'theme', id: t.id };
  }
  const a = autreGroups.find(g => g.member === name);
  if (a) return { type: 'autre', id: a.id };
  return null;
}

function getState() {
  return {
    themes: THEMES,
    autre: AUTRE,
    groups,
    autreGroups,
    students: Array.from(registeredNames.values()),
    connected: activeCount(),
  };
}

io.on('connection', (socket) => {
  socket.emit('state', getState());

  socket.on('join', ({ name }) => {
    const raw = (name || '').trim();
    if (!raw) return;
    const key = normalize(raw);
    if (!key) return;

    // Reconnaît un élève déjà inscrit (même sans accent / majuscule)
    let displayName = registeredNames.get(key);
    if (!displayName) {
      displayName = raw;
      registeredNames.set(key, displayName);
    }

    // Déconnecte l'ancien onglet de ce même élève
    const oldSid = nameToSocket.get(displayName);
    if (oldSid && oldSid !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSid);
      if (oldSocket) oldSocket.disconnect(true);
    }

    nameToSocket.set(displayName, socket.id);
    socket.data.name = displayName;

    socket.emit('joined', { name: displayName });
    io.emit('state', getState());
  });

  // Rejoindre un thème classique (boisson, saucisson, gâteau, chips) — illimité
  socket.on('joinTheme', ({ themeId }) => {
    const name = socket.data.name;
    if (!name) return;
    const group = groups[themeId];
    if (!group) return;

    removeFromEverywhere(name);
    group.members.push(name);
    io.emit('state', getState());
  });

  // Créer une entrée "Autre" : 1 personne, avec ce qu'elle apporte
  socket.on('joinAutre', ({ item }) => {
    const name = socket.data.name;
    if (!name) return;
    const what = (item || '').trim();
    if (!what) { socket.emit('groupError', { message: 'Dis ce que tu apportes !' }); return; }

    removeFromEverywhere(name);
    autreGroups.push({ id: autreSeq++, item: what, member: name });
    io.emit('state', getState());
  });

  socket.on('leaveGroup', () => {
    const name = socket.data.name;
    if (!name) return;
    removeFromEverywhere(name);
    io.emit('state', getState());
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    if (name && nameToSocket.get(name) === socket.id) {
      nameToSocket.set(name, null); // reste inscrit, juste hors ligne
    }
    io.emit('state', getState());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur lancé sur http://localhost:${PORT}`));
