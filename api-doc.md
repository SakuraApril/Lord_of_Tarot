# 后端 API 对接文档

## 启动后端

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
# 编辑 .env 文件，填入 API Key
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini

# 3. 启动服务
npm start
```

服务默认运行在 `http://localhost:3000`

---

## API 接口

### POST /api/reading

生成塔罗牌解读

**请求头：**
```
Content-Type: application/json
```

**请求体：**
```json
{
  "question": "我的事业发展如何？",
  "cards": [
    {"name": "The Fool", "nameZh": "愚者", "reversed": false},
    {"name": "The Star", "nameZh": "星星", "reversed": true}
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| question | string | 是 | 用户的问题 |
| cards | array | 是 | 抽到的牌数组 |
| cards[].name | string | 是 | 牌的英文名 |
| cards[].nameZh | string | 否 | 牌的中文名 |
| cards[].reversed | boolean | 是 | 是否逆位 |

**响应：**
```json
{
  "reading": "根据你抽到的牌..."
}
```

**错误响应：**
```json
{
  "error": "错误信息"
}
```

---

## 前端调用示例

### 基础调用

```javascript
async function getReading(question, cards) {
  const res = await fetch('http://localhost:3000/api/reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, cards })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.reading;
}
```

### 完整示例（含 loading 状态）

```javascript
async function handleRead() {
  const question = $('q').value;
  const cards = S.cards.map(c => ({
    name: c.n,
    nameZh: c.z,
    reversed: c.reversed
  }));

  // 显示 loading
  $('r-title').textContent = '🔮 正在解读...';
  $('overview').innerHTML = '<p style="color:#888">塔罗导师正在思考中，请稍候...</p>';
  $('r-grid').innerHTML = '';
  go('reading');

  try {
    const reading = await getReading(question, cards);
    $('overview').innerHTML = `<div class="ov-text">${reading.replace(/\n/g, '<br>')}</div>`;
    $('r-title').textContent = '🔮 塔罗解读';
  } catch (e) {
    $('overview').innerHTML = `<p style="color:#f87171">解读失败：${e.message}</p>`;
  }
}
```

---

## 牌面数据结构

从 `tarot-module.js` 中获取的牌面数据：

```javascript
// 大阿卡纳示例
{ n: "The Fool", z: "愚者", em: "🌟", up: "正位...", rv: "逆位..." }

// 小阿卡纳示例
{ n: "Ace of Wands", z: "权杖王牌", suit: "wands", rank: 0 }
```

转换为 API 格式：

```javascript
const cards = S.cards.map(c => ({
  name: c.n,           // 英文名
  nameZh: c.z,         // 中文名
  reversed: c.reversed // 是否逆位
}));
```

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| OPENAI_API_KEY | - | API 密钥（必填） |
| OPENAI_BASE_URL | https://api.openai.com/v1 | API 地址 |
| OPENAI_MODEL | gpt-4o-mini | 模型名称 |
| PORT | 3000 | 服务端口 |
