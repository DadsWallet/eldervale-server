const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors({ origin: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = new Map(); // roomId -> room
const playerRoom = new Map(); // socketId -> roomId
const SERVER_TICK_MS = 50;
const GAME_STATE_EMIT_MS = 180;
const PLAYER_RECONNECT_GRACE_MS = 3 * 60 * 1000;
const EMPTY_STARTED_ROOM_GRACE_MS = 8 * 60 * 1000;

const DIFFICULTY_MULT = Object.freeze({
  easy: 0.7,
  medium: 1.0,
  hard: 1.5,
  impossible: 2.0,
});

const WOLF_LEASH = Object.freeze({
  minX: 950,
  maxX: 1860,
  minY: 100,
  maxY: 1080,
});

const BANDIT_LEASH = Object.freeze({
  minX: 900,
  maxX: 1760,
  minY: 250,
  maxY: 1380,
});

const DIRE_LEASH = Object.freeze({
  minX: 1280,
  maxX: 1860,
  minY: 80,
  maxY: 370,
});

const WARLORD_CAVE_LEASH = Object.freeze({
  minX: 90,
  maxX: 820,
  minY: 90,
  maxY: 570,
});

const QUEST_NUM_KEYS = Object.freeze([
  "wolvesSlain",
  "banditsSlain",
  "finalWaveTotalKills",
]);

const QUEST_BOOL_KEYS = Object.freeze([
  "gotPelt",
  "direDefeated",
  "foundCrowbar",
  "openedCave",
  "caveCrestTaken",
  "askedAboutDarkPrince",
  "wizardGateOpened",
  "gotCrest",
  "crestTauntPlayed",
  "warlordDefeated",
  "finalWaveStarted",
  "finalWaveKeyTaken",
  "finalMazeKeyTaken",
  "finalFangPlaced",
  "finalSignetPlaced",
  "finalMiniTriggered",
  "finalMiniDefeated",
  "finalDarkDefeated",
]);

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function roomDifficultyMult(room) {
  const id = String(room?.difficulty || "medium");
  return DIFFICULTY_MULT[id] || 1;
}

function roomPartySize(room) {
  return Math.max(1, connectedPlayers(room).length || 1);
}

function connectedPlayers(room) {
  if (!room || !Array.isArray(room.players)) return [];
  return room.players.filter((p) => p && p.connected !== false);
}

function normalizeClientId(raw, socketId) {
  const value = String(raw || "").trim().slice(0, 96);
  if (value) return value;
  return `sock_${String(socketId || "").slice(0, 24)}`;
}

function defaultQuestSync() {
  return {
    stage: 0,
    wolvesSlain: 0,
    gotPelt: false,
    direDefeated: false,
    banditsSlain: 0,
    foundCrowbar: false,
    openedCave: false,
    caveCrestTaken: false,
    askedAboutDarkPrince: false,
    wizardGateOpened: false,
    gotCrest: false,
    crestTauntPlayed: false,
    warlordDefeated: false,
    finalWaveStarted: false,
    finalWaveTotalKills: 0,
    finalWaveKeyTaken: false,
    finalMazeKeyTaken: false,
    finalFangPlaced: false,
    finalSignetPlaced: false,
    finalMiniTriggered: false,
    finalMiniDefeated: false,
    finalDarkDefeated: false,
  };
}

function sanitizeQuestSync(raw) {
  const base = defaultQuestSync();
  const stage = Math.max(0, Number(raw?.stage) || 0);
  const out = { ...base, stage };
  for (const key of QUEST_NUM_KEYS) {
    out[key] = Math.max(0, Number(raw?.[key]) || 0);
  }
  for (const key of QUEST_BOOL_KEYS) {
    out[key] = !!raw?.[key];
  }
  return out;
}

function mergeQuestSync(target, incoming) {
  if (!incoming || typeof incoming !== "object") return false;
  let changed = false;

  const nextStage = Math.max(0, Number(incoming.stage) || 0);
  if (nextStage > target.stage) {
    target.stage = nextStage;
    changed = true;
  }

  for (const key of QUEST_NUM_KEYS) {
    const next = Math.max(0, Number(incoming[key]) || 0);
    if (next > target[key]) {
      target[key] = next;
      changed = true;
    }
  }

  for (const key of QUEST_BOOL_KEYS) {
    if (incoming[key] === true && !target[key]) {
      target[key] = true;
      changed = true;
    }
  }

  return changed;
}

function serializeEnemy(e) {
  if (!e) return null;
  return {
    id: e.id,
    map: e.map,
    type: e.type,
    name: e.name,
    x: Number(e.x) || 0,
    y: Number(e.y) || 0,
    r: Number(e.r) || 15,
    hp: Number(e.hp) || 0,
    maxHp: Number(e.maxHp) || 1,
    damage: Number(e.damage) || 1,
    speed: Number(e.speed) || 90,
    alive: e.alive !== false,
    animT: Number(e.animT) || 0,
  };
}

function makeRoomId() {
  return `room_${Math.random().toString(36).slice(2, 10)}`;
}

function randomWolfPos() {
  return {
    x: 1000 + Math.random() * 780,
    y: 150 + Math.random() * 840,
  };
}

function randomBanditPos() {
  return {
    x: 930 + Math.random() * 780,
    y: 280 + Math.random() * 1000,
  };
}

function createWolf(room, id) {
  const diff = roomDifficultyMult(room);
  const party = roomPartySize(room);
  const hp = Math.max(1, Math.round(58 * 1.5 * diff * party));
  const damage = Math.max(1, Math.round(6 * 1.5 * diff));
  const pos = randomWolfPos();
  return {
    id,
    type: "wolf",
    map: "silver",
    name: `Wolf #${id}`,
    x: pos.x,
    y: pos.y,
    r: 15,
    hp,
    maxHp: hp,
    damage,
    speed: 104,
    hitCd: 0,
    windup: 0,
    alive: true,
    animT: Math.random() * 10,
    wanderA: Math.random() * Math.PI * 2,
  };
}

function createBandit(room, id) {
  const diff = roomDifficultyMult(room);
  const party = roomPartySize(room);
  const hp = Math.max(1, Math.round(96 * 1.5 * diff * party));
  const damage = Math.max(1, Math.round(8 * 1.5 * diff));
  const pos = randomBanditPos();
  return {
    id,
    type: "bandit",
    map: "iron",
    name: `Bandit #${id}`,
    x: pos.x,
    y: pos.y,
    r: 16,
    hp,
    maxHp: hp,
    damage,
    speed: 110,
    hitCd: 0,
    windup: 0,
    alive: true,
    animT: Math.random() * 10,
    wanderA: Math.random() * Math.PI * 2,
  };
}

function createDireWolf(room) {
  const diff = roomDifficultyMult(room);
  const party = roomPartySize(room);
  const hp = Math.max(1, Math.round(360 * 1.5 * diff * party));
  const damage = Math.max(1, Math.round(12 * 1.5 * diff));
  return {
    id: "dire_alpha",
    type: "dire",
    map: "silver",
    name: "Dire Wolf",
    x: 1560,
    y: 200,
    r: 23,
    hp,
    maxHp: hp,
    damage,
    speed: 126,
    hitCd: 0,
    windup: 0,
    alive: true,
    animT: 0,
    wanderA: Math.random() * Math.PI * 2,
  };
}

function createWarlord(room) {
  const diff = roomDifficultyMult(room);
  const party = roomPartySize(room);
  const hp = Math.max(1, Math.round(480 * 1.5 * diff * party));
  const damage = Math.max(1, Math.round(16 * 1.5 * diff));
  return {
    id: "warlord_overseer",
    type: "warlord",
    map: "cave",
    name: "Bandit Warlord",
    x: 690,
    y: 230,
    r: 24,
    hp,
    maxHp: hp,
    damage,
    speed: 118,
    hitCd: 0,
    windup: 0,
    alive: true,
    animT: 0,
    wanderA: Math.random() * Math.PI * 2,
  };
}

function initRoomGame(room) {
  if (room.game) return;
  room.game = {
    questSync: defaultQuestSync(),
    phase1: {
      nextWolfId: 1,
      wolves: [],
      lastEmitAt: 0,
    },
    phase2: {
      nextBanditId: 1,
      bandits: [],
      direWolf: null,
      warlord: null,
    },
  };
  for (let i = 0; i < 10; i += 1) {
    room.game.phase1.wolves.push(createWolf(room, room.game.phase1.nextWolfId));
    room.game.phase1.nextWolfId += 1;
  }
}

function ensurePhase2Spawns(room) {
  if (!room?.game) return;
  const q = room.game.questSync;
  const phase2 = room.game.phase2;

  if (q.stage >= 10 && phase2.bandits.length === 0) {
    for (let i = 0; i < 10; i += 1) {
      phase2.bandits.push(createBandit(room, phase2.nextBanditId));
      phase2.nextBanditId += 1;
    }
  }

  if (q.stage >= 6 && !q.direDefeated && (!phase2.direWolf || phase2.direWolf.alive === false)) {
    phase2.direWolf = createDireWolf(room);
  }
  if (q.direDefeated) {
    phase2.direWolf = null;
  }

  if (q.stage >= 14 && !q.warlordDefeated && (!phase2.warlord || phase2.warlord.alive === false)) {
    phase2.warlord = createWarlord(room);
  }
  if (q.warlordDefeated) {
    phase2.warlord = null;
  }
}

function makeGamePublic(room) {
  const phase1 = room?.game?.phase1 || {};
  const phase2 = room?.game?.phase2 || {};
  const questSync = sanitizeQuestSync(room?.game?.questSync || {});
  const wolves = Array.isArray(phase1.wolves) ? phase1.wolves : [];
  const bandits = Array.isArray(phase2.bandits) ? phase2.bandits : [];
  const direWolf = phase2.direWolf || null;
  const warlord = phase2.warlord || null;

  return {
    quest: questSync,
    phase1: {
      quest: {
        wolvesSlain: questSync.wolvesSlain,
        gotPelt: questSync.gotPelt,
      },
      wolves: wolves.map((w) => serializeEnemy(w)),
    },
    phase2: {
      quest: {
        banditsSlain: questSync.banditsSlain,
        direDefeated: questSync.direDefeated,
        warlordDefeated: questSync.warlordDefeated,
      },
      bandits: bandits.map((b) => serializeEnemy(b)),
      direWolf: serializeEnemy(direWolf),
      warlord: serializeEnemy(warlord),
    },
  };
}

function emitGameState(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.game) return;
  io.to(roomId).emit("game:state", {
    roomId,
    state: makeGamePublic(room),
  });
}

function emitQuestSync(roomId) {
  const room = rooms.get(roomId);
  if (!room?.game) return;
  io.to(roomId).emit("quest:sync", {
    roomId,
    quest: sanitizeQuestSync(room.game.questSync),
  });
}

function makeRoomPublic(room) {
  const players = connectedPlayers(room);
  return {
    id: room.id,
    name: room.name,
    difficulty: room.difficulty,
    maxPlayers: room.maxPlayers,
    started: room.started,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      leader: p.leader,
      state: p.state || null,
    })),
    createdAt: room.createdAt || Date.now(),
  };
}

function emitRoomUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("room:update", makeRoomPublic(room));
}

function activePlayersOnMap(room, mapId) {
  return connectedPlayers(room).filter(
    (p) => p?.state?.map === mapId && Number.isFinite(p.state.x) && Number.isFinite(p.state.y),
  );
}

function roomLeader(room) {
  const active = connectedPlayers(room);
  return active.find((p) => p.leader) || active[0] || null;
}

function updateEnemyAI(enemy, players, dt, leash) {
  if (!enemy?.alive) return;

  enemy.animT += dt * 8;
  enemy.hitCd = Math.max(0, enemy.hitCd - dt);

  if (enemy.windup > 0) {
    enemy.windup -= dt;
    if (enemy.windup <= 0) enemy.hitCd = enemy.type === "warlord" ? 0.9 : 1.05;
    return;
  }

  let target = null;
  let targetDist = Infinity;
  for (const player of players) {
    const d = dist(enemy, player.state);
    if (d < targetDist) {
      targetDist = d;
      target = player.state;
    }
  }

  if (target && targetDist < 245) {
    const vx = (target.x - enemy.x) / (targetDist || 1);
    const vy = (target.y - enemy.y) / (targetDist || 1);
    enemy.x += vx * enemy.speed * dt;
    enemy.y += vy * enemy.speed * dt;

    if (targetDist < enemy.r + 14 + 14 && enemy.hitCd <= 0) {
      enemy.windup = enemy.type === "warlord" ? 0.48 : enemy.type === "dire" ? 0.42 : 0.34;
    }
  } else {
    enemy.wanderA += (Math.random() - 0.5) * dt;
    enemy.x += Math.cos(enemy.wanderA) * 38 * dt;
    enemy.y += Math.sin(enemy.wanderA) * 38 * dt;
  }

  enemy.x = clamp(enemy.x, leash.minX, leash.maxX);
  enemy.y = clamp(enemy.y, leash.minY, leash.maxY);
}

