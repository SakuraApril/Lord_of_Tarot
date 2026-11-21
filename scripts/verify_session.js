/** 临时：验证 Redis 登录态、缓存命中、登出作废 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../db/init');

const BASE = 'http://127.0.0.1:3100';
const EMAIL = 'sessionverify@example.com';
const PASS = 'Test1234';

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, headers: r.headers };
}

(async () => {
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query(
    'INSERT INTO users (uuid, email, username, password_hash, credits, email_verified) VALUES (UUID(), $1, $2, $3, 5, 1)',
    [EMAIL, 'sessionverify', await bcrypt.hash(PASS, 10)]
  );
  console.log('① 造用户');

  const login = await api('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: EMAIL, password: PASS }),
  });
  const token = login.json && login.json.token;
  console.log('② 登录:', login.status, token ? '拿到 token' : login.json);
  const auth = { Authorization: 'Bearer ' + token };

  const c1 = await api('/api/user/credits', { headers: auth });
  const c2 = await api('/api/user/credits', { headers: auth });
  console.log(`③ 鉴权缓存: 第一次 ${c1.headers.get('x-auth-cache')}（期望 MISS），第二次 ${c2.headers.get('x-auth-cache')}（期望 HIT）`);

  const trace = c1.headers.get('x-trace-id');
  console.log(`④ X-Trace-Id: ${trace || '缺失'}`);

  const out = await api('/api/auth/logout', { method: 'POST', headers: auth });
  console.log('⑤ 登出:', out.status, JSON.stringify(out.json));

  const after = await api('/api/user/credits', { headers: auth });
  console.log(`⑥ 登出后再用同一 token: ${after.status}，${JSON.stringify(after.json)}（期望 401）`);

  const pass = c1.headers.get('x-auth-cache') === 'MISS'
    && c2.headers.get('x-auth-cache') === 'HIT'
    && !!trace
    && out.status === 200
    && after.status === 401;
  console.log(pass ? '\n✅ 登录态与登出验证通过' : '\n❌ 验证失败');

  await pool.end();
  process.exit(pass ? 0 : 1);
})();
