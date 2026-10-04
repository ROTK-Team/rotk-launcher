/* PS3 stance v17. Runs on the game's actor thread, never a polling thread.
 * Owns only idle RVA 1659000 (15 bytes) and console call F4341D (5 bytes).
 * ROTKConsole feeds the debug-console query; console_gate.h opens it for all.
 * Crouch/Vivox/Steam and the existing CanSprint v3 edits are independent.
 * Removing the marker disables behavior; restart removes every native hook.
 */
#include <tlhelp32.h>

typedef void (*stance_idle_fn)(BYTE *);
typedef uintptr_t (*stance_query_fn)(uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t);
static BYTE *stance_base;
static stance_idle_fn stance_original_idle;
static volatile LONG stance_enabled;
static BYTE *stance_last_actor;
static BOOL stance_initialized, stance_pressed;
static BYTE *stance_rule_cache, *stance_rule_node, *stance_rule_value;
static unsigned long stance_toggles;

static BOOL stance_read(const void *p, void *out, SIZE_T size) {
    SIZE_T done = 0;
    return p != NULL && ReadProcessMemory(GetCurrentProcess(), p, out, size, &done) && done == size;
}
static uintptr_t stance_ptr(const void *p) {
    uintptr_t n = 0; (void)stance_read(p, &n, sizeof(n)); return n;
}
static uint32_t stance_u32(const void *p) {
    uint32_t n = 0; (void)stance_read(p, &n, sizeof(n)); return n;
}
static uint32_t stance_hash(const char *s) {
    uint32_t h = 0;
    while (*s) { h = (h + (unsigned char)*s++) * 1025U; h ^= (uint32_t)((int32_t)h >> 6); }
    h *= 9U; h ^= (uint32_t)((int32_t)h >> 11); return h * 32769U;
}
static BOOL stance_name(BYTE *node, const char *name) {
    char text[64]; SIZE_T length = strlen(name);
    return length < sizeof(text) && stance_u32(node + 0x10) == length &&
        stance_read((void *)stance_ptr(node + 8), text, length) && memcmp(text, name, length) == 0;
}
static BYTE *stance_context_action(BYTE *manager, const char *context_name, const char *name) {
    BYTE *context; unsigned int i, j; uintptr_t count; BYTE *table, *action;
    if (!manager) return NULL;
    context = (BYTE *)stance_ptr(manager + 0x2d8 + (stance_hash(context_name) & 1023U) * 8U);
    for (i = 0; i < 128 && context; ++i, context = (BYTE *)stance_ptr(context + 0xb8)) {
        if (!stance_name(context, context_name)) continue;
        count = stance_ptr(context + 0x88);
        if (!count || count > 65536 || (count & (count - 1))) return NULL;
        table = (BYTE *)stance_ptr(context + 0x80);
        if (!table) return NULL;
        action = (BYTE *)stance_ptr(table + (stance_hash(name) & (count - 1)) * 8);
        for (j = 0; j < 128 && action; ++j, action = (BYTE *)stance_ptr(action + 0x188))
            if (stance_name(action, name)) return action + 0x18;
        return NULL;
    }
    return NULL;
}
static BYTE *stance_action(BYTE *manager, const char *name) {
    return stance_context_action(manager, "Generic", name);
}
static BOOL stance_action_pressed(BYTE *action) {
    BYTE flags = 0;
    return action && stance_read(action + 0x118, &flags, 1) && (flags & 1);
}
/* Re-resolve allocations every tick/zone; never write to a retained stale string. */
static void stance_sprint_rule(BOOL enable) {
    BYTE *cache = (BYTE *)stance_ptr(stance_base + 0x476dc38), *table, *node, *value;
    uintptr_t count; unsigned int i; char text[2]; MEMORY_BASIC_INFORMATION info;
    if (!cache) return;
    count = stance_ptr(cache + 0x70); table = (BYTE *)stance_ptr(cache + 0x68);
    if (!table || !count || count > 1048576 || (count & (count - 1))) return;
    node = (BYTE *)stance_ptr(table + (0x6cbaedc9U & (count - 1)) * 8);
    for (i = 0; node && i < 128; ++i, node = (BYTE *)stance_ptr(node + 0xa8)) {
        if (stance_u32(node) != 0x6cbaedc9U) continue;
        value = (BYTE *)stance_ptr(node + 0x10);
        if (!value || !stance_read(value, text, 2) || text[1] != 0) return;
        if (!enable) {
            if (cache == stance_rule_cache && node == stance_rule_node && value == stance_rule_value && text[0] == '0') {
                if (VirtualQuery(value, &info, sizeof(info)) == sizeof(info) && info.Protect == PAGE_READWRITE)
                    *value = '1';
            }
            stance_rule_cache = stance_rule_node = stance_rule_value = NULL;
            return;
        }
        if (text[0] != '1' || stance_u32(value - 4) != 1) return;
        if (VirtualQuery(value, &info, sizeof(info)) != sizeof(info) || info.Protect != PAGE_READWRITE) return;
        /* Only once per new zone allocation, not every frame. */
        for (uintptr_t k = 0; k < count; ++k) {
            BYTE *other = (BYTE *)stance_ptr(table + k * 8);
            for (unsigned int j = 0; other && j < 128; ++j, other = (BYTE *)stance_ptr(other + 0xa8))
                if (other != node && (BYTE *)stance_ptr(other + 0x10) == value) return;
        }
        *value = '0'; stance_rule_cache = cache; stance_rule_node = node; stance_rule_value = value;
        patch_log("ROTK stance: private sprint rule set to 0.\n"); return;
    }
}
static void stance_set(BYTE *actor, int value) {
    typedef void (*setter_fn)(BYTE *, int, BYTE, BYTE);
    uintptr_t vt = stance_ptr(actor), target = stance_ptr((void *)(vt + 0x4d8));
    if (target == (uintptr_t)(stance_base + 0x7a2de)) ((setter_fn)target)(actor, value, 1, 0);
}
static void stance_idle(BYTE *actor) {
    typedef void *(*focus_fn)(BYTE *, unsigned int);
    BYTE *game, *ui, *manager, *action; DWORD pid = 0; int raw; BOOL pressed, fire, aim;
    if (!InterlockedCompareExchange(&stance_enabled, 0, 0)) {
        stance_sprint_rule(FALSE); stance_original_idle(actor); return;
    }
    if (stance_ptr(actor) != (uintptr_t)(stance_base + 0x387fdb0)) { stance_original_idle(actor); return; }
    if (actor != stance_last_actor) {
        stance_last_actor = actor; stance_initialized = FALSE; stance_pressed = FALSE;
    }
    stance_sprint_rule(TRUE);
    game = (BYTE *)stance_ptr(stance_base + 0x476dc08);
    if (!game) return;
    ui = (BYTE *)stance_ptr(game + 0x384d8);
    if (!ui) return;
    GetWindowThreadProcessId(GetForegroundWindow(), &pid);
    if (pid != GetCurrentProcessId() || ((focus_fn)(stance_base + 0x1c138e0))(ui, stance_u32(ui + 0x340))) {
        stance_pressed = FALSE; return;
    }
    manager = (BYTE *)stance_ptr(game + 0x382c8); action = stance_action(manager, "ToggleWeaponStance");
    pressed = stance_action_pressed(action);
    /* Use the engine's Infantry actions, including remaps/gamepad triggers.
     * A missing context must not fall back to unrelated physical mouse keys. */
    fire = stance_action_pressed(stance_context_action(manager, "Infantry", "Fire"));
    aim = stance_action_pressed(stance_context_action(manager, "Infantry", "SecondaryFire"));
    raw = (int)stance_u32(actor + 0x9a0);
    if (!stance_initialized && (raw == 1 || raw == 2)) stance_initialized = TRUE;
    if ((fire || aim) && (raw == 0 || raw == -1)) {
        stance_set(actor, 1); stance_initialized = TRUE;
    } else if (!stance_initialized && stance_u32(actor + 0x1090) == 0 && raw != 1) {
        stance_set(actor, 1); stance_initialized = TRUE;
    } else if (!fire && !aim && stance_initialized && pressed && !stance_pressed) {
        stance_set(actor, raw == 1 ? 0 : 1); ++stance_toggles;
        if (stance_toggles <= 10) patch_log("ROTK stance: native binding toggled.\n");
    }
    stance_pressed = pressed;
}
static uintptr_t stance_console(uintptr_t manager, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f) {
    uintptr_t original = ((stance_query_fn)(stance_base + 0x11b81c0))(manager, b, c, d, e, f);
    if (InterlockedCompareExchange(&stance_enabled, 0, 0)) {
        BYTE *action = stance_action((BYTE *)manager, "ROTKConsole");
        if (stance_action_pressed(action)) return (uintptr_t)action;
    }
    return original;
}
static void stance_jump(BYTE *out, const void *target) {
    uintptr_t address = (uintptr_t)target;
    out[0] = 0xff; out[1] = 0x25; memset(out + 2, 0, 4); memcpy(out + 6, &address, 8);
}
/* The main thread must never execute a half-written multi-byte branch. All
 * handles are opened before suspension; failures resume every suspended thread.
 * Refuse when any instruction pointer is inside either overwrite window. */
