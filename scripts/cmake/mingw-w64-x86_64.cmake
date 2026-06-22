# Toolchain file for cross-compiling whisper.cpp for Windows x64 on Linux.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR AMD64)

set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)
set(CMAKE_AR x86_64-w64-mingw32-ar)
set(CMAKE_RANLIB x86_64-w64-mingw32-ranlib)

set(CMAKE_FIND_ROOT_PATH /usr/x86_64-w64-mingw32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)

# MinGW headers may lack THREAD_POWER_THROTTLING_STATE definitions, so patch
# them at compile time.
set(WINNT_PATCH_H "${CMAKE_CURRENT_LIST_DIR}/mingw-w64-winnt-patch.h")
set(CMAKE_C_FLAGS_INIT "-D_WIN32_WINNT=0x0A00 -include ${WINNT_PATCH_H}" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_INIT "-D_WIN32_WINNT=0x0A00 -include ${WINNT_PATCH_H}" CACHE STRING "" FORCE)

set(CMAKE_EXE_LINKER_FLAGS "-static-libgcc -static-libstdc++" CACHE STRING "" FORCE)
