const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendVerifyEmail(to, token, baseUrl) {
  const url = `${baseUrl}/verify-email.html?token=${token}`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: '星界启示录 - 邮箱验证',
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a1a;font-family:Georgia,serif;">
<div style="max-width:500px;margin:40px auto;background:linear-gradient(180deg,#1a0a2e,#0d0420);border:1px solid rgba(214,168,67,0.3);border-radius:16px;padding:40px 30px;text-align:center;">
  <h1 style="color:#FFD26A;font-size:1.8rem;letter-spacing:4px;margin-bottom:8px;">星界启示录</h1>
  <p style="color:#38BDF8;font-size:0.7rem;font-family:monospace;letter-spacing:6px;text-transform:uppercase;">ASTRAL TAROT</p>
  <div style="width:120px;height:1px;margin:24px auto;background:linear-gradient(90deg,transparent,#D4A843,transparent);"></div>
  <p style="color:#e2e8f0;font-size:1rem;line-height:1.8;">感谢注册星界启示录，请点击下方按钮验证你的邮箱：</p>
  <a href="${url}" style="display:inline-block;margin:24px 0;padding:12px 36px;background:linear-gradient(135deg,#4a3319,#241403);border:1px solid #D4A843;color:#FFF8E7;border-radius:25px;text-decoration:none;font-size:0.95rem;letter-spacing:2px;">验证邮箱</a>
  <p style="color:#64748b;font-size:0.75rem;">此链接 24 小时内有效。如果这不是你的操作，请忽略此邮件。</p>
</div>
</body>
</html>`,
  });
}

async function sendResetEmail(to, token, baseUrl) {
  const url = `${baseUrl}/reset-password.html?token=${token}`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: '星界启示录 - 重置密码',
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a1a;font-family:Georgia,serif;">
<div style="max-width:500px;margin:40px auto;background:linear-gradient(180deg,#1a0a2e,#0d0420);border:1px solid rgba(214,168,67,0.3);border-radius:16px;padding:40px 30px;text-align:center;">
  <h1 style="color:#FFD26A;font-size:1.8rem;letter-spacing:4px;margin-bottom:8px;">星界启示录</h1>
  <p style="color:#38BDF8;font-size:0.7rem;font-family:monospace;letter-spacing:6px;text-transform:uppercase;">ASTRAL TAROT</p>
  <div style="width:120px;height:1px;margin:24px auto;background:linear-gradient(90deg,transparent,#D4A843,transparent);"></div>
  <p style="color:#e2e8f0;font-size:1rem;line-height:1.8;">我们收到你的密码重置请求，请点击下方按钮设置新密码：</p>
  <a href="${url}" style="display:inline-block;margin:24px 0;padding:12px 36px;background:linear-gradient(135deg,#4a3319,#241403);border:1px solid #D4A843;color:#FFF8E7;border-radius:25px;text-decoration:none;font-size:0.95rem;letter-spacing:2px;">重置密码</a>
  <p style="color:#64748b;font-size:0.75rem;">此链接 1 小时内有效。如果这不是你的操作，请忽略此邮件。</p>
</div>
</body>
</html>`,
  });
}

module.exports = { sendVerifyEmail, sendResetEmail };
