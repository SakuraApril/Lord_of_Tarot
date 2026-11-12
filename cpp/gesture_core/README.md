# gesture_core

C++ gesture post-processing core for browser WebAssembly.

MediaPipe still detects hand landmarks in `public/js/gesture.js`. This module only handles the CPU-friendly numeric part:

- finger geometry classification
- wave trajectory window
- stable-frame counting
- debounce trigger state

Build with Emscripten:

```bash
emcmake cmake -S cpp/gesture_core -B cpp/gesture_core/build
cmake --build cpp/gesture_core/build
mkdir -p public/wasm
cp cpp/gesture_core/build/gesture_core.js public/wasm/
cp cpp/gesture_core/build/gesture_core.wasm public/wasm/
```
