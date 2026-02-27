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
      io.to(room.id).emit("game:start", {
        roomId: room.id,
        roomName: room.name,
        difficulty: room.difficulty,
        playerCount: room.players.length,
      });
      emitRoomUpdate(room.id);
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
