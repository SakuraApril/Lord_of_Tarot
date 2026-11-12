const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db/init');
const { sendVerifyEmail, sendResetEmail } = require('../utils/email');
const authGuard = require('../middleware/auth');

const router = express.Router();

// 发件冷却（60秒/邮箱，按类型分开）
const EMAIL_COOLDOWN = 60;
const cooldownMaps = {
  verify: new Map(),
  reset: new Map(),
};

// 登录防暴力破解
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // 锁定5分钟
const loginAttempts = new Map(); // email -> { count, lockedUntil }

// 每5分钟清理过期条目
setInterval(function() {
  const now = Date.now();
  for (const key in cooldownMaps) {
    for (const [email, time] of cooldownMaps[key]) {
      if (now - time > EMAIL_COOLDOWN * 1000) cooldownMaps[key].delete(email);
    }
  }
  for (const [email, data] of loginAttempts) {
    if (data.lockedUntil && now > data.lockedUntil) loginAttempts.delete(email);
    else if (!data.lockedUntil && now - data.lastAttempt > LOGIN_LOCKOUT_MS) loginAttempts.delete(email);
  }
}, 5 * 60 * 1000);

function checkLoginBruteForce(email) {
  const key = email.toLowerCase();
  const data = loginAttempts.get(key);
  if (!data) return { blocked: false, remaining: LOGIN_MAX_ATTEMPTS };
  if (data.lockedUntil) {
    if (Date.now() < data.lockedUntil) {
      return { blocked: true, remaining: 0, lockoutEnds: data.lockedUntil };
    }
    loginAttempts.delete(key);
    return { blocked: false, remaining: LOGIN_MAX_ATTEMPTS };
  }
  return { blocked: false, remaining: LOGIN_MAX_ATTEMPTS - data.count };
}

function recordLoginAttempt(email, success) {
  const key = email.toLowerCase();
  if (success) {
    loginAttempts.delete(key);
    return;
  }
  let data = loginAttempts.get(key);
  if (!data) {
    data = { count: 0, lastAttempt: 0, lockedUntil: null };
    loginAttempts.set(key, data);
  }
  data.count++;
  data.lastAttempt = Date.now();
  if (data.count >= LOGIN_MAX_ATTEMPTS) {
    data.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  }
}

function checkEmailCooldown(email, type) {
  const key = email.toLowerCase();
  const map = cooldownMaps[type];
  if (!map) return 0;
  const last = map.get(key);
  if (last) {
    const elapsed = (Date.now() - last) / 1000;
    if (elapsed < EMAIL_COOLDOWN) {
      return Math.ceil(EMAIL_COOLDOWN - elapsed);
    }
  }
  map.set(key, Date.now());
  return 0;
}

// 暴露冷却查询给前端
router.get('/email-cooldown', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  const type = req.query.type || 'verify';
  if (!email) return res.json({ remaining: 0 });
  const map = cooldownMaps[type];
  if (!map) return res.json({ remaining: 0 });
  const last = map.get(email);
  if (!last) return res.json({ remaining: 0 });
  const elapsed = (Date.now() - last) / 1000;
  const remaining = elapsed < EMAIL_COOLDOWN ? Math.ceil(EMAIL_COOLDOWN - elapsed) : 0;
  res.json({ remaining });
});

// 工具函数：生成默认用户名
function generateDefaultUsername() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return '星际旅者_' + result;
}

// 工具函数：获取唯一用户名
async function getUniqueUsername(base) {
  let username = base || generateDefaultUsername();
  let attempts = 0;
  while (attempts < 10) {
    const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (result.rowCount === 0) return username;
    username = generateDefaultUsername();
    attempts++;
  }
  throw new Error('无法生成唯一用户名');
}

// 工具函数：判断是否为邮箱
function isEmail(input) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

