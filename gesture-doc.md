# gesture.js 使用文档

手势识别模块，基于 MediaPipe Hands，识别 4 种手势：

| id | 手势 | emoji |
|---|---|---|
| `fist` | 握拳 | ✊ |
| `point` | 竖单指 | ☝️ |
| `wave-left` | 向左挥手 | 👈 |
| `wave-right` | 向右挥手 | 👉 |

---

## 引入

```html
<!-- 依赖 MediaPipe CDN -->
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js" crossorigin="anonymous"></script>

<!-- 手势模块 -->
<script src="gesture.js"></script>
```

## 最小示例

```html
<video id="cam" autoplay playsinline style="display:none"></video>
<canvas id="hand-canvas" width="320" height="240"></canvas>

<script>
// 1. 初始化
Gesture.init(
  document.getElementById('cam'),
  document.getElementById('hand-canvas')
);

// 2. 监听手势
Gesture.onDetect(function(data) {
  if (data.triggered) {
    console.log(data.triggered.emoji, data.triggered.name);
  }
});

// 3. 启动
Gesture.start().then(function() {
  console.log('手势识别已启动');
});
</script>
```

---

## API

### `Gesture.init(video, canvas, opts?)`

初始化模块。必须在 `start()` 之前调用。

| 参数 | 类型 | 说明 |
|---|---|---|
| `video` | HTMLVideoElement | 摄像头视频元素（可隐藏） |
| `canvas` | HTMLCanvasElement | 手部骨架绘制画布（可隐藏） |
| `opts` | Object? | 可选，覆盖默认配置（见下方） |

### `Gesture.onDetect(fn)`

注册回调函数，每帧调用一次。

回调参数 `data`：

```js
{
  gesture:    { id, name, emoji } | null,  // 当前帧识别结果，null = 未检测到手
  triggered:  { id, name, emoji } | null,  // 防抖后触发的结果，null = 未触发
  landmarks:  Array(21) | null,            // 手部 21 个关键点
  debug:      { range, net, stable } | null // 调试数据
}
```

**关键**：只处理 `triggered`，它是经过防抖的，每种手势只触发一次。

### `Gesture.start() → Promise`

开启摄像头，启动识别。返回 Promise，失败时 reject（摄像头不可用等）。

### `Gesture.stop()`

停止识别，释放摄像头资源。

### `Gesture.isEnabled() → boolean`

当前是否正在运行。

---

## 配置项

通过 `Gesture.init(video, canvas, { ... })` 第三个参数覆盖：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `WAVE_WINDOW` | 1000 | 挥手轨迹记录窗口 (ms) |
| `WAVE_MIN_RANGE` | 0.2 | 挥手最小移动范围 (0-1) |
| `WAVE_DIR_THRESHOLD` | 0.015 | 挥手方向判定阈值 |
| `WAVE_COOLDOWN` | 500 | 挥手触发冷却 (ms) |
| `WAVE_HOLD` | 800 | 挥手状态保持时长 (ms) |
| `STABLE_FRAMES` | 5 | 稳定多少帧才触发 |
| `DEBOUNCE_MS` | 500 | 触发后防抖间隔 (ms) |

---

## 与主应用交互示例

```js
Gesture.onDetect(function(data) {
  var g = data.triggered;
  if (!g) return;

  switch (currentScreen) {
    case 'welcome':
      if (g.id === 'wave-left' || g.id === 'wave-right') {
        document.getElementById('btn-start').click();
      }
      break;
    case 'draw':
      if (g.id === 'fist' || g.id === 'point') {
        flipNextCard();
      }
      if (g.id === 'wave-left' || g.id === 'wave-right') {
        if (allCardsFlipped) showReading();
      }
      break;
  }
});
```
