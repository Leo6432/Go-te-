const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Délégués + admin (Léo peut ajouter des gens dans une pizza)
const DELEGATES = {
  louna:  'la déléguée',
  tom:    'le délégué',
  romane: 'la déléguée',
  leo:    'le délégué',
};
const ADMIN_KEY = 'leo';

const SIZES = ['Petite', 'Grande', 'Méga'];
const SIZE_MAX = { Petite: 1, Grande: 3, 'Méga': 4 };
const SIZE_PRICE = { Petite: '9€', Grande: '13,50€', 'Méga': '18,50€' };
const SIZE_LABEL = { Petite: '1 pers.', Grande: '3 pers.', 'Méga': '3/4 pers.' };

function normalize(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// ===== ÉTAT =====
const registeredNames = new Map();   // normalized -> displayName
const nameToSocket = new Map();      // displayName -> socketId | null
let pizzas = [];                     // [{ id, name, size, members: [displayName] }]
let pizzaSeq = 1;

// ===== PERSISTANCE (Upstash Redis) =====
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = 'gouter:state:v2';
const persistenceOn = !!(REDIS_URL && REDIS_TOKEN);

async function redisCmd(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
  return (await res.json()).result;
}

function snapshot() {
  return {
    registeredNames: Array.from(registeredNames.entries()),
    pizzas,
    pizzaSeq,
  };
}

function applySnapshot(data) {
  if (!data) return;
  registeredNames.clear();
  (data.registeredNames || []).forEach(([k, v]) => registeredNames.set(k, v));
  pizzas = data.pizzas || [];
  pizzaSeq = data.pizzaSeq || 1;
  nameToSocket.clear();
  registeredNames.forEach(displayName => nameToSocket.set(displayName, null));
}

async function loadState() {
  if (!persistenceOn) { console.log('💾 Persistance OFF (mémoire seule)'); return; }
  try {
    const raw = await redisCmd(['GET', REDIS_KEY]);
    if (raw) { applySnapshot(JSON.parse(raw)); console.log('💾 État restauré depuis Redis'); }
    else console.log('💾 Persistance ON (base vide pour l\'instant)');
  } catch (e) {
    console.error('⚠️ Échec du chargement Redis :', e.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (!persistenceOn) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await redisCmd(['SET', REDIS_KEY, JSON.stringify(snapshot())]); }
    catch (e) { console.error('⚠️ Échec sauvegarde Redis :', e.message); }
  }, 400);
}

function broadcastState() {
  io.emit('state', getState());
  scheduleSave();
}

function activeCount() {
  let n = 0;
  nameToSocket.forEach(sid => { if (sid) n++; });
  return n;
}

function removeFromAllPizzas(name) {
  pizzas.forEach(p => { p.members = p.members.filter(m => m !== name); });
}

function findMyPizza(name) {
  return pizzas.find(p => p.members.includes(name)) || null;
}

function getState() {
  return {
    sizes: SIZES,
    sizeMax: SIZE_MAX,
    sizePrice: SIZE_PRICE,
    sizeLabel: SIZE_LABEL,
    pizzas,
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

    let displayName = registeredNames.get(key);
    if (!displayName) {
      displayName = raw;
      registeredNames.set(key, displayName);
    }

    const oldSid = nameToSocket.get(displayName);
    if (oldSid && oldSid !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSid);
      if (oldSocket) oldSocket.disconnect(true);
    }

    nameToSocket.set(displayName, socket.id);
    socket.data.name = displayName;

    const delegateLabel = DELEGATES[key] || null;
    const isAdmin = key === ADMIN_KEY;
    socket.emit('joined', { name: displayName, delegateLabel, isAdmin });
    broadcastState();
  });

  // Créer une nouvelle pizza
  socket.on('createPizza', ({ name: pizzaName, size }) => {
    const who = socket.data.name;
    if (!who) return;
    const pName = (pizzaName || '').trim();
    if (!pName) { socket.emit('groupError', { message: 'Donne un nom à la pizza !' }); return; }
    if (!SIZES.includes(size)) { socket.emit('groupError', { message: 'Taille invalide' }); return; }

    removeFromAllPizzas(who);
    pizzas.push({ id: pizzaSeq++, name: pName, size, members: [who] });
    broadcastState();
  });

  // Rejoindre une pizza existante
  socket.on('joinPizza', ({ pizzaId }) => {
    const who = socket.data.name;
    if (!who) return;
    const pizza = pizzas.find(p => p.id === pizzaId);
    if (!pizza) return;

    const alreadyHere = pizza.members.includes(who);
    const max = SIZE_MAX[pizza.size] || 4;
    if (!alreadyHere && pizza.members.length >= max) {
      socket.emit('groupError', { message: 'Désolé, cette pizza est complète !' });
      return;
    }

    removeFromAllPizzas(who);
    pizza.members.push(who);
    broadcastState();
  });

  // Quitter sa pizza
  socket.on('leavePizza', () => {
    const who = socket.data.name;
    if (!who) return;
    removeFromAllPizzas(who);
    broadcastState();
  });

  // Admin (Léo) : ajouter quelqu'un dans une pizza
  socket.on('adminAddMember', ({ pizzaId, name }) => {
    if (normalize(socket.data.name || '') !== ADMIN_KEY) return;
    const raw = (name || '').trim();
    if (!raw) return;
    const key = normalize(raw);
    if (!key) return;
    const pizza = pizzas.find(p => p.id === pizzaId);
    if (!pizza) return;

    let displayName = registeredNames.get(key);
    if (!displayName) {
      displayName = raw;
      registeredNames.set(key, displayName);
      nameToSocket.set(displayName, null);
    }

    removeFromAllPizzas(displayName);
    pizza.members.push(displayName);
    broadcastState();
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    if (name && nameToSocket.get(name) === socket.id) {
      nameToSocket.set(name, null);
    }
    broadcastState();
  });
});

app.get('/ping', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
loadState().then(() => {
  server.listen(PORT, () => console.log(`Serveur lancé sur http://localhost:${PORT}`));
});

const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => { fetch(`${SELF_URL}/ping`).catch(() => {}); }, 10 * 60 * 1000);
  console.log('🟢 Anti-sommeil activé');
}
