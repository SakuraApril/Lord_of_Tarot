// ============================================================
// gesture.js — 手势识别模块（MediaPipe HandLandmarker）
// 识别：握拳✊ / 竖单指☝️ / 向左挥手👈 / 向右挥手👉
// 使用 @mediapipe/tasks-vision，支持 GPU 加速
// ============================================================
var Gesture = (function () {
  'use strict';

  // ---- 配置 ----
  var config = {
    WAVE_WINDOW: 1000,
    WAVE_MIN_RANGE: 0.2,
    WAVE_DIR_THRESHOLD: 0.015,
    WAVE_COOLDOWN: 500,
    WAVE_HOLD: 800,
    STABLE_FRAMES: 5,
    DEBOUNCE_MS: 500,
    DETECT_CONFIDENCE: 0.7,
    TRACK_CONFIDENCE: 0.5,
  };

  // ---- 状态 ----
  var handLandmarker = null;
  var videoEl = null;
  var canvasEl = null;
  var ctx = null;
  var enabled = false;
  var callback = null;
  var stream = null;
  var rafId = 0;
  var sending = false;

  var wristHistory = [];
  var waveActiveUntil = 0;
  var lastWaveDir = '';
  var waveLeftTime = 0;
  var waveRightTime = 0;
  var waveEndTime = 0;
  var waveDebugRange = 0;
  var waveDebugNet = 0;

  var lastTriggerId = '';
  var stableCount = 0;
  var lastTriggerTime = 0;
  var delegate = 'unknown';
  var gestureCore = null;
  var gestureCoreLoading = null;
  var gestureCoreInputPtr = 0;
  var gestureCoreDebugPtr = 0;

  var HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17]
  ];

  // ---- 几何工具 ----
  function dist(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
  }

  function angleBetween(a, b, c) {
    var v1x = a.x - b.x, v1y = a.y - b.y;
    var v2x = c.x - b.x, v2y = c.y - b.y;
    var dot = v1x * v2x + v1y * v2y;
    var cos = dot / (dist(a, b) * dist(c, b) + 0.0001);
    return Math.acos(Math.max(-1, Math.min(1, cos)));
  }

  // ---- 手指判定 ----
  function isFingerExtended(lm, finger) {
    var tips = [8, 12, 16, 20];
    var pips = [6, 10, 14, 18];
    var dips = [7, 11, 15, 19];
    var mcps = [5, 9, 13, 17];
    var idx = { index: 0, middle: 1, ring: 2, pinky: 3 }[finger];
    var tip = lm[tips[idx]], pip = lm[pips[idx]], dip = lm[dips[idx]], mcp = lm[mcps[idx]], wrist = lm[0];
    var ratio = dist(tip, wrist) / (dist(mcp, wrist) + 0.001);
    var tipAbovePip = tip.y < pip.y;
    var v1x = tip.x - dip.x, v1y = tip.y - dip.y;
    var v2x = pip.x - dip.x, v2y = pip.y - dip.y;
    var dot = v1x * v2x + v1y * v2y;
    var cosAngle = dot / (dist(tip, dip) * dist(pip, dip) + 0.001);
    return (ratio > 1.15 && tipAbovePip) || (cosAngle > 0.5 && ratio > 1.0);
  }

  function isThumbExtended(lm) {
    return angleBetween(lm[2], lm[3], lm[4]) > 2.6;
  }

  function gestureFromId(id) {
    if (id === 1) return { id: 'fist', name: '握拳', emoji: '✊' };
    if (id === 2) return { id: 'point', name: '竖单指', emoji: '☝️' };
    if (id === 3) return { id: 'wave-left', name: '向左挥手', emoji: '👈' };
    if (id === 4) return { id: 'wave-right', name: '向右挥手', emoji: '👉' };
    return { id: 'none', name: '未识别', emoji: '❌' };
  }

  function resetGestureState() {
    wristHistory = [];
    waveActiveUntil = 0;
    lastWaveDir = '';
    waveLeftTime = 0;
    waveRightTime = 0;
    waveEndTime = Date.now();
    waveDebugRange = 0;
    waveDebugNet = 0;
    stableCount = 0;
    lastTriggerId = 'none';
    lastTriggerTime = 0;
    if (gestureCore && gestureCore._gesture_reset) {
      gestureCore._gesture_reset();
    }
  }

  function loadGestureCore() {
    if (gestureCore) return Promise.resolve(gestureCore);
    if (gestureCoreLoading) return gestureCoreLoading;
    gestureCoreLoading = import('/wasm/gesture_core.js').then(function (mod) {
      var create = mod.default || mod.createGestureCore;
      return create({
        locateFile: function (path) { return '/wasm/' + path; },
      });
    }).then(function (core) {
      gestureCore = core;
      gestureCoreInputPtr = core._malloc(21 * 3 * 4);
      gestureCoreDebugPtr = core._malloc(3 * 4);
      core._gesture_reset();
      console.log('[Gesture] C++ WASM classifier loaded');
      return core;
    }).catch(function (e) {
      console.warn('[Gesture] C++ WASM classifier unavailable, using JS fallback', e);
      gestureCore = null;
      return null;
    });
    return gestureCoreLoading;
  }

  function classifyWithCore(lm) {
    if (!gestureCore || !gestureCoreInputPtr || !gestureCoreDebugPtr) return null;
    var heap = gestureCore.HEAPF32;
    var base = gestureCoreInputPtr / 4;
    for (var i = 0; i < 21; i++) {
      heap[base + i * 3] = lm[i].x;
      heap[base + i * 3 + 1] = lm[i].y;
      heap[base + i * 3 + 2] = lm[i].z || 0;
    }
    var packed = gestureCore._gesture_update(gestureCoreInputPtr, Date.now(), gestureCoreDebugPtr);
    var gestureId = packed & 255;
    var triggeredId = (packed >> 8) & 255;
    var debugBase = gestureCoreDebugPtr / 4;
    return {
      gesture: gestureFromId(gestureId),
      triggered: triggeredId ? gestureFromId(triggeredId) : null,
      debug: {
        range: heap[debugBase],
        net: heap[debugBase + 1],
        stable: heap[debugBase + 2],
        delegate: delegate,
        classifier: 'cpp-wasm',
      },
    };
  }

  // ---- 挥手检测 ----
  function detectWave(lm) {
    var palmX = (lm[0].x + lm[9].x) / 2;
    var now = Date.now();
    wristHistory.push({ x: palmX, time: now });
    while (wristHistory.length > 0 && now - wristHistory[0].time > config.WAVE_WINDOW) {
      wristHistory.shift();
    }
    if (wristHistory.length < 5) return false;

    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < wristHistory.length; i++) {
      mn = Math.min(mn, wristHistory[i].x);
      mx = Math.max(mx, wristHistory[i].x);
    }
    var range = mx - mn;
    var net = wristHistory[wristHistory.length - 1].x - wristHistory[0].x;
    waveDebugRange = range;
    waveDebugNet = net;
    if (range < config.WAVE_MIN_RANGE) return false;

    if (Math.abs(net) >= config.WAVE_DIR_THRESHOLD) {
      return net > 0 ? 'left' : 'right';
    }
    return false;
  }

  // ---- 手势识别 ----
  function recognize(lm) {
    var thumb = isThumbExtended(lm);
    var index = isFingerExtended(lm, 'index');
    var middle = isFingerExtended(lm, 'middle');
    var ring = isFingerExtended(lm, 'ring');
    var pinky = isFingerExtended(lm, 'pinky');
    var count = [thumb, index, middle, ring, pinky].filter(Boolean).length;
    var now = Date.now();

    // 挥手保持
    if (now < waveActiveUntil) {
      return {
        id: 'wave-' + lastWaveDir,
        name: lastWaveDir === 'left' ? '向左挥手' : '向右挥手',
        emoji: lastWaveDir === 'left' ? '👈' : '👉',
      };
    }

    // 挥手检测
    var wave = detectWave(lm);
    if (wave) {
      var cd = wave === 'left' ? waveLeftTime : waveRightTime;
      if (now - cd > config.WAVE_COOLDOWN && now - waveEndTime > config.WAVE_COOLDOWN) {
        if (wave === 'left') waveLeftTime = now; else waveRightTime = now;
        lastWaveDir = wave;
        waveActiveUntil = now + config.WAVE_HOLD;
        wristHistory = [];
        return {
          id: 'wave-' + wave,
          name: wave === 'left' ? '向左挥手' : '向右挥手',
          emoji: wave === 'left' ? '👈' : '👉',
        };
      }
    } else {
      waveEndTime = now;
    }

    if (count === 0) return { id: 'fist', name: '握拳', emoji: '✊' };
    if (!thumb && index && !middle && !ring && !pinky) return { id: 'point', name: '竖单指', emoji: '☝️' };
    return { id: 'none', name: '未识别', emoji: '❓' };
  }

  // ---- 手部骨架绘制 ----
  function drawHand(lm) {
    if (!canvasEl || !ctx) return;
    canvasEl.width = canvasEl.clientWidth;
    canvasEl.height = canvasEl.clientHeight;
    var w = canvasEl.width, h = canvasEl.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = 2;
    for (var i = 0; i < HAND_CONNECTIONS.length; i++) {
      var a = lm[HAND_CONNECTIONS[i][0]], b = lm[HAND_CONNECTIONS[i][1]];
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
    }
    for (var j = 0; j < lm.length; j++) {
      var p = lm[j];
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, j % 4 === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = j === 0 ? '#f87171' : '#a78bfa';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ---- 防抖 ----
  function debounce(g) {
    var family = (g.id === 'wave-left' || g.id === 'wave-right') ? 'wave' : g.id;
    if (family === lastTriggerId) {
      stableCount++;
    } else {
      lastTriggerId = family;
      stableCount = 0;
    }
    var now = Date.now();
    if (stableCount >= config.STABLE_FRAMES && g.id !== 'none' && now - lastTriggerTime > config.DEBOUNCE_MS) {
      lastTriggerTime = now;
      return g;
    }
    return null;
  }

  // ---- 检测循环 ----
  function loop() {
    if (!enabled) return;
    if (videoEl.readyState >= 2 && !sending) {
      sending = true;
      try {
        var results = handLandmarker.detectForVideo(videoEl, performance.now());
        if (results.landmarks && results.landmarks.length > 0) {
          var lm = results.landmarks[0];
          var coreResult = classifyWithCore(lm);
          var g = coreResult ? coreResult.gesture : recognize(lm);
          drawHand(lm);
          var triggered = coreResult ? coreResult.triggered : debounce(g);
          var debugInfo = coreResult ? coreResult.debug : { range: waveDebugRange, net: waveDebugNet, stable: stableCount, delegate: delegate, classifier: 'js' };
          if (callback) {
            callback({
              gesture: g,
              triggered: triggered,
              landmarks: lm,
              debug: debugInfo,
            });
          }
        } else {
          if (canvasEl && ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          resetGestureState();
          if (callback) {
            callback({ gesture: null, triggered: null, landmarks: null, debug: { range: 0, net: 0, stable: 0, delegate: delegate } });
          }
        }
      } catch (e) {
        console.error('[Gesture]', e);
      } finally {
        sending = false;
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  // ---- 加载模型（桌面 GPU 优先 fallback CPU，移动端直接 CPU）----
  async function loadModel() {
    var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    var mod = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm');
    var vision = await mod.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
    );
    var opts = {
      baseOptions: {
        modelAssetPath: 'models/hand_landmarker.task',
        delegate: isMobile ? 'CPU' : 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: config.DETECT_CONFIDENCE,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: config.TRACK_CONFIDENCE,
    };
    if (isMobile) {
      handLandmarker = await mod.HandLandmarker.createFromOptions(vision, opts);
      delegate = 'CPU';
      console.log('[Gesture] 模型加载完成（移动端CPU模式）');
      return;
    }
    try {
      handLandmarker = await mod.HandLandmarker.createFromOptions(vision, opts);
      delegate = 'GPU';
      console.log('[Gesture] 模型加载完成（GPU加速）');
    } catch (e) {
      opts.baseOptions.delegate = 'CPU';
      handLandmarker = await mod.HandLandmarker.createFromOptions(vision, opts);
      delegate = 'CPU';
      console.log('[Gesture] 模型加载完成（CPU模式）');
    }
  }

  // ---- 公开 API ----
  return {
    /**
     * 初始化手势识别
     * @param {HTMLVideoElement} video - 摄像头视频元素
     * @param {HTMLCanvasElement} canvas - 手部骨架绘制画布
     * @param {Object} [opts] - 可选配置覆盖
     */
    init: function (video, canvas, opts) {
      videoEl = video;
      canvasEl = canvas;
      ctx = canvas ? canvas.getContext('2d') : null;
      if (opts) {
        for (var k in opts) {
          if (config.hasOwnProperty(k)) config[k] = opts[k];
        }
      }
    },

    /**
     * 注册手势检测回调
     * @param {Function} fn - 回调函数，参数: { gesture, triggered, landmarks, debug }
     */
    onDetect: function (fn) {
      callback = fn;
    },

    /**
     * 开启摄像头，启动手势识别
     * @returns {Promise}
     */
    start: function () {
      if (enabled) return Promise.resolve();
      return Promise.all([
        loadModel().then(function () { return loadGestureCore(); }),
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        }),
      ]).then(function (results) {
        stream = results[1];
        videoEl.srcObject = stream;
        return videoEl.play();
      }).then(function () {
        resetGestureState();
        enabled = true;
        loop();
      }).catch(function (e) {
        // 失败时清理已加载的资源，方便重试
        handLandmarker = null;
        if (stream) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          stream = null;
        }
        throw e;
      });
    },

    /**
     * 停止手势识别，释放摄像头
     */
    stop: function () {
      enabled = false;
      cancelAnimationFrame(rafId);
      if (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
      }
      if (videoEl) videoEl.srcObject = null;
      if (canvasEl && ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      resetGestureState();
      handLandmarker = null;
    },

    /** 是否正在运行 */
    isEnabled: function () { return enabled; },

    /** 获取当前配置（调试用） */
    getConfig: function () { var c = Object.assign({}, config); c.delegate = delegate; return c; },
  };
})();
