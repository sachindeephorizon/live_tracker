const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { subscriber, ioPub, ioSub } = require("./redis");

const CHANNEL = "location_updates";
const EMIT_INTERVAL_MS = 2000; // throttle emits to once per 2s per user

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    // Performance tuning for 10k+ connections
    pingTimeout: 30000,
    pingInterval: 25000,
    transports: ["websocket"], // skip HTTP long-polling
  });

  // ── Redis adapter — syncs Socket.io across multiple server instances ──
  io.adapter(createAdapter(ioPub, ioSub));
  console.log("[Socket.io] Redis adapter attached (horizontal scaling ready)");

  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected   | id=${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[Socket.io] Client disconnected | id=${socket.id} reason=${reason}`);
    });
  });

  // ── Redis Pub/Sub → broadcast to all WebSocket clients ──
  // Per-user throttle: buffer latest location, emit at most once per EMIT_INTERVAL_MS
  const lastEmitTime = new Map();
  const pendingEmit = new Map();

  function emitThrottled(data) {
    const userId = data.userId;
    if (!userId) {
      io.emit("locationUpdate", data);
      return;
    }

    const now = Date.now();
    const lastTime = lastEmitTime.get(userId) || 0;
    const elapsed = now - lastTime;

    if (elapsed >= EMIT_INTERVAL_MS) {
      lastEmitTime.set(userId, now);
      io.emit("locationUpdate", data);
    } else {
      // Buffer latest and schedule emit for remaining time
      if (pendingEmit.has(userId)) clearTimeout(pendingEmit.get(userId));
      pendingEmit.set(userId, setTimeout(() => {
        lastEmitTime.set(userId, Date.now());
        pendingEmit.delete(userId);
        io.emit("locationUpdate", data);
      }, EMIT_INTERVAL_MS - elapsed));
    }
  }

  subscriber.subscribe(CHANNEL, (message) => {
    try {
      const data = JSON.parse(message);
      emitThrottled(data);
    } catch (err) {
      console.error("[PubSub] Failed to parse message:", err.message);
    }
  });

  console.log(`[Socket.io] Listening for Pub/Sub on channel "${CHANNEL}"`);

  return io;
}

module.exports = { initSocket };
