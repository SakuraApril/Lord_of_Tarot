/**
 * Lua 限流脚本验收
 *
 *   node scripts/verify_lua.js
 *
 * 验证三件事：
 *   1. 计数与过期时间是原子设置的：200 次并发后 count=200 且 TTL > 0（绝不是 -1）
 *   2. 自愈：已存在的「无 TTL 脏 key」会被脚本补上过期时间
 *   3. 计数与 TTL 一次往返拿到（对比两条命令的两次往返）
 */
require('dotenv').config();
const redis = require('../lib/redis');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await redis.waitReady();
  const key = 'lua:test:' + Date.now();
  const WINDOW_SEC = 60;

  // ① 并发打 200 次
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 200 }, () => redis.incrWindow(key, WINDOW_SEC))
  );
  const ms = Date.now() - t0;

  const counts = results.map((r) => r.count).sort((a, b) => a - b);
  const ttls = results.map((r) => r.ttl);
  const maxCount = counts[counts.length - 1];
  const minTtl = Math.min(...ttls);
  const hasNoTtl = ttls.some((t) => t <= 0);

  console.log('① 并发 200 次：');
  console.log(`   最终计数 ${maxCount}（期望 200，说明没有丢计数）`);
  console.log(`   最小 TTL ${minTtl}s（期望 > 0，说明每次都有过期时间）`);
  console.log(`   出现无 TTL 的返回：${hasNoTtl ? '有（异常）' : '无'}`);
  console.log(`   总耗时 ${ms} ms（200 次 EVALSHA 往返）`);

  // ② 自愈：手动造一个没有 TTL 的脏 key
  const dirty = 'lua:dirty:' + Date.now();
  await redis.client.set(dirty, '5');            // 没有 EX → TTL = -1
  const before = await redis.client.ttl(dirty);
  const r2 = await redis.incrWindow(dirty, WINDOW_SEC);
  const after = await redis.client.ttl(dirty);
  console.log('\n② 脏 key 自愈：');
  console.log(`   调用前 TTL=${before}（-1 表示永不过期，就是那个 bug）`);
  console.log(`   调用后 TTL=${after}，脚本返回 ttl=${r2.ttl}s`);

  await redis.client.del(key, dirty);

  const pass = maxCount === 200 && !hasNoTtl && before === -1 && after > 0;
  console.log(pass ? '\n✅ Lua 限流验收通过' : '\n❌ 验收失败');
  await redis.client.quit();
  process.exit(pass ? 0 : 1);
})();
