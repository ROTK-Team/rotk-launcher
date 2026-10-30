/* Inert DLL for the image inventory test: it only exists to be mapped. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance; (void)reason; (void)reserved;
    return TRUE;
}

__declspec(dllexport) int rotk_fixture_module(void) { return 42; }
