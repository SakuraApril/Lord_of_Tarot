/**
 * 数据库初始化（MySQL 8.0）
 *
 * 迁移前这里用的是 `pg` + Supabase 托管 PostgreSQL；
 * 现在改为 mysql2，连接信息从环境变量读取，DDL 放在 db/schema.mysql.sql。
 *
 * 配置方式（二选一）：
 *   1. MYSQL_URL=mysql://user:pass@host:3306/tarot
 *   2. MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
 */
const fs = require('fs');
const path = require('path');
const { MysqlPool } = require('./mysql');

function resolveConfig() {
  const url = process.env.MYSQL_URL;
  if (url) {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      max: Number(process.env.MYSQL_POOL_SIZE || 5),
    };
  }
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'tarot',
    max: Number(process.env.MYSQL_POOL_SIZE || 5),
  };
}

const pool = new MysqlPool(resolveConfig());

/** 建表：按分号切分 schema 文件逐条执行，避免开启 multipleStatements */
async function initDB() {
  const schemaPath = path.join(__dirname, 'schema.mysql.sql');
  const raw = fs.readFileSync(schemaPath, 'utf-8');
  const statements = raw
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s && !s.split('\n').every((line) => line.trim().startsWith('--')));

  for (const stmt of statements) {
    await pool.query(stmt);
  }
  console.log(`✅ MySQL 表初始化完成（${statements.length} 条 DDL）`);
}

module.exports = { pool, initDB };
