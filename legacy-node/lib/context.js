/**
 * 请求级上下文（Node 版 ThreadLocal）
 *
 * Node 没有线程，每次请求跑在同一个事件循环上，普通全局变量会被并发请求互相覆盖。
 * 官方等价物是 AsyncLocalStorage：给每个异步调用链绑定一份独立上下文。
 *
 * 用途：日志里带上 traceId 与用户 ID，排查问题时能串起同一次请求的所有日志。
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** 在给定上下文里执行后续中间件与路由 */
function run(ctx, fn) {
  return storage.run(ctx, fn);
}

/** 取当前请求上下文；不在请求内调用时返回空对象 */
function get() {
  return storage.getStore() || {};
}

/** 写上下文（例如鉴权通过后补上 userId） */
function set(key, value) {
  const ctx = storage.getStore();
  if (ctx) ctx[key] = value;
}

/** 统一日志前缀：`[traceId][userId] message` */
function tag() {
  const ctx = get();
  const parts = [];
  if (ctx.traceId) parts.push(`[${ctx.traceId}]`);
  if (ctx.userId) parts.push(`[u${ctx.userId}]`);
  return parts.length ? parts.join('') + ' ' : '';
}

module.exports = { run, get, set, tag };
