/**
 * Redis 封装：限流计数 + 缓存三件套
 *
 * 设计原则（面试可以照着讲）：
 *   1. 限流用 INCR + EXPIRE，单命令原子；不用「先读后写」那种两条命令的写法
 *   2. 缓存读用 cache-aside；写库时删缓存，而不是更新缓存
 *   3. 防穿透：查不到也缓存一个空标记，TTL 更短
 *   4. 防击穿：回源前抢 SET NX 互斥锁，只有一个请求打数据库
 *   5. 防雪崩：TTL 加随机抖动，避免同一时刻批量过期
 *   6. Redis 故障时降级：限流放行、缓存降级为直接查库，不让业务挂掉
 */
const Redis = require('ioredis');

const NULL_MARKER = '\u0000__NULL__';

const client = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

let lastError = null;
client.on('error', (err) => {
  lastError = err.message;
});
client.on('ready', () => {
  lastError = null;
});

/** Redis 是否可用（用于降级判断与健康检查） */
function isReady() {
  return client.status === 'ready';
}

// 把 Lua 脚本注册成命令：ioredis 会自动用 EVALSHA，并处理 NOSCRIPT 重载
const { WINDOW_SCRIPT } = require('./lua/window.lua');
client.defineCommand('incrWindowAtomic', {
  numberOfKeys: 1,
  lua: WINDOW_SCRIPT,
});

/**
 * 固定窗口计数（Lua 原子版）
 *
 * 为什么不是 INCR + EXPIRE 两条命令：
 *   两条命令之间如果进程崩溃，会留下一个没有 TTL 的计数 key，
 *   这个 IP/用户就被永久封禁了。Lua 在 Redis 内部原子执行，不存在这个窗口。
 *
 * 返回 { count, ttl }，ttl 为剩余秒数。
 */
async function incrWindow(key, windowSec) {
  const [count, ttlMs] = await client.incrWindowAtomic(key, Math.round(windowSec * 1000));
  return { count: Number(count), ttl: Math.max(1, Math.ceil(Number(ttlMs) / 1000)) };
}

/** 等待连接就绪（脚本或启动时用），超时返回 false */
function waitReady(timeoutMs = 3000) {
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { client.removeListener('ready', onReady); resolve(false); }, timeoutMs);
    function onReady() { clearTimeout(timer); resolve(true); }
    client.once('ready', onReady);
  });
}

/** 读缓存：命中返回 { hit: true, value }，未命中返回 { hit: false } */
async function getCache(key) {
  const raw = await client.get(key);
  if (raw === null) return { hit: false };
  if (raw === NULL_MARKER) return { hit: true, value: null, isEmpty: true };
  try {
    return { hit: true, value: JSON.parse(raw) };
  } catch {
    return { hit: false };
  }
}

/** 写缓存：ttlSec + 随机抖动（防雪崩） */
async function setCache(key, value, ttlSec, jitterSec = 0) {
  const ttl = ttlSec + Math.floor(Math.random() * jitterSec);
  if (value === null || value === undefined) {
    // 空值缓存：TTL 更短，防穿透；同时避免长期占内存
    await client.set(key, NULL_MARKER, 'EX', Math.max(5, Math.floor(ttl / 4)));
    return;
  }
  await client.set(key, JSON.stringify(value), 'EX', ttl);
}

/** 删缓存（写库之后调用） */
async function delCache(key) {
  await client.del(key);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * cache-aside 读：
 *   命中 → 直接返回
 *   未命中 → 抢锁回源（只有一个请求查库）→ 写缓存 → 返回
 *   Redis 不可用 → 直接走 loader（降级）
 */
async function cacheAside({ key, ttlSec, jitterSec = 0, lockTtlMs = 3000, loader }) {
  if (!isReady()) {
    return { value: await loader(), cached: false, degraded: true };
  }

  try {
    const hit = await getCache(key);
    if (hit.hit) return { value: hit.value, cached: true, isEmpty: !!hit.isEmpty };

    // 防击穿：抢锁，抢不到就短暂等待后重试读缓存
    const lockKey = `${key}:lock`;
    const gotLock = await client.set(lockKey, '1', 'PX', lockTtlMs, 'NX');

    if (!gotLock) {
      await sleep(60);
      const retry = await getCache(key);
      if (retry.hit) return { value: retry.value, cached: true, isEmpty: !!retry.isEmpty };
      // 等不到就直接查库，避免无限等待
      return { value: await loader(), cached: false, lockMiss: true };
    }

    try {
      const value = await loader();
      await setCache(key, value, ttlSec, jitterSec);
      return { value, cached: false };
    } finally {
      await client.del(lockKey).catch(() => {});
    }
  } catch (err) {
    // Redis 抖动：降级直查
    lastError = err.message;
    return { value: await loader(), cached: false, degraded: true };
  }
}

/** 健康检查用 */
async function health() {
  const t0 = Date.now();
  try {
    await client.ping();
    return { ok: true, latencyMs: Date.now() - t0, status: client.status };
  } catch (e) {
    return { ok: false, error: e.message, status: client.status };
  }
}

module.exports = {
  client,
  waitReady,
  isReady,
  incrWindow,
  getCache,
  setCache,
  delCache,
  cacheAside,
  health,
  NULL_MARKER,
};
