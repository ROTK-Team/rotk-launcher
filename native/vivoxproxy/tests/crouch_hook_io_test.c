/* Exercise the production hook, including cache, control reads and forwarding.
 * No DllMain, runtime patch installer or real game process is called. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <assert.h>
#include <math.h>
#include <stdio.h>

static unsigned file_opens;
static HANDLE WINAPI counted_open(LPCWSTR name, DWORD access, DWORD sharing,
    LPSECURITY_ATTRIBUTES security, DWORD creation, DWORD flags, HANDLE template_file) {
    ++file_opens;
    return CreateFileW(name, access, sharing, security, creation, flags, template_file);
}

static LONGLONG test_time;
static BOOL WINAPI test_clock(LARGE_INTEGER *value) {
    value->QuadPart = test_time;
    return TRUE;
}
#define QueryPerformanceCounter test_clock
#define CreateFileW counted_open
#include "../vivoxsdk_x64_proxy.c"
#undef QueryPerformanceCounter
#undef CreateFileW

/* Release builds must retain checks. */
#undef assert
#define assert(condition) do { if (!(condition)) { \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #condition); exit(1); \
} } while (0)

static unsigned char network[32], generation[0x400], control_pin[32], node[32];
static void *control_generation;
static float result;
static unsigned calls;
static uint16_t capture(void *a, void *b, void *c, void *n, void *d,
    float pose, float events, float sampled, float sync, unsigned char additive) {
    assert(a == (void *)1 && b == (void *)2 && c == (void *)3);
    assert(n == network && d == node && additive == 1);
    assert(events == 0.21f && sampled == 0.32f && sync == 0.43f);
    result = pose;
    ++calls;
    return 123;
}
static float tick(double ms, float target, int moving) {
    unsigned before = calls;
    test_time = 10000000 + (LONGLONG)(ms * 1000.0 + 0.5);
    memcpy(control_pin + 16, &target, sizeof(target));
    *(uint16_t *)(node + 8) = moving ? CROUCH_MOVE_NODE_ID : CROUCH_IDLE_NODE_ID;
    assert(crouch_blend_weight_hook((void *)1, (void *)2, (void *)3,
        network, node, target, 0.21f, 0.32f, 0.43f, 1) == 123);
    assert(calls == before + 1);
    assert(isfinite(result) && result >= 0 && result <= 1);
    return result;
}
static void reset(float pose, int moving) {
    memset(g_crouch_states, 0, sizeof(g_crouch_states));
    memset(network, 0, sizeof(network));
    memset(generation, 0, sizeof(generation));
    *(void **)(network + 8) = generation;
    control_generation = control_pin;
    *(void **)(generation + 0x330) = &control_generation;
    *(uint32_t *)node = CROUCH_NODE_TYPE;
    g_crouch_qpc_frequency.QuadPart = 1000000;
    g_crouch_original_blend_trampoline = (void *)(uintptr_t)capture;
    /* Skip the first-call telemetry; transition logs stay in test output dir. */
    g_crouch_blend_call_count = 16;
    assert(tick(0, pose, moving) == pose);
}
static void close_to(float a, float b) { assert(fabsf(a - b) < 0.00002f); }

static void nominal(void) {
    for (int moving = 0; moving <= 1; ++moving) {
        for (int down = 0; down <= 1; ++down) {
            double duration = moving ? 250 : down ? 400 : 200;
            reset((float)!down, moving);
            tick(1, (float)down, moving);
            for (int i = 1; i <= 20; ++i) {
                float expected = (float)((1.0 - cos(3.14159265358979323846 * i / 20)) * .5);
                if (!down) expected = 1 - expected;
                close_to(tick(1 + duration * i / 20, (float)down, moving), expected);
            }
            assert(tick(502, (float)down, moving) == (float)down);
        }
    }
}
int main(void) {
    nominal();
    reset(0,0);
    g_crouch_blend_call_count = 0;
    tick(1,1,0); tick(501,1,0); tick(3001,0,0);
    assert(file_opens == 0);
    g_crouch_transition_trace = TRUE;
    reset(0,0); tick(1,1,0);
    assert(file_opens > 0);
    printf("PASS v12 unchanged nominal curves, %u forwarded calls, zero normal disk opens, opt-in trace\n",calls);
    return 0;
}