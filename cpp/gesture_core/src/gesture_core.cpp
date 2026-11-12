#include <algorithm>
#include <cmath>

namespace {

constexpr int kNone = 0;
constexpr int kFist = 1;
constexpr int kPoint = 2;
constexpr int kWaveLeft = 3;
constexpr int kWaveRight = 4;
constexpr int kWaveFamily = 5;

constexpr double kWaveWindowMs = 1000.0;
constexpr float kWaveMinRange = 0.2f;
constexpr float kWaveDirThreshold = 0.015f;
constexpr double kWaveCooldownMs = 500.0;
constexpr double kWaveHoldMs = 800.0;
constexpr int kStableFrames = 5;
constexpr double kDebounceMs = 500.0;

struct Sample {
  float x;
  double time;
};

Sample wrist_history[64];
int history_start = 0;
int history_count = 0;

double wave_active_until = 0.0;
int last_wave_dir = kNone;
double wave_left_time = 0.0;
double wave_right_time = 0.0;
double wave_end_time = 0.0;
float wave_debug_range = 0.0f;
float wave_debug_net = 0.0f;

int last_trigger_family = kNone;
int stable_count = 0;
double last_trigger_time = 0.0;

inline float lx(const float* lm, int i) { return lm[i * 3]; }
inline float ly(const float* lm, int i) { return lm[i * 3 + 1]; }

float dist(const float* lm, int a, int b) {
  const float dx = lx(lm, a) - lx(lm, b);
  const float dy = ly(lm, a) - ly(lm, b);
  return std::sqrt(dx * dx + dy * dy);
}

float angle_between(const float* lm, int a, int b, int c) {
  const float v1x = lx(lm, a) - lx(lm, b);
  const float v1y = ly(lm, a) - ly(lm, b);
  const float v2x = lx(lm, c) - lx(lm, b);
  const float v2y = ly(lm, c) - ly(lm, b);
  const float dot = v1x * v2x + v1y * v2y;
  const float denom = dist(lm, a, b) * dist(lm, c, b) + 0.0001f;
  const float cos_value = std::max(-1.0f, std::min(1.0f, dot / denom));
  return std::acos(cos_value);
}

bool is_finger_extended(const float* lm, int finger_index) {
  constexpr int tips[] = {8, 12, 16, 20};
  constexpr int pips[] = {6, 10, 14, 18};
  constexpr int dips[] = {7, 11, 15, 19};
  constexpr int mcps[] = {5, 9, 13, 17};

  const int tip = tips[finger_index];
  const int pip = pips[finger_index];
  const int dip = dips[finger_index];
  const int mcp = mcps[finger_index];

  const float ratio = dist(lm, tip, 0) / (dist(lm, mcp, 0) + 0.001f);
  const bool tip_above_pip = ly(lm, tip) < ly(lm, pip);
  const float v1x = lx(lm, tip) - lx(lm, dip);
  const float v1y = ly(lm, tip) - ly(lm, dip);
  const float v2x = lx(lm, pip) - lx(lm, dip);
  const float v2y = ly(lm, pip) - ly(lm, dip);
  const float dot = v1x * v2x + v1y * v2y;
  const float cos_angle = dot / (dist(lm, tip, dip) * dist(lm, pip, dip) + 0.001f);

  return (ratio > 1.15f && tip_above_pip) || (cos_angle > 0.5f && ratio > 1.0f);
}

bool is_thumb_extended(const float* lm) {
  return angle_between(lm, 2, 3, 4) > 2.6f;
}

void clear_history() {
  history_start = 0;
  history_count = 0;
}

void push_history(float x, double time) {
  if (history_count < 64) {
    const int idx = (history_start + history_count) % 64;
    wrist_history[idx] = {x, time};
    history_count++;
  } else {
    wrist_history[history_start] = {x, time};
    history_start = (history_start + 1) % 64;
  }

  while (history_count > 0 && time - wrist_history[history_start].time > kWaveWindowMs) {
    history_start = (history_start + 1) % 64;
    history_count--;
  }
}

int detect_wave(const float* lm, double now) {
  const float palm_x = (lx(lm, 0) + lx(lm, 9)) * 0.5f;
  push_history(palm_x, now);
  if (history_count < 5) return kNone;

  float mn = wrist_history[history_start].x;
  float mx = wrist_history[history_start].x;
  for (int i = 0; i < history_count; ++i) {
    const int idx = (history_start + i) % 64;
    mn = std::min(mn, wrist_history[idx].x);
    mx = std::max(mx, wrist_history[idx].x);
  }

  const int first_idx = history_start;
  const int last_idx = (history_start + history_count - 1) % 64;
  wave_debug_range = mx - mn;
  wave_debug_net = wrist_history[last_idx].x - wrist_history[first_idx].x;

  if (wave_debug_range < kWaveMinRange) return kNone;
  if (std::fabs(wave_debug_net) >= kWaveDirThreshold) {
    return wave_debug_net > 0 ? kWaveLeft : kWaveRight;
  }
  return kNone;
}

int recognize(const float* lm, double now) {
  if (now < wave_active_until) return last_wave_dir;

  const int wave = detect_wave(lm, now);
  if (wave != kNone) {
    const double last_same_wave_time = wave == kWaveLeft ? wave_left_time : wave_right_time;
    if (now - last_same_wave_time > kWaveCooldownMs && now - wave_end_time > kWaveCooldownMs) {
      if (wave == kWaveLeft) {
        wave_left_time = now;
      } else {
        wave_right_time = now;
      }
      last_wave_dir = wave;
      wave_active_until = now + kWaveHoldMs;
      clear_history();
      return wave;
    }
  } else {
    wave_end_time = now;
  }

  const bool thumb = is_thumb_extended(lm);
  const bool index = is_finger_extended(lm, 0);
  const bool middle = is_finger_extended(lm, 1);
  const bool ring = is_finger_extended(lm, 2);
  const bool pinky = is_finger_extended(lm, 3);
  const int count = (thumb ? 1 : 0) + (index ? 1 : 0) + (middle ? 1 : 0) + (ring ? 1 : 0) + (pinky ? 1 : 0);

  if (count == 0) return kFist;
  if (!thumb && index && !middle && !ring && !pinky) return kPoint;
  return kNone;
}

int debounce(int gesture, double now) {
  const int family = (gesture == kWaveLeft || gesture == kWaveRight) ? kWaveFamily : gesture;
  if (family == last_trigger_family) {
    stable_count++;
  } else {
    last_trigger_family = family;
    stable_count = 0;
  }

  if (stable_count >= kStableFrames && gesture != kNone && now - last_trigger_time > kDebounceMs) {
    last_trigger_time = now;
    return gesture;
  }
  return kNone;
}

}  // namespace

extern "C" {

void gesture_reset() {
  clear_history();
  wave_active_until = 0.0;
  last_wave_dir = kNone;
  wave_left_time = 0.0;
  wave_right_time = 0.0;
  wave_end_time = 0.0;
  wave_debug_range = 0.0f;
  wave_debug_net = 0.0f;
  last_trigger_family = kNone;
  stable_count = 0;
  last_trigger_time = 0.0;
}

int gesture_update(const float* landmarks, double now_ms, float* debug_out) {
  const int gesture = recognize(landmarks, now_ms);
  const int triggered = debounce(gesture, now_ms);

  if (debug_out) {
    debug_out[0] = wave_debug_range;
    debug_out[1] = wave_debug_net;
    debug_out[2] = static_cast<float>(stable_count);
  }

  return gesture | (triggered << 8);
}

}
