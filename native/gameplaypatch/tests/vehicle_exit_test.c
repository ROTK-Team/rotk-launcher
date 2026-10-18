#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static HANDLE WINAPI test_open_thread(DWORD access, BOOL inherit, DWORD id);
static BOOL WINAPI test_virtual_protect(LPVOID address, SIZE_T bytes, DWORD protection, PDWORD old);
#define OpenThread test_open_thread
#define VirtualProtect test_virtual_protect
#define DirectInput8Create RotkTestDirectInput8Create
#define DllCanUnloadNow RotkTestDllCanUnloadNow
#define DllGetClassObject RotkTestDllGetClassObject
#define DllRegisterServer RotkTestDllRegisterServer
#define DllUnregisterServer RotkTestDllUnregisterServer
#define GetdfDIJoystick RotkTestGetdfDIJoystick
#define DllMain RotkTestDllMain
#include "../dinput8_proxy.c"
#undef OpenThread
#undef VirtualProtect
#undef NDEBUG
#include <assert.h>

static HANDLE retiring_thread, retire_event;
static DWORD retiring_id;
static unsigned int retired_open_errors, denied_opens, forced_open_failures;
static BYTE *refused_site;
static unsigned int protection_refusals;
static BOOL WINAPI test_virtual_protect(LPVOID address, SIZE_T bytes, DWORD protection, PDWORD old) {
    if (address == refused_site && protection == PAGE_EXECUTE_READWRITE) {
        ++protection_refusals; SetLastError(ERROR_ACCESS_DENIED); return FALSE;
    }
    return VirtualProtect(address, bytes, protection, old);
}
static DWORD WINAPI retire_worker(LPVOID unused) {
    (void)unused;
    assert(WaitForSingleObject(retire_event, 5000) == WAIT_OBJECT_0);
    return 0;
}
static HANDLE WINAPI test_open_thread(DWORD access, BOOL inherit, DWORD id) {
    if (id == retiring_id) {
        assert(SetEvent(retire_event));
        assert(WaitForSingleObject(retiring_thread, 5000) == WAIT_OBJECT_0);
        assert(CloseHandle(retiring_thread));
        retiring_thread = NULL; retiring_id = 0;
        ++retired_open_errors;
        /* Replay the error captured in H1Z1 without depending on how quickly
         * Windows destroys the terminated thread object. */
        SetLastError(ERROR_INVALID_PARAMETER);
        return NULL;
    }
    if (forced_open_failures) {
        --forced_open_failures; ++denied_opens;
        SetLastError(ERROR_ACCESS_DENIED);
        return NULL;
    }
    return OpenThread(access, inherit, id);
}

