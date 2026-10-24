#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define DirectInput8Create RotkTestDirectInput8Create
#define DllCanUnloadNow RotkTestDllCanUnloadNow
#define DllGetClassObject RotkTestDllGetClassObject
#define DllRegisterServer RotkTestDllRegisterServer
#define DllUnregisterServer RotkTestDllUnregisterServer
#define GetdfDIJoystick RotkTestGetdfDIJoystick
#define DllMain RotkTestDllMain
#include "../dinput8_proxy.c"
#undef NDEBUG
#include <assert.h>

#define WORKERS 300U
static HANDLE release_event;
static volatile LONG spinning;
static volatile LONG spin_stop;
static DWORD WINAPI parked(LPVOID unused) {
    (void)unused;
    return WaitForSingleObject(release_event, 10000) == WAIT_OBJECT_0 ? 0 : 1;
}
static __declspec(noinline) void spin_window(void) {
    while (!spin_stop) YieldProcessor();
}
static DWORD WINAPI spinner(LPVOID unused) {
    (void)unused; InterlockedExchange(&spinning, 1); spin_window(); return 0;
}

int main(void) {
    HANDLE workers[WORKERS], spin;
    thread_gate gate;
    thread_gate_window none[] = {{NULL, 0}};
    thread_gate_window everywhere[] = {{(const BYTE *)(uintptr_t)spin_window, 64}};
    unsigned int i;
    release_event = CreateEventW(NULL, TRUE, FALSE, NULL); assert(release_event);
    for (i = 0; i < WORKERS; ++i) { workers[i] = CreateThread(NULL, 0x10000, parked, NULL, 0, NULL); assert(workers[i]); }

    /* Launcher 2.0.45 refused every guarded write above 256 other threads
     * (316 in H1Z1 with an NVIDIA driver). The gate now holds all of them. */
    assert(thread_gate_freeze(&gate, "test", none, 1));
    assert(gate.count >= WORKERS && gate.stopped == gate.count);
    for (i = 0; i < WORKERS; ++i) assert(SuspendThread(workers[i]) == 1 && ResumeThread(workers[i]) == 2);
    thread_gate_thaw(&gate);
    assert(!gate.handles && !gate.count && !gate.stopped && !gate.name);
    for (i = 0; i < WORKERS; ++i) assert(SuspendThread(workers[i]) == 0 && ResumeThread(workers[i]) == 1);

    /* A thread that never leaves a patch window is bounded and fully resumed. */
    spin = CreateThread(NULL, 0, spinner, NULL, 0, NULL); assert(spin);
    while (!spinning) Sleep(1);
    assert(!thread_gate_freeze(&gate, "test", everywhere, 1));
    assert(!gate.handles && !gate.count && !gate.stopped);
    assert(SuspendThread(spin) == 0 && ResumeThread(spin) == 1);
    InterlockedExchange(&spin_stop, 1);
    assert(WaitForSingleObject(spin, 5000) == WAIT_OBJECT_0);

    assert(SetEvent(release_event));
    for (i = 0; i < WORKERS; ++i) {
        DWORD code = 1;
        assert(WaitForSingleObject(workers[i], 10000) == WAIT_OBJECT_0);
        assert(GetExitCodeThread(workers[i], &code) && code == 0);
        CloseHandle(workers[i]);
    }
    CloseHandle(spin); CloseHandle(release_event);
    puts("PASS thread gate: 300 threads frozen and resumed, window refusal bounded and resumed");
    return 0;
}
