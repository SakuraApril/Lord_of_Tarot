/**
 * 进程内限流（粗粒度）
 *
 * 用途：给「便宜且高频」的接口做第一道闸（牌面数据这类纯内存读），
 * 避免每个请求都去 Redis 做一次 INCR —— 那等于用一次网络往返换一次计数。
 *
 * 与 Redis 限流的分工：
 *   本地限流：静态/只读接口，挡突发；多实例时按实例数放大，可以接受
 *   Redis 限流：登录、兑换、起卦这类「有成本、可被滥用」的接口，必须全局精确
 *
 * 代价（面试要主动说）：多实例部署时本地计数不共享，
 * 实际放行量是「单实例上限 × 实例数」。所以本地限流只用于兜底。
 */

function createLocalLimiter({ windowMs, max, name }) {
  const buckets = new Map();          // key -> { start, count }
  const windowSec = windowMs / 1000;

  // 定期清理过期桶，避免 Map 无限增长
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (now - b.start > windowMs) buckets.delete(k);
    }
  }, Math.max(30000, windowMs));
  if (timer.unref) timer.unref();

  return function localRateLimit(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let b = buckets.get(key);

    if (!b || now - b.start >= windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count += 1;

    const remaining = Math.max(0, max - b.count);
    const reset = Math.ceil((b.start + windowMs - now) / 1000);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(reset));
    res.setHeader('X-RateLimit-Scope', 'local');

    if (b.count > max) {
      res.setHeader('Retry-After', String(reset));
      return res.status(429).json({
        error: `请求过于频繁，请 ${reset} 秒后再试`,
        code: 'RATE_LIMITED',
        scope: name,
        retryAfter: reset,
      });
    }
    next();
  };
}

module.exports = { createLocalLimiter };
