/**
 * Compatibility patch for older MinGW-w64 headers that do not define
 * THREAD_POWER_THROTTLING_STATE used by whisper.cpp's thread scheduling code.
 */
#ifndef _VOICE_WINNT_PATCH_H
#define _VOICE_WINNT_PATCH_H

#include <windows.h>

typedef struct _THREAD_POWER_THROTTLING_STATE {
  ULONG Version;
  ULONG ControlMask;
  ULONG StateMask;
} THREAD_POWER_THROTTLING_STATE;

#define THREAD_POWER_THROTTLING_CURRENT_VERSION 1
#define THREAD_POWER_THROTTLING_EXECUTION_SPEED 1

#endif
