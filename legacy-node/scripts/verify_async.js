/**
 * 临时验收：异步链路（提交 → 消费 → 完成 / 幂等 / 失败退款）
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db/init');

const BASE = 'http://127.0.0.1:3100';
const EMAIL = 'asyncverify@example.com';

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 160) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 准备用户
  await pool.query('DELETE FROM reading_tasks WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [EMAIL]);
  await pool.query('DELETE FROM credit_transactions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [EMAIL]);
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.query(
    'INSERT INTO users (uuid, email, username, password_hash, credits, email_verified) VALUES (UUID(), $1, $2, $3, 5, 1)',
    [EMAIL, 'asyncverify', 'x']
  );
  const u = await pool.query('SELECT id, uuid, credits FROM users WHERE email = $1', [EMAIL]);
  const user = u.rows[0];
  const token = jwt.sign({ userId: user.id, uuid: user.uuid }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const reqId = crypto.randomUUID();
  const body = JSON.stringify({ question: '我该换工作吗', cards: [{ nameZh: '愚者', reversed: false }] });
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Request-Id': reqId };

  // ① 提交
  const t0 = Date.now();
  const submit = await api('/api/reading/async', { method: 'POST', headers, body });
  const submitMs = Date.now() - t0;
  console.log(`① 提交: ${submit.status} 用时 ${submitMs}ms`, JSON.stringify(submit.json));
  const taskId = submit.json && submit.json.taskId;

  // ② 轮询
  let task = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const r = await api('/api/reading/task/' + taskId, { headers: { Authorization: 'Bearer ' + token } });
    task = r.json;
    if (task && (task.status === 'done' || task.status === 'failed')) break;
  }
  console.log(`② 任务状态: ${task.status}，attempts=${task.attempts}，readingId=${task.readingId}`);
  console.log(`   内容前 40 字: ${(task.content || '').slice(0, 40).replace(/\n/g, ' ')}`);

  // ③ 幂等：同一 requestId 再提交
  const again = await api('/api/reading/async', { method: 'POST', headers, body });
  console.log(`③ 重复提交: ${again.status}，replayed=${again.json && again.json.replayed}，taskId 相同=${again.json && again.json.taskId === taskId}`);

  const after = await pool.query('SELECT credits FROM users WHERE id = $1', [user.id]);
  console.log(`④ 余额: 5 → ${after.rows[0].credits}（期望 4，只扣一次）`);

  const tx = await pool.query('SELECT delta, source FROM credit_transactions WHERE user_id = $1 ORDER BY id', [user.id]);
  console.log('⑤ 流水:', JSON.stringify(tx.rows));

  const pass =
    submit.status === 202 &&
    task.status === 'done' &&
    again.status === 200 && again.json.replayed === true &&
    after.rows[0].credits === 4;
  console.log(pass ? '\n✅ 异步链路验收通过' : '\n❌ 验收失败');
  await pool.end();
  process.exit(pass ? 0 : 1);
})();
