# PostgreSQL → MySQL 迁移记录

> 记录时间：2026-11-21
> 迁移范围：`db/`、`server.js`、`routes/auth.js`、`routes/user.js`
> 结果：7 张表全部迁移，接口回归通过，并发扣减验证通过

---

## 一、为什么要迁

原实现跑在 Supabase 托管 PostgreSQL 上，SQL 里用了不少 PG 专有写法。
后端岗位的面试与团队技术栈普遍以 MySQL 为主，所以这次把数据层整体换到 MySQL 8.0，
并顺手补上两张支撑「幂等」和「异步任务」的表。

迁移的原则是：**不动业务逻辑，只动数据访问层**。
所以没有逐条重写 30 多处 SQL，而是加了一层薄适配（见第四节）。

---

## 二、表结构变化

| PG 版 | MySQL 版 | 变化 |
|---|---|---|
| 7 张表 | 9 张表 | 新增 `idempotency_keys`、`reading_tasks` |
| `credit_transactions.change` | `credit_transactions.delta` | `CHANGE` 是 MySQL 保留字 |
| 无 | `readings` 增加 `(user_id, created_at)` 索引 | 分页查询走复合索引 |
| 无 | `credit_transactions` 增加 `(user_id, created_at)` 索引 | 流水列表按时间倒序 |

完整 DDL 见 `db/schema.mysql.sql`。

---

## 三、类型与语法映射

| PostgreSQL | MySQL 8.0 | 说明 |
|---|---|---|
| `SERIAL PRIMARY KEY` | `INT AUTO_INCREMENT` | 自增主键 |
| `UUID DEFAULT gen_random_uuid()` | `CHAR(36) DEFAULT (UUID())` | 需 MySQL 8.0.13+ |
| `TEXT` + `UNIQUE` | `VARCHAR(191)` + `UNIQUE` | MySQL 索引需要前缀长度，191 兼容 utf8mb4 |
| `TIMESTAMP DEFAULT NOW()` | `DATETIME DEFAULT CURRENT_TIMESTAMP` | — |
| `TIMESTAMP` 自动更新 | `ON UPDATE CURRENT_TIMESTAMP` | 替代触发器 |
| `CREATE INDEX IF NOT EXISTS` | `CREATE TABLE` 内联 `KEY` | MySQL 8 不支持该语法 |
| `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` | 去掉（建表时已包含） | MySQL 8 不支持 |
| `RETURNING ...` | 无等价物 | 需改写，见下 |

---

## 四、RETURNING 的处理（迁移里唯一不能自动化的部分）

MySQL 没有 `RETURNING`，共 7 处，按语义分三类处理：

| 场景 | PG 写法 | MySQL 写法 |
|---|---|---|
| 扣额度后取新余额 | `UPDATE ... WHERE credits > 0 RETURNING credits` | 事务内 `UPDATE` + `SELECT credits` |
| 插入后取主键 | `INSERT ... RETURNING id` | 用 `result.insertId` |
| 更新/删除后取行 | `UPDATE/DELETE ... RETURNING id, email` | 先 `SELECT`，再执行 `UPDATE/DELETE` |

**扣额度这处最关键**，它不是简单替换：

```js
// MySQL 里 UPDATE 之后立刻 SELECT，读到的余额会不会被别人改？
// 不会 —— UPDATE 已对该行加排他锁，锁在事务提交时才释放。
await conn.begin();
const upd = await conn.query(
  'UPDATE users SET credits = credits - 1, updated_at = NOW() WHERE id = $1 AND credits > 0', [userId]
);
if (upd.rowCount === 0) { await conn.rollback(); return; }   // 额度不足
const bal = await conn.query('SELECT credits FROM users WHERE id = $1', [userId]);
await conn.commit();
```

---

## 五、占位符适配层（`db/mysql.js`）

业务代码里全是 `$1 / $2`，如果逐个改成 `?`，要动 30 多处、回归风险高。
所以加了一层转换：

```js
// $1 $2 → ?，并按编号重排参数
function convertPlaceholders(sql, params) {
  const order = [];
  const text = sql.replace(/\$(\d+)/g, (_, n) => { order.push(Number(n) - 1); return '?'; });
  return { text, params: order.length ? order.map(i => params[i]) : params };
}
```

同时把 mysql2 的返回统一成 pg 的 `{ rows, rowCount }`，
这样 `result.rows[0]`、`result.rowCount` 这些调用点一行都不用改。

> 面试可以讲：这是「适配层换方言」的思路，代价是多一层函数调用；
> 长期维护应该逐步把 SQL 改成原生 `?`，但一次性改完的风险不值得。
> **注意别把它说成“我做了 ORM”**——它只是个占位符转换。

---

## 六、踩到的坑

| 坑 | 现象 | 处理 |
|---|---|---|
| `CHANGE` 是保留字 | 建表直接报语法错 | 列名改 `delta`，查询时 `delta AS \`change\`` 保证前端字段不变 |
| 别名也要反引号 | `SELECT delta AS change` 报语法错 | 同上，别名加反引号；在 JS 模板字符串里要写成 `` \`change\` `` |
| `TEXT` 不能直接建唯一索引 | `BLOB/TEXT column used in key specification without a key length` | 改成 `VARCHAR(191)` |
| `CREATE INDEX IF NOT EXISTS` 不支持 | 建表脚本第二次执行报错 | 索引写进 `CREATE TABLE` 的 `KEY` 里 |
| WSL 里 MySQL 会随虚拟机休眠停止 | Windows 侧 `ECONNREFUSED 127.0.0.1:3306` | `systemctl enable --now mysql redis-server`，并保持 WSL 有常驻进程 |

---

## 七、验证

### 7.1 并发扣减（`npm run verify:mysql`）

30 个并发请求抢 10 次额度：

```
初始额度: 10，并发请求: 30
成功次数: 10（期望 10）
最终余额: 0（期望 0）
流水条数: 10（期望 10）
扣减后的余额序列: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
总耗时: 103 ms

✅ 通过：没有超扣，余额快照无重复
```

余额序列不重复，说明每个并发请求拿到的都是「自己这一次扣完之后」的余额，
没有出现两个请求读到同一个快照的情况。

### 7.2 接口回归

```
② 登录:            200，拿到 token
③ 查额度:          200 {"credits":3}
④ 兑换:            200 {"credits":8,"added":5}
⑤ 流水:            200 [{"change":5,"balance":8,"source":"redeem"}]
⑥ 重复兑换:        400 该兑换码已被使用
⑦ 最终额度:        8（期望 8）
```

覆盖了：`SELECT`、`INSERT`、条件 `UPDATE`、`DELETE`、别名查询、唯一约束冲突。

---

## 八、已知遗留

1. **线上仍是 PostgreSQL**：Fly.io 的 256MB 实例跑不动 MySQL，改造版只在本地跑压测，
   线上服务不动。
2. **连接池上限 5**：本地验证够用，压测时如果出现 `ER_CON_COUNT_ERROR` 需要调整。
3. **没有迁移工具**：目前是启动时执行 `db/schema.mysql.sql`（幂等建表），
   生产应该换成正式迁移工具（如 `knex` / `umzug`）并记录版本。
4. **历史数据没迁**：只迁了结构，线上旧数据未导入（本地验证不需要）。
