/** 临时：验证 Redis 不可用时的降级行为（bypass + 放行） */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { pool } = require('../db/init');

const BASE = 'http://127.0.0.1:3100';

(async () => {
  let any = await pool.query('SELECT id, user_id FROM readings ORDER BY id DESC LIMIT 1');
  if (any.rowCount === 0) {
    await pool.query('DELETE FROM users WHERE email = $1', ['degrade@example.com']);
    await pool.query(
      'INSERT INTO users (uuid, email, username, password_hash, credits, email_verified) VALUES (UUID(), $1, $2, $3, 3, 1)',
      ['degrade@example.com', 'degradeuser', 'x']
    );
    const nu = await pool.query('SELECT id FROM users WHERE email = $1', ['degrade@example.com']);
    await pool.query(
      'INSERT INTO readings (user_id, question, spread_type, cards_json, ai_response) VALUES ($1, $2, $3, $4, $5)',
      [nu.rows[0].id, '降级测试', 'single', '[]', '内容']
    );
    any = await pool.query('SELECT id, user_id FROM readings ORDER BY id DESC LIMIT 1');
  }
  const reading = any.rows[0];
  const u = await pool.query('SELECT id, uuid FROM users WHERE id = $1', [reading.user_id]);
  const user = u.rows[0];

  const token = jwt.sign({ userId: user.id, uuid: user.uuid }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const auth = { Authorization: 'Bearer ' + token };

  const h = await fetch(BASE + '/api/health');
  const hj = await h.json();
  console.log('① 健康检查:', h.status, 'redis.ok =', hj.redis && hj.redis.ok);

  const r = await fetch(`${BASE}/api/user/history/${reading.id}`, { headers: auth });
  console.log(`② 查历史详情: ${r.status}，X-Cache=${r.headers.get('x-cache')}（Redis 挂时应为 bypass）`);

  let passed = 0;
  for (let i = 0; i < 6; i++) {
    const x = await fetch(BASE + '/api/cards');
    if (x.status === 200) passed++;
  }
  console.log(`③ 连打 6 次 /api/cards：${passed}/6 放行（限流降级为放行）`);

  console.log(r.headers.get('x-cache') === 'bypass' && passed === 6 ? '\n✅ 降级验证通过' : '\n❌ 降级验证失败');
  await pool.end();
})();