static BOOL stance_commit(BYTE *idle, const BYTE *old_idle, const BYTE *new_idle,
                          BYTE *call, const BYTE *old_call, const BYTE *new_call) {
    HANDLE handles[256], snapshot; unsigned int count = 0, stopped = 0, i; THREADENTRY32 row;
    DWORD self = GetCurrentThreadId(), process = GetCurrentProcessId(), p1 = 0, p2 = 0;
    BOOL ok = FALSE, idle_writable = FALSE, call_writable = FALSE;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return FALSE;
    row.dwSize = sizeof(row);
    if (!Thread32First(snapshot, &row)) { CloseHandle(snapshot); return FALSE; }
    do {
        if (row.th32OwnerProcessID != process || row.th32ThreadID == self) continue;
        if (count == ARRAYSIZE(handles)) goto close_handles;
        handles[count] = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT, FALSE, row.th32ThreadID);
        if (!handles[count]) goto close_handles;
        ++count;
    } while (Thread32Next(snapshot, &row));
    CloseHandle(snapshot); snapshot = INVALID_HANDLE_VALUE;
    for (i = 0; i < count; ++i) {
        CONTEXT context; memset(&context, 0, sizeof(context)); context.ContextFlags = CONTEXT_CONTROL;
        if (SuspendThread(handles[i]) == (DWORD)-1) goto resume_threads;
        ++stopped;
        if (!GetThreadContext(handles[i], &context) ||
            (context.Rip >= (uintptr_t)idle && context.Rip < (uintptr_t)idle + 15) ||
            (context.Rip >= (uintptr_t)call && context.Rip < (uintptr_t)call + 5)) goto resume_threads;
    }
    if (!exact_bytes(idle, old_idle, 15) || !exact_bytes(call, old_call, 5)) goto resume_threads;
    idle_writable = VirtualProtect(idle, 15, PAGE_EXECUTE_READWRITE, &p1);
    call_writable = VirtualProtect(call, 5, PAGE_EXECUTE_READWRITE, &p2);
    if (idle_writable && call_writable) {
        memcpy(idle, new_idle, 15); memcpy(call, new_call, 5);
        ok = FlushInstructionCache(GetCurrentProcess(), idle, 15) && FlushInstructionCache(GetCurrentProcess(), call, 5);
        if (!ok) { memcpy(idle, old_idle, 15); memcpy(call, old_call, 5); FlushInstructionCache(GetCurrentProcess(), NULL, 0); }
    }
    if (idle_writable && !restore_page_protection(idle, 15, p1)) ok = FALSE;
    if (call_writable && !restore_page_protection(call, 5, p2)) ok = FALSE;
