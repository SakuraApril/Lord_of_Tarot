/**
 * 登录态与用户上下文（Redis）
 *
 * 解决两个问题：
 *   1. 鉴权中间件原来每个请求都查一次 MySQL 取用户信息（SELECT ... WHERE uuid = ?）
 *      → 改成 Redis 缓存用户快照，命中就不查库
 *   2. JWT 是无状态的：签发之后在过期前无法作废，用户点「退出登录」其实没退
 *      → 给每个 token 加 jti，登出时把 jti 写进黑名单，鉴权时校验
 *
 * 为什么不用「Redis 存 session、每次读整份会话」：
 *   这个项目是 JWT + 短校验，不需要服务端保存会话状态；
 *   只需要「缓存用户快照」+「作废清单」两样东西，比完整 session 轻得多。
 */
const { client, isReady } = require('./redis');

const USER_TTL = 300;           // 用户快照 5 分钟，改额度/改名时主动失效
const userKey = (uuid) => `user:${uuid}`;
const revokedKey = (jti) => `jwt:revoked:${jti}`;

/** 读用户快照；未命中返回 null（不是错误） */
async function getUser(uuid) {
  if (!isReady()) return null;
  try {
    const raw = await client.get(userKey(uuid));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setUser(uuid, user, ttlSec = USER_TTL) {
  if (!isReady()) return;
  try {
    await client.set(userKey(uuid), JSON.stringify(user), 'EX', ttlSec);
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

/** 用户信息变更（改额度、改名、兑换）后调用 */
async function invalidateUser(uuid) {
  if (!isReady()) return;
  try {
    await client.del(userKey(uuid));
  } catch {}
}

/** 把某个 token 作废，TTL 到该 token 自然过期为止，不占长期内存 */
async function revokeToken(jti, ttlSec) {
  await client.set(revokedKey(jti), '1', 'EX', Math.max(1, ttlSec));
}

async function isRevoked(jti) {
  if (!isReady()) return false;   // Redis 不可用时降级为不清查，保证可用性
  try {
    return (await client.get(revokedKey(jti))) !== null;
  } catch {
    return false;
  }
}

module.exports = { getUser, setUser, invalidateUser, revokeToken, isRevoked, USER_TTL };
