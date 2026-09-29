/* Exercise the production hook, including cache, control reads and forwarding.
 * No DllMain, runtime patch installer or real game process is called. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <assert.h>
#include <math.h>
#include <stdio.h>

static LONGLONG test_time;
static BOOL WINAPI test_clock(LARGE_INTEGER *value) {
    value->QuadPart = test_time;
    return TRUE;
}
#define QueryPerformanceCounter test_clock
#include "../vivoxsdk_x64_proxy.c"
#undef QueryPerformanceCounter

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
static void reversals(void) {
    const int taps[] = {30, 50, 100};
    for (int moving = 0; moving <= 1; ++moving) {
        for (int down = 0; down <= 1; ++down) {
            for (unsigned i = 0; i < sizeof(taps)/sizeof(taps[0]); ++i) {
                reset((float)!down, moving);
                tick(1, (float)down, moving);
                float before = tick(1 + taps[i], (float)down, moving);
                close_to(tick(1 + taps[i], (float)!down, moving), before);
                float after = tick(2 + taps[i], (float)!down, moving);
                assert(down ? after < before : after > before);
                assert(tick(501, (float)!down, moving) == (float)!down);
            }
        }
    }
    reset(0, 0);
    tick(1, 1, 0);
    float release = tick(101, 0, 0);
    assert(tick(111, 0, 0) < release);
    float recrouch = tick(112, 1, 0);
    assert(tick(122, 1, 0) > recrouch);
    assert(tick(700, 1, 0) == 1);
}
static float after_stop(int start) {
    reset(0, 1);
    tick(start, 1, 0);
    return tick(start + 125, 1, 0);
}
static float cadence(int step) {
    reset(0, 1);
    tick(1, 1, 1);
    for (int t = step; t < 300; t += step) tick(1+t, 1, 0);
    return tick(301, 1, 0);
}
static void locomotion(void) {
    assert(fabsf(after_stop(100) - after_stop(101)) < .005f);
    assert(fabsf(after_stop(199) - after_stop(200)) < .005f);
    close_to(cadence(1), cadence(17));
    close_to(cadence(17), cadence(300));
    reset(0, 0);
    tick(1, 1, 0);
    float idle = tick(101, 1, 0);
    close_to(tick(101, 1, 1), idle);
    for (int t=111; t<=281; t+=10) tick(t,1,1);
    assert(tick(301,1,1) == 1); /* v12 was still at ~0.854 */
    /* Node order in one evaluation does not advance the phase twice. */
    reset(0,0); tick(1,1,0);
    float first = tick(101,1,1);
    close_to(tick(101,1,0), first);
    float next = tick(151,1,1);
    reset(0,0); tick(1,1,0);
    close_to(tick(101,1,0), first);
    close_to(tick(101,1,1), first);
    close_to(tick(151,1,1), next);
}
static void boundaries(void) {
    reset(0,0);
    tick(1,1,0);
    assert(tick(1,0,0) == 0);
    assert(tick(2,0,0) == 0); /* zero-distance reversal cannot divide by zero */
    *(uint32_t *)node = 108;
    assert(tick(3,.37f,0) == .37f); /* unrelated graph untouched */
    *(uint32_t *)node = CROUCH_NODE_TYPE;
    *(void **)(generation + 0x330) = NULL;
    assert(tick(4,.42f,0) == .42f); /* invalid identity fails open */
    reset(0,0); tick(1,1,0);
    assert(tick(3001,0,0) == 0); /* stale identity policy retained */
    reset(0,0);
    for (int t=1;t<1000;++t) tick(t, (float)((t/13)%2), t%3==0);
    assert(tick(1600,0,0) == 0);
}
int main(void) {
    nominal(); puts("PASS nominal sine curves and 400/200/250 ms endpoints");
    reversals(); puts("PASS both directions, short taps and repeated reversals");
    locomotion(); puts("PASS continuous locomotion timing, cadence and node order");
    boundaries(); puts("PASS boundaries, fail-open, stale reset and rapid inputs");
    printf("PASS production hook: %u forwarded calls with unchanged ADS/event arguments\n", calls);
    return 0;
}
