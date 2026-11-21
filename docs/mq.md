# RabbitMQ 改造：解读任务异步化

> 记录时间：2026-11-21
> 涉及文件：`lib/mq.js`、`workers/reading_worker.js`、`routes/reading_async.js`、`middleware/idempotency.js`

---

## 一、为什么要异步

改造前 `POST /api/reading` 是同步链路：

```
扣额度 → 调模型（流式）→ 写库 → 返回
```

模型要生成几百字，一次请求占着连接几十秒。后果：

1. **接口耗时被模型决定**，前端只能干等
2. **连接被长时间占用**，并发一高就打满（Node 单进程更明显）
3. **流量尖峰没法削**，来多少请求就压多少给模型 API

异步化之后：

```
扣额度 → 建任务 → 投递消息 → 立刻返回 taskId（≈90ms）
                    ↓
              worker 消费 → 调模型 → 写库 → 更新任务状态
```

接口不再等模型，前端轮询任务状态。

---

## 二、拓扑

```
exchange: reading.dx (direct, durable)
  └─ queue: reading.jobs  (durable, prefetch=1, 手动 ack)
        │ x-dead-letter-exchange = reading.dlx
        ▼
exchange: reading.dlx (direct, durable)
  └─ queue: reading.dead  → 重试耗尽的失败任务
```

为什么要有死信队列：消息失败后如果一直 `requeue`，会变成毒消息把队列堵死；
扔进死信队列之后，失败任务是**可查、可重放**的，而不是消失。

---

## 三、关键设计

### 3.1 手动 ack，而不是自动 ack

```js
await channel.consume(queue, async (msg) => {
  await handler(job);
  ch.ack(msg);        // 处理成功才确认
}, { noAck: false });
```

自动 ack 的问题：消息一出队就算「已处理」，worker 崩了这条消息就没了。
手动 ack 保证「处理完才出队」，worker 崩溃时消息会重新投递。

### 3.2 重试三次，然后进死信

```js
if (attempts < 3) {
  setTimeout(() => publishJob({ ...job, attempts }), 2000 * attempts);  // 退避重发
  ch.ack(msg);
} else {
  ch.nack(msg, false, false);   // requeue=false → 走死信
}
```

注意这里是「重新发布一条新消息 + ack 旧消息」，而不是 `nack(requeue=true)`。
原因：`requeue=true` 会立刻回到队首，模型 API 挂了的话就是热循环空转。

### 3.3 死信队列要有人消费

第一版就踩了这个坑：消息进了死信队列，但**没有任何消费者**，
结果任务永远停在 `processing`，用户的额度也一直没退。

修法：`consumeDead(handler)` 专门消费 `reading.dead`，在里面做补偿：

```js
UPDATE reading_tasks SET status='failed', error='生成失败，已重试 3 次'
UPDATE users SET credits = credits + 1
INSERT INTO credit_transactions (..., delta=1, source='refund')
```

> 这是「补偿」而不是「回滚」：额度在提交时就已经扣掉了，
> 分布式环境下没有跨服务事务，只能靠显式补偿 + 流水对账。

### 3.4 幂等：消息可能重复投递

worker 进来先查任务状态：

```js
if (task.status === 'done') { console.log('已处理，跳过'); return; }
```

不加这个判断，一条重复投递的消息会生成两条解读记录、多扣一次额度。

### 3.5 接口幂等：X-Request-Id

提交接口要求带 `X-Request-Id`，服务端把它写进 `idempotency_keys` 主键：

- 插入成功 = 第一次请求
- 唯一键冲突 = 重复提交，直接回放上次的响应（`replayed: true`）
- 任务失败时把记录标 `failed`，允许同一个 id 重试

**为什么不能只靠前端禁用按钮**：网络重试、用户狂点、直接重放请求都能绕过去。

---

## 四、验证结果

### 4.1 正常链路（`npm run verify:async`）

```
① 提交: 202 用时 90ms {"taskId":"a737...","credits":4,"status":"queued"}
② 任务状态: done，attempts=1，readingId=3
③ 重复提交: 200，replayed=true，taskId 相同=true
④ 余额: 5 → 4（期望 4，只扣一次）
⑤ 流水: [{"delta":-1,"source":"reading_async"}]
```

提交从「几十秒」降到 **90ms**，这是异步化最直观的收益。

### 4.2 失败重试与退款（`npm run verify:refund`，需 `MOCK_FAIL=1`）

```
① 提交: 202
② 最终状态: failed，attempts=3，error=生成失败，已重试 3 次
③ 余额: 3 → 3（失败已退款）
④ 流水: [{"delta":-1,"source":"reading_async"},{"delta":1,"source":"refund"}]
```

失败没有让用户白扣额度，流水里能对上账。

---

## 五、踩到的坑

| 坑 | 现象 | 处理 |
|---|---|---|
| 死信队列没有消费者 | 任务永远 processing、额度不退 | 加 `consumeDead` 做补偿 |
| 轮询接口被起卦限流拦 | 前端轮询几次就 429 | 限流 `skip: (req) => req.method === 'GET'`，只限 POST 起卦 |
| RabbitMQ 监听在 IPv6 | Windows 侧 `ECONNREFUSED 127.0.0.1:5672` | `listeners.tcp.default = 0.0.0.0:5672` 强制 IPv4 |
| `nack(requeue=true)` 热循环 | 模型 API 挂时 CPU 空转 | 改成「退避后重新发布」 |

---

## 六、已知遗留

1. **前端还是旧的同步接口**：`/api/reading`（SSE 流式）保留着，
   异步接口是新增的 `/api/reading/async`，前端要改成轮询才会真正用上。
2. **没有做消息积压监控**：健康检查只报死信数量，没有看队列表头长度。
3. **重试没有指数退避上限**：现在固定 2s、4s、6s，任务量大了应该加 jitter。
4. **worker 与 web 同机跑**：生产应该独立进程/独立扩缩容。
