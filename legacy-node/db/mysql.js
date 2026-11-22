/**
 * MySQL 适配层
 *
 * 背景：项目原本跑在 PostgreSQL 上，业务代码里全是 `$1 / $2` 占位符和 `RETURNING`。
 * 迁移到 MySQL 时如果逐条改写 30 多处 SQL，改动面太大、回归风险高。
 *
 * 这里的做法是加一层薄适配：
 *   1. 占位符：`$1` → `?`，并按编号重排参数顺序，业务代码不用动
 *   2. 返回值：把 mysql2 的 `[rows] / affectedRows` 统一成 pg 风格的 `{ rows, rowCount }`
 *   3. 连接：暴露 `connect()`，语义与 pg 的 `pool.connect()` 一致，事务写法不变
 *
 * `RETURNING` 是 PostgreSQL 独有的，MySQL 没有等价物，这 7 处必须单独改写，
 * 具体处理方式见 docs/mysql-migration.md。
 */
const mysql = require('mysql2/promise');

/** `$1 $2` → `?`，并把参数按出现顺序重排 */
function convertPlaceholders(sql, params = []) {
  const order = [];
  const text = String(sql).replace(/\$(\d+)/g, (_, n) => {
    order.push(Number(n) - 1);
    return '?';
  });
  const ordered = order.length ? order.map((i) => params[i]) : params;
  return { text, params: ordered };
}

/** 把 mysql2 的返回结果统一成 pg 的形态 */
function normalize(result) {
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length };
  }
  return { rows: [], rowCount: result.affectedRows || 0, insertId: result.insertId };
}

class MysqlPool {
  constructor(config) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port || 3306,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.max || 5,
      waitForConnections: true,
      timezone: 'Z',
      dateStrings: false,
      charset: 'utf8mb4_general_ci',
    });
  }

  async query(sql, params = []) {
    const { text, params: p } = convertPlaceholders(sql, params);
    const [result] = await this.pool.execute(text, p);
    return normalize(result);
  }

  /** 语义同 pg 的 pool.connect()，主要用于事务 */
  async connect() {
    const conn = await this.pool.getConnection();
    return {
      query: async (sql, params = []) => {
        const { text, params: p } = convertPlaceholders(sql, params);
        const [result] = await conn.execute(text, p);
        return normalize(result);
      },
      begin: () => conn.beginTransaction(),
      commit: () => conn.commit(),
      rollback: () => conn.rollback(),
      release: () => conn.release(),
    };
  }

  async end() {
    await this.pool.end();
  }
}

module.exports = { MysqlPool, convertPlaceholders, normalize };
