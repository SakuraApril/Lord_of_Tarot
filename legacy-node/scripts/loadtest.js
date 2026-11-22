/**
 * 简易压测脚本（不依赖 wrk / JMeter，纯 Node 实现，方便在 Windows 上跑）
 *
 *   node scripts/loadtest.js --path /api/cards --concurrency 50 --duration 10
 *   node scripts/loadtest.js --path /api/reading/async --method POST --auth
 *   node scripts/loadtest.js --path /api/user/history/1 --auth
 *
 * 指标：QPS、成功数、错误数（含 429）、P50 / P95 / P99、平均延迟
 *
 * 注意：跑之前要先把限流上限调大（RL_*_MAX），否则测的是限流而不是系统能力。
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db/init');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const BASE = arg('base', 'http://127.0.0.1:3100');
const PATH = arg('path', '/api/cards');
const METHOD = String(arg('method', 'GET')).toUpperCase();
const CONCURRENCY = Number(arg('concurrency', 50));
const DURATION = Number(arg('duration', 10));
const NEED_AUTH = !!arg('auth', false);
const EMAIL = arg('email', 'loadtest@example.com');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

(async () => {
  let token = null;
  let userId = null;
  let seededReadingId = null;
  const users = [];                       // 多用户模式：每个并发用一个独立用户
  const USER_COUNT = Number(arg('users', 1));

  if (NEED_AUTH) {
    await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
    await pool.query(
      'INSERT INTO users (uuid, email, username, password_hash, credits, email_verified) VALUES (UUID(), $1, $2, $3, 1000000, 1)',
      [EMAIL, 'loadtest', 'x']
    );
    const u = await pool.query('SELECT id, uuid FROM users WHERE email = $1', [EMAIL]);
    userId = u.rows[0].id;
    token = jwt.sign({ userId: u.rows[0].id, uuid: u.rows[0].uuid, email: u.rows[0].email }, process.env.JWT_SECRET, { expiresIn: '2h', subject: u.rows[0].uuid });

    // 造一条历史记录，供 /history/{id} 这类路径使用
    const ins = await pool.query(
      'INSERT INTO readings (user_id, question, spread_type, cards_json, ai_response) VALUES ($1, $2, $3, $4, $5)',
      [userId, '压测用记录', 'single', '[]', '压测内容']
    );
    seededReadingId = ins.insertId;

    // 多用户模式：再造 USER_COUNT-1 个用户，避免所有请求抢同一行额度
    for (let i = 1; i < USER_COUNT; i++) {
      const email = `loadtest${i}@example.com`;
      await pool.query('DELETE FROM users WHERE email = $1', [email]);
      await pool.query(
        'INSERT INTO users (uuid, email, username, password_hash, credits, email_verified) VALUES (UUID(), $1, $2, $3, 1000000, 1)',
        [email, `loadtest${i}`, 'x']
      );
      const row = await pool.query('SELECT id, uuid FROM users WHERE email = $1', [email]);
      users.push({ id: row.rows[0].id, token: jwt.sign({ userId: row.rows[0].id, uuid: row.rows[0].uuid }, process.env.JWT_SECRET, { expiresIn: '2h', subject: row.rows[0].uuid }) });
    }
  }

  // 路径里的 {id} 用刚造出来的记录 id 替换
  const path = PATH.replace('{id}', String(seededReadingId || 1));

  const latencies = [];
  const statusCount = {};
  let sent = 0;
  let errors = 0;

  const deadline = Date.now() + DURATION * 1000;

  async function worker(slot) {
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try {
        const headers = { 'Content-Type': 'application/json' };
        const tk = users.length ? users[slot % users.length].token : token;
        if (tk) headers.Authorization = 'Bearer ' + tk;
        let body;
        if (METHOD === 'POST') {
          headers['X-Request-Id'] = crypto.randomUUID();
          body = JSON.stringify({
            question: '压测问题 #' + sent,
            cards: [{ nameZh: '愚者', reversed: false }],
          });
        }
        const r = await fetch(BASE + path, { method: METHOD, headers, body });
        await r.arrayBuffer();          // 读完响应，否则连接不释放
        const dt = Date.now() - t0;
        latencies.push(dt);
        statusCount[r.status] = (statusCount[r.status] || 0) + 1;
        if (r.status >= 400) errors++;
      } catch (e) {
        errors++;
        statusCount['EXC'] = (statusCount['EXC'] || 0) + 1;
      }
      sent++;
    }
  }

  console.log(`目标: ${METHOD} ${BASE}${PATH}  并发 ${CONCURRENCY}  持续 ${DURATION}s`);
  const start = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const elapsed = (Date.now() - start) / 1000;

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const avg = total ? latencies.reduce((s, x) => s + x, 0) / total : 0;

  console.log('\n—— 结果 ——');
  console.log(`总请求   ${total}（${elapsed.toFixed(1)}s）`);
  console.log(`QPS      ${(total / elapsed).toFixed(1)}`);
  console.log(`错误     ${errors}（${((errors / Math.max(total, 1)) * 100).toFixed(1)}%）`);
  console.log(`状态分布 ${JSON.stringify(statusCount)}`);
  console.log(`平均延迟 ${avg.toFixed(1)} ms`);
  console.log(`P50      ${percentile(latencies, 50)} ms`);
  console.log(`P95      ${percentile(latencies, 95)} ms`);
  console.log(`P99      ${percentile(latencies, 99)} ms`);

  await pool.end();
})();
