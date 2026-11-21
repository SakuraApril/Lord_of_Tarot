/**
 * 一次性迁移脚本：把 PG 专有语法改成 MySQL 可用写法。
 * 每处替换都断言命中，避免「改了个寂寞」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function patch(file, pairs) {
  const full = path.join(ROOT, file);
  let src = fs.readFileSync(full, 'utf-8').replace(/\r\n/g, '\n');
  pairs.forEach(([from, to], i) => {
    if (!src.includes(from)) {
      throw new Error(`[${file}] 第 ${i + 1} 处未命中：\n${from.slice(0, 120)}`);
    }
    src = src.replace(from, to);
  });
  fs.writeFileSync(full, src, 'utf-8');
  console.log(`✅ ${file}：${pairs.length} 处`);
}

// ─────────────────────────── server.js
patch('server.js', [
  // 1) 扣额度：RETURNING → 事务内 UPDATE + SELECT
  [
`    // 1. 先扣额度（原子操作，防竞态）
    const deductResult = await pool.query(
      \`UPDATE users SET credits = credits - 1, updated_at = NOW()
       WHERE id = $1 AND credits > 0
       RETURNING credits\`,
      [req.user.id]
    );

    if (deductResult.rowCount === 0) {
      return res.status(403).json({ error: '额度不足', code: 'NO_CREDITS' });
    }
    creditDeducted = true;`,
`    // 1. 先扣额度（原子操作，防竞态）
    //    MySQL 没有 RETURNING，改成「同一事务里 UPDATE + SELECT」：
    //    UPDATE 已经对该行加了排他锁，事务提交前别的请求改不了，
    //    所以紧接着读到的余额一定是本次扣减后的值。
    let newBalance;
    const conn = await pool.connect();
    try {
      await conn.begin();
      const deductResult = await conn.query(
        \`UPDATE users SET credits = credits - 1, updated_at = NOW()
         WHERE id = $1 AND credits > 0\`,
        [req.user.id]
      );
      if (deductResult.rowCount === 0) {
        await conn.rollback();
        return res.status(403).json({ error: '额度不足', code: 'NO_CREDITS' });
      }
      const balanceRow = await conn.query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
      newBalance = balanceRow.rows[0].credits;
      await conn.commit();
    } catch (deductErr) {
      await conn.rollback().catch(() => {});
      throw deductErr;
    } finally {
      conn.release();
    }
    creditDeducted = true;`,
  ],
  // 2) 插入解读记录：RETURNING id → insertId
  [
`    const readingResult = await pool.query(
      \`INSERT INTO readings (user_id, question, spread_type, cards_json, ai_response)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id\`,
      [req.user.id, question, spreadType, cardsJson, fullText]
    );
    const readingId = readingResult.rows[0].id;`,
`    const readingResult = await pool.query(
      \`INSERT INTO readings (user_id, question, spread_type, cards_json, ai_response)
       VALUES ($1, $2, $3, $4, $5)\`,
      [req.user.id, question, spreadType, cardsJson, fullText]
    );
    const readingId = readingResult.insertId;`,
  ],
  // 3) 余额已在上面的事务里拿到，删掉重复取值
  [
`    // 记录额度流水
    const newBalance = deductResult.rows[0].credits;
    await pool.query(`,
`    // 记录额度流水（余额在扣减事务里已取到）
    await pool.query(`,
  ],
  // 4) change → delta
  [
`      'INSERT INTO credit_transactions (user_id, change, balance, source, ref_id) VALUES ($1, -1, $2, $3, $4)',`,
`      'INSERT INTO credit_transactions (user_id, delta, balance, source, ref_id) VALUES ($1, -1, $2, $3, $4)',`,
  ],
  // 5) 管理员改额度：UPDATE RETURNING → UPDATE + SELECT
  [
`    const result = await pool.query(
      'UPDATE users SET credits = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, credits',
      [parseInt(credits), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });`,
`    await pool.query(
      'UPDATE users SET credits = $1, updated_at = NOW() WHERE id = $2',
      [parseInt(credits), id]
    );
    const result = await pool.query('SELECT id, email, credits FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });`,
  ],
  // 6) 删用户：DELETE RETURNING → 先查后删
  [
`    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id, email', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });`,
`    const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    await pool.query('DELETE FROM users WHERE id = $1', [id]);`,
  ],
]);

// ─────────────────────────── routes/auth.js
patch(path.join('routes', 'auth.js'), [
  // 7) 注册：INSERT RETURNING → INSERT + SELECT
  [
`    const result = await pool.query(
      \`INSERT INTO users (uuid, email, password_hash, username)
       VALUES ($1, $2, $3, $4)
       RETURNING id, uuid, email, username, credits\`,
      [uuid, email, hash, username]
    );
    const user = result.rows[0];`,
`    await pool.query(
      \`INSERT INTO users (uuid, email, password_hash, username)
       VALUES ($1, $2, $3, $4)\`,
      [uuid, email, hash, username]
    );
    const result = await pool.query(
      'SELECT id, uuid, email, username, credits FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];`,
  ],
  // 8) change → delta
  [
`      'INSERT INTO credit_transactions (user_id, change, balance, source) VALUES ($1, 3, 3, $2)',`,
`      'INSERT INTO credit_transactions (user_id, delta, balance, source) VALUES ($1, 3, 3, $2)',`,
  ],
]);

// ─────────────────────────── routes/user.js
patch(path.join('routes', 'user.js'), [
  // 9) 兑换码：UPDATE RETURNING → UPDATE + SELECT
  [
`    const result = await pool.query(
      \`UPDATE coupons
       SET used = 1, used_by = $1, used_at = NOW()
       WHERE code = $2 AND used = 0 AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING credits, id\`,
      [req.user.id, formattedCode]
    );`,
`    const updated = await pool.query(
      \`UPDATE coupons
       SET used = 1, used_by = $1, used_at = NOW()
       WHERE code = $2 AND used = 0 AND (expires_at IS NULL OR expires_at > NOW())\`,
      [req.user.id, formattedCode]
    );
    const result = updated.rowCount === 0
      ? { rowCount: 0, rows: [] }
      : await pool.query('SELECT credits, id FROM coupons WHERE code = $1', [formattedCode]);`,
  ],
  // 10) 流水列名
  [
`      'INSERT INTO credit_transactions (user_id, change, balance, source, ref_id) VALUES ($1, $2, $3, $4, $5)',`,
`      'INSERT INTO credit_transactions (user_id, delta, balance, source, ref_id) VALUES ($1, $2, $3, $4, $5)',`,
  ],
  // 11) 查询时把 delta 别名成 change，前端字段不用改
  [
`      \`SELECT id, change, balance, source, ref_id, created_at`,
`      \`SELECT id, delta AS change, balance, source, ref_id, created_at`,
  ],
  // 12) 删历史记录：DELETE RETURNING → 先查后删
  [
`    const result = await pool.query(
      'DELETE FROM readings WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }`,
`    const existing = await pool.query(
      'SELECT id FROM readings WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }
    await pool.query('DELETE FROM readings WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);`,
  ],
]);

// ─────────────────────────── 残留检查
console.log('\n=== 残留的 PG 专有语法 ===');
let left = 0;
for (const f of ['server.js', path.join('routes', 'auth.js'), path.join('routes', 'user.js')]) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf-8').split('\n');
  lines.forEach((l, i) => {
    if (/RETURNING|\bchange\b/.test(l) && !l.includes('//')) {
      console.log(`  ${f}:${i + 1}  ${l.trim()}`);
      left++;
    }
  });
}
console.log(left === 0 ? '（无残留）' : `（还有 ${left} 处，需要人工确认）`);
