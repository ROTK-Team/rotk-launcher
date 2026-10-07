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

static BYTE *image, *game, *context, *actor, *flags_context, *flags_owner, *history, *team_view, *normal_view, *mode;
static unsigned int wanted = 0x18, setter_calls, visible_calls, hidden_calls, event_calls, actor_calls;
static BYTE native_dead, refuse_setter, expect_unfinished_event;
static int apply_dead = -1;
static void native_actor(BYTE *a) {
    assert(a != NULL); ++actor_calls;
    if (a == actor && apply_dead >= 0) native_dead = (BYTE)apply_dead;
}
static BYTE native_is_dead(BYTE *a) { assert(a == actor + 0x310); return native_dead; }
static unsigned int native_select(BYTE *g) {
    assert(g == game); assert((flags_owner[0x108fc] & 0x18) == 0); return wanted;
}
static void native_set(BYTE *g, unsigned int selected) {
    assert(g == game && selected == wanted && !reboot_pending.game);
    ++setter_calls;
    if (!refuse_setter) *(BYTE **)(game + 0x382d8) = normal_view;
    if (refuse_setter == 2) *(BYTE **)(game + 0x382d8) = NULL;
}
static unsigned int native_view_type(BYTE *view) { assert(view == normal_view); return wanted; }
static void native_visible(BYTE *a) { assert(a == actor); ++visible_calls; }
static void native_hidden(BYTE *a, BYTE enabled, unsigned int reason) {
    assert(a == actor && !enabled && reason == 0); ++hidden_calls;
}
static uintptr_t native_event(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d) {
    assert(a == 11 && b == 22 && c == 33 && d == 44);
    if (expect_unfinished_event) assert(!history[0x438] && !history[0x439]);
    ++event_calls; return 0x12345678;
}
static void write_code(BYTE *where, const BYTE *bytes, SIZE_T n) {
    DWORD old; assert(VirtualProtect(where, n, PAGE_EXECUTE_READWRITE, &old));
    memcpy(where, bytes, n); assert(FlushInstructionCache(GetCurrentProcess(), where, n));
    assert(VirtualProtect(where, n, old, &old));
}
static void forward(BYTE *where, const void *target) {
    BYTE bytes[14]; stance_jump(bytes, target); write_code(where, bytes, sizeof(bytes));
}
static void fresh(void) {
    reboot_clear(); InterlockedExchange(&reboot_enabled, 1);
    *(BYTE **)(game + 0x382a0) = context; *(BYTE **)(context + 0x780) = actor;
    *(BYTE **)(game + 0x37680) = flags_context; *(BYTE **)(flags_context + 0x1710) = flags_owner;
    *(BYTE **)(game + 0x382d8) = team_view; *(unsigned int *)(game + 0x382d0) = 0;
    game[0x38951] = 1;
    *(unsigned int *)(mode + 0x28) = 1;
    *(uintptr_t *)actor = (uintptr_t)(image + 0x387fdb0);
    *(uintptr_t *)(actor + 0x310) = (uintptr_t)(image + 0x3800100);
    *(uint64_t *)(actor + 0x338) = *(uint64_t *)(actor + 0x1d8) = UINT64_C(0xf123456789abcdef);
    *(uint64_t *)(actor + 0x728) = UINT64_C(0xeabcdef012345678);
    *(uint64_t *)(actor + 0x3d8) = 0; /* Live BR evidence: this is NOT the GUID. */
    *(uintptr_t *)team_view = (uintptr_t)(image + 0x37ea5c8);
    *(uintptr_t *)normal_view = (uintptr_t)(image + 0x3800200);
    history[0x438] = 1; history[0x439] = 0;
    flags_owner[0x108fc] = 0xa9; /* Preserve 0xa1, remove exactly 0x08. */
    setter_calls = visible_calls = hidden_calls = event_calls = actor_calls = 0;
    native_dead = refuse_setter = expect_unfinished_event = 0; apply_dead = -1; wanted = 0x18;
}
static void apply_state(void) {
    ((reboot_actor_fn)(uintptr_t)(image + REBOOT_ACTOR_RVA))(actor);
}
/* Exercise the installed rel32 gate JMP with native BL/R15 and RBP+420,
 * preserving the native RSP alignment. Both continuations unwind this frame.
 */
