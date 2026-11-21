require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { createLimiter } = require('./middleware/redisRateLimit');
const redis = require('./lib/redis');
const { initDB, pool } = require('./db/init');
const authGuard = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));
const PORT = process.env.PORT || 3000;

// --- 限流 ---
const jwt = require('jsonwebtoken');

// 通用 API：防爬虫，已登录用户不受限
app.use('/api/', createLimiter({
  name: 'api',
  prefix: 'rl:api',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RL_API_MAX || 200),
  keyGenerator: (req) => req.ip || 'unknown',
  skip: (req) => {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        jwt.verify(header.slice(7), process.env.JWT_SECRET);
        return true;
      } catch {}
    }
    return false;
  }
}));

// 认证接口：防暴力破解，校园网放宽
app.use('/api/auth/', createLimiter({
  name: 'auth',
  prefix: 'rl:auth',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RL_AUTH_MAX || 500),
  keyGenerator: (req) => req.ip || 'unknown',
}));

// 兑换接口：防刷，按用户 ID
app.use('/api/user/redeem', createLimiter({
  name: 'redeem',
  prefix: 'rl:redeem',
  windowMs: 60 * 1000,
  max: Number(process.env.RL_REDEEM_MAX || 3),
  keyGenerator: (req) => {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        return decoded.userId || decoded.uuid || (req.ip || 'unknown');
      } catch {}
    }
    return (req.ip || 'unknown');
  }
}));

// 占卜接口：防滥用，按用户 ID
app.use('/api/reading', createLimiter({
  name: 'reading',
  prefix: 'rl:reading',
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.RL_READING_MAX || 15),
  // 只限制「起卦」（POST）；轮询任务状态是 GET，不该占用起卦额度
  skip: (req) => req.method === 'GET',
  keyGenerator: (req) => {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        return decoded.userId || decoded.uuid || (req.ip || 'unknown');
      } catch {}
    }
    return (req.ip || 'unknown');
  }
}));

// --- 中间件 ---
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// --- 静态托管 ---
app.use(express.static('public'));

// --- 挂载路由 ---
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api', require('./routes/reading_async'));   // POST /api/reading/async、GET /api/reading/task/:id

// --- OpenAI 客户端 ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// 提示词构建抽到 lib/prompt.js，与异步 worker 共用同一份
const { buildPrompt, spreadTypeOf } = require('./lib/prompt');

// --- AI 解读接口 ---
app.post('/api/reading', authGuard(true), async (req, res) => {
  let creditDeducted = false;
  try {
    const { question, cards } = req.body;

    if (!question || !cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    // 1. 先扣额度（原子操作，防竞态）
    //    MySQL 没有 RETURNING，改成「同一事务里 UPDATE + SELECT」：
    //    UPDATE 已经对该行加了排他锁，事务提交前别的请求改不了，
    //    所以紧接着读到的余额一定是本次扣减后的值。
    let newBalance;
    const conn = await pool.connect();
    try {
      await conn.begin();
      const deductResult = await conn.query(
        `UPDATE users SET credits = credits - 1, updated_at = NOW()
         WHERE id = $1 AND credits > 0`,
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
    creditDeducted = true;

    // 2. 构建 AI Prompt
    const messages = buildPrompt(question, cards);

    // 3. SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 2000,
      stream: true,
    });

    let fullText = '';

    // 4. 流式处理
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }
    }

    // 5. 流正常结束 → 保存历史 + 记录流水
    const spreadType = spreadTypeOf(cards);
    const cardsJson = JSON.stringify(cards);

    const readingResult = await pool.query(
      `INSERT INTO readings (user_id, question, spread_type, cards_json, ai_response)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, question, spreadType, cardsJson, fullText]
    );
    const readingId = readingResult.insertId;

    // 记录额度流水（余额在扣减事务里已取到）
    await pool.query(
      'INSERT INTO credit_transactions (user_id, delta, balance, source, ref_id) VALUES ($1, -1, $2, $3, $4)',
      [req.user.id, newBalance, 'reading', readingId]
    );

    // 发送结束标记
    res.write(`data: ${JSON.stringify({ done: true, readingId })}\n\n`);
    res.end();

  } catch (error) {
    console.error('AI 解读失败:', error.message);
    // 已扣额度但失败 → 退还
    if (creditDeducted) {
      await pool.query(
        'UPDATE users SET credits = credits + 1, updated_at = NOW() WHERE id = $1',
        [req.user.id]
      ).catch(() => {});
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI 服务暂时不可用，请重试' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'AI 服务暂时不可用，请重试' })}\n\n`);
      res.end();
    }
  }
});

// --- 牌面数据接口 ---
const majorArcana = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'major_arcana.json'), 'utf-8'));
const minorArcana = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'minor_arcana.json'), 'utf-8'));
const spreads = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'spreads.json'), 'utf-8'));

function buildFullDeck() {
  const deck = [...majorArcana];
  let id = majorArcana.length;
  for (const suit of minorArcana.suits) {
    for (let i = 0; i < 14; i++) {
      const rank = minorArcana.ranks[i];
      const meanings = minorArcana.cards[suit.id][i];
      const suitEn = suit.id.charAt(0).toUpperCase() + suit.id.slice(1);
      deck.push({
        id: id++,
        major: false,
        suit: suit.id,
        element: suit.element,
        num: i + 1,
        roman: rank.roman,
        name: rank.name + ' of ' + suitEn,
        nameZh: suit.nameZh + rank.nameZh,
        emoji: suit.emoji,
        keywords: [],
        upright: meanings.upright,
        reversed: meanings.reversed,
      });
    }
  }
  return deck;
}

