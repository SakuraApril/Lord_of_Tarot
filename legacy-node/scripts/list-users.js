require('dotenv').config();

const { Pool } = require('pg');

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function shouldUseSSL(connectionString) {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode === 'disable') return false;
  return !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function normalizeConnectionString(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('缺少 DATABASE_URL。请先在 .env 里配置数据库连接。');
    process.exitCode = 1;
    return;
  }

  const useSSL = shouldUseSSL(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: normalizeConnectionString(process.env.DATABASE_URL),
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.username,
        u.email_verified,
        u.created_at,
        COUNT(r.id)::int AS readings_count
      FROM users u
      LEFT JOIN readings r ON r.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    if (result.rows.length === 0) {
      console.log('当前还没有注册用户。');
      return;
    }

    console.log(`注册用户总数：${result.rows.length}\n`);
    console.table(result.rows.map((user) => ({
      ID: user.id,
      邮箱: user.email,
      昵称: user.username,
      邮箱已验证: user.email_verified === 1 ? '是' : '否',
      占卜次数: user.readings_count,
      注册时间: formatDate(user.created_at),
    })));
  } catch (error) {
    const detail = error.message || error.code || String(error);
    console.error('查询注册用户失败：', detail);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
