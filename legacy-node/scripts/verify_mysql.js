/**
 * MySQL 迁移验证：并发扣额度，检查「不超扣、余额准确、流水条数对得上」。
 *
 *   node scripts/verify_mysql.js
 *
 * 验证点：
 *   1. 30 个并发请求抢 10 次额度 → 只能成功 10 次
 *   2. 最终余额 = 0，不会出现负数
 *   3. 流水条数 = 成功次数（没有多扣、也没有少记）
 */
require('dotenv').config();
const { pool, initDB } = require('../db/init');

const USER_EMAIL = 'verify_mysql@example.com';
const CONCURRENCY = 30;
const START_CREDITS = 10;

async function setupUser() {
  await pool.query('DELETE FROM credit_transactions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [USER_EMAIL]);
  await pool.query('DELETE FROM users WHERE email = $1', [USER_EMAIL]);
  await pool.query(
    `INSERT INTO users (email, username, password_hash, credits, email_verified)
     VALUES ($1, $2, $3, $4, 1)`,
    [USER_EMAIL, 'verify_mysql', 'x', START_CREDITS]
  );
  const r = await pool.query('SELECT id, credits FROM users WHERE email = $1', [USER_EMAIL]);
  return r.rows[0];
}

/** 与 server.js 里完全一致的扣减逻辑：事务内 UPDATE + SELECT */
async function deductOnce(userId) {
  const conn = await pool.connect();
  try {
    await conn.begin();
    const upd = await conn.query(
      `UPDATE users SET credits = credits - 1, updated_at = NOW()
       WHERE id = $1 AND credits > 0`,
      [userId]
    );
    if (upd.rowCount === 0) {
      await conn.rollback();
      return { ok: false };
    }
    const bal = await conn.query('SELECT credits FROM users WHERE id = $1', [userId]);
    const balance = bal.rows[0].credits;
    await conn.query(
      'INSERT INTO credit_transactions (user_id, delta, balance, source) VALUES ($1, -1, $2, $3)',
      [userId, balance, 'verify']
    );
    await conn.commit();
    return { ok: true, balance };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

(async () => {
  await initDB();
  const user = await setupUser();
  console.log(`初始额度: ${user.credits}，并发请求: ${CONCURRENCY}`);

  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => deductOnce(user.id).catch((e) => ({ ok: false, error: e.message })))
  );
  const ms = Date.now() - t0;

  const okCount = results.filter((r) => r.ok).length;
  const balances = results.filter((r) => r.ok).map((r) => r.balance).sort((a, b) => b - a);

  const final = await pool.query('SELECT credits FROM users WHERE id = $1', [user.id]);
  const tx = await pool.query('SELECT COUNT(*) AS c FROM credit_transactions WHERE user_id = $1', [user.id]);
  const finalCredits = final.rows[0].credits;
  const txCount = Number(tx.rows[0].c);

  console.log(`\n成功次数: ${okCount}（期望 ${START_CREDITS}）`);
  console.log(`最终余额: ${finalCredits}（期望 0）`);
  console.log(`流水条数: ${txCount}（期望 ${START_CREDITS}）`);
  console.log(`扣减后的余额序列: [${balances.join(', ')}]（期望 9..0 不重复）`);
  console.log(`总耗时: ${ms} ms`);

  const pass =
    okCount === START_CREDITS &&
    finalCredits === 0 &&
    txCount === START_CREDITS &&
    new Set(balances).size === START_CREDITS;

  console.log(pass ? '\n✅ 通过：没有超扣，余额快照无重复' : '\n❌ 失败：存在超扣或余额快照重复');
  await pool.end();
  process.exit(pass ? 0 : 1);
})();
