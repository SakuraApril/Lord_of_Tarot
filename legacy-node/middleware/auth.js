const jwt = require('jsonwebtoken');
const { pool } = require('../db/init');
const session = require('../lib/session');
const ctx = require('../lib/context');

module.exports = function authGuard(required = false) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      if (required) return res.status(401).json({ error: '请先登录' });
      return next();
    }
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);

      // 1. 作废校验：登出过的 token 直接拒绝（老 token 没有 jti，跳过）
      if (decoded.jti && (await session.isRevoked(decoded.jti))) {
        throw new Error('令牌已注销');
      }

      // 2. 用户快照：优先 Redis，未命中再查库并回填
      let user = await session.getUser(decoded.uuid);
      if (user) {
        res.setHeader('X-Auth-Cache', 'HIT');
      } else {
        const result = await pool.query(
          'SELECT id, uuid, email, username, credits, email_verified FROM users WHERE uuid = $1',
          [decoded.uuid]
        );
        if (result.rowCount === 0) {
          throw new Error('用户不存在');
        }
        user = result.rows[0];
        res.setHeader('X-Auth-Cache', 'MISS');
        await session.setUser(user.uuid, user);
      }

      req.user = user;
      ctx.set('userId', user.id);       // 写入请求上下文，后续日志自动带 userId
      next();
    } catch (err) {
      if (required) return res.status(401).json({ error: '登录已过期，请重新登录' });
      next();
    }
  };
};
