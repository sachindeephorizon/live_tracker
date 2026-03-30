/**
 * Per-user rate limiter using Redis.
 * Allows max 1 ping per MIN_INTERVAL_MS per userId.
 * Uses Redis for shared state across cluster workers.
 */

const { redis } = require("./redis");

const MIN_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS) || 5000; // 5s default

async function rateLimitPing(req, res, next) {
  const userId = req.params.id;
  if (!userId) return next();

  const key = `ratelimit:${userId}`;

  try {
    const last = await redis.get(key);
    if (last) {
      const elapsed = Date.now() - parseInt(last, 10);
      if (elapsed < MIN_INTERVAL_MS) {
        return res.status(429).json({
          error: "Too fast",
          retryAfterMs: MIN_INTERVAL_MS - elapsed,
        });
      }
    }
    await redis.set(key, Date.now().toString(), { EX: 10 }); // auto-expire after 10s
    next();
  } catch {
    // If Redis fails, let the request through (don't block on rate limit errors)
    next();
  }
}

module.exports = { rateLimitPing };
