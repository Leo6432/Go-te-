const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const THEMES = [
  { id: 'boisson',   label: 'Boisson',   emoji: '🥤', color: '#4FC3F7' },
  { id: 'saucisson', label: 'Saucisson', emoji: '🥖', color: '#FF8A65' },
  { id: 'gateau',    label: 'Gâteau',    emoji: '🎂', color: '#CE93D8' },
  { id: 'chips',     label: 'Chips',     emoji: '🥨', color: '#FFCC02' },
  { id: 'autre',     label: 'Autre',     emoji: '✨', color: '#A5D6A7' },
];

const MAX_MEMBERS = 3;

// State
const groups = {};      // themeId -> { name, members: [{ name, socketId }] }
const students = {};    // socketId -> { name }
let connected = 0;

THEMES.forEach(t => {
  groups[t.id] = { name: null, members: [] };
});

function getState() {
  return {
    themes: THEMES,
    groups,
    students: Object.values(students).map(s => s.name),
    connected,
    totalSpots: THEMES.length * MAX_MEMBERS,
    takenSpots: Object.values(groups).reduce((acc, g) => acc + g.members.length, 0),
  };
}

io.on('connection', (socket) => {
  connected++;

  socket.on('join', ({ name }) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    // Check not already registered under different socket
    const alreadyExists = Object.values(students).some(s => s.name.toLowerCase() === trimmed.toLowerCase());
    if (alreadyExists) {
      // Find existing socket with that name and reassign
      const existingEntry = Object.entries(students).find(([, s]) => s.name.toLowerCase() === trimmed.toLowerCase());
      if (existingEntry) {
        const [oldSocketId] = existingEntry;
        delete students[oldSocketId];
        // Update member references in groups
        Object.values(groups).forEach(g => {
          g.members.forEach(m => {
            if (m.socketId === oldSocketId) m.socketId = socket.id;
          });
        });
      }
    }

    students[socket.id] = { name: trimmed };
    socket.emit('joined', { name: trimmed });
    io.emit('state', getState());
  });

  socket.on('joinGroup', ({ themeId, groupName }) => {
    const student = students[socket.id];
    if (!student) return;

    const group = groups[themeId];
    if (!group) return;

    // Remove from any existing group first
    Object.values(groups).forEach(g => {
      g.members = g.members.filter(m => m.socketId !== socket.id);
    });

    if (group.members.length >= MAX_MEMBERS) {
      socket.emit('error', { message: 'Ce groupe est complet !' });
      return;
    }

    const isFirst = group.members.length === 0;
    if (isFirst && groupName && groupName.trim()) {
      group.name = groupName.trim();
    }

    group.members.push({ name: student.name, socketId: socket.id });
    io.emit('state', getState());
  });

  socket.on('leaveGroup', () => {
    Object.values(groups).forEach(g => {
      g.members = g.members.filter(m => m.socketId !== socket.id);
      // Reset name if empty
      if (g.members.length === 0) g.name = null;
    });
    io.emit('state', getState());
  });

  socket.on('disconnect', () => {
    connected = Math.max(0, connected - 1);
    // Keep name in students so they can reconnect; remove from groups
    delete students[socket.id];
    Object.values(groups).forEach(g => {
      g.members = g.members.filter(m => m.socketId !== socket.id);
      if (g.members.length === 0) g.name = null;
    });
    io.emit('state', getState());
  });

  socket.emit('state', getState());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