function updateRoomEnemies(room, dt) {
  const game = room.game;
  if (!game) return;

  ensurePhase2Spawns(room);

  const wolves = game.phase1.wolves;
  const silverPlayers = activePlayersOnMap(room, "silver");
  for (const wolf of wolves) updateEnemyAI(wolf, silverPlayers, dt, WOLF_LEASH);

  const aliveWolves = wolves.filter((w) => w.alive).length;
  if (aliveWolves < 5) {
    for (let i = 0; i < 3; i += 1) {
      wolves.push(createWolf(room, game.phase1.nextWolfId));
      game.phase1.nextWolfId += 1;
    }
  }

  const q = game.questSync;
  const phase2 = game.phase2;

  if (q.stage >= 10) {
    const ironPlayers = activePlayersOnMap(room, "iron");
    for (const bandit of phase2.bandits) updateEnemyAI(bandit, ironPlayers, dt, BANDIT_LEASH);
    const aliveBandits = phase2.bandits.filter((b) => b.alive).length;
    if (aliveBandits < 5) {
      for (let i = 0; i < 4; i += 1) {
        phase2.bandits.push(createBandit(room, phase2.nextBanditId));
        phase2.nextBanditId += 1;
      }
    }
  }

  if (phase2.direWolf && !q.direDefeated) {
    updateEnemyAI(phase2.direWolf, silverPlayers, dt, DIRE_LEASH);
  }

  if (phase2.warlord && !q.warlordDefeated) {
    const cavePlayers = activePlayersOnMap(room, "cave");
    updateEnemyAI(phase2.warlord, cavePlayers, dt, WARLORD_CAVE_LEASH);
  }
}

