

const { Server } = require("socket.io");
const { subscriber } = require("./redis");

const CHANNEL = "location_updates";

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: "*", // TODO: lock down to specific dashboard origins in production
      methods: ["GET", "POST"],
    },
  });


  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected   | id=${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[Socket.io] Client disconnected | id=${socket.id} reason=${reason}`);
    });
  });


  subscriber.subscribe(CHANNEL, (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`[PubSub] Broadcasting location for userId=${data.userId}`);

      // Emit to every connected WebSocket client (agents)
      io.emit("locationUpdate", data);
    } catch (err) {
      console.error("[PubSub] Failed to parse message:", err.message);
    }
  });

  console.log(`[Socket.io] Listening for Pub/Sub on channel "${CHANNEL}"`);

  return io;
}

module.exports = { initSocket };
