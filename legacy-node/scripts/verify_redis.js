/**
 * 临时验收脚本（跑完删除）：验证 Redis 限流与缓存
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { pool } = require('../db/init');
const redis = require('../lib/redis');

const BASE = 'http://127.0.0.1:3100';
const EMAIL = 'redisverify@example.com';

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, headers: r.headers, text: text.slice(0, 120) };
}

(async () => {
  await redis.waitReady();
  await redis.client.flushall();
  console.log('① 清空 Redis');

  // ── 限流：连续打 205 次（上限 200/15min）
  let firstBlocked = null;
  for (let i = 1; i <= 205; i++) {
    const r = await api('/api/health');
    if (r.status === 429 && firstBlocked === null) firstBlocked = i;
  }
  const probe = await api('/api/health');
  console.log(`② 限流：第 ${firstBlocked} 次开始被拦（期望 201），最后一次状态 ${probe.status}`);
  console.log(`   Retry-After=${probe.headers.get('retry-after')}s，剩余额度头=${probe.headers.get('x-ratelimit-remaining')}`);

  await redis.client.flushall();

  // ── 缓存：造一条历史记录
  await pool.query('DELETE FROM readings WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [EMAIL]);
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query(
    'INSERT INTO users (uuid, email, username, password_hash, credits, email_verified) VALUES (UUID(), $1, $2, $3, 3, 1)',
    [EMAIL, 'redisverify', 'x']
  );
  const u = await pool.query('SELECT id, uuid FROM users WHERE email = $1', [EMAIL]);
  const user = u.rows[0];
  await pool.query(
    'INSERT INTO readings (user_id, question, spread_type, cards_json, ai_response) VALUES ($1, $2, $3, $4, $5)',
    [user.id, '测试问题', 'single', '[]', '缓存测试内容']
  );
  const rd = await pool.query('SELECT id FROM readings WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [user.id]);
  const readingId = rd.rows[0].id;
  console.log(`③ 造数据：用户 ${user.id} / 记录 ${readingId}`);

  const token = jwt.sign({ userId: user.id, uuid: user.uuid }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const auth = { Authorization: 'Bearer ' + token };

  const c1 = await api(`/api/user/history/${readingId}`, { headers: auth });
  const c2 = await api(`/api/user/history/${readingId}`, { headers: auth });
  console.log(`④ 第一次 X-Cache=${c1.headers.get('x-cache')}（期望 MISS），第二次 X-Cache=${c2.headers.get('x-cache')}（期望 HIT）`);

  // 删掉数据库记录后仍能读到 → 证明走的是缓存
  await pool.query('DELETE FROM readings WHERE id = $1', [readingId]);
  const c3 = await api(`/api/user/history/${readingId}`, { headers: auth });
  console.log(`⑤ 删库后再查：状态 ${c3.status}，X-Cache=${c3.headers.get('x-cache')}（期望 200 + HIT，证明命中缓存）`);

  // 缓存不存在的 id → 空值缓存，第二次仍是 HIT（防穿透）
  const n1 = await api('/api/user/history/99999', { headers: auth });
  const n2 = await api('/api/user/history/99999', { headers: auth });
  console.log(`⑥ 不存在的记录：${n1.status}/${n2.status}，X-Cache=${n1.headers.get('x-cache')}→${n2.headers.get('x-cache')}（空值缓存生效）`);

  const keys = await redis.client.keys('reading:*');
  console.log('⑦ Redis 中的缓存键:', keys.filter(k => !k.endsWith(':lock')));

  const pass =
    firstBlocked === 201 &&
    c1.headers.get('x-cache') === 'MISS' &&
    c2.headers.get('x-cache') === 'HIT' &&
    c3.status === 200 && c3.headers.get('x-cache') === 'HIT';
  console.log(pass ? '\n✅ 限流与缓存验收通过' : '\n❌ 验收失败');

  await pool.end();
  await redis.client.quit();
  process.exit(pass ? 0 : 1);
})();
