# gesture-module.js 接口文档

## 依赖

| 依赖项 | 来源 | 说明 |
|--------|------|------|
| MediaPipe Hands | CDN | 手部关键点检测 |
| MediaPipe Camera Utils | CDN | 摄像头视频流处理 |

## HTML 元素依赖

```html
<!-- 必需元素 -->
<video id="webcam" autoplay playsinline muted></video>
<canvas id="mask-canvas"></canvas>
<div id="gesture-debug"></div>
<span id="db-det"></span>
<span id="db-size"></span>
<span id="db-stable"></span>
<span id="db-trig"></span>
<button id="btn-gesture">✋ 启用手势控制</button>
```

## 对外 API

### 启用手势

```javascript
// 通过点击按钮自动触发，或手动调用
initGesture()
```

**功能**：初始化摄像头、MediaPipe Hands，开始手势识别

### 停用手势

```javascript
stopGesture()
```

**功能**：停止摄像头、清理状态

### 识别结果

```javascript
recognizeGesture(landmarks)
```

**输入**：
| 参数 | 类型 | 说明 |
|------|------|------|
| landmarks | Array<Object> | MediaPipe 返回的 21 个手部关键点 |

每个关键点格式：
```javascript
{
  x: number,  // 0-1，相对宽度
  y: number,  // 0-1，相对高度
  z: number   // 深度（负值=靠近摄像头）
}
```

**输出**：
```javascript
{
  id: string,    // 'wave-left' | 'wave-right' | 'fist' | 'point' | 'none'
  name: string,  // '向左挥手' | '向右挥手' | '握拳' | '竖单指' | '未识别'
  emoji: string  // '👈' | '👉' | '✊' | '☝️' | '❓'
}
```

## 内部参数

### 挥手检测参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| WAVE_WINDOW | 1000ms | 轨迹记录时间窗口 |
| WAVE_MIN_DIR_CHANGES | 3 | 最少方向变化次数 |
| WAVE_MIN_RANGE | 0.08 | 最小移动范围（0-1） |
| WAVE_COOLDOWN | 500ms | 触发后冷却时间（左右独立） |
| WAVE_HOLD | 800ms | 挥手状态保持时长 |
| WAVE_DIR_THRESHOLD | 0.015 | 最小净位移判定方向 |

### 手指判定参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 拇指伸直 | angle > 2.6 rad | MCP-IP-TIP 角度 |
| 四指伸直 | ratio > 1.15 或 cosAngle > 0.5 | tip到wrist / mcp到wrist |

## 关键点索引

```
0:  手腕 (WRIST)
1:  拇指 CMC
2:  拇指 MCP
3:  拇指 IP
4:  拇指 TIP
5:  食指 MCP
6:  食指 PIP
7:  食指 DIP
8:  食指 TIP
9:  中指 MCP
10: 中指 PIP
11: 中指 DIP
12: 中指 TIP
13: 无名指 MCP
14: 无名指 PIP
15: 无名指 DIP
16: 无名指 TIP
17: 小指 MCP
18: 小指 PIP
19: 小指 DIP
20: 小指 TIP
```

## 主应用交互

模块通过 `handleGesture()` 与主应用交互，根据当前屏幕状态触发不同操作：

```javascript
// 内部会调用主应用的方法
$('btn-go').click()      // 欢迎页 - 开始占卜
$('btn-shuf').click()    // 洗牌页 - 洗牌
$('btn-draw').click()    // 洗牌页 - 抽牌
$('btn-read').click()    // 翻牌页 - 查看解读
$('btn-again').click()   // 解读页 - 重新占卜
```

## 状态对象

```javascript
var Gesture = {
  enabled: boolean,     // 是否启用
  camera: Camera,       // 摄像头实例
  hands: Hands,         // MediaPipe Hands 实例
  lastG: string,        // 上一帧手势
  stableCnt: number,    // 稳定帧计数
  stableG: string,      // 稳定后的手势
  lastTrigger: number,  // 上次触发时间戳
  lastLabel: string     // 上次识别的中文名
};
```