static float tilted[16] = {0.8f,0.6f,0,0,-0.6f,0.8f,0,0,0,0,1,0,10,20,30,1};
static float upright[16] = {1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
static float observed[16];
static unsigned int calls;
static BOOL first_accept, second_accept, flat, disable_during_call;
static float *mock_inverse(float *out, const float *source) {
    memcpy(observed, source, sizeof(observed)); memcpy(out, source, sizeof(observed)); return out;
}
static DWORD WINAPI foreign_inverse(LPVOID ignored) {
    float out[16]; (void)ignored;
    vehicle_exit_inverse(out, tilted, upright);
    assert(!memcmp(out, tilted, sizeof(out)));
    return 0;
}
static BYTE mock_point(BYTE *vehicle, float *out, const char *bone, void *auxiliary,
                       float heading, BYTE geometry, BYTE special, BYTE air) {
    float inverse[16];
    assert(vehicle == (BYTE *)0x1234 && !strcmp(bone, "mount1") && auxiliary == (void *)0x5678);
    assert(heading == 0.75f && air == 1 && geometry == 1 && special == 0);
    ++calls;
    vehicle_exit_inverse(inverse, flat ? upright : tilted, upright);
    if (calls == 1) {
        HANDLE thread = CreateThread(NULL, 0, foreign_inverse, NULL, 0, NULL);
        assert(thread && WaitForSingleObject(thread, 5000) == WAIT_OBJECT_0); CloseHandle(thread);
        if (disable_during_call) InterlockedExchange(&vehicle_exit_enabled, 0);
    } else {
        assert(!memcmp(inverse, upright, 12 * sizeof(float)));
        assert(!memcmp(inverse + 12, tilted + 12, 4 * sizeof(float)));
    }
    for (unsigned int i = 0; i < 16; ++i) out[i] = (float)calls;
    return calls == 1 ? first_accept : second_accept;
}
static void run(BOOL accept_first, BOOL accept_second, BOOL level, unsigned int expected_calls, BYTE expected) {
    float out[16];
    calls = 0; first_accept = accept_first; second_accept = accept_second; flat = level;
    InterlockedExchange(&vehicle_exit_enabled, 1);
    assert(vehicle_exit_candidate((BYTE *)0x1234, out, "mount1", (void *)0x5678, 0.75f, 1, 0, 1) == expected);
    assert(calls == expected_calls && !vehicle_exit_current);
    assert(out[0] == (expected && expected_calls == 2 ? 2.0f : 1.0f));
}
int main(int argc, char **argv) {
    DWORD protection;
    BYTE *memory = VirtualAlloc(NULL, 0x2000000, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    BYTE *bridge = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    assert(memory && bridge); vehicle_exit_base = memory;
    stance_jump(memory + 0x10577c0, (void *)(uintptr_t)mock_point);
    stance_jump(memory + 0xf2fb60, (void *)(uintptr_t)mock_inverse);
    assert(FlushInstructionCache(GetCurrentProcess(), memory, 0x2000000));
    run(TRUE, FALSE, FALSE, 1, 1);
    run(FALSE, TRUE, FALSE, 2, 1);
    run(FALSE, FALSE, FALSE, 2, 0);
    run(FALSE, TRUE, TRUE, 1, 0);
    disable_during_call = TRUE; run(FALSE, TRUE, FALSE, 2, 1); disable_during_call = FALSE;
    calls = 0; first_accept = FALSE; InterlockedExchange(&vehicle_exit_enabled, 0);
    { float out[16]; assert(!vehicle_exit_candidate((BYTE *)0x1234, out, "mount1", (void *)0x5678, 0.75f, 1, 0, 1)); }
    assert(calls == 1 && !vehicle_exit_current);

    vehicle_exit_build_bridges(bridge);
    calls = 0; first_accept = TRUE; InterlockedExchange(&vehicle_exit_enabled, 1);
    { float out[16];
      assert(((vehicle_exit_point_fn)(uintptr_t)bridge)((BYTE *)0x1234, out, "mount1", (void *)0x5678, 0.75f, 1, 0, 1));
      assert(calls == 1 && out[0] == 1.0f);
    }
    /* Exercise emitted inverse bridge with a caller that supplies native R15. */
    { BYTE *p = bridge + 128; uintptr_t address = (uintptr_t)(bridge + 32);
      const BYTE start[] = {0x41,0x57,0x48,0x83,0xec,0x20,0x4d,0x89,0xc7,0x48,0xb8};
      const BYTE end[] = {0xff,0xd0,0x48,0x83,0xc4,0x20,0x41,0x5f,0xc3};
      memcpy(p, start, sizeof(start)); memcpy(p + sizeof(start), &address, 8); memcpy(p + sizeof(start) + 8, end, sizeof(end));
      assert(FlushInstructionCache(GetCurrentProcess(), bridge, 4096));
      { vehicle_exit_scope scope = {TRUE, FALSE, NULL}; float out[16];
        vehicle_exit_current = &scope;
        assert(((float *(*)(float *, const float *, const float *))(uintptr_t)p)(out, tilted, upright) == out);
        assert(!memcmp(out, upright, 12 * sizeof(float)) && !memcmp(out + 12, tilted + 12, 4 * sizeof(float)));
        vehicle_exit_current = NULL;
      }
    }
    if (argc == 2) { FILE *file = fopen(argv[1], "wb"); assert(file); assert(fwrite(bridge, 1, 64, file) == 64); fclose(file); }
    /* A mismatched site must leave both CALL instructions untouched. */
    memcpy(memory + 0x12e6635, vehicle_exit_candidate_guard, sizeof(vehicle_exit_candidate_guard));
    InterlockedExchange(&vehicle_exit_enabled, 0); vehicle_exit_install(memory);
    assert(!vehicle_exit_enabled && !memcmp(memory + 0x12e6635, vehicle_exit_candidate_guard, sizeof(vehicle_exit_candidate_guard)));
    memcpy(memory + 0x10579a0, vehicle_exit_inverse_guard, sizeof(vehicle_exit_inverse_guard));
    memcpy(memory + 0x12e5a87, vehicle_exit_bailout_guard, sizeof(vehicle_exit_bailout_guard));
    memcpy(memory + 0x1057a12, vehicle_exit_frame_guard, sizeof(vehicle_exit_frame_guard));
    assert(VirtualProtect(memory, 0x2000000, PAGE_EXECUTE_READ, &protection));
    /* The snapshot contains a real thread which exits before OpenThread. */
    retire_event = CreateEventW(NULL, TRUE, FALSE, NULL); assert(retire_event);
    retiring_thread = CreateThread(NULL, 0, retire_worker, NULL, 0, &retiring_id);
    assert(retiring_thread);
    vehicle_exit_install(memory);
    assert(retired_open_errors == 1 && !retiring_thread);
    assert(vehicle_exit_enabled && memory[0x12e6635] == 0xe8 && memory[0x10579a0] == 0xe8);
    assert(memcmp(memory + 0x12e6635, vehicle_exit_candidate_guard, 5));
    assert(memcmp(memory + 0x10579a0, vehicle_exit_inverse_guard, 5));
    assert(memcmp(memory + 0x12e5a87, vehicle_exit_bailout_guard, 5));
    assert(memory + 0x12e663a + *(int32_t *)(memory + 0x12e6636) ==
           memory + 0x12e5a8c + *(int32_t *)(memory + 0x12e5a88));
    /* A persistent failure is bounded and never changes the original code. */
    assert(VirtualProtect(memory, 0x2000000, PAGE_READWRITE, &protection));
    memcpy(memory + 0x12e6635, vehicle_exit_candidate_guard, sizeof(vehicle_exit_candidate_guard));
    memcpy(memory + 0x10579a0, vehicle_exit_inverse_guard, sizeof(vehicle_exit_inverse_guard));
    memcpy(memory + 0x12e5a87, vehicle_exit_bailout_guard, sizeof(vehicle_exit_bailout_guard));
    assert(VirtualProtect(memory, 0x2000000, PAGE_EXECUTE_READ, &protection));
    assert(ResetEvent(retire_event));
    retiring_thread = CreateThread(NULL, 0, retire_worker, NULL, 0, NULL); assert(retiring_thread);
    forced_open_failures = 100; denied_opens = 0;
    InterlockedExchange(&vehicle_exit_enabled, 0);
    vehicle_exit_install(memory);
    assert(!vehicle_exit_enabled && denied_opens == 20 && forced_open_failures == 80);
    assert(!memcmp(memory + 0x12e6635, vehicle_exit_candidate_guard, sizeof(vehicle_exit_candidate_guard)));
    assert(!memcmp(memory + 0x10579a0, vehicle_exit_inverse_guard, sizeof(vehicle_exit_inverse_guard)));
    assert(!memcmp(memory + 0x12e5a87, vehicle_exit_bailout_guard, sizeof(vehicle_exit_bailout_guard)));
    /* Protection failures must be terminal, unlike the stale thread snapshot. */
    forced_open_failures = 0; refused_site = memory + 0x12e6635;
    vehicle_exit_install(memory);
    assert(!vehicle_exit_enabled && protection_refusals == 1);
    assert(!memcmp(memory + 0x12e6635, vehicle_exit_candidate_guard, sizeof(vehicle_exit_candidate_guard)));
    assert(!memcmp(memory + 0x10579a0, vehicle_exit_inverse_guard, sizeof(vehicle_exit_inverse_guard)));
    assert(!memcmp(memory + 0x12e5a87, vehicle_exit_bailout_guard, sizeof(vehicle_exit_bailout_guard)));
    refused_site = NULL;
    assert(SetEvent(retire_event) && WaitForSingleObject(retiring_thread, 5000) == WAIT_OBJECT_0);
    CloseHandle(retiring_thread); CloseHandle(retire_event);
    puts("PASS vehicle exit: retry, blocked fallback, flat ground, disable, thread isolation, emitted bridge, guarded install, startup thread exit, bounded refusal, terminal protection refusal");
    return 0;
}
