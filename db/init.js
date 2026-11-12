const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const caPath = path.join(__dirname, '..', 'supabase-ca.pem');
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

// 优先从环境变量读取，其次从文件读取
let caCert = process.env.SUPABASE_CA_CERT
  || (fs.existsSync(caPath) ? fs.readFileSync(caPath).toString() : null);
// 环境变量中换行符可能被存储为 \n 字面字符串，需要转换
if (caCert && !caCert.includes('\n') && caCert.includes('\\n')) {
  caCert = caCert.replace(/\\n/g, '\n');
}

// 连接 Supabase 时必须用 CA 证书验证
const useCA = !!caCert && dbUrl.includes('supabase');

// 始终去掉 sslmode 及其他非标准参数，由代码控制 SSL
let connectionString = dbUrl;
if (connectionString) {
  connectionString = connectionString
    .replace(/[?&]sslmode=[^&]*/g, '')
    .replace(/[?&]supa=[^&]*/g, '')
    .replace(/\?$/, '')
    .replace(/&/, '?');
}

const pool = new Pool({
  connectionString,
  ssl: useCA ? {
    rejectUnauthorized: true,
    ca: caCert,
  } : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- 1. users 表
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        uuid            UUID DEFAULT gen_random_uuid() NOT NULL UNIQUE,
        email           TEXT NOT NULL UNIQUE,
        username        TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        credits         INTEGER NOT NULL DEFAULT 3,
        email_verified  INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid);

      -- 2. readings 表
      CREATE TABLE IF NOT EXISTS readings (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        question    TEXT NOT NULL,
        spread_type TEXT NOT NULL,
        cards_json  TEXT NOT NULL,
        ai_response TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_readings_user ON readings(user_id, created_at DESC);

      -- 3. email_tokens 表
      CREATE TABLE IF NOT EXISTS email_tokens (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      TEXT NOT NULL UNIQUE,
        type       TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_email_tokens_token ON email_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);

      -- 4. coupons 表
      CREATE TABLE IF NOT EXISTS coupons (
        id          SERIAL PRIMARY KEY,
        code        TEXT NOT NULL UNIQUE,
        credits     INTEGER NOT NULL DEFAULT 1,
        used        INTEGER NOT NULL DEFAULT 0,
        used_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        used_at     TIMESTAMP,
        expires_at  TIMESTAMP,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);

      -- 5. credit_transactions 表
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        change      INTEGER NOT NULL,
        balance     INTEGER NOT NULL,
        source      TEXT NOT NULL,
        ref_id      INTEGER,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id);

      -- 6. login_logs 表
      CREATE TABLE IF NOT EXISTS login_logs (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip          TEXT NOT NULL,
        user_agent  TEXT,
        location    TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
      -- 兼容已有数据库：如果 location 列不存在则添加
      ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS location TEXT;
      CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs(user_id, created_at DESC);

      -- 7. pending_registrations 表（邮箱未验证前的临时存储）
      CREATE TABLE IF NOT EXISTS pending_registrations (
        id              SERIAL PRIMARY KEY,
        email           TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        username        TEXT NOT NULL,
        token           TEXT NOT NULL UNIQUE,
        expires_at      TIMESTAMP NOT NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pending_token ON pending_registrations(token);
    `);
    console.log('✅ 所有表初始化完成');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