function withinMeleeRange(playerState, enemy, isHeavy) {
  const range = isHeavy ? 96 : 68;
  const dx = playerState.x - enemy.x;
  const dy = playerState.y - enemy.y;
  const maxDist = range + enemy.r + 20;
  return dx * dx + dy * dy <= maxDist * maxDist;
}

function applyEnemyDamage(enemy, amount) {
  const dmg = clamp(Math.round(Number(amount) || 0), 1, 999);
  enemy.hp -= dmg;
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    enemy.alive = false;
    return true;
  }
  return false;
}

function pruneRoomStaleMembers(room, now = Date.now()) {
  if (!room || !Array.isArray(room.players)) return;

  room.players = room.players.filter((p) => {
    if (!p) return false;
    if (p.connected !== false) return true;
    const disconnectedAt = Number(p.disconnectedAt) || 0;
    return now - disconnectedAt <= PLAYER_RECONNECT_GRACE_MS;
  });

  if (room.players.length > 0 && !room.players.some((p) => p.leader && p.connected !== false)) {
    const firstConnected = room.players.find((p) => p.connected !== false);
    if (firstConnected) firstConnected.leader = true;
  }
}

let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTickAt) / 1000, 0.2);
  lastTickAt = now;

  for (const [roomId, room] of rooms.entries()) {
    pruneRoomStaleMembers(room, now);

    if (room.players.length === 0) {
      rooms.delete(roomId);
      continue;
    }

    if (room.started && connectedPlayers(room).length === 0) {
      room.emptySince = room.emptySince || now;
      if (now - room.emptySince > EMPTY_STARTED_ROOM_GRACE_MS) {
        rooms.delete(roomId);
        continue;
      }
    } else {
      room.emptySince = 0;
    }

    if (!room.started || !room.game) continue;
    updateRoomEnemies(room, dt);

    if (now - room.game.phase1.lastEmitAt >= GAME_STATE_EMIT_MS) {
      room.game.phase1.lastEmitAt = now;
      emitGameState(roomId);
    }
  }
}, SERVER_TICK_MS);

