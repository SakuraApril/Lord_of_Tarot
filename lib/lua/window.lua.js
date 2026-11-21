/**
 * 限流计数脚本（Lua）
 *
 * 为什么必须用 Lua：
 *   INCR 和 EXPIRE 是两条命令，中间如果进程崩溃 / 网络断开，
 *   就会留下一个「有计数、没过期时间」的 key —— 这个 IP 或用户会被永久封禁。
 *   Lua 在 Redis 内部原子执行，要么都执行，要么都不执行，不存在中间态。
 *
 * 另外脚本里做了自愈：如果发现 key 没有 TTL（历史遗留的无过期 key），
 * 顺手补上，避免已经存在的坏 key 永远卡住用户。
 *
 * KEYS[1] = 计数 key
 * ARGV[1] = 窗口毫秒数
 * 返回 { 当前计数, 剩余毫秒 }
 */
const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

module.exports = { WINDOW_SCRIPT };
