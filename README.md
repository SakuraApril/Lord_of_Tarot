# Lord of Tarot · 塔罗之主

AI 塔罗占卜 Web 应用：Express + PostgreSQL 后端，SSE 流式解读，手势交互由 **C++ 编译成 WebAssembly** 在浏览器本地推理。

线上版本：`https://lord-of-tarot.fly.dev`（如果打不开就是已下线，代码仍可本地运行）

---

## ⚠️ 先读这一段：关于 `.env`

**本仓库不包含 `.env`。** 仓库里的 `.gitignore` 第一节就显式忽略了 `.env`、`.env.*`、`*.pem`、`supabase-ca.pem`，只保留 `.env.example` 作为模板。

第一次跑请：

```bash
cp .env.example .env
# 然后填入你自己的 POSTGRES_URL / JWT_SECRET / OPENAI_API_KEY / SMTP_*
```

如果你在任何地方误提交过 `.env`：只删文件是没用的，**必须去服务商后台把每个密钥轮换一遍**（换数据库密码、重新签发 API Key、重设 SMTP 授权码），因为历史提交里还留着原件。

---

## 功能

- **AI 解读**：单牌 / 三张（过去-现在-未来）/ 凯尔特十字三种牌阵，78 张韦特牌，正逆位
- **流式输出**：SSE 逐字推送，首个 token 到达即渲染，不等整段生成
- **手势交互**：握拳翻牌、竖指定格、左右挥手切换，MediaPipe 取 21 个手部关键点，判定逻辑在 WASM 里跑
- **账号体系**：邮箱注册 + 验证邮件 + JWT 无状态鉴权 + bcrypt 口令哈希 + 找回密码
- **积分体系**：注册赠 3 次、兑换码充值、每次解读扣 1 次，全部走额度流水的台账
- **运营后台**：用户检索、额度调整、占卜记录、登录 IP 归属地与设备信息

## 架构

```
浏览器
 ├─ 原生 HTML/CSS/JS（无框架）
 ├─ WebGL 粒子背景 / CSS 3D 翻牌
 └─ MediaPipe Hands ──21 landmarks──▶ gesture_core.wasm（C++）
                                          │
                                    手势事件（防抖后）
Express (Node 18)
 ├─ /api/auth   注册 / 登录 / 验证邮件 / 重置密码
 ├─ /api/user   资料 / 额度 / 兑换码 / 历史
 ├─ /api/reading  ──扣额度（原子）──▶ LLM 流式生成 ──SSE──▶ 浏览器
 └─ /api/admin   运营后台
        │
   PostgreSQL（7 张表）
```

## 手势链路

MediaPipe 只负责「把手部关键点找出来」，剩下的判定全在 C++：

| 步骤 | 做法 |
|---|---|
| 手指是否伸直 | 指尖-手腕距离比 + 食指/中指夹角，双条件取或，避免侧手时误判 |
| 挥手方向 | 手腕 x 坐标进 1 s 环形缓冲，看极差与净位移，超过 0.2 的行程才算挥手 |
| 去抖 | 连续 5 帧同族手势才触发；同族 500 ms 冷却；挥手 800 ms 保持期 |

`cpp/gesture_core/` 用 Emscripten 编成 ES6 模块，导出的只有 `_gesture_reset` / `_gesture_update` 两个符号。这样推理完全在端上：**零后端算力，摄像头画面不出端**。

```bash
emcmake cmake -S cpp/gesture_core -B cpp/gesture_core/build
cmake --build cpp/gesture_core/build
mkdir -p public/wasm && cp cpp/gesture_core/build/gesture_core.{js,wasm} public/wasm/
```

## 数据模型

| 表 | 作用 |
|---|---|
| `users` | 账号、bcrypt 口令哈希、额度余额 |
| `readings` | 每次占卜：问题、牌阵、抽到的牌（JSON）、AI 全文 |
| `credit_transactions` | 额度流水台账：变动值、变动后余额、来源、关联业务 ID |
| `coupons` | 兑换码与面额、是否已用 |
| `email_tokens` | 邮箱验证 / 重置令牌（32 字节随机、带过期） |
| `login_logs` | 登录 IP、UA、归属地 |
| `pending_registrations` | 未验证邮箱的临时注册态 |

**额度扣减是原子的**：先 `UPDATE users SET credits = credits - 1 WHERE id = $1 AND credits > 0 RETURNING credits`，`rowCount === 0` 就说明没额度，直接 403；后续 LLM 调用失败再把额度加回去。这样并发下也不会把余额扣成负数。

## 本地运行

```bash
npm ci
cp .env.example .env      # 填入数据库 / 密钥
npm start                 # http://localhost:3000
```

`db/init.js` 会在启动时建表（`CREATE TABLE IF NOT EXISTS`），不用手动迁移。

## 部署

`Dockerfile` + `fly.toml`（256 MB / 1 共享核，`min_machines_running = 0` 让它闲着时缩到 0 省钱）。CI 见 `.gitlab-ci.yml`：`emsdk` 镜像里先编 WASM，再跑冒烟检查，最后 `flyctl deploy`。

## 已知问题

- **`/api/admin/*` 没有鉴权**，目前假设「只有本机能访问」。要上生产必须先加管理员身份校验，否则任何人都能删用户、改额度。
- 卡牌释义数据在 `data/*.json` 里手工维护，还没有后台编辑入口。
- 前端是原生 JS 单页，状态管理靠一个全局 `S` 对象，页面再复杂就该上框架了。

## 文档

- `api-doc.md` —— 后端接口与返回结构
- `gesture-doc.md` / `gesture-module-doc.md` —— 手势模块的 API 与调参说明
- `tarot_prompt.md` —— 解读用的 Prompt 模板（导师人设 / 三种牌阵结构 / 反宿命论准则）

---

代码仅用于作品展示，未声明开源许可。
