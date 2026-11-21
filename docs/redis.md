# Redis 改造：限流与缓存

> 记录时间：2026-11-21
> 涉及文件：`lib/redis.js`、`middleware/redisRateLimit.js`、`server.js`、`routes/user.js`

---

## 一、为什么要改

改造前的两个问题：

1. **限流是进程内计数**（`express-rate-limit` 默认内存存储）。
   单实例没问题，一旦部署两个实例，实际放行量就是上限的两倍——这是典型的「本地测试永远发现不了、上线才炸」的坑。
2. **读接口全部打库**。历史详情每次请求都要查 MySQL，没有任何缓存层。

改造后：限流计数进 Redis（多实例共享），历史详情走 cache-aside 缓存。

---

## 二、限流：从进程内计数到 Redis

### 2.1 四层限流保持不变

| 层级 | 窗口 | 上限 | 目的 |
|---|---|---|---|
| `/api/` | 15 分钟 | 200 | 挡爬虫；已登录用户跳过 |
| `/api/auth/` | 15 分钟 | 500 | 登录注册放宽但计数 |
| `/api/user/redeem` | 1 分钟 | 3 | 兑换码是枚举目标，必须严 |
| `/api/reading` | 5 分钟 | 15 | 防刷额度与模型成本 |

### 2.2 实现：Lua 脚本（不是 INCR + EXPIRE 两条命令）

```lua
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return { count, ttl }
```

**为什么必须用 Lua**：`INCR` 和 `EXPIRE` 是两条命令，中间如果进程崩溃，
会留下一个「有计数、没有 TTL」的 key —— 这个 IP 会被**永久封禁**。
Lua 在 Redis 内部原子执行，不存在中间态。

脚本里还加了自愈：如果发现 key 没有 TTL（历史遗留的脏 key），顺手补上，
避免已经存在坏 key 永远卡住用户。

用 ioredis 的 `defineCommand` 注册，客户端会自动走 `EVALSHA` 并处理 `NOSCRIPT` 重载：

```js
client.defineCommand('incrWindowAtomic', { numberOfKeys: 1, lua: WINDOW_SCRIPT });
const [count, ttlMs] = await client.incrWindowAtomic(key, windowMs);
```

顺带的好处：计数和剩余 TTL 一次往返拿到，而两条命令要两次往返。

#### 验证（`npm run verify:lua`）

```
① 并发 200 次：
   最终计数 200（说明没有丢计数）
   最小 TTL 60s（说明每次都有过期时间）
   总耗时 17 ms（200 次 EVALSHA 往返）
② 脏 key 自愈：
   调用前 TTL=-1（永不过期，就是那个 bug）
   调用后 TTL=60
```

### 2.3 为什么不用滑动窗口 / 令牌桶

固定窗口在窗口交界处会放过最多 2 倍流量（比如 14:59 打满 200，15:00 又打满 200）。
对这个项目足够——限流目的是「防刷」而不是「精确控速」。
真要平滑，把 `INCR` 换成 Lua 令牌桶即可，代价是脚本更难维护、更难被面试官问明白。

### 2.4 关键设计：Redis 挂了要放行

```js
if (!isReady()) return next();          // 连接不可用 → 直接放行
try { ... } catch { return next(); }    // 计数失败 → 同样放行
```

限流是保护措施，不能反过来把业务卡死。这是取舍，不是疏忽：
- 放行的风险：短时间可能被刷
- 拦死的风险：Redis 一抖，全站 429

对个人项目、低流量场景，宁可放行。

---

## 三、缓存：cache-aside + 三件套

### 3.1 缓存对象

`GET /api/user/history/:id`（解读详情）——原本每次都查 MySQL。

key：`reading:{userId}:{readingId}`，TTL 60 秒 + 0~30 秒随机抖动。

> 为什么 key 里要带 userId：详情是按用户隔离的，
> 只按 readingId 做 key，理论上会出现「A 的缓存被 B 读到」。
> 虽然查询条件里有 user_id，但缓存层不做鉴权，所以 key 必须带用户维度。

### 3.2 防穿透（查询不存在的数据）

查不到也写缓存，值是一个空标记，TTL 更短：

```js
const NULL_MARKER = '\u0000__NULL__';
await client.set(key, NULL_MARKER, 'EX', Math.max(5, Math.floor(ttl / 4)));
```

效果：不存在的 id 第一次 404 + MISS，第二次直接 404 + HIT，不打库。

> 面试可以补一句：数据量大、id 空间稀疏时应该用布隆过滤器，
> 这里 id 是自增、量级小，空值缓存够用，且实现更简单。

### 3.3 防击穿（热点 key 过期瞬间）

回源前抢互斥锁：

```js
const gotLock = await client.set(lockKey, '1', 'PX', lockTtlMs, 'NX');
if (!gotLock) { await sleep(60); /* 重读缓存，仍没有就直接查库 */ }
```

只有抢到锁的请求打数据库，其余等 60ms 后重读。

> 这里没有用「逻辑过期 + 异步重建」，因为那需要后台线程；
> 60ms 重试对读接口是可接受的代价。

### 3.4 防雪崩（大量 key 同时过期）

`ttl = 60 + random(0, 30)`。同一批写入的 key 不会在同一秒集体失效。

### 3.5 一致性：删缓存而不是更新缓存

```js
await pool.query('DELETE FROM readings WHERE id = $1 AND user_id = $2', [...]);
if (isReady()) await delCache(key);   // 删库后清缓存
```

为什么删而不是更新：
- 更新缓存要「把库里的最新值读出来再写回去」，两次写之间有并发窗口
- 删除是幂等的，下次读自然回源

**没有做延迟双删**：详情页是低频写、高频读，删一次足够；
如果是有并发写的场景（比如点赞数），才需要延迟双删或订阅 binlog。

---

## 四、验证结果

### 4.1 限流（`npm run verify:redis`）

```
② 限流：第 201 次开始被拦（期望 201），最后一次状态 429
   Retry-After=900s，剩余额度头=0
```

### 4.2 缓存

```
④ 第一次 X-Cache=MISS（期望 MISS），第二次 X-Cache=HIT（期望 HIT）
⑤ 删库后再查：状态 200，X-Cache=HIT   ← 证明读的是缓存而不是库
⑥ 不存在的记录：404/404，X-Cache=MISS→HIT（空值缓存生效）
⑦ Redis 中的缓存键: [ 'reading:5:99999', 'reading:5:1' ]
```

第 ⑤ 步是关键证据：把数据库里的记录删掉之后还能返回 200，说明真的走了缓存。

### 4.3 降级（`npm run verify:degrade`，需先停掉 Redis）

```
① 健康检查: 200 redis.ok = false
② 查历史详情: 200，X-Cache=bypass
③ 连打 6 次 /api/cards：6/6 放行（限流降级为放行）

✅ 降级验证通过
```

---

## 五、已知遗留

1. **限流是固定窗口**，边界处可能放过 2 倍流量；要精确需换令牌桶 Lua。
2. **缓存没有做主动预热**，冷启动后首批请求会 MISS。
3. **没有缓存命中率指标**（只打了 `X-Cache` 响应头），接监控后应该统计 HIT/MISS 比例。
4. **互斥锁的锁超时是 3 秒**，如果回源超过 3 秒会短暂出现并发回源，属于可接受退化。
