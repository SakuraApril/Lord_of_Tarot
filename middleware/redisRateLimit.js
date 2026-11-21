/**
 * 基于 Redis 的限流中间件
 *
 * 替代原来的 express-rate-limit（进程内计数）。差别只有一个但很关键：
 *   进程内计数在多实例部署时各算各的，N 个实例等于放行 N 倍；
 *   换成 Redis 之后所有实例共用一个计数器。
 *
 * 固定窗口实现（INCR + EXPIRE），足够应付「防刷」这个场景；
 * 需要更平滑可以把 INCR 换成 Lua 令牌桶，代价是脚本更难维护。
 */
const { incrWindow, isReady } = require('../lib/redis');

function createLimiter({ windowMs, max, prefix, keyGenerator, skip, name }) {
  const windowSec = Math.ceil(windowMs / 1000);

  return async function redisRateLimit(req, res, next) {
    if (skip && skip(req)) return next();

    // Redis 不可用 → 放行（限流是保护措施，不能反过来把业务卡死）
    if (!isReady()) return next();

    let key;
    try {
      key = `${prefix}:${keyGenerator ? keyGenerator(req) : req.ip}`;
    } catch {
      return next();
    }

    try {
      const { count, ttl } = await incrWindow(key, windowSec);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
      res.setHeader('X-RateLimit-Reset', String(ttl));

      if (count > max) {
        res.setHeader('Retry-After', String(ttl));
        return res.status(429).json({
          error: `请求过于频繁，请 ${ttl} 秒后再试`,
          code: 'RATE_LIMITED',
          scope: name,
          retryAfter: ttl,
        });
      }
      return next();
    } catch (err) {
      // 计数失败同样放行，但记一条日志便于排查
      console.warn(`[rate-limit] ${name} 计数失败，放行：`, err.message);
      return next();
    }
  };
}

module.exports = { createLimiter };
