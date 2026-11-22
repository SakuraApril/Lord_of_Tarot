/**
 * 解读任务 worker
 *
 *   node workers/reading_worker.js
 *
 * 职责：消费 reading.jobs → 调模型 → 写 readings → 更新任务状态。
 * 三个要点：
 *   1. 手动 ack：处理成功才 ack，失败走重试/死信，不会「消息丢了但任务显示成功」
 *   2. 幂等：进来先看任务状态，已 done 直接跳过（消息可能重复投递）
 *   3. 失败兜底：重试耗尽后退回额度并标记 failed，不让用户白扣
 */
require('dotenv').config();
const OpenAI = require('openai');
const { pool } = require('../db/init');
const { consume, consumeDead, health } = require('../lib/mq');
const { buildPrompt, spreadTypeOf } = require('../lib/prompt');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MOCK = !process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-dummy';

const openai = MOCK
  ? null
  : new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });

/** 没有 API Key 时生成一段假回答，方便本地把链路跑通 */
async function mockGenerate(question, cards) {
  await new Promise((r) => setTimeout(r, 300));
  if (process.env.MOCK_FAIL === '1') throw new Error('mock 模式：模拟模型调用失败');
  const names = cards.map((c) => (c.nameZh || c.name) + (c.reversed ? '（逆位）' : '')).join('、');
  return `【mock 解读】关于「${question}」，你抽到的是 ${names}。\n这是一段用于本地联调的占位文本，真实环境会替换为模型输出。`;
}

async function generate(question, cards) {
  if (MOCK) return mockGenerate(question, cards);
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: buildPrompt(question, cards),
    temperature: 0.7,
    max_tokens: 2000,
  });
  return resp.choices[0]?.message?.content || '';
}

async function handle(job) {
  const { taskId } = job;

  // 1. 幂等：已完成就跳过（重复投递）
  const t = await pool.query(
    'SELECT id, user_id, question, cards_json, status, attempts FROM reading_tasks WHERE task_id = $1',
    [taskId]
  );
  if (t.rowCount === 0) {
    console.warn('[worker] 任务不存在，丢弃:', taskId);
    return;
  }
  const task = t.rows[0];
  if (task.status === 'done') {
    console.log('[worker] 任务已完成，跳过:', taskId);
    return;
  }

  // 2. 标记处理中 + attempts+1
  await pool.query(
    "UPDATE reading_tasks SET status = 'processing', attempts = attempts + 1 WHERE task_id = $1",
    [taskId]
  );

  const cards = JSON.parse(task.cards_json);
  const answer = await generate(task.question, cards);

  // 3. 写解读记录 + 回填任务
  const ins = await pool.query(
    `INSERT INTO readings (user_id, question, spread_type, cards_json, ai_response)
     VALUES ($1, $2, $3, $4, $5)`,
    [task.user_id, task.question, spreadTypeOf(cards), task.cards_json, answer]
  );

  await pool.query(
    "UPDATE reading_tasks SET status = 'done', reading_id = $2, ai_response = $3, error = NULL WHERE task_id = $1",
    [taskId, ins.insertId, answer]
  );
  console.log('[worker] 任务完成:', taskId, '→ reading', ins.insertId);
}

/**
 * 重试耗尽的处理：把任务标记失败并退额度。
 * 这里是「补偿」而不是「回滚」——额度是在提交时扣的，失败必须显式退还。
 */
async function handleDeadLetter(job) {
  const { taskId } = job;
  const t = await pool.query('SELECT user_id, status FROM reading_tasks WHERE task_id = $1', [taskId]);
  if (t.rowCount === 0 || t.rows[0].status === 'done') return;
  const userId = t.rows[0].user_id;

  await pool.query(
    "UPDATE reading_tasks SET status = 'failed', error = $2 WHERE task_id = $1",
    [taskId, '生成失败，已重试 3 次']
  );
  await pool.query('UPDATE users SET credits = credits + 1 WHERE id = $1', [userId]);
  const bal = await pool.query('SELECT credits FROM users WHERE id = $1', [userId]);
  await pool.query(
    'INSERT INTO credit_transactions (user_id, delta, balance, source) VALUES ($1, 1, $2, $3)',
    [userId, bal.rows[0].credits, 'refund']
  );
  console.error('[worker] 任务失败已退款:', taskId);
}

(async () => {
  console.log(`[worker] 启动（模型模式：${MOCK ? 'mock' : MODEL}）`);
  const h = await health();
  console.log('[worker] 队列状态:', JSON.stringify(h));

  // 主队列：正常处理
  await consume(handle);

  // 死信队列：重试耗尽的失败任务在这里退款
  await consumeDead(handleDeadLetter);

  process.on('SIGINT', async () => {
    console.log('\n[worker] 退出');
    await pool.end();
    process.exit(0);
  });
})();
