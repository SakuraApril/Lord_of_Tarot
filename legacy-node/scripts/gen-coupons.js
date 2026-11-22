require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const args = process.argv.slice(2);
  const count = parseInt(args[0]) || 1;
  const credits = parseInt(args[1]) || 10;

  const client = await pool.connect();
  const codes = [];

  try {
    // 确保 coupons 表存在
    await client.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id          SERIAL PRIMARY KEY,
        code        TEXT NOT NULL UNIQUE,
        credits     INTEGER NOT NULL DEFAULT 1,
        used        INTEGER NOT NULL DEFAULT 0,
        used_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        used_at     TIMESTAMP,
        expires_at  TIMESTAMP,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    for (let i = 0; i < count; i++) {
      const code = 'TAROT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      await client.query(
        `INSERT INTO coupons (code, credits) VALUES ($1, $2)`,
        [code, credits]
      );
      codes.push(code);
      console.log(`✅ ${code}  (${credits} 积分)`);
    }
    console.log(`\n已生成 ${count} 个兑换码，每个 ${credits} 积分`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
