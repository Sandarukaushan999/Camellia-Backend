const buckets = new Map();

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanupExpiredBuckets(now) {
  for (const [key, bucket] of buckets.entries()) {
    if (!bucket || bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

setInterval(() => cleanupExpiredBuckets(Date.now()), 60_000).unref();

export default function createRateLimiter(options = {}) {
  const windowMs = Math.max(1_000, toInteger(options.windowMs, 15 * 60 * 1000));
  const max = Math.max(1, toInteger(options.max, 8));
  const message =
    String(options.message || "").trim() || "Too many requests. Please try again later.";
  const keyGenerator =
    typeof options.keyGenerator === "function"
      ? options.keyGenerator
      : (req) => String(req.ip || "unknown");

  return (req, res, next) => {
    const now = Date.now();
    const key = String(keyGenerator(req) || "unknown");
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      return next();
    }

    existing.count += 1;
    buckets.set(key, existing);

    if (existing.count > max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000)
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        message,
        retry_after_seconds: retryAfterSeconds,
      });
    }

    return next();
  };
}

