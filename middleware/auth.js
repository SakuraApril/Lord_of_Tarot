const jwt = require('jsonwebtoken');
const { pool } = require('../db/init');

module.exports = function authGuard(required = false) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      if (required) return res.status(401).json({ error: '请先登录' });
      return next();
    }
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      const result = await pool.query(
        'SELECT id, uuid, email, username, credits, email_verified FROM users WHERE uuid = $1',
        [decoded.uuid]
      );
      if (result.rowCount === 0) {
        throw new Error('用户不存在');
      }
      req.user = result.rows[0];
      next();
    } catch (err) {
      if (required) return res.status(401).json({ error: '登录已过期，请重新登录' });
      next();
    }
  };
};