resume_threads:
    while (stopped) ResumeThread(handles[--stopped]);
close_handles:
    if (snapshot != INVALID_HANDLE_VALUE) CloseHandle(snapshot);
    while (count) CloseHandle(handles[--count]);
    return ok;
}
#include "weapon_stance_guards.h"
static void stance_install(BYTE *base) {
    BYTE *memory = NULL, idle_jump[15], call_jump[5]; DWORD old; int32_t displacement;
    SYSTEM_INFO info;
    if (!stance_guards_ready(base)) { patch_log("ROTK stance: guard mismatch; skipped.\n"); return; }
    GetSystemInfo(&info);
    /* Keep the console CALL rel32; bridge contains an absolute tail jump. */
    for (uintptr_t delta = 0x08000000; delta < 0x70000000 && !memory; delta += info.dwAllocationGranularity)
        memory = VirtualAlloc(base + delta, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!memory) { patch_log("ROTK stance: bridge allocation refused.\n"); return; }
    memcpy(memory, base + 0x1659000, 15); stance_jump(memory + 15, base + 0x165900f);
    stance_jump(memory + 64, (void *)(uintptr_t)stance_console);
    if (!VirtualProtect(memory, 4096, PAGE_EXECUTE_READ, &old) || !FlushInstructionCache(GetCurrentProcess(), memory, 4096)) {
        VirtualFree(memory, 0, MEM_RELEASE); return;
    }
    stance_base = base; stance_original_idle = (stance_idle_fn)(uintptr_t)memory;
    memset(idle_jump, 0x90, sizeof(idle_jump)); stance_jump(idle_jump, (void *)(uintptr_t)stance_idle);
    call_jump[0] = 0xe8; displacement = (int32_t)((memory + 64) - (base + 0xf43422)); memcpy(call_jump + 1, &displacement, 4);
    if (!stance_commit(base + 0x1659000, memory, idle_jump, base + 0xf4341d, stance_console_call_guard, call_jump)) {
        /* Do not free a bridge which may have become visible if protection
         * restoration failed. Disabled wrappers safely call the native path. */
        patch_log("ROTK stance: guarded installation refused; disabled.\n"); return;
    }
    InterlockedExchange(&stance_enabled, 1);
    patch_log("ROTK stance: native v17 idle and console installed.\n");
}
