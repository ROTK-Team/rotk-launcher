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

static unsigned char network[32], generation[0x800], control_pin[32], vehicle_pin[32], node[32];
static void *control_generation;
static void *vehicle_generation;
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
static float tick_raw(double ms, float target, float raw, int moving) {
    unsigned before = calls;
    test_time = 10000000 + (LONGLONG)(ms * 1000.0 + 0.5);
    memcpy(control_pin + 16, &target, sizeof(target));
    *(uint16_t *)(node + 8) = moving ? CROUCH_MOVE_NODE_ID : CROUCH_IDLE_NODE_ID;
    assert(crouch_blend_weight_hook((void *)1, (void *)2, (void *)3,
        network, node, raw, 0.21f, 0.32f, 0.43f, 1) == 123);
    assert(calls == before + 1);
    assert(isfinite(result) && result >= 0 && result <= 1);
    return result;
}
static float tick(double ms, float target, int moving) {
    return tick_raw(ms, target, target, moving);
}
static void vehicle(float value) {
    memcpy(vehicle_pin + 16, &value, sizeof(value));
}
static void reset(float pose, int moving) {
    memset(g_crouch_states, 0, sizeof(g_crouch_states));
    memset(network, 0, sizeof(network));
    memset(generation, 0, sizeof(generation));
    *(void **)(network + 8) = generation;
    control_generation = control_pin;
    *(void **)(generation + 0x330) = &control_generation;
    vehicle_generation = vehicle_pin;
    *(void **)(generation + 0x10 + 45 * 0x28) = &vehicle_generation;
    vehicle(0);
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
static void pickup_seat_pose(void) {
    for (int moving = 0; moving <= 1; ++moving) {
        reset(0, moving);
        /* Native OrPickupBed chooses crouch for the rear seat even though
         * State_Crouching stays zero: C changes the seat instead. */
        vehicle(11);
        assert(tick_raw(1, 0, 1, moving) == 1);
        assert(tick_raw(2, 0, 0, moving) == 0);
        assert(tick_raw(3, 0, 0.37f, moving) == 0.37f);
        /* A foot transition interrupted by mounting must not resume on exit. */
        vehicle(0);
        assert(tick(4, 0, moving) == 0);
        tick(5, 1, moving);
        vehicle(11);
        assert(tick_raw(6, 0, 1, moving) == 1);
        vehicle(0);
        assert(tick(7, 0, moving) == 0);
        tick(8, 1, moving);
        double duration = moving ? 250 : 400;
        close_to(tick(8 + duration / 2, 1, moving), .5f);
        assert(tick(8 + duration, 1, moving) == 1);
        /* Other mounts keep the stock pose as well. */
        vehicle(1);
        assert(tick_raw(900, 1, 0.23f, moving) == .23f);
        /* Missing control data must retain the game's computed pose. */
        *(void **)(generation + 0x10 + 45 * 0x28) = NULL;
        assert(tick_raw(901, 0, .61f, moving) == .61f);
    }
}
/* A pointer the game no longer maps must keep the stock pose, not fault. */
static void unmapped_graph(void) {
    unsigned char *page = VirtualAlloc(NULL, 8192, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    DWORD old;
    assert(page != NULL && VirtualProtect(page + 4096, 4096, PAGE_NOACCESS, &old));
    reset(0, 0);
    *(void **)(generation + 0x330) = page + 4096;            /* pin entries gone */
    assert(tick_raw(1, 1, .42f, 0) == .42f);
    *(void **)(generation + 0x330) = &control_generation;
    control_generation = page + 4096 - 0x12;                 /* float straddles the gap */
    assert(tick_raw(2, 1, .43f, 0) == .43f);
    control_generation = (void *)(uintptr_t)0x4d8;           /* garbage attrib */
    assert(tick_raw(3, 1, .44f, 0) == .44f);
    *(void **)(network + 8) = page + 4096;                   /* node bins gone */
    assert(tick_raw(4, 1, .45f, 0) == .45f);
    VirtualFree(page, 0, MEM_RELEASE);
}
int main(void) {
    pickup_seat_pose();
    nominal();
    unmapped_graph();
    reset(0,0);
    g_crouch_blend_call_count = 0;
    tick(1,1,0); tick(501,1,0); tick(3001,0,0);
    assert(file_opens == 0);
    reset(0,0); tick(1,1,0);
    assert(file_opens == 0);
    printf("PASS pickup seat poses, mount/exit, foot curves, %u forwarded calls, zero crouch log disk opens\n",calls);
    return 0;
}
