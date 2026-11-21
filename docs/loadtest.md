# 压测记录与瓶颈分析

> 时间：2026-11-21
> 环境：Windows 10 + WSL2(Ubuntu 20.04) / MySQL 8.0.42 / Redis 5.0.7 / RabbitMQ 3.8
> 服务：Node 24，单进程，`MYSQL_POOL_SIZE=5`
> 工具：`scripts/loadtest.js`（自写，纯 Node，无需 wrk）

---

## 一、方法

```bash
# 先把限流上限调大，否则测的是限流而不是系统能力
RL_API_MAX=1000000 RL_READING_MAX=1000000 npm start

node scripts/loadtest.js --path /api/cards --concurrency 50 --duration 10
node scripts/loadtest.js --path "/api/user/history/{id}" --auth --concurrency 50 --duration 10
node scripts/loadtest.js --path /api/reading/async --method POST --auth --users 50 --concurrency 20 --duration 10
```

指标：QPS、错误率、平均延迟、P50 / P95 / P99。

---

## 二、结果

| # | 接口 | 路径 | 并发 | QPS | P99 | 错误率 |
|---|---|---|---|---|---|---|
| ① | 牌面数据（纯内存 + Redis 限流） | `GET /api/cards` | 50 | **669.6** | 145 ms | 0% |
| ② | 历史详情（Redis 缓存命中） | `GET /api/user/history/{id}` | 50 | **2102.2** | 50 ms | 0% |
| ③ | 异步提交（单用户，热点行） | `POST /api/reading/async` | 20 | **80.1** | 385 ms | 0% |
| ④ | 异步提交（50 用户分散） | `POST /api/reading/async` | 20 | **317.6** | 129 ms | 0% |

---

## 三、瓶颈分析

### 3.1 第一反应：不是连接池

③ 只有 80 QPS，直觉怀疑连接池太小（`max=5`）。
把 `MYSQL_POOL_SIZE` 调到 20 重测：

```
连接池 5  → QPS 80.1，P99 385 ms
连接池 20 → QPS 81.9，P99 357 ms
```

**几乎没有变化**，说明瓶颈不在连接数量。

### 3.2 实际原因：热点行锁

每次提交都要执行：

```sql
UPDATE users SET credits = credits - 1 WHERE id = $1 AND credits > 0
```

所有压测请求打的是**同一个用户**，等于所有事务都在抢同一行。
InnoDB 对同一行的排他锁会把并发串行化：吞吐上限 ≈ 1 / 单个事务耗时。

验证方法：换成 50 个用户轮询，让更新分散到 50 行。

```
单用户  → QPS 80.1， P99 385 ms
50 用户 → QPS 317.6，P99 129 ms
```

**吞吐提升约 4 倍，P99 降低 3 倍**，符合「热点行锁」的预期。
这也解释了为什么加连接池没用——锁不在连接上，在行上。

### 3.3 为什么 ① 比 ② 慢

① 每个请求都要过一次 Redis 限流（`INCR` + 可能的 `EXPIRE`，2 次往返），
② 是缓存命中（1 次 `GET`）+ 缓存中间件跳过限流（GET 不占起卦额度）。

单次测量：MySQL 往返 0.34 ms，Redis 往返 0.23 ms，
所以 ① 的 669 QPS 主要花在「每请求 2~3 次 Redis 往返 + Express 中间件栈」上，
不是数据库问题。

---

## 四、可以写进简历的结论

> 用自写压测脚本（50 并发）测三类接口：内存读 670 QPS、缓存读 2100 QPS、
> 含事务的异步提交 80 QPS；定位到瓶颈是**同一用户额度行的锁竞争**而非连接池
> （池 5→20 无提升），改为 50 用户分散后 QPS 提升 4 倍至 318、P99 从 385ms 降到 129ms。

---

## 五、局限

1. **本机压测**：客户端和服务端同机，测的是「相对差异」而不是绝对性能。
2. **数据量小**：`readings` 只有几十行，索引效率不代表真实数据量。
3. **单进程 Node**：没有用 cluster，单核限制未测。
4. **没有长时间稳定性测试**：只跑 10 秒，没看内存增长与连接泄漏。
5. **模型是 mock**：异步提交不包含真实模型耗时（真实场景 QPS 会更高，因为提交不等模型）。
