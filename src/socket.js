const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { subscriber, ioPub, ioSub } = require("./redis");

const CHANNEL = "location_updates";

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
  subscriber.subscribe(CHANNEL, (message) => {
    try {
      const data = JSON.parse(message);
      io.emit("locationUpdate", data);
    } catch (err) {
      console.error("[PubSub] Failed to parse message:", err.message);
    }
  });

  console.log(`[Socket.io] Listening for Pub/Sub on channel "${CHANNEL}"`);

  return io;
}

module.exports = { initSocket };
