
const { Router } = require("express");
const { redis } = require("../redis");
const { pool } = require("../db");
const router = Router();
const LOCATION_TTL = 60;

const CHANNEL = "location_updates";
const ACTIVE_SET = "active_users";

// ── POST /:id/ping ──────────────────────────────────────────────────

router.post("/:id/ping", async (req, res) => {
  try {
    const userId = req.params.id;
    const { lat, lng, speed } = req.body;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng are required and must be numbers" });
    }
    if (lat < -90 || lat > 90) {
      return res.status(400).json({ error: "lat must be between -90 and 90" });
    }
    if (lng < -180 || lng > 180) {
      return res.status(400).json({ error: "lng must be between -180 and 180" });
    }

    const now = new Date().toISOString();
    const userSpeed = typeof speed === "number" ? speed : null;
    const payload = { userId, lat, lng, speed: userSpeed, timestamp: now };
    const redisKey = `user:${userId}`;
    const sessionStartKey = `session:${userId}:start`;
    const sessionLogsKey = `session:${userId}:logs`;

    const locationPoint = JSON.stringify({ lat, lng, speed: userSpeed, timestamp: now });

    await Promise.all([
      redis.setEx(redisKey, LOCATION_TTL, JSON.stringify(payload)),
      redis.sAdd(ACTIVE_SET, userId),
      redis.publish(CHANNEL, JSON.stringify(payload)),
      redis.set(sessionStartKey, now, { NX: true }),
      redis.rPush(sessionLogsKey, locationPoint),
    ]);

    return res.status(200).json({ ok: true, data: payload });
  } catch (err) {
    console.error("[POST /:id/ping] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /:id/stop ──────────────────────────────────────────────────

router.post("/:id/stop", async (req, res) => {
  try {
    const userId = req.params.id;
    const now = new Date();
    const sessionStartKey = `session:${userId}:start`;
    const sessionLogsKey = `session:${userId}:logs`;

    const [startedAt, logs] = await Promise.all([
      redis.get(sessionStartKey),
      redis.lRange(sessionLogsKey, 0, -1),
    ]);

    const countResult = await pool.query(
      "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1",
      [userId]
    );
    const sessionNumber = parseInt(countResult.rows[0].cnt, 10) + 1;
    const sessionName = `session${sessionNumber}`;

    const sessionStart = startedAt ? new Date(startedAt) : now;
    const durationSecs = Math.floor((now - sessionStart) / 1000);
    const parsedLogs = logs.map((l) => JSON.parse(l));

    const sessionResult = await pool.query(
      `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, sessionName, sessionStart, now, durationSecs, parsedLogs.length]
    );
    const sessionId = sessionResult.rows[0].id;

    // Bulk insert in batches of 500 to avoid query size limits
    const BATCH_SIZE = 500;
    for (let b = 0; b < parsedLogs.length; b += BATCH_SIZE) {
      const batch = parsedLogs.slice(b, b + BATCH_SIZE);
      const values = [];
      const params = [];
      batch.forEach((point, i) => {
        const offset = i * 5;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
        params.push(sessionId, point.lat, point.lng, point.speed ?? null, point.timestamp);
      });
      await pool.query(
        `INSERT INTO location_logs (session_id, lat, lng, speed, recorded_at) VALUES ${values.join(", ")}`,
        params
      );
    }

    console.log(
      `[POST /${userId}/stop] Flushed: ${sessionName} | ${parsedLogs.length} points | ${durationSecs}s`
    );

    await Promise.all([
      redis.del(`user:${userId}`),
      redis.del(sessionStartKey),
      redis.del(sessionLogsKey),
      redis.sRem(ACTIVE_SET, userId),
      redis.publish(CHANNEL, JSON.stringify({ userId, stopped: true })),
    ]);

    return res.status(200).json({
      ok: true,
      session: {
        id: sessionId, name: sessionName, userId,
        startedAt: sessionStart, endedAt: now,
        durationSecs, totalPings: parsedLogs.length,
      },
    });
  } catch (err) {
    console.error("[POST /:id/stop] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /users/active ────────────────────────────────────────────────
// Paginated with cursor-based Redis SSCAN. Default limit=50.

router.get("/users/active", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const cursor = req.query.cursor || "0";

    const [nextCursor, userIds] = await redis.sScan(ACTIVE_SET, cursor, { COUNT: limit });

    if (userIds.length === 0) {
      return res.status(200).json({ ok: true, data: [], cursor: "0", hasMore: false });
    }

    const keys = userIds.map((id) => `user:${id}`);
    const values = await redis.mGet(keys);

    const users = [];
    const staleIds = [];

    for (let i = 0; i < userIds.length; i++) {
      if (values[i]) {
        users.push(JSON.parse(values[i]));
      } else {
        staleIds.push(userIds[i]);
      }
    }

    if (staleIds.length > 0) {
      redis.sRem(ACTIVE_SET, staleIds).catch(() => {});
    }

    // Also return total count (SCARD is O(1))
    const total = await redis.sCard(ACTIVE_SET);

    return res.status(200).json({
      ok: true,
      data: users,
      total,
      cursor: nextCursor,
      hasMore: nextCursor !== "0",
    });
  } catch (err) {
    console.error("[GET /users/active] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /sessions/all ────────────────────────────────────────────────
// Paginated. Default page=1, limit=20.

router.get("/sessions/all", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM sessions"),
      pool.query(
        `SELECT id, user_id, session_name, started_at, ended_at, duration_secs, total_pings, created_at
         FROM sessions ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /sessions/all] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id ───────────────────────────────────────────────────

router.get("/user/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const raw = await redis.get(`user:${id}`);
    if (!raw) {
      return res.status(404).json({ error: "No location found for this user" });
    }
    return res.status(200).json({ ok: true, data: JSON.parse(raw) });
  } catch (err) {
    console.error("[GET /user/:id] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/sessions ──────────────────────────────────────────
// Paginated. Default page=1, limit=20.

router.get("/user/:id/sessions", async (req, res) => {
  try {
    const { id } = req.params;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM sessions WHERE user_id = $1", [id]),
      pool.query(
        `SELECT id, session_name, started_at, ended_at, duration_secs, total_pings, created_at
         FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /user/:id/sessions] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /session/:sessionId/logs ────────────────────────────────────
// Paginated. Default page=1, limit=500.

router.get("/session/:sessionId/logs", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const offset = (page - 1) * limit;

    const sid = parseInt(sessionId, 10);

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM location_logs WHERE session_id = $1", [sid]),
      pool.query(
        `SELECT lat, lng, speed, recorded_at FROM location_logs
         WHERE session_id = $1 ORDER BY recorded_at ASC LIMIT $2 OFFSET $3`,
        [sid, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /session/:id/logs] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
