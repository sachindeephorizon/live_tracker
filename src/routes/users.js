const { Router } = require("express");
const { redis } = require("../redis");
const { haversineDistance } = require("../utils/gps");
const { ACTIVE_SET } = require("../config");

const router = Router();

// ── GET /users/active ────────────────────────────────────────────────

router.get("/active", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const cursor = req.query.cursor || "0";

    const scanResult = await redis.sScan(ACTIVE_SET, cursor, { COUNT: limit });
    const nextCursor = scanResult.cursor;
    const userIds = scanResult.members;

    if (userIds.length === 0) {
      return res.status(200).json({ ok: true, data: [], cursor: "0", hasMore: false });
    }

    const locationKeys = userIds.map((id) => `user:${id}`);
    const sessionKeys = userIds.map((id) => `session:${id}:start`);

    const [locationValues, sessionValues] = await Promise.all([
      redis.mGet(locationKeys),
      redis.mGet(sessionKeys),
    ]);

    const users = [];
    const staleIds = [];

    for (let i = 0; i < userIds.length; i++) {
      const hasLocation = !!locationValues[i];
      const hasSession = !!sessionValues[i];

      if (hasLocation) {
        // Normal case — location key fresh, use it directly
        users.push(JSON.parse(locationValues[i]));
      } else if (hasSession) {
        // FIX: location key expired (screen off > 30min or brief gap)
        // but session is still active (session key has 24hr TTL).
        // Don't remove from ACTIVE_SET — user is still tracking.
        // Return a placeholder so dashboard keeps showing them.
        users.push({
          userId: userIds[i],
          lat: null,
          lng: null,
          timestamp: null,
          startedAt: sessionValues[i],
          stale: true, // dashboard can show "last seen" indicator
        });
      } else {
        // No location AND no session — truly stale, safe to remove
        staleIds.push(userIds[i]);
      }
    }

    if (staleIds.length > 0) {
      redis.sRem(ACTIVE_SET, staleIds).catch(() => {});
    }

    const total = await redis.sCard(ACTIVE_SET);

    return res.status(200).json({
      ok: true,
      data: users,
      total,
      cursor: nextCursor,
      hasMore: String(nextCursor) !== "0",
    });
  } catch (err) {
    console.error("[GET /users/active] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id ───────────────────────────────────────────────────

router.get("/:id", async (req, res) => {
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

// ── GET /user/:id/trail ──────────────────────────────────────────────

router.get("/:id/trail", async (req, res) => {
  try {
    const { id } = req.params;
    const [trailDots, startMarkerRaw] = await Promise.all([
      redis.lRange(`trail:${id}`, 0, -1),
      redis.get(`marker:${id}:start`),
    ]);

    return res.status(200).json({
      ok: true,
      startMarker: startMarkerRaw ? JSON.parse(startMarkerRaw) : null,
      trail: trailDots.map((d) => JSON.parse(d)),
    });
  } catch (err) {
    console.error("[GET /user/:id/trail] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/session-distance ──────────────────────────────────

router.get("/:id/session-distance", async (req, res) => {
  try {
    const { id } = req.params;
    const logs = await redis.lRange(`session:${id}:logs`, 0, -1);

    if (!logs || logs.length < 2) {
      return res.status(200).json({ ok: true, distance: 0, points: logs ? logs.length : 0 });
    }

    let totalDistance = 0;
    let prev = JSON.parse(logs[0]);

    for (let i = 1; i < logs.length; i++) {
      const curr = JSON.parse(logs[i]);
      const d = haversineDistance(prev.lat, prev.lng, curr.lat, curr.lng);
      if (d < 100) {
        totalDistance += d;
      }
      prev = curr;
    }

    return res.status(200).json({ ok: true, distance: totalDistance, points: logs.length });
  } catch (err) {
    console.error("[GET /user/:id/session-distance] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;