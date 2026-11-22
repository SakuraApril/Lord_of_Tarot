/**
 * RabbitMQ 封装：发布任务 / 消费任务，带手动 ack、重试与死信队列
 *
 * 拓扑：
 *   exchange: reading.dx (direct, durable)
 *   queue:    reading.jobs  → 死信到 reading.dlx / routingKey = dead
 *   exchange: reading.dlx (direct, durable)
 *   queue:    reading.dead  → 绑 'dead'，存放重试耗尽的失败任务
 *
 * 为什么要死信队列：消息重试到上限后如果一直 requeue，会变成毒消息把队列拖死；
 * 丢到死信队列之后，失败任务是「可查、可重放」的，而不是消失。
 */
const amqp = require('amqplib');

const URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
const JOB_QUEUE = 'reading.jobs';
const JOB_EXCHANGE = 'reading.dx';
const DLX = 'reading.dlx';
const DEAD_QUEUE = 'reading.dead';
const DEAD_ROUTING_KEY = 'dead';

let conn = null;
let channel = null;

async function connect() {
  if (channel) return channel;
  conn = await amqp.connect(URL);
  conn.on('error', (e) => console.error('[mq] 连接错误:', e.message));
  conn.on('close', () => {
    console.warn('[mq] 连接关闭，下次调用会重连');
    channel = null;
  });
  channel = await conn.createChannel();
  await channel.prefetch(1);

  // 死信交换与队列
  await channel.assertExchange(DLX, 'direct', { durable: true });
  await channel.assertQueue(DEAD_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_QUEUE, DLX, DEAD_ROUTING_KEY);

  // 业务交换与队列（带死信参数）
  await channel.assertExchange(JOB_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(JOB_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DLX,
      'x-dead-letter-routing-key': DEAD_ROUTING_KEY,
    },
  });
  await channel.bindQueue(JOB_QUEUE, JOB_EXCHANGE, 'reading');
  return channel;
}

/** 发布一条解读任务，persistent 保证 broker 重启后消息不丢 */
async function publishJob(payload) {
  const ch = await connect();
  ch.publish(JOB_EXCHANGE, 'reading', Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: 'application/json',
    messageId: payload.taskId,
    timestamp: Date.now(),
  });
  return true;
}

/** 消费：handler 抛异常即视为失败 */
async function consume(handler) {
  const ch = await connect();
  await ch.consume(JOB_QUEUE, async (msg) => {
    if (!msg) return;
    let job;
    try {
      job = JSON.parse(msg.content.toString());
    } catch (e) {
      console.error('[mq] 消息体解析失败，直接进死信');
      ch.nack(msg, false, false); // requeue=false → 走死信
      return;
    }

    try {
      await handler(job, msg);
      ch.ack(msg);
    } catch (err) {
      const attempts = Number(job.attempts || 0) + 1;
      console.error(`[mq] 任务 ${job.taskId} 第 ${attempts} 次失败:`, err.message);

      if (attempts < 3) {
        // 重试：重新发布（带尝试次数），并把原消息确认掉，避免 requeue 造成热循环
        setTimeout(async () => {
          try {
            await publishJob({ ...job, attempts });
          } catch (e) {
            console.error('[mq] 重试发布失败:', e.message);
          }
        }, 2000 * attempts);
        ch.ack(msg);
      } else {
        // 重试耗尽：进死信队列，由业务层标记失败
        ch.nack(msg, false, false);
      }
    }
  });
  console.log(`[mq] 已开始消费 ${JOB_QUEUE}（prefetch=1，手动 ack）`);
}

/**
 * 消费死信队列：重试耗尽的失败任务在这里做补偿（退款、标记失败、告警）。
 * 为什么单独消费而不是在 consume() 里回调：死信本身是「可以人工重放」的队列，
 * 补偿逻辑挂在这里，重放时也能复用同一套处理。
 */
async function consumeDead(handler) {
  const ch = await connect();
  await ch.consume(DEAD_QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const job = JSON.parse(msg.content.toString());
      await handler(job);
      ch.ack(msg);
    } catch (e) {
      console.error('[mq] 死信处理失败，保留在队列:', e.message);
      ch.nack(msg, false, true);   // requeue，留待排查
    }
  });
  console.log(`[mq] 已开始消费死信队列 ${DEAD_QUEUE}`);
}

async function health() {
  try {
    const ch = await connect();
    await ch.checkQueue(JOB_QUEUE);
    const info = await ch.checkQueue(DEAD_QUEUE);
    return { ok: true, deadLetterCount: info.messageCount };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function close() {
  try { if (conn) await conn.close(); } catch {}
  conn = null;
  channel = null;
}

module.exports = { connect, publishJob, consume, consumeDead, health, close, JOB_QUEUE, DEAD_QUEUE };
