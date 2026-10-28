/*
 * Test double for rotkc.dll, built only by test-rotkc-load.ps1. It records
 * the thread its DllMain ran on and does nothing else. The real closed module
 * is never copied, loaded or referenced by the proxy tests.
 *
 * Built with ROTKC_STUB_WITH_DEPENDENCY, it also imports rotkc_test_dep.dll,
 * which the test only puts on PATH.
 */
#include <windows.h>

#if defined(ROTKC_STUB_WITH_DEPENDENCY)
__declspec(dllimport) int rotkc_test_dependency(void);
#endif

static DWORD g_attach_thread;

__declspec(dllexport) DWORD rotkc_stub_attach_thread(void) {
#if defined(ROTKC_STUB_WITH_DEPENDENCY)
    (void)rotkc_test_dependency();
#endif
    return g_attach_thread;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance;
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_attach_thread = GetCurrentThreadId();
    }
    return TRUE;
}
