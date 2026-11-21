const express = require('express');
const { pool } = require('../db/init');
const authGuard = require('../middleware/auth');

const router = express.Router();

// --- 额度流水查询 ---
router.get('/credit-transactions', authGuard(true), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const data = await pool.query(
      `SELECT id, delta AS \`change\`, balance, source, ref_id, created_at
       FROM credit_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const total = await pool.query(
      'SELECT COUNT(*) FROM credit_transactions WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      transactions: data.rows,
      total: parseInt(total.rows[0].count),
      page,
      limit
    });
  } catch (err) {
    console.error('获取额度流水失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// --- 查询额度 ---
router.get('/credits', authGuard(true), async (req, res) => {
  res.json({ credits: req.user.credits });
});

// --- 兑换卡密 ---
router.post('/redeem', authGuard(true), async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: '请输入兑换码' });
    }

    const formattedCode = code.trim().toUpperCase();

    // 原子查询并更新
    const updated = await pool.query(
      `UPDATE coupons
       SET used = 1, used_by = $1, used_at = NOW()
       WHERE code = $2 AND used = 0 AND (expires_at IS NULL OR expires_at > NOW())`,
      [req.user.id, formattedCode]
    );
    const result = updated.rowCount === 0
      ? { rowCount: 0, rows: [] }
      : await pool.query('SELECT credits, id FROM coupons WHERE code = $1', [formattedCode]);

    if (result.rowCount === 0) {
      const check = await pool.query('SELECT used, expires_at FROM coupons WHERE code = $1', [formattedCode]);
      if (check.rowCount === 0) {
        return res.status(400).json({ error: '无效的兑换码' });
      }
      if (check.rows[0].used === 1) {
        return res.status(400).json({ error: '该兑换码已被使用' });
      }
      if (check.rows[0].expires_at && new Date(check.rows[0].expires_at) < new Date()) {
        return res.status(400).json({ error: '该兑换码已过期' });
      }
      return res.status(400).json({ error: '兑换失败，请稍后重试' });
    }

    const coupon = result.rows[0];
    const newCredits = req.user.credits + coupon.credits;

    await pool.query(
      'UPDATE users SET credits = $1, updated_at = NOW() WHERE id = $2',
      [newCredits, req.user.id]
    );

    await pool.query(
      'INSERT INTO credit_transactions (user_id, delta, balance, source, ref_id) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, coupon.credits, newCredits, 'redeem', coupon.id]
    );

    req.user.credits = newCredits;

    res.json({
      message: '兑换成功',
      credits: newCredits,
      added: coupon.credits
    });
  } catch (err) {
    console.error('兑换失败:', err);
    res.status(500).json({ error: '兑换失败，请稍后重试' });
  }
});

// --- 历史记录列表 ---
router.get('/history', authGuard(true), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const data = await pool.query(
      `SELECT id, question, spread_type, cards_json, created_at
       FROM readings
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const total = await pool.query(
      'SELECT COUNT(*) FROM readings WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      readings: data.rows,
      total: parseInt(total.rows[0].count),
      page,
      limit
    });
  } catch (err) {
    console.error('获取历史记录失败:', err);
    res.status(500).json({ error: '获取失败，请稍后重试' });
  }
});

// --- 历史记录详情 ---
router.get('/history/:id', authGuard(true), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM readings WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }
    res.json({ reading: result.rows[0] });
  } catch (err) {
    console.error('获取历史详情失败:', err);
    res.status(500).json({ error: '获取失败，请稍后重试' });
  }
});

// --- 删除历史记录 ---
router.delete('/history/:id', authGuard(true), async (req, res) => {
  try {
    const existing = await pool.query(
      'SELECT id FROM readings WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }
    await pool.query('DELETE FROM readings WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: '删除成功' });
  } catch (err) {
    console.error('删除历史记录失败:', err);
    res.status(500).json({ error: '删除失败' });
  }
});

// --- 修改用户名 ---
router.put('/update-username', authGuard(true), async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || username.trim().length === 0) {
      return res.status(400).json({ error: '请输入用户名' });
    }
    if (username.length > 30) {
      return res.status(400).json({ error: '用户名最长 30 个字符' });
    }

    // 检查是否已存在
    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 AND id != $2',
      [username, req.user.id]
    );
    if (existing.rowCount > 0) {
      return res.status(400).json({ error: '该用户名已被使用' });
    }

    await pool.query(
      'UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2',
      [username, req.user.id]
    );

    res.json({ message: '用户名修改成功', username });
  } catch (err) {
    console.error('修改用户名失败:', err);
    res.status(500).json({ error: '修改失败，请稍后重试' });
  }
});

// --- 修改邮箱 ---
router.put('/update-email', authGuard(true), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: '请输入邮箱' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    // 检查是否已存在
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND id != $2',
      [email, req.user.id]
    );
    if (existing.rowCount > 0) {
      return res.status(400).json({ error: '该邮箱已被注册' });
    }

    // 更新邮箱并重置验证状态
    await pool.query(
      'UPDATE users SET email = $1, email_verified = 0, updated_at = NOW() WHERE id = $2',
      [email, req.user.id]
    );

    res.json({ message: '邮箱修改成功，新邮箱需要重新验证' });
  } catch (err) {
    console.error('修改邮箱失败:', err);
    res.status(500).json({ error: '修改失败，请稍后重试' });
  }
});

// --- 删除账号（需密码确认）---
router.delete('/delete-account', authGuard(true), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: '请输入密码' });
    const bcrypt = require('bcryptjs');
    const user = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (user.rowCount === 0) return res.status(404).json({ error: '用户不存在' });
    const match = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: '密码错误' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    res.json({ message: '账号已删除' });
  } catch (err) {
    console.error('删除账号失败:', err);
    res.status(500).json({ error: '删除账号失败' });
  }
});

module.exports = router;
