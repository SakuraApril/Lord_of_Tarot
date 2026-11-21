# 登录态改造：Redis 用户快照 + 登出作废 + 请求上下文

> 记录时间：2026-11-21
> 涉及文件：`lib/session.js`、`lib/context.js`、`middleware/auth.js`、`routes/auth.js`、`routes/user.js`、`server.js`

---

## 一、改造前的两个问题

**1. 每个鉴权请求都查一次 MySQL**

```js
// 改造前：middleware/auth.js
const result = await pool.query('SELECT ... FROM users WHERE uuid = $1', [decoded.uuid]);
```

有登录态的接口，每请求一次都要回一次库。对 `/api/user/credits` 这种接口来说，数据库查询是主要成本。

**2. JWT 无状态，登出是假的**

token 签发后 7 天内一直有效，用户点「退出登录」只是前端删掉了本地 token。
如果 token 泄露（XSS、日志、共享设备），服务端没有任何手段让它失效。

---

## 二、改造方案

### 2.1 用户快照缓存（Redis）

```
GET user:{uuid}  →  命中直接返回
                 →  未命中查库，回填 5 分钟
```

鉴权中间件加 `X-Auth-Cache: HIT/MISS` 响应头，方便验证与排查。

失效时机（关键，写错会读到旧余额）：

| 场景 | 处理 |
|---|---|
| 兑换码加额度 | `session.invalidateUser(uuid)` |
| 后台改额度 | 同上（管理接口） |
| 用户退出登录 | 同上 |
| 其他 | 依赖 5 分钟 TTL 自然过期 |

> 为什么是「删缓存」而不是「更新缓存」：更新要读一次库再写回去，中间仍有并发窗口；
> 删掉之后下次读自然回源，逻辑简单且不会写错。

### 2.2 登出：token 黑名单

签发时给每个 token 加唯一 `jti`：

```js
jwt.sign({ uuid, email, jti: crypto.randomUUID() }, SECRET, { expiresIn: '7d' });
```

登出时把 `jti` 写进 Redis，TTL 设为该 token 的剩余有效期（最长 7 天，自然会清掉，不占长期内存）：

```js
jwt:revoked:{jti} = 1  EX  {exp - now}
```

鉴权时先查黑名单，命中直接 401：

```js
if (decoded.jti && (await session.isRevoked(decoded.jti))) throw new Error('令牌已注销');
```

**Redis 不可用时降级为「不查黑名单」**——宁可放过可能已注销的 token，也不要让所有人登录不了。

### 2.3 请求上下文（Node 版的 ThreadLocal）

Java 用 `ThreadLocal` 传用户上下文，Node 没有线程（单事件循环、多并发请求），
普通全局变量会被并发请求互相覆盖。等价物是 `AsyncLocalStorage`：

```js
const { AsyncLocalStorage } = require('async_hooks');
const storage = new AsyncLocalStorage();

// 中间件里给每个请求开一个上下文
ctx.run({ traceId, startedAt: Date.now() }, next);

// 鉴权通过后补上 userId
ctx.set('userId', user.id);
```

效果：响应头返回 `X-Trace-Id`，日志可以统一带 `[traceId][u123]` 前缀，
一个请求打出来的所有日志都能串起来。

> 面试如果被问「为什么不用 ThreadLocal」：Node 没有线程模型，
> 用 AsyncLocalStorage 实现同样的「请求级隔离」，别的并发请求读不到你的上下文。

---

## 三、验证

### 3.1 功能（`npm run verify:session`）

```
② 登录: 200 拿到 token
③ 鉴权缓存: 第一次 MISS，第二次 HIT
④ X-Trace-Id: ubuqnqt0
⑤ 登出: 200 {"ok":true,"revoked":true,"ttl":604800}
⑥ 登出后再用同一 token: 401 登录已过期，请重新登录
```

### 3.2 性能（`GET /api/user/credits`，50 并发 8 秒）

| 版本 | QPS | P99 |
|---|---|---|
| 改造前（每请求查 MySQL） | 1150.7 | 71 ms |
| 改造后（Redis 快照命中） | **1628.4** | 49 ms |

提升 41% QPS、P99 降低 31%。单次库查询虽然只要 0.34ms，但在高并发下它同时消耗
**连接池槽位**和 **MySQL 的查询处理能力**，省掉之后并发吞吐明显上来。

---

## 四、关于布隆过滤器：这个项目不加

原始需求里提到「用布隆过滤器拦截不存在的用户 ID」。评估后没做，原因：

1. **ID 空间是稠密的**：`users.id` 是自增主键，1..N 连续存在，
   查一个不存在的 id 本来就极少发生，布隆过滤器几乎没有可拦截的量。
2. **已有空值缓存兜底**：解读详情已经实现了「查不到也缓存一个空标记」，
   穿透场景已经被挡住（见 `docs/redis.md`）。
3. **引入成本不低**：Redis 5.0 没有 RedisBloom 模块，要么装模块、要么在应用层维护位图，
   为一个几乎不发生的场景增加一个组件，不划算。

**什么情况下值得加**：用户 ID 是随机 UUID、或者查询来自不可信的枚举（比如卡密、短链），
那时「大量不存在的 key」才是真实流量，布隆过滤器能挡住绝大多数请求。

---

## 五、已知遗留

1. **没有做「强制所有设备下线」**：现在只能作废单个 token。
   要做需要版本号（`users.token_version`），签发时写入 token，校验时比对。
2. **用户快照 5 分钟 TTL**：如果绕过业务接口直接改库（比如手动 SQL 改额度），
   最多会有 5 分钟脏读。
3. **黑名单没有持久化**：Redis 重启后黑名单丢失，已注销的 token 会重新可用
   （最多影响到 token 过期为止）。要求更严就需要写到数据库。