static uintptr_t response(BYTE success) {
    BYTE code[] = {
        0x53,0x55,0x41,0x57, 0x48,0x81,0xec,0x50,0x04,0,0,
        0x48,0x89,0xe5,
        0x48,0xbb,0,0,0,0,0,0,0,0,
        0x49,0xbf,0,0,0,0,0,0,0,0,
        0x48,0xb8,0,0,0,0,0,0,0,0,
        0x48,0x89,0x85,0x20,0x04,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0
    };
    uint64_t raw = success, g = (uintptr_t)game;
    memcpy(code + 16, &raw, 8); memcpy(code + 26, &g, 8);
    memcpy(code + 36, actor + 0x728, 8);
    stance_jump(code + 51, image + REBOOT_RESPONSE_RVA);
    write_code(image + 0x2000, code, sizeof(code));
    return ((uintptr_t (*)(void))(uintptr_t)(image + 0x2000))();
}
int main(void) {
    DWORD old; MEMORY_BASIC_INFORMATION mem;
    image = VirtualAlloc(NULL, 0x4800000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    game = calloc(1, 0x39000); context = calloc(1, 0x1000); actor = calloc(1, 0x11000);
    flags_context = calloc(1, 0x1800); flags_owner = calloc(1, 0x11000);
    history = VirtualAlloc(NULL, 0x1000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    mode = calloc(1, 0x40);
    team_view = calloc(1, 0x100); normal_view = calloc(1, 0x100);
    assert(image && game && context && actor && flags_context && flags_owner && history && team_view && normal_view && mode);
    *(BYTE **)(image + 0x476dc08) = game; *(BYTE **)(image + 0x476e6b8) = history;
    *(BYTE **)(image + 0x476e308) = mode;
    *(uintptr_t *)(image + 0x387fdb0 + 0x380) = (uintptr_t)(image + 0xadd55);
    *(uintptr_t *)(image + 0x3800100 + 0xb0) = (uintptr_t)(image + 0x3000);
    *(uintptr_t *)(image + 0x3800200 + 8) = (uintptr_t)(image + 0x3100);
    memcpy(image + REBOOT_ACTOR_RVA, reboot_actor_guard, sizeof(reboot_actor_guard));
    /* Resume at the genuine SUB RSP128, undo it, then unwind exactly the eight
     * copied pushes and tail-call the native state-consumer stand-in. */
    const BYTE tail[] = {0x48,0x81,0xec,0x28,0x01,0,0,0x48,0x81,0xc4,0x28,0x01,0,0,
        0x41,0x5f,0x41,0x5e,0x41,0x5d,0x41,0x5c,0x5f,0x5e,0x5b,0x5d};
    memcpy(image + REBOOT_ACTOR_RVA + 18, tail, sizeof(tail));
    stance_jump(image + REBOOT_ACTOR_RVA + 18 + sizeof(tail), (const void *)(uintptr_t)native_actor);
    memcpy(image + REBOOT_RESPONSE_RVA, reboot_response_guard, sizeof(reboot_response_guard));
    memcpy(image + 0xee0f20, reboot_selector_guard, sizeof(reboot_selector_guard));
    memcpy(image + 0xf71710, reboot_setter_guard, sizeof(reboot_setter_guard));
    memcpy(image + 0x10876b0, reboot_hidden_guard, sizeof(reboot_hidden_guard));
    assert(VirtualProtect(image, 0x4800000, PAGE_EXECUTE_READ, &old));
    assert(FlushInstructionCache(GetCurrentProcess(), image, 0x4800000));
    reboot_install(image); assert(reboot_enabled && reboot_original_actor);
    assert(VirtualQuery(image + REBOOT_ACTOR_RVA, &mem, sizeof(mem)) == sizeof(mem) && mem.Protect == PAGE_EXECUTE_READ);
    forward(image + 0xee0f20, (const void *)(uintptr_t)native_select);
    forward(image + 0xf71710, (const void *)(uintptr_t)native_set);
    forward(image + 0x10876b0, (const void *)(uintptr_t)native_hidden);
    forward(image + 0xadd55, (const void *)(uintptr_t)native_visible);
    forward(image + 0x3000, (const void *)(uintptr_t)native_is_dead);
    forward(image + 0x3100, (const void *)(uintptr_t)native_view_type);
    BYTE event_tail[] = {
        0xb9,11,0,0,0,0xba,22,0,0,0,0x41,0xb8,33,0,0,0,0x41,0xb9,44,0,0,0,
        0x48,0xb8,0,0,0,0,0,0,0,0,0xff,0xd0,
        0x48,0x81,0xc4,0x50,0x04,0,0,0x41,0x5f,0x5d,0x5b,0xc3
    };
    uintptr_t event_target = (uintptr_t)native_event;
    memcpy(event_tail + 24, &event_target, sizeof(event_target));
    write_code(image + 0xef4e05, event_tail, sizeof(event_tail));
    const BYTE skip_tail[] = {0x31,0xc0,0x48,0x81,0xc4,0x50,0x04,0,0,0x41,0x5f,0x5d,0x5b,0xc3};
    write_code(image + 0xef4e6d, skip_tail, sizeof(skip_tail));
    fresh(); assert(response(1) == 0 && event_calls == 0 && reboot_pending.game == game);
    native_dead = 1; apply_dead = 0; /* Only the original consumer makes this alive. */
    apply_state(); assert(actor_calls == 1 && setter_calls == 1 && hidden_calls == 1 && visible_calls == 1);
    assert(flags_owner[0x108fc] == 0xa1 && !reboot_pending.game);
    apply_state(); assert(setter_calls == 1); /* idempotent */
    fresh(); assert(response(0) == 0); apply_state(); assert(!setter_calls && !reboot_pending.game && !event_calls);
    /* Native 5c08(false) publishes UI fields but leaves death latches at one.
     * Only the authenticated local-success response resets these two bytes,
     * before the optional stock Lua event. Preserve every other history byte.
     */
    fresh(); memset(history, 0x5a, 0x500); history[0x438] = history[0x439] = 1;
    game[0x38951] = 0; expect_unfinished_event = 1; response(1);
    for (unsigned int i = 0; i < 0x500; ++i)
        assert(history[i] == ((i == 0x438 || i == 0x439) ? 0 : 0x5a));
    assert(reboot_pending.history == history); apply_state(); assert(setter_calls == 1);
    fresh(); history[0x438] = history[0x439] = 1; response(0); apply_state();
    assert(!setter_calls && !reboot_pending.game && history[0x438] == 1 && history[0x439] == 1);
    fresh(); history[0x438] = history[0x439] = 1; *(uintptr_t *)team_view = 0; response(1);
    assert(!reboot_pending.game && history[0x438] == 1 && history[0x439] == 1);
    fresh(); history[0x438] = history[0x439] = 1; reboot_arm(1, game + 8, UINT64_C(0xeabcdef012345678));
    assert(!reboot_pending.game && history[0x438] == 1 && history[0x439] == 1);
    fresh(); history[0x438] = 2; response(1); apply_state(); assert(!setter_calls && !reboot_pending.game && history[0x438] == 2);
    fresh(); history[0x439] = 2; response(1); apply_state(); assert(!setter_calls && !reboot_pending.game && history[0x439] == 2);
    fresh(); history[0x438] = history[0x439] = 1;
    assert(VirtualProtect(history, 0x1000, PAGE_READONLY, &old)); response(1);
    assert(!reboot_pending.game && history[0x438] == 1 && history[0x439] == 1);
    assert(VirtualProtect(history, 0x1000, old, &old));
    fresh(); response(1);
    BYTE *other_history = VirtualAlloc(NULL, 0x1000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(other_history); write_code(image + 0x476e6b8, (BYTE *)&other_history, sizeof(other_history));
    apply_state(); assert(!setter_calls && !reboot_pending.game);
    write_code(image + 0x476e6b8, (BYTE *)&history, sizeof(history)); VirtualFree(other_history, 0, MEM_RELEASE);
    fresh(); *(uintptr_t *)team_view = 0; response(1); apply_state(); assert(!setter_calls && !reboot_pending.game);
    fresh(); response(1); native_dead = 1; apply_state(); assert(!setter_calls && reboot_pending.game);
    apply_dead = 0; apply_state(); assert(setter_calls == 1);
    fresh(); response(1); native_dead = 1; apply_state(); assert(!setter_calls && flags_owner[0x108fc] == 0xa9);
    native_dead = 0; apply_state(); assert(setter_calls == 1);
    fresh(); response(1); wanted = 0x15; apply_state(); assert(!setter_calls && flags_owner[0x108fc] == 0xa9 && reboot_pending.game);
    wanted = 0x13; apply_state(); assert(setter_calls == 1);
    fresh(); response(1); *(unsigned int *)(game + 0x382d0) = 1; apply_state(); assert(!setter_calls);
    fresh(); response(1); reboot_after_actor(actor + 8); assert(!setter_calls);
    fresh(); response(1); *(uint64_t *)(actor + 0x338) += 1; apply_state(); assert(!setter_calls && !reboot_pending.game);
    fresh(); response(1); *(uint64_t *)(actor + 0x728) += 1; apply_state(); assert(!setter_calls && !reboot_pending.game);
    fresh(); response(1); *(BYTE **)(context + 0x780) = NULL; apply_state(); assert(!setter_calls && !reboot_pending.game);
    fresh(); response(1); *(BYTE **)(flags_context + 0x1710) = NULL; apply_state(); assert(!setter_calls && !reboot_pending.game);
    fresh(); response(1); history[0x438] = 1; apply_state(); assert(!setter_calls && !reboot_pending.game);
    fresh(); response(1); reboot_pending.until = 0; apply_state(); assert(!setter_calls && !reboot_pending.game);
    fresh(); response(1); InterlockedExchange(&reboot_enabled, 0); apply_state(); assert(!setter_calls && !reboot_pending.game);
    fresh(); response(1); refuse_setter = 1; apply_state(); assert(setter_calls == 1 && !visible_calls && !hidden_calls && !reboot_pending.game && flags_owner[0x108fc] == 0xa9);
    fresh(); response(1); refuse_setter = 2; apply_state(); assert(setter_calls == 1 && !visible_calls && !hidden_calls && !reboot_pending.game && flags_owner[0x108fc] == 0xa9);
    fresh(); *(uintptr_t *)team_view = (uintptr_t)(image + 0x37eac30); flags_owner[0x108fc] = 0xb9;
    response(1); wanted = 1; apply_state(); assert(setter_calls == 1 && flags_owner[0x108fc] == 0xa1);
    /* No SPECTATE click: DeathCam leaves the two spectator bits and hidden
     * reason zero untouched. Native Exit handles its own death-camera state.
     */
    fresh(); *(uintptr_t *)team_view = (uintptr_t)(image + 0x37e41d8); flags_owner[0x108fc] = 0xa1;
    assert(response(1) == 0 && !event_calls && !history[0x438]);
    native_dead = 1; apply_state(); assert(!setter_calls && reboot_pending.game);
    native_dead = 0; apply_state();
    assert(setter_calls == 1 && visible_calls == 1 && !hidden_calls && flags_owner[0x108fc] == 0xa1);
    fresh(); history[0x438] = 0; assert(response(1) == 0);
    assert(!event_calls && !reboot_pending.game && !history[0x438]); /* KO/live is not terminal death. */
    fresh(); assert(!reboot_response(game, 1, UINT64_C(0xeabcdef012345679)));
    assert(!reboot_pending.game && history[0x438] == 1);
    fresh(); *(uint64_t *)(actor + 0x1d8) ^= 1; assert(response(1) == 0);
    assert(!reboot_pending.game && history[0x438] == 1);
    fresh(); game[0x38951] = 0; assert(response(0) == 0x12345678);
    assert(event_calls == 1 && !reboot_pending.game && history[0x438] == 1);
    fresh(); game[0x38951] = 0; expect_unfinished_event = 1;
    assert(response(1) == 0x12345678 && event_calls == 1 && reboot_pending.game);
    apply_state(); assert(setter_calls == 1);
    fresh(); *(uintptr_t *)team_view = (uintptr_t)(image + 0x37e41d8); flags_owner[0x108fc] = 0xa1;
    game[0x38951] = 0; expect_unfinished_event = 1; assert(response(1) == 0x12345678);
    apply_state(); assert(setter_calls == 1 && !hidden_calls && visible_calls == 1);
    fresh(); *(unsigned int *)(mode + 0x28) = 6; assert(response(1) == 0);
    assert(!event_calls && !reboot_pending.game && history[0x438] == 1); /* Training excluded. */
    game[0x38951] = 0; assert(response(1) == 0x12345678);
    assert(event_calls == 1 && !reboot_pending.game && history[0x438] == 1); /* Stock Training UI unchanged. */
    fresh(); response(1); *(unsigned int *)(mode + 0x28) = 6; apply_state();
    assert(!setter_calls && !reboot_pending.game);
    puts("Trio reboot camera: native x64 state-consumer trampoline/gate ABI and both original continuations, delayed alive transition applied by original consumer BEFORE restoration, local BR success and terminal death required, two latches reset with all other history preserved, distinct full actor/character IDs, TeamSpectate and DeathCam exits with both UIs, Training excluded, unchanged stock Lua event routing, rejection, expiry and no DeathCam fallback passed.");
    return 0;
}
