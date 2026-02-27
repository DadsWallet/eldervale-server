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
  return Math.max(1, Number(room?.players?.length) || 1);
}

function randomWolfPos() {
  return {
    x: 1000 + Math.random() * 780,
    y: 150 + Math.random() * 840,
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

function initRoomGame(room) {
  if (room.game) return;
  room.game = {
    phase1: {
      nextWolfId: 1,
      wolves: [],
      quest: {
        wolvesSlain: 0,
      },
      lastEmitAt: 0,
    },
  };
  for (let i = 0; i < 10; i += 1) {
    room.game.phase1.wolves.push(createWolf(room, room.game.phase1.nextWolfId));
    room.game.phase1.nextWolfId += 1;
  }
}

function makeGamePublic(room) {
  const phase1 = room?.game?.phase1 || {};
  const wolves = phase1.wolves || [];
  const quest = phase1.quest || { wolvesSlain: 0 };
  return {
    phase1: {
      quest: {
        wolvesSlain: Math.max(0, Number(quest.wolvesSlain) || 0),
      },
      wolves: wolves.map((w) => ({
        id: w.id,
        map: "silver",
        type: "wolf",
        name: w.name,
        x: Number(w.x) || 0,
        y: Number(w.y) || 0,
        r: Number(w.r) || 15,
        hp: Number(w.hp) || 0,
        maxHp: Number(w.maxHp) || 1,
        damage: Number(w.damage) || 1,
        speed: Number(w.speed) || 90,
        alive: w.alive !== false,
        animT: Number(w.animT) || 0,
      })),
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

function makeRoomPublic(room) {
  return {
    id: room.id,
    name: room.name,
    difficulty: room.difficulty,
    maxPlayers: room.maxPlayers,
    started: room.started,
    players: room.players.map((p) => ({
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

function makeRoomId() {
  return `room_${Math.random().toString(36).slice(2, 10)}`;
}

function activeSilverPlayers(room) {
  return room.players.filter(
    (p) =>
      p?.state?.map === "silver" &&
      Number.isFinite(p.state.x) &&
      Number.isFinite(p.state.y),
  );
}

function updateRoomWolves(room, dt) {
  const wolves = room?.game?.phase1?.wolves;
  if (!wolves) return;

  const players = activeSilverPlayers(room);

  for (const wolf of wolves) {
    if (!wolf.alive) continue;
    wolf.animT += dt * 8;
    wolf.hitCd = Math.max(0, wolf.hitCd - dt);

    if (wolf.windup > 0) {
      wolf.windup -= dt;
      if (wolf.windup <= 0) wolf.hitCd = 1.05;
      continue;
    }

    let target = null;
    let targetDist = Infinity;
    for (const player of players) {
      const d = dist(wolf, player.state);
      if (d < targetDist) {
        targetDist = d;
        target = player.state;
      }
    }

    if (target && targetDist < 245) {
      const vx = (target.x - wolf.x) / (targetDist || 1);
      const vy = (target.y - wolf.y) / (targetDist || 1);
      wolf.x += vx * wolf.speed * dt;
      wolf.y += vy * wolf.speed * dt;
      if (targetDist < wolf.r + 14 + 14 && wolf.hitCd <= 0) wolf.windup = 0.34;
    } else {
      wolf.wanderA += (Math.random() - 0.5) * dt;
      wolf.x += Math.cos(wolf.wanderA) * 38 * dt;
      wolf.y += Math.sin(wolf.wanderA) * 38 * dt;
    }

    wolf.x = clamp(wolf.x, WOLF_LEASH.minX, WOLF_LEASH.maxX);
    wolf.y = clamp(wolf.y, WOLF_LEASH.minY, WOLF_LEASH.maxY);
  }

  const aliveCount = wolves.filter((w) => w.alive).length;
  if (aliveCount < 5) {
    for (let i = 0; i < 3; i += 1) {
      wolves.push(createWolf(room, room.game.phase1.nextWolfId));
      room.game.phase1.nextWolfId += 1;
    }
  }
}

let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTickAt) / 1000, 0.2);
  lastTickAt = now;

  for (const room of rooms.values()) {
    if (!room.started || !room.game) continue;
    updateRoomWolves(room, dt);

    const phase1 = room.game.phase1;
    if (now - phase1.lastEmitAt >= GAME_STATE_EMIT_MS) {
      phase1.lastEmitAt = now;
      emitGameState(room.id);
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
    const room = {
      id: makeRoomId(),
      name: String(payload.name || "Party").slice(0, 36),
      code: String(payload.code || ""),
      difficulty: String(payload.difficulty || "medium"),
      maxPlayers: Math.max(1, Math.min(4, Number(payload.maxPlayers) || 1)),
      started: false,
      createdAt: Date.now(),
      game: null,
      players: [
        {
          id: socket.id,
          name: String(payload.hostName || "Host").slice(0, 20),
          ready: false,
          leader: true,
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
    const room = rooms.get(payload.roomId);
    if (!room) return ack?.({ ok: false, error: "Room not found" });
    if (room.started) return ack?.({ ok: false, error: "Room already started" });
    if (room.code !== String(payload.code || "")) return ack?.({ ok: false, error: "Wrong room code" });
    if (room.players.length >= room.maxPlayers) return ack?.({ ok: false, error: "Room full" });

    const existing = room.players.find((p) => p.id === socket.id);
    if (!existing) {
      room.players.push({
        id: socket.id,
        name: String(payload.name || "Player").slice(0, 20),
        ready: false,
        leader: false,
        state: null,
      });
    }

    playerRoom.set(socket.id, room.id);
    socket.join(room.id);
    ack?.({ ok: true, room: makeRoomPublic(room) });
    emitRoomUpdate(room.id);
  });

  socket.on("room:ready", (payload) => {
    const roomId = payload.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    player.ready = !!payload.ready;
    if (payload.name) player.name = String(payload.name).slice(0, 20);

    emitRoomUpdate(room.id);

    if (room.players.length > 0 && room.players.every((p) => p.ready)) {
      room.started = true;
      initRoomGame(room);
      io.to(room.id).emit("game:start", {
        roomId: room.id,
        roomName: room.name,
        difficulty: room.difficulty,
        playerCount: room.players.length,
      });
      emitRoomUpdate(room.id);
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
    socket.to(room.id).emit("player:state", { id: socket.id, state: player.state });
  });

  socket.on("wolf:hit", (payload, ack) => {
    const roomId = payload?.roomId || playerRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || !room.started) {
      ack?.({ ok: false, error: "Room not active" });
      return;
    }

    initRoomGame(room);
    const wolves = room.game.phase1.wolves;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player?.state || player.state.map !== "silver") {
      ack?.({ ok: false, error: "Player not in Silver Keep" });
      return;
    }

    const wolfId = Number(payload?.wolfId);
    const wolf = wolves.find((w) => w.id === wolfId && w.alive);
    if (!wolf) {
      ack?.({ ok: false, error: "Wolf not found" });
      return;
    }

    const isHeavy = !!payload?.heavy;
    const range = isHeavy ? 96 : 68;
    const dx = player.state.x - wolf.x;
    const dy = player.state.y - wolf.y;
    const maxDist = range + wolf.r + 20;
    if (dx * dx + dy * dy > maxDist * maxDist) {
      ack?.({ ok: false, error: "Out of range" });
      return;
    }

    const damage = clamp(Math.round(Number(payload?.damage) || 0), 1, 999);
    wolf.hp -= damage;
    let killed = false;
    if (wolf.hp <= 0) {
      wolf.hp = 0;
      wolf.alive = false;
      killed = true;
      room.game.phase1.quest.wolvesSlain = Math.max(
        0,
        Number(room.game.phase1.quest.wolvesSlain) || 0,
      ) + 1;
      io.to(room.id).emit("wolf:slain", {
        roomId: room.id,
        wolfId: wolf.id,
        killerId: socket.id,
        wolvesSlain: room.game.phase1.quest.wolvesSlain,
        x: wolf.x,
        y: wolf.y,
      });
    }

    emitGameState(room.id);
    ack?.({ ok: true, killed, hp: wolf.hp });
  });

  socket.on("disconnect", () => {
    const roomId = playerRoom.get(socket.id);
    playerRoom.delete(socket.id);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(roomId);
      return;
    }

    if (!room.players.some((p) => p.leader)) room.players[0].leader = true;
    emitRoomUpdate(roomId);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Multiplayer server running on http://localhost:${PORT}`);
});
