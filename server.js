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
  { id: 'bonbon',    label: 'Bonbons',   emoji: '🍬' },
  { id: 'vaisselle', label: 'Verres, papier & assiettes', emoji: '🥤' },
];
// "Autre" est spécial : chacun crée sa propre entrée (1 personne) avec ce qu'il apporte
const AUTRE = { id: 'autre', label: 'Autre', emoji: '✨' };

// Délégués (voient les stats) + leur libellé. Léo est aussi admin (peut ajouter des élèves).
const DELEGATES = {
  louna:  'la déléguée',
  tom:    'le délégué',
  romane: 'la déléguée',
  leo:    'le délégué',
};
const ADMIN_KEY = 'leo';

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

// ===== PERSISTANCE (Upstash Redis, optionnelle) =====
// Si les variables d'env Upstash sont présentes, on sauvegarde/charge l'état
// dans une base externe pour qu'il survive aux redémarrages. Sinon : mémoire seule.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = 'gouter:state';
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
    groups,
    autreGroups,
    autreSeq,
  };
}

function applySnapshot(data) {
  if (!data) return;
  registeredNames.clear();
  (data.registeredNames || []).forEach(([k, v]) => registeredNames.set(k, v));
  THEMES.forEach(t => { groups[t.id] = { members: (data.groups?.[t.id]?.members) || [] }; });
  autreGroups = data.autreGroups || [];
  autreSeq = data.autreSeq || 1;
  // Tous les inscrits sont hors ligne au démarrage (pas de socket actif)
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

// Diffuse l'état à tout le monde ET planifie une sauvegarde
function broadcastState() {
  io.emit('state', getState());
  scheduleSave();
}

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

    const delegateLabel = DELEGATES[key] || null;
    const isAdmin = key === ADMIN_KEY;
    socket.emit('joined', { name: displayName, delegateLabel, isAdmin });
    broadcastState();
  });

  // Réservé à l'admin (Léo) : ajouter un élève dans un thème classique
  socket.on('adminAddMember', ({ themeId, name }) => {
    if (normalize(socket.data.name || '') !== ADMIN_KEY) return;
    const raw = (name || '').trim();
    if (!raw) return;
    const key = normalize(raw);
    if (!key) return;
    const group = groups[themeId];
    if (!group) return;

    let displayName = registeredNames.get(key);
    if (!displayName) {
      displayName = raw;
      registeredNames.set(key, displayName);
      nameToSocket.set(displayName, null); // inscrit mais hors ligne
    }

    removeFromEverywhere(displayName);
    group.members.push(displayName);
    broadcastState();
  });

  const MAX_PER_THEME = 5;

  // Rejoindre un thème classique — max 5 personnes
  socket.on('joinTheme', ({ themeId }) => {
    const name = socket.data.name;
    if (!name) return;
    const group = groups[themeId];
    if (!group) return;

    // Si l'élève est déjà dans ce groupe, on ne compte pas sa place en double
    const alreadyHere = group.members.includes(name);
    if (!alreadyHere && group.members.length >= MAX_PER_THEME) {
      socket.emit('groupError', { message: 'Désolé, le groupe est complet !' });
      return;
    }

    removeFromEverywhere(name);
    group.members.push(name);
    broadcastState();
  });

  // Créer une entrée "Autre" : 1 personne, avec ce qu'elle apporte
  socket.on('joinAutre', ({ item }) => {
    const name = socket.data.name;
    if (!name) return;
    const what = (item || '').trim();
    if (!what) { socket.emit('groupError', { message: 'Dis ce que tu apportes !' }); return; }

    removeFromEverywhere(name);
    autreGroups.push({ id: autreSeq++, item: what, member: name });
    broadcastState();
  });

  socket.on('leaveGroup', () => {
    const name = socket.data.name;
    if (!name) return;
    removeFromEverywhere(name);
    broadcastState();
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    if (name && nameToSocket.get(name) === socket.id) {
      nameToSocket.set(name, null); // reste inscrit, juste hors ligne
    }
    broadcastState();
  });
});

// Petit endpoint santé pour l'anti-sommeil
app.get('/ping', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;

loadState().then(() => {
  server.listen(PORT, () => console.log(`Serveur lancé sur http://localhost:${PORT}`));
});

// ===== ANTI-SOMMEIL =====
// Sur Render gratuit, le serveur s'endort après 15 min d'inactivité.
// On se ping soi-même toutes les 10 min pour rester éveillé.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/ping`).catch(() => {});
  }, 10 * 60 * 1000);
  console.log('🟢 Anti-sommeil activé');
}