const FULL_DECK = buildFullDeck();

app.get('/api/cards', (req, res) => {
  res.json({ major: majorArcana, minor: minorArcana, fullDeck: FULL_DECK });
});

app.get('/api/cards/major', (req, res) => {
  res.json(majorArcana);
});

app.get('/api/cards/minor', (req, res) => {
  res.json(minorArcana);
});

app.get('/api/cards/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const card = FULL_DECK.find(c => c.id === id);
  if (!card) {
    return res.status(404).json({ error: '未找到该牌面' });
  }
  res.json(card);
});

app.get('/api/spreads', (req, res) => {
  res.json(spreads);
});

// 健康检查
app.get('/api/health', async (req, res) => {
  const [dbOk, redisState] = await Promise.all([
    pool.query('SELECT 1 AS ok').then(() => true).catch(() => false),
    redis.health(),
  ]);
  let mqState = { ok: false, error: 'not checked' };
  try {
    mqState = await require('./lib/mq').health();
  } catch (e) {
    mqState = { ok: false, error: e.message };
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    mysql: { ok: dbOk },
    redis: redisState,
    mq: mqState,
    uptimeSec: Math.round(process.uptime()),
  });
});

// ─────────── 管理员接口（仅本地使用） ───────────

// 用户列表（支持搜索，含 IP 归属地）
app.get('/api/admin/users', async (req, res) => {
  try {
    const search = req.query.search || '';
    let query, params;
    if (search) {
      query = `SELECT u.id, u.uuid, u.email, u.username, u.email_verified, u.credits, u.created_at, u.updated_at,
        (SELECT COUNT(*) FROM readings WHERE readings.user_id = u.id) AS readings_count,
        (SELECT ip FROM login_logs WHERE login_logs.user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_ip,
        (SELECT location FROM login_logs WHERE login_logs.user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_location,
        (SELECT created_at FROM login_logs WHERE login_logs.user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_login_at,
        (SELECT COUNT(*) FROM login_logs WHERE login_logs.user_id = u.id) AS login_count
       FROM users u WHERE u.email ILIKE $1 OR u.username ILIKE $1 ORDER BY u.created_at DESC`;
      params = [`%${search}%`];
    } else {
      query = `SELECT u.id, u.uuid, u.email, u.username, u.email_verified, u.credits, u.created_at, u.updated_at,
        (SELECT COUNT(*) FROM readings WHERE readings.user_id = u.id) AS readings_count,
        (SELECT ip FROM login_logs WHERE login_logs.user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_ip,
        (SELECT location FROM login_logs WHERE login_logs.user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_location,
        (SELECT created_at FROM login_logs WHERE login_logs.user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_login_at,
        (SELECT COUNT(*) FROM login_logs WHERE login_logs.user_id = u.id) AS login_count
       FROM users u ORDER BY u.created_at DESC`;
      params = [];
    }
    const result = await pool.query(query, params);
    res.json({ total: result.rows.length, users: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 修改用户额度
app.put('/api/admin/users/:id/credits', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { credits } = req.body;
    if (!id || credits == null) return res.status(400).json({ error: '无效参数' });
    await pool.query(
      'UPDATE users SET credits = $1, updated_at = NOW() WHERE id = $2',
      [parseInt(credits), id]
    );
    const result = await pool.query('SELECT id, email, credits FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    res.json({ ok: true, user: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 删除用户
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的用户 ID' });
    await pool.query('DELETE FROM readings WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM credit_transactions WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM login_logs WHERE user_id = $1', [id]);
    const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 用户占卜详情
app.get('/api/admin/users/:id/readings', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的用户 ID' });
    const result = await pool.query(
      `SELECT id, question, spread_type, cards_json, ai_response, created_at
       FROM readings WHERE user_id = $1 ORDER BY created_at DESC`, [id]
    );
    res.json({ total: result.rows.length, readings: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 用户登录历史
app.get('/api/admin/users/:id/logins', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的用户 ID' });
    const result = await pool.query(
      'SELECT id, ip, user_agent, location, created_at FROM login_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [id]
    );
    res.json({ total: result.rows.length, logs: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 充值记录（仅兑换码） ──
app.get('/api/admin/transactions', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;
    const result = await pool.query(
      `SELECT ct.id, ct.user_id, ct.delta AS \`change\`, ct.balance, ct.source, ct.ref_id, ct.created_at,
         u.email, u.username
       FROM credit_transactions ct
       LEFT JOIN users u ON u.id = ct.user_id
       WHERE ct.source = 'redeem'
       ORDER BY ct.created_at DESC
       LIMIT $1 OFFSET $2`, [limit, offset]
    );
    const cnt = await pool.query("SELECT COUNT(*) FROM credit_transactions WHERE source = 'redeem'");
    res.json({ total: parseInt(cnt.rows[0].count), page, limit, transactions: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 启动服务器 ---
async function start() {
  try {
    await initDB();
  } catch (err) {
    console.error('❌ 数据库初始化失败:', err.message);
    console.log('服务器将启动，但数据库功能不可用');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
    console.log(`Model: ${MODEL}`);
  });
}

start();
