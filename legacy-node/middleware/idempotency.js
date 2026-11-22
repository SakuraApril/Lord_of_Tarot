/**
 * 幂等：以 request_id 为主键落库，重复提交直接返回上次结果
 *
 * 为什么不用「前端按钮禁用」：那只防住正常用户，
 * 网络重试、用户狂点、重放请求都能绕过去。幂等必须做在服务端。
 *
 * 实现要点：
 *   1. 先用 INSERT 抢主键，成功 = 第一次；唯一键冲突 = 重复提交
 *   2. 抢到之后如果业务失败，把记录标记 failed，允许同一个 request_id 重试
 *   3. 完成时把响应体写进 response_json，重复请求直接回放
 */
const { pool } = require('../db/init');

async function begin({ requestId, userId, endpoint }) {
  try {
    await pool.query(
      'INSERT INTO idempotency_keys (request_id, user_id, endpoint) VALUES ($1, $2, $3)',
      [requestId, userId, endpoint]
    );
    return { fresh: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const row = await pool.query(
        'SELECT status, response_json FROM idempotency_keys WHERE request_id = $1',
        [requestId]
      );
      return { fresh: false, record: row.rows[0] };
    }
    throw err;
  }
}

async function complete(requestId, responseBody) {
  await pool.query(
    "UPDATE idempotency_keys SET status = 'done', response_json = $2 WHERE request_id = $1",
    [requestId, JSON.stringify(responseBody)]
  );
}

async function fail(requestId, message) {
  await pool.query(
    "UPDATE idempotency_keys SET status = 'failed', response_json = $2 WHERE request_id = $1",
    [requestId, JSON.stringify({ error: message })]
  );
}

module.exports = { begin, complete, fail };