// --- 注册 ---
router.post('/register', async (req, res) => {
  try {
    const { email, password, username: providedUsername } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码为必填项' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少 6 位' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      return res.status(400).json({ error: '邮箱已被注册' });
    }

    const username = await getUniqueUsername(providedUsername);
    const uuid = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, username)
       VALUES ($1, $2, $3, $4)
       RETURNING id, uuid, email, username, credits`,
      [uuid, email, hash, username]
    );
    const user = result.rows[0];

    // 插入额度流水
    await pool.query(
      'INSERT INTO credit_transactions (user_id, change, balance, source) VALUES ($1, 3, 3, $2)',
      [user.id, 'register']
    );

    // 生成验证 token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO email_tokens (user_id, token, type, expires_at) VALUES ($1, $2, $3, $4)',
      [user.id, verifyToken, 'verify', expiresAt]
    );

    // 发送验证邮件（带冷却检查）
    const regCooldown = checkEmailCooldown(email, 'verify');
    if (regCooldown > 0) {
      return res.status(429).json({ error: '发送过于频繁，请 ' + regCooldown + ' 秒后重试', cooldown: regCooldown });
    }
    if (process.env.SMTP_HOST) {
      try {
        await sendVerifyEmail(email, verifyToken, process.env.BASE_URL || 'http://localhost:8080');
      } catch (e) {
        console.error('发送验证邮件失败:', e.message);
      }
    }

    res.status(201).json({
      message: '注册成功，请查收验证邮件',
      user: { uuid: user.uuid, email: user.email, username: user.username }
    });
  } catch (err) {
    console.error('注册失败:', err);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

// --- 登录（支持邮箱或用户名）---
router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;

    if (!login || !password) {
      return res.status(400).json({ error: '请输入登录凭证和密码' });
    }

    // 暴力破解检查
    const bruteCheck = checkLoginBruteForce(login);
    if (bruteCheck.blocked) {
      var secs = Math.ceil((bruteCheck.lockoutEnds - Date.now()) / 1000);
      return res.status(429).json({ error: '登录失败次数过多，请 ' + Math.ceil(secs / 60) + ' 分钟后再试', lockout: true, lockoutEnds: bruteCheck.lockoutEnds });
    }

    let user;
    if (isEmail(login)) {
      const result = await pool.query('SELECT * FROM users WHERE email = $1', [login]);
      user = result.rows[0];
    } else {
      const result = await pool.query('SELECT * FROM users WHERE username = $1', [login]);
      user = result.rows[0];
    }

    if (!user) {
      recordLoginAttempt(login, false);
      var bf = checkLoginBruteForce(login);
      return res.status(401).json({ error: '用户不存在', remaining: bf.remaining });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      recordLoginAttempt(login, false);
      var bf2 = checkLoginBruteForce(login);
      return res.status(401).json({ error: '密码错误，还剩 ' + bf2.remaining + ' 次机会', remaining: bf2.remaining });
    }

    // 检查邮箱是否已验证
    if (user.email_verified === 0) {
      return res.status(403).json({
        error: '邮箱未验证，请先验证邮箱',
        code: 'NOT_VERIFIED',
        email: user.email
      });
    }

    // 登录成功，清除失败计数
    recordLoginAttempt(login, true);

    // 签发 JWT（存 uuid）
    const token = jwt.sign(
      { uuid: user.uuid, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 记录登录 IP + 归属地
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const ua = (req.headers['user-agent'] || '').substring(0, 256);
    (async () => {
      try {
        const geo = require('../utils/geoip');
        const location = await geo.queryIP(ip);
        await pool.query(
          'INSERT INTO login_logs (user_id, ip, user_agent, location) VALUES ($1, $2, $3, $4)',
          [user.id, ip, ua, location]
        );
      } catch (e) {
        console.error('记录登录IP失败:', e.message);
        // fallback: insert without location
        pool.query(
          'INSERT INTO login_logs (user_id, ip, user_agent) VALUES ($1, $2, $3)',
          [user.id, ip, ua]
        ).catch(() => {});
      }
    })();

    res.json({
      token,
      user: {
        uuid: user.uuid,
        email: user.email,
        username: user.username,
        credits: user.credits
      }
    });
  } catch (err) {
    console.error('登录失败:', err);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

// --- 获取当前用户信息 ---
router.get('/me', authGuard(true), async (req, res) => {
  res.json({
    user: {
      uuid: req.user.uuid,
      email: req.user.email,
      username: req.user.username,
      credits: req.user.credits,
      email_verified: req.user.email_verified
    }
  });
});

// --- 邮箱验证 ---
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: '缺少验证 token' });
    }

    const result = await pool.query(
      'SELECT user_id, type, used, expires_at FROM email_tokens WHERE token = $1 AND type = $2',
      [token, 'verify']
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: '验证链接已失效' });
    }

    const tokenData = result.rows[0];

    if (tokenData.used === 1) {
      return res.status(400).json({ error: '验证链接已失效' });
    }

    if (new Date(tokenData.expires_at) < new Date()) {
      return res.status(400).json({ error: '验证链接已失效' });
    }

    await pool.query(
      'UPDATE users SET email_verified = 1, updated_at = NOW() WHERE id = $1',
      [tokenData.user_id]
    );

    await pool.query(
      'UPDATE email_tokens SET used = 1 WHERE token = $1',
      [token]
    );

    res.json({ message: '邮箱验证成功，请登录' });
  } catch (err) {
    console.error('邮箱验证失败:', err);
    res.status(500).json({ error: '验证失败，请稍后重试' });
  }
});

// --- 重发验证邮件 ---
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: '请输入邮箱' });
    }

    const result = await pool.query('SELECT id, email_verified FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = result.rows[0];
    if (user.email_verified === 1) {
      return res.status(400).json({ error: '邮箱已验证' });
    }

    // 冷却检查
    const resendCooldown = checkEmailCooldown(email, 'verify');
    if (resendCooldown > 0) {
      return res.status(429).json({ error: '发送过于频繁，请 ' + resendCooldown + ' 秒后重试', cooldown: resendCooldown });
    }

    // 失效旧的验证 token
    await pool.query(
      "UPDATE email_tokens SET used = 1 WHERE user_id = $1 AND type = 'verify' AND used = 0",
      [user.id]
    );

    // 生成新 token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO email_tokens (user_id, token, type, expires_at) VALUES ($1, $2, $3, $4)',
      [user.id, verifyToken, 'verify', expiresAt]
    );

    if (process.env.SMTP_HOST) {
      try {
        await sendVerifyEmail(email, verifyToken, process.env.BASE_URL || 'http://localhost:8080');
      } catch (e) {
        console.error('发送验证邮件失败:', e.message);
      }
    }

    res.json({ message: '验证邮件已重新发送' });
  } catch (err) {
    console.error('重发验证邮件失败:', err);
    res.status(500).json({ error: '发送失败，请稍后重试' });
  }
});

// --- 忘记密码 ---
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    // 冷却检查
    const forgotCooldown = checkEmailCooldown(email, 'reset');
    if (forgotCooldown > 0) {
      return res.status(429).json({ error: '发送过于频繁，请 ' + forgotCooldown + ' 秒后重试', cooldown: forgotCooldown });
    }

    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);

    if (result.rowCount > 0) {
      const user = result.rows[0];
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await pool.query(
        'INSERT INTO email_tokens (user_id, token, type, expires_at) VALUES ($1, $2, $3, $4)',
        [user.id, resetToken, 'reset', expiresAt]
      );

      if (process.env.SMTP_HOST) {
        try {
          await sendResetEmail(email, resetToken, process.env.BASE_URL || 'http://localhost:8080');
        } catch (e) {
          console.error('发送重置邮件失败:', e.message);
        }
      }
    }

    res.json({ message: '如果该邮箱已注册，重置链接已发送' });
  } catch (err) {
    console.error('忘记密码失败:', err);
    res.status(500).json({ error: '发送失败，请稍后重试' });
  }
});

// --- 重置密码 ---
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少 6 位' });
    }

    const result = await pool.query(
      'SELECT user_id, used, expires_at FROM email_tokens WHERE token = $1 AND type = $2',
      [token, 'reset']
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: '无效的重置链接' });
    }

    const tokenData = result.rows[0];
    if (tokenData.used === 1) {
      return res.status(400).json({ error: '该重置链接已被使用' });
    }
    if (new Date(tokenData.expires_at) < new Date()) {
      return res.status(400).json({ error: '重置链接已过期' });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, tokenData.user_id]
    );

    await pool.query('UPDATE email_tokens SET used = 1 WHERE token = $1', [token]);

    res.json({ message: '密码已重置，请用新密码登录' });
  } catch (err) {
    console.error('重置密码失败:', err);
    res.status(500).json({ error: '重置失败，请稍后重试' });
  }
});

module.exports = router;
