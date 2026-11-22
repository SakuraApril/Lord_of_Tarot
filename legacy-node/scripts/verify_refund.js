/** 临时验收：失败重试 3 次 → 死信 → 标记失败并退款 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db/init');

const BASE = 'http://127.0.0.1:3100';
const EMAIL = 'failverify@example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}

(async () => {
  await pool.query('DELETE FROM reading_tasks WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [EMAIL]);
  await pool.query('DELETE FROM credit_transactions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [EMAIL]);
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query(
    'INSERT INTO users (uuid, email, username, password_hash, credits, email_verified) VALUES (UUID(), $1, $2, $3, 3, 1)',
    [EMAIL, 'failverify', 'x']
  );
  const u = await pool.query('SELECT id, uuid FROM users WHERE email = $1', [EMAIL]);
  const user = u.rows[0];
  const token = jwt.sign({ userId: user.id, uuid: user.uuid }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const submit = await api('/api/reading/async', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'X-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({ question: '失败重试测试', cards: [{ nameZh: '塔', reversed: false }] }),
  });
  const taskId = submit.json.taskId;
  console.log('① 提交:', submit.status, taskId);

  let task = null;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const r = await api('/api/reading/task/' + taskId, { headers: { Authorization: 'Bearer ' + token } });
    task = r.json;
    if (task && (task.status === 'failed' || task.status === 'done')) break;
  }
  console.log(`② 最终状态: ${task.status}，attempts=${task.attempts}，error=${task.error}`);

  const bal = await pool.query('SELECT credits FROM users WHERE id = $1', [user.id]);
  const tx = await pool.query('SELECT delta, source FROM credit_transactions WHERE user_id = $1 ORDER BY id', [user.id]);
  console.log(`③ 余额: 3 → ${bal.rows[0].credits}（期望 3，失败已退款）`);
  console.log('④ 流水:', JSON.stringify(tx.rows));

  const pass = task.status === 'failed' && bal.rows[0].credits === 3 && tx.rows.length === 2;
  console.log(pass ? '\n✅ 失败重试与退款验证通过' : '\n❌ 验证失败');
  await pool.end();
  process.exit(pass ? 0 : 1);
})();
