/**
 * 异步解读接口
 *
 * POST /api/reading/async  提交任务（幂等：需带 X-Request-Id）
 * GET  /api/reading/task/:taskId  查任务状态
 *
 * 与同步接口的区别：接口只负责「扣额度 + 建任务 + 投递消息」，不等待模型。
 * 好处是接口响应时间从「模型生成的几十秒」降到「两次数据库写 + 一次投递」，
 * 模型再慢也不会占着连接；坏处是前端要轮询任务状态。
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/init');
const authGuard = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { publishJob } = require('../lib/mq');

const router = express.Router();

/** 扣额度 + 建任务 + 投递，成功返回 taskId */
async function submitTask(userId, question, cards, requestId) {
  const conn = await pool.connect();
  let newBalance;
  let taskId;
  try {
    await conn.begin();

    // 1. 扣额度（与同步接口同一套逻辑：事务内 UPDATE + SELECT）
    const upd = await conn.query(
      `UPDATE users SET credits = credits - 1, updated_at = NOW()
       WHERE id = $1 AND credits > 0`,
      [userId]
    );
    if (upd.rowCount === 0) {
      await conn.rollback();
      return { error: 'NO_CREDITS' };
    }
    const bal = await conn.query('SELECT credits FROM users WHERE id = $1', [userId]);
    newBalance = bal.rows[0].credits;

    // 2. 建任务（用 insertId，省掉一次 SELECT）
    taskId = crypto.randomUUID();
    const ins = await conn.query(
      `INSERT INTO reading_tasks (task_id, user_id, question, cards_json, status)
       VALUES ($1, $2, $3, $4, 'queued')`,
      [taskId, userId, question, JSON.stringify(cards)]
    );
    const taskRowId = ins.insertId;

    // 3. 记额度流水（ref_id 指向任务，便于对账）
    await conn.query(
      'INSERT INTO credit_transactions (user_id, delta, balance, source, ref_id) VALUES ($1, -1, $2, $3, $4)',
      [userId, newBalance, 'reading_async', taskRowId]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }

  // 4. 投递消息（放在事务外：投递失败要退款，而不是回滚任务）
  try {
    await publishJob({ taskId, userId, question, cards, attempts: 0, requestId });
  } catch (err) {
    console.error('[async] 投递失败，退回额度:', err.message);
    await pool.query('UPDATE users SET credits = credits + 1 WHERE id = $1', [userId]);
    await pool.query(
      "UPDATE reading_tasks SET status = 'failed', error = $2 WHERE task_id = $1",
      [taskId, '队列不可用']
    );
    await pool.query(
      'INSERT INTO credit_transactions (user_id, delta, balance, source) VALUES ($1, 1, $2, $3)',
      [userId, newBalance + 1, 'refund']
    );
    throw err;
  }

  return { taskId, credits: newBalance };
}

router.post('/reading/async', authGuard(true), async (req, res) => {
  const { question, cards } = req.body || {};
  if (!question || !Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  // 幂等键：优先 header，其次 body，都没有就退化成「不幂等」并提示
  const requestId =
    req.get('X-Request-Id') || (req.body && req.body.requestId) || null;
  if (!requestId) {
    return res.status(400).json({
      error: '缺少 X-Request-Id 请求头（用于幂等，防止重复扣额度）',
      code: 'NEED_REQUEST_ID',
    });
  }

  try {
    const begun = await idempotency.begin({
      requestId,
      userId: req.user.id,
      endpoint: 'reading.async',
    });

    // 重复提交：直接回放上次结果
    if (!begun.fresh) {
      const rec = begun.record || {};
      if (rec.status === 'done' && rec.response_json) {
        return res.status(200).json({ ...JSON.parse(rec.response_json), replayed: true });
      }
      if (rec.status === 'processing') {
        return res.status(409).json({ error: '同一请求正在处理中', code: 'IN_PROGRESS' });
      }
      // failed 的记录允许重新走一遍
    }

    const result = await submitTask(req.user.id, question, cards, requestId);
    if (result.error === 'NO_CREDITS') {
      await idempotency.fail(requestId, '额度不足');
      return res.status(403).json({ error: '额度不足', code: 'NO_CREDITS' });
    }

    const body = { taskId: result.taskId, credits: result.credits, status: 'queued' };
    await idempotency.complete(requestId, body);
    return res.status(202).json(body);
  } catch (err) {
    console.error('[async] 提交失败:', err.message);
    await idempotency.fail(requestId, err.message).catch(() => {});
    return res.status(500).json({ error: '提交失败，请重试' });
  }
});

router.get('/reading/task/:taskId', authGuard(true), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT task_id, status, ai_response, reading_id, error, attempts, created_at
       FROM reading_tasks WHERE task_id = $1 AND user_id = $2`,
      [req.params.taskId, req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: '任务不存在' });
    const t = r.rows[0];
    res.json({
      taskId: t.task_id,
      status: t.status,
      attempts: t.attempts,
      readingId: t.reading_id,
      content: t.status === 'done' ? t.ai_response : null,
      error: t.error || null,
    });
  } catch (err) {
    console.error('[async] 查询任务失败:', err.message);
    res.status(500).json({ error: '查询失败' });
  }
});

module.exports = router;
