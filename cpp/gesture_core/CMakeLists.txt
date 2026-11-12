cmake_minimum_required(VERSION 3.16)
project(gesture_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(gesture_core src/gesture_core.cpp)

if (EMSCRIPTEN)
  target_link_options(gesture_core PRIVATE
    "SHELL:--no-entry"
    "SHELL:-s WASM=1"
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_ES6=1"
    "SHELL:-s EXPORT_NAME=createGestureCore"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s EXPORTED_FUNCTIONS=['_malloc','_free','_gesture_reset','_gesture_update']"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPF32']"
  )
endif()
