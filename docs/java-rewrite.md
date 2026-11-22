# Java 重写说明（Spring Boot）

> 分支：`java-rewrite`
> 结论：后端已用 Java 21 + Spring Boot 3.3 重写，接口与 Node 版一致，本地全链路验证通过

---

## 一、为什么换，以及没换什么

**换的**：后端服务（HTTP 接口、鉴权、事务、缓存、MQ 消费）。
**没换的**：

| 部分 | 语言 | 原因 |
|---|---|---|
| 手势识别（端侧） | C++ → WASM | 浏览器里跑，Java 编不出 WASM |
| 前端页面 | JS / Three.js | 前端本来就是 JS |
| 四足机器人项目 | C++ / Python | 是另一个项目，与这里无关 |

Node 版整体保留在 `legacy-node/`，两套实现共用同一套 MySQL / Redis / RabbitMQ，
可以并存、可以灰度切换——这是刻意的，不是没删干净。

---

## 二、技术选型

| 关注点 | 选型 | 说明 |
|---|---|---|
| 框架 | Spring Boot 3.3.5 | 内嵌 Tomcat，`java -jar` 直接跑 |
| 数据访问 | `JdbcTemplate` | 不引 MyBatis，SQL 显式可见，和 Node 版的 SQL 一一对应 |
| 连接池 | HikariCP（Boot 默认） | `maximum-pool-size` 可配 |
| 鉴权 | jjwt 0.12 + 自写拦截器 | 不用 Spring Security，避免一上来就陷进过滤器链 |
| 密码 | `spring-security-crypto` 的 BCrypt | 只引这一个包，不引整套 Security |
| 缓存 | `StringRedisTemplate` + Lua | key 与 Lua 脚本与 Node 版完全一致 |
| MQ | `spring-boot-starter-amqp` | 手动 ack + 局部重试 + 补偿退款 |
| 上下文 | **ThreadLocal** | 请求级用户上下文，请求结束必须 `clear()` |

---

## 三、包结构与 Node 版的对应

```
src/main/java/com/tarot/
├── TarotApplication.java          启动类
├── config/
│   ├── WebConfig.java             拦截器顺序（先限流、后鉴权）+ 静态资源 + CORS
│   ├── TraceIdFilter.java         每请求 traceId（对应 Node 的 AsyncLocalStorage）
│   └── RabbitConfig.java          队列/死信拓扑 + JSON 序列化
├── security/
│   ├── AuthInterceptor.java       JWT → 黑名单 → 用户快照(Redis) → 未命中查库
│   └── RateLimitInterceptor.java  本地限流 + Redis(Lua) 两级
├── common/
│   ├── UserContext.java           ThreadLocal 用户上下文
│   ├── JwtService.java            签发/校验（带 jti）
│   ├── RedisSupport.java          缓存三件套 + Lua 限流脚本
│   └── RabbitHealth.java          MQ 健康检查
├── auth/AuthController.java       login / logout / me
├── user/UserController.java       credits / redeem / transactions / history(缓存)
├── reading/
│   ├── ReadingController.java     POST /api/reading/async、GET /api/reading/task/{id}
│   ├── ReadingService.java        幂等 + 投递 MQ
│   └── ReadingTxService.java      事务：扣额度 + 建任务 + 写流水
├── worker/ReadingWorker.java      消费者：手动 ack、3 次重试、补偿退款
└── web/PublicController.java      /api/cards（预序列化+ETag）、/api/spreads、/api/health
```

---

## 四、三个容易踩的坑（都真的踩了）

### 4.1 `@Transactional` 自调用失效

第一版把「扣额度 + 建任务 + 写流水」写在一个 `@Transactional` 方法里，
然后在**同一个类**里被另一个方法调用——注解不生效，因为走不到 Spring 的代理对象。

修法：把事务方法单独抽成 `ReadingTxService`，由 `ReadingService` 注入调用。
这就是经典的「同类方法内部调用事务失效」。

### 4.2 ThreadLocal 必须 clear

`AuthInterceptor` 把用户放进 `UserContext`（ThreadLocal），
Tomcat 线程是复用的，不清理会把上一个请求的用户带给下一个请求。
所以在 `afterCompletion` 里 `UserContext.clear()`——这是线程池场景下最容易出的越权事故。

### 4.3 MQ 序列化：JDK 序列化 vs JSON

第一版没配转换器，`RabbitTemplate` 用默认的 `SimpleMessageConverter`，
把 Map 写成了 **JDK 序列化字节**；消费者反序列化失败，消息在队列里无限重投。

修法：注册 `Jackson2JsonMessageConverter`。换成 JSON 之后还有额外好处——
`legacy-node/` 的 Node worker 能消费同一个队列，两套实现可以共存。

---

## 五、验证结果

启动：`Tomcat started on port 3100`，`Started TarotApplication in 4.268 seconds`

```
① health: 200 {"status":"ok","mysql":{"ok":true},"redis":{"ok":true},"mq":{...}}
② login: 200 拿到 token
③ credits: 5，鉴权缓存 MISS → HIT
④ 提交: 202 {"status":"queued","taskId":"3629336f-...","credits":4}
⑤ 任务: done，attempts=1，内容前 30 字: 【mock 解读】...
⑥ 幂等重放: 202 replayed=true，taskId 相同=true
⑦ 余额: 5 → 4（只扣一次）
⑧ /api/cards: 200，ETag="25821"
⑨ 登出: 200 {"ok":true,"revoked":true,"ttl":604799}
⑩ 登出后同 token: 401 登录已过期
```

覆盖了：健康检查、登录、鉴权缓存、异步提交、MQ 消费、幂等回放、余额、静态资源、
登出作废。

---

## 六、怎么跑

```bash
# 1. 依赖（WSL 内）
wsl -d Ubuntu-20.04 -u root -- systemctl start mysql redis-server rabbitmq-server

# 2. 环境变量
MYSQL_URL=jdbc:mysql://127.0.0.1:3306/tarot?useSSL=false&serverTimezone=UTC
MYSQL_USER=tarot
MYSQL_PASSWORD=tarot123
REDIS_URL=redis://127.0.0.1:6379
RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672
JWT_SECRET=<至少 32 位>
OPENAI_API_KEY=<没有就留空，走 mock>

# 3. 构建与启动
mvn -DskipTests package
java -jar target/tarot-backend-3.0.0.jar
```

---

## 七、还没做的（诚实清单）

1. **注册与邮箱验证**没搬：Node 版有 `pending_registrations` + 发信流程，这里只做了登录。
2. **同步 SSE 接口**（`POST /api/reading`）没搬：只做了异步通道。
   如果要搬，Spring 用 `SseEmitter`，注意它默认超时 30 秒。
3. **管理后台接口**没搬：Node 版有用户检索、额度调整、流水查询。
4. **没有单元测试**：目前只有一个端到端验证脚本。
5. **线上没切**：`lord-of-tarot.fly.dev` 还是 Node 版；Fly 的 256MB 跑 Spring Boot 偏紧。
