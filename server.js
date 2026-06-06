const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const THEMES = [
  { id: 'boisson',   label: 'Boisson',   emoji: '🥤' },
  { id: 'saucisson', label: 'Saucisson', emoji: '🥖' },
  { id: 'gateau',    label: 'Gâteau',    emoji: '🎂' },
  { id: 'chips',     label: 'Chips',     emoji: '🥨' },
  { id: 'autre',     label: 'Autre',     emoji: '✨' },
];

const MAX_MEMBERS = 3;

// Persistent state (by name, not socketId)
const registeredNames = new Set();        // all students who ever joined
const nameToSocket = new Map();           // name -> active socketId (or null)
const groups = {};                        // themeId -> { name, members: [studentName] }

THEMES.forEach(t => {
  groups[t.id] = { name: null, members: [] };
});

function activeCount() {
  let n = 0;
  nameToSocket.forEach(sid => { if (sid) n++; });
  return n;
}

function getState() {
  const takenSpots = Object.values(groups).reduce((a, g) => a + g.members.length, 0);
  return {
    themes: THEMES,
    groups,
    students: Array.from(registeredNames),
    connected: activeCount(),
    totalSpots: THEMES.length * MAX_MEMBERS,
    takenSpots,
  };
}

io.on('connection', (socket) => {
  // Send current state to newcomer
  socket.emit('state', getState());

  socket.on('join', ({ name }) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    // Case-insensitive duplicate check — find canonical name
    let canonical = trimmed;
    for (const n of registeredNames) {
      if (n.toLowerCase() === trimmed.toLowerCase()) { canonical = n; break; }
    }

    // Mark old socket as gone if different
    if (nameToSocket.has(canonical)) {
      const oldSid = nameToSocket.get(canonical);
      if (oldSid && oldSid !== socket.id) {
        // Disconnect old socket gracefully
        const oldSocket = io.sockets.sockets.get(oldSid);
        if (oldSocket) oldSocket.disconnect(true);
      }
    }

    registeredNames.add(canonical);
    nameToSocket.set(canonical, socket.id);
    socket.data.name = canonical;

    socket.emit('joined', { name: canonical });
    io.emit('state', getState());
  });

  socket.on('joinGroup', ({ themeId, groupName }) => {
    const name = socket.data.name;
    if (!name) return;

    const group = groups[themeId];
    if (!group) return;

    // Remove from any existing group
    Object.values(groups).forEach(g => {
      g.members = g.members.filter(m => m !== name);
      if (g.members.length === 0) g.name = null;
    });

    if (group.members.length >= MAX_MEMBERS) {
      socket.emit('groupError', { message: 'Ce groupe est complet !' });
      return;
    }

    if (group.members.length === 0 && groupName && groupName.trim()) {
      group.name = groupName.trim();
    }

    group.members.push(name);
    io.emit('state', getState());
  });

  socket.on('leaveGroup', () => {
    const name = socket.data.name;
    Object.values(groups).forEach(g => {
      g.members = g.members.filter(m => m !== name);
      if (g.members.length === 0) g.name = null;
    });
    io.emit('state', getState());
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    if (name && nameToSocket.get(name) === socket.id) {
      nameToSocket.set(name, null); // keep in list, just mark offline
    }
    io.emit('state', getState());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur lancé sur http://localhost:${PORT}`));