io.on("connection", (socket) => {
  socket.on("room:list", (ack) => {
    const list = [...rooms.values()]
      .filter((r) => !r.started)
      .map((r) => makeRoomPublic(r));
    if (ack) ack(list);
  });

  socket.on("room:create", (payload, ack) => {
    const clientId = normalizeClientId(payload?.clientId, socket.id);
    const room = {
      id: makeRoomId(),
      name: String(payload.name || "Party").slice(0, 36),
      code: String(payload.code || ""),
      difficulty: String(payload.difficulty || "medium"),
      maxPlayers: Math.max(1, Math.min(4, Number(payload.maxPlayers) || 1)),
      started: false,
      createdAt: Date.now(),
      emptySince: 0,
      game: null,
      players: [
        {
          id: socket.id,
          clientId,
          name: String(payload.hostName || "Host").slice(0, 20),
          ready: false,
          leader: true,
          connected: true,
          disconnectedAt: 0,
          state: null,
        },
      ],
    };

    rooms.set(room.id, room);
    playerRoom.set(socket.id, room.id);
    socket.join(room.id);

    if (ack) ack({ ok: true, room: makeRoomPublic(room) });
    emitRoomUpdate(room.id);
  });

  socket.on("room:join", (payload, ack) => {
    const room = rooms.get(payload?.roomId);
    if (!room) return ack?.({ ok: false, error: "Room not found" });

    const clientId = normalizeClientId(payload?.clientId, socket.id);
    const existingByClient = room.players.find((p) => p.clientId === clientId);

    if (!existingByClient) {
      if (room.started) return ack?.({ ok: false, error: "Room already started" });
      if (room.code !== String(payload.code || "")) return ack?.({ ok: false, error: "Wrong room code" });
      if (room.players.length >= room.maxPlayers) return ack?.({ ok: false, error: "Room full" });

      room.players.push({
        id: socket.id,
        clientId,
        name: String(payload.name || "Player").slice(0, 20),
        ready: false,
        leader: false,
        connected: true,
        disconnectedAt: 0,
        state: null,
      });
    } else {
      const oldSocketId = existingByClient.id;
      existingByClient.id = socket.id;
      existingByClient.connected = true;
      existingByClient.disconnectedAt = 0;
      if (payload?.name) existingByClient.name = String(payload.name).slice(0, 20);
      if (oldSocketId && oldSocketId !== socket.id) playerRoom.delete(oldSocketId);
    }

    playerRoom.set(socket.id, room.id);
    room.emptySince = 0;
    socket.join(room.id);
    ack?.({ ok: true, room: makeRoomPublic(room) });
    emitRoomUpdate(room.id);
    if (room.started) {
      emitQuestSync(room.id);
      emitGameState(room.id);
    }
  });

  socket.on("room:reconnect", (payload, ack) => {
    const roomId = payload?.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      ack?.({ ok: false, error: "Room not found" });
      return;
    }

    const clientId = normalizeClientId(payload?.clientId, socket.id);
    const player = room.players.find((p) => p.clientId === clientId);
    if (!player) {
      ack?.({ ok: false, error: "Player slot not found" });
      return;
    }

    const oldSocketId = player.id;
    player.id = socket.id;
    player.connected = true;
    player.disconnectedAt = 0;
    if (payload?.name) player.name = String(payload.name).slice(0, 20);

    if (oldSocketId && oldSocketId !== socket.id) playerRoom.delete(oldSocketId);
    playerRoom.set(socket.id, room.id);
    room.emptySince = 0;
    socket.join(room.id);

    ack?.({
      ok: true,
      room: makeRoomPublic(room),
      state: room.started && room.game ? makeGamePublic(room) : null,
      quest: room.started && room.game ? sanitizeQuestSync(room.game.questSync) : null,
    });

    emitRoomUpdate(room.id);
    if (room.started) {
      emitQuestSync(room.id);
      emitGameState(room.id);
    }
  });

  socket.on("room:ready", (payload) => {
    const roomId = payload.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    player.connected = true;
    player.disconnectedAt = 0;

    player.ready = !!payload.ready;
    if (payload.name) player.name = String(payload.name).slice(0, 20);

    emitRoomUpdate(room.id);

    const active = connectedPlayers(room);
    if (active.length > 0 && active.every((p) => p.ready)) {
      room.started = true;
      initRoomGame(room);
      io.to(room.id).emit("game:start", {
        roomId: room.id,
        roomName: room.name,
        difficulty: room.difficulty,
        playerCount: active.length,
      });
      emitRoomUpdate(room.id);
      emitQuestSync(room.id);
      emitGameState(room.id);
    }
  });

  socket.on("player:state", (payload) => {
    const roomId = payload.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.started !== true) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    player.state = payload.state || null;
    player.connected = true;
    player.disconnectedAt = 0;
    socket.to(room.id).emit("player:state", { id: socket.id, state: player.state });
  });

  socket.on("quest:sync", (payload, ack) => {
    const roomId = payload?.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || !room.started) {
      ack?.({ ok: false, error: "Room not active" });
      return;
    }

    initRoomGame(room);
    const incoming = {
      stage: Number(payload?.stage) || 0,
      ...(payload?.quest || {}),
    };
    const changed = mergeQuestSync(room.game.questSync, incoming);

    ensurePhase2Spawns(room);

    if (changed) {
      emitQuestSync(room.id);
      emitGameState(room.id);
    }

    ack?.({ ok: true, quest: sanitizeQuestSync(room.game.questSync) });
  });

  socket.on("quest:phase1:update", (payload, ack) => {
    const roomId = payload?.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || !room.started) {
      ack?.({ ok: false, error: "Room not active" });
      return;
    }

    initRoomGame(room);
    const changed = mergeQuestSync(room.game.questSync, {
      gotPelt: payload?.gotPelt === true,
    });

    if (changed) {
      io.to(room.id).emit("quest:phase1:update", {
        roomId: room.id,
        quest: {
          wolvesSlain: room.game.questSync.wolvesSlain,
          gotPelt: room.game.questSync.gotPelt,
        },
      });
      emitQuestSync(room.id);
      emitGameState(room.id);
    }

    ack?.({
      ok: true,
      quest: {
        wolvesSlain: room.game.questSync.wolvesSlain,
        gotPelt: room.game.questSync.gotPelt,
      },
    });
  });

  socket.on("wolf:hit", (payload, ack) => {
    const roomId = payload?.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || !room.started) {
      ack?.({ ok: false, error: "Room not active" });
      return;
    }

    initRoomGame(room);
    const player = room.players.find((p) => p.id === socket.id);
    if (!player?.state || player.state.map !== "silver") {
      ack?.({ ok: false, error: "Player not in Silver Keep" });
      return;
    }

    const wolfId = Number(payload?.wolfId);
    const wolf = room.game.phase1.wolves.find((w) => w.id === wolfId && w.alive);
    if (!wolf) {
      ack?.({ ok: false, error: "Wolf not found" });
      return;
    }

    const isHeavy = !!payload?.heavy;
    if (!withinMeleeRange(player.state, wolf, isHeavy)) {
      ack?.({ ok: false, error: "Out of range" });
      return;
    }

    const killed = applyEnemyDamage(wolf, payload?.damage);
    if (killed) {
      room.game.questSync.wolvesSlain += 1;
      io.to(room.id).emit("wolf:slain", {
        roomId: room.id,
        wolfId: wolf.id,
        killerId: socket.id,
        wolvesSlain: room.game.questSync.wolvesSlain,
        gotPelt: room.game.questSync.gotPelt,
        x: wolf.x,
        y: wolf.y,
      });
      emitQuestSync(room.id);
    }

    emitGameState(room.id);
    ack?.({ ok: true, killed, hp: wolf.hp });
  });

  socket.on("enemy:hit", (payload, ack) => {
    const roomId = payload?.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || !room.started) {
      ack?.({ ok: false, error: "Room not active" });
      return;
    }

    initRoomGame(room);
    const player = room.players.find((p) => p.id === socket.id);
    if (!player?.state) {
      ack?.({ ok: false, error: "Missing player state" });
      return;
    }

    const enemyType = String(payload?.enemyType || "");
    const enemyId = payload?.enemyId;
    let enemy = null;

    if (enemyType === "bandit") {
      const banditId = Number(enemyId);
      enemy = room.game.phase2.bandits.find((b) => b.id === banditId && b.alive);
    } else if (enemyType === "dire") {
      enemy = room.game.phase2.direWolf && room.game.phase2.direWolf.alive ? room.game.phase2.direWolf : null;
    } else if (enemyType === "warlord") {
      enemy = room.game.phase2.warlord && room.game.phase2.warlord.alive ? room.game.phase2.warlord : null;
    }

    if (!enemy) {
      ack?.({ ok: false, error: "Enemy not found" });
      return;
    }

    if (player.state.map !== enemy.map) {
      ack?.({ ok: false, error: "Wrong map" });
      return;
    }

    const isHeavy = !!payload?.heavy;
    if (!withinMeleeRange(player.state, enemy, isHeavy)) {
      ack?.({ ok: false, error: "Out of range" });
      return;
    }

    const killed = applyEnemyDamage(enemy, payload?.damage);

    if (killed) {
      if (enemy.type === "bandit") {
        room.game.questSync.banditsSlain += 1;
      } else if (enemy.type === "dire") {
        room.game.questSync.direDefeated = true;
        room.game.phase2.direWolf = null;
      } else if (enemy.type === "warlord") {
        room.game.questSync.warlordDefeated = true;
        room.game.phase2.warlord = null;
      }

      io.to(room.id).emit("enemy:slain", {
        roomId: room.id,
        enemyType: enemy.type,
        enemyId: enemy.id,
        killerId: socket.id,
        x: enemy.x,
        y: enemy.y,
        quest: sanitizeQuestSync(room.game.questSync),
      });
      emitQuestSync(room.id);
    }

    emitGameState(room.id);
    ack?.({ ok: true, killed, hp: enemy.hp });
  });

  socket.on("wave:state", (payload) => {
    const roomId = payload?.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || !room.started) return;

    const leader = roomLeader(room);
    if (!leader || leader.id !== socket.id) return;

    io.to(room.id).emit("wave:state", {
      roomId: room.id,
      state: payload?.state || null,
    });
  });

  socket.on("wave:hit", (payload, ack) => {
    const roomId = payload?.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || !room.started) {
      ack?.({ ok: false, error: "Room not active" });
      return;
    }

    const leader = roomLeader(room);
    if (!leader) {
      ack?.({ ok: false, error: "Leader not found" });
      return;
    }

    if (leader.id === socket.id) {
      ack?.({ ok: false, error: "Leader should resolve locally" });
      return;
    }

    io.to(leader.id).emit("wave:hit", {
      roomId: room.id,
      enemyId: payload?.enemyId,
      damage: payload?.damage,
      heavy: !!payload?.heavy,
      fromId: socket.id,
    });
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const roomId = playerRoom.get(socket.id);
    playerRoom.delete(socket.id);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (!room.started) {
      room.players = room.players.filter((p) => p.id !== socket.id);
      if (room.players.length === 0) {
        rooms.delete(roomId);
        return;
      }
      if (!room.players.some((p) => p.leader)) {
        const firstConnected = room.players.find((p) => p.connected !== false) || room.players[0];
        if (firstConnected) firstConnected.leader = true;
      }
      emitRoomUpdate(roomId);
      return;
    }

    player.connected = false;
    player.disconnectedAt = Date.now();
    if (connectedPlayers(room).length === 0) room.emptySince = Date.now();
    emitRoomUpdate(roomId);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Multiplayer server running on http://localhost:${PORT}`);
});
