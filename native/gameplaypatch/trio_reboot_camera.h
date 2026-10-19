/* BR1315: restore the native player controller after an authoritative reboot.
 * e9/0b is NOT an in-match exit: it returns to character select. Instead use
 * the same selector/setter as CameraRestore, after the native state queue is
 * applied. Packet acceptance alone precedes its deferred KO-bit transition.
 * All callbacks run on the original packet/actor thread, never the watchdog.
 */
#define REBOOT_ACTOR_RVA 0x01078c60U
#define REBOOT_ACTOR_STOLEN 18U
#define REBOOT_RESPONSE_RVA 0x00ef4dfbU
#define REBOOT_RESPONSE_STOLEN 10U
#define REBOOT_RETRY_MS 250U
static const BYTE reboot_actor_guard[] = {
    0x40,0x55,0x53,0x56,0x57,0x41,0x54,0x41,0x55,0x41,0x56,0x41,0x57,
    0x48,0x8d,0x6c,0x24,0xd8,0x48,0x81,0xec,0x28,0x01,0x00,0x00
};
static const BYTE reboot_response_guard[] = {
    0x41,0x80,0xbf,0x51,0x89,0x03,0x00,0x00,0x75,0x68,
    0x4c,0x89,0xad,0x38,0x0c,0x00,0x00,0x4c,0x89,0xad,0x40,0x0c,0x00,0x00
};
static const BYTE reboot_selector_guard[] = {
    0x40,0x53,0x48,0x83,0xec,0x20,0x48,0x8b,0x81,0x80,0x76,0x03,
    0x00,0x48,0x8b,0xd9,0x48,0x85,0xc0,0x74,0x37
};
static const BYTE reboot_setter_guard[] = {
    0x40,0x53,0x48,0x83,0xec,0x40,0x48,0x8b,0xd9,0x83,0xfa,0x18,
    0x75,0x33,0x48,0x8b,0x81,0x80,0x76,0x03,0x00
};
static const BYTE reboot_hidden_guard[] = {
    0x40,0x53,0x56,0x57,0x41,0x56,0x48,0x83,0xec,0x28,
    0x41,0xb9,0x07,0x00,0x00,0x00
};
/* UIBindingMatch.GetMatchId at 1416d5100 reads the full u64 at history+3d8.
 * Validate that reader too: a reused history allocation is not the same match. */
static const BYTE reboot_match_guard[] = {
    0x48,0x8b,0x05,0x80,0x95,0x09,0x03,0x48,0x85,0xc0,0x74,0x22,
    0x4c,0x8b,0x80,0xd8,0x03,0x00,0x00
};
typedef void (*reboot_actor_fn)(BYTE *);
static BYTE *reboot_base;
static reboot_actor_fn reboot_original_actor;
static volatile LONG reboot_enabled;
static unsigned int reboot_reports;
static struct {
    BYTE *game, *context, *actor, *flags_owner, *history, *mode;
    uint64_t actor_id, character, match;
    BOOL team_hidden, applying;
    ULONGLONG next_attempt;
    unsigned int reasons;
} reboot_pending;

static void reboot_clear(void) { memset(&reboot_pending, 0, sizeof(reboot_pending)); }
static void reboot_report(const char *text) {
    if (reboot_reports < 24U) { ++reboot_reports; patch_log(text); }
}
static void reboot_note(unsigned int reason, const char *text) {
    if (!(reboot_pending.reasons & reason)) {
        reboot_pending.reasons |= reason; reboot_report(text);
    }
}
static BOOL reboot_byte(const void *p, BYTE *value) { return stance_read(p, value, 1); }
static BOOL reboot_data_byte(BYTE *p) {
    MEMORY_BASIC_INFORMATION m;
    return p && VirtualQuery(p, &m, sizeof(m)) == sizeof(m) && m.State == MEM_COMMIT &&
        !(m.Protect & (PAGE_GUARD | PAGE_NOACCESS)) &&
        (m.Protect == PAGE_READWRITE || m.Protect == PAGE_WRITECOPY ||
         m.Protect == PAGE_EXECUTE_READWRITE || m.Protect == PAGE_EXECUTE_WRITECOPY);
}
static uintptr_t reboot_virtual(BYTE *object, SIZE_T slot) {
    uintptr_t vt = stance_ptr(object), fn;
    if (vt < (uintptr_t)(reboot_base + 0x36a0000) || vt >= (uintptr_t)(reboot_base + 0x6b35000)) return 0;
    fn = stance_ptr((void *)(vt + slot));
    return fn >= (uintptr_t)(reboot_base + 0x1000) && fn < (uintptr_t)(reboot_base + 0x36a0000) ? fn : 0;
}
static unsigned int reboot_team_type(BYTE *view) {
    uintptr_t vt = stance_ptr(view);
    if (vt == (uintptr_t)(reboot_base + 0x37ea5c8)) return 0x1e;
    if (vt == (uintptr_t)(reboot_base + 0x37eac30)) return 0x1b;
    return 0;
}
static unsigned int reboot_dead_type(BYTE *view) {
    unsigned int team = reboot_team_type(view);
    if (team) return team;
    return stance_ptr(view) == (uintptr_t)(reboot_base + 0x37e41d8) ? 0x15 : 0;
}
static BOOL reboot_unfinished(void) {
    BYTE flags[2]; BYTE *history = (BYTE *)stance_ptr(reboot_base + 0x476e6b8);
    return history && stance_read(history + 0x438, flags, sizeof(flags)) && !flags[0] && !flags[1];
}
/* Same source as UIBindingSystem.IsBattleRoyale (1416b6c50): enum1 is BR,
 * enum6 is Training (1416b7040). UseNewUI and ClientRunState are NOT modes.
 */
static BYTE *reboot_br_mode(void) {
    BYTE *mode = (BYTE *)stance_ptr(reboot_base + 0x476e308);
    return mode && stance_u32(mode + 0x28) == 1 ? mode : NULL;
}
/* An accepted next life outlives a frame stall or a death -> teammate camera
 * change. Its lifetime ends on a new death, match/history/mode/identity change,
 * patch disable, or a verified player camera. Never time out a paid respawn. */
static BOOL reboot_same_life(void) {
    BYTE *game = (BYTE *)stance_ptr(reboot_base + 0x476dc08);
    BYTE *context = game ? (BYTE *)stance_ptr(game + 0x382a0) : NULL;
    BYTE *owner = game ? (BYTE *)stance_ptr(game + 0x37680) : NULL;
    owner = owner ? (BYTE *)stance_ptr(owner + 0x1710) : NULL;
    return reboot_pending.game && InterlockedCompareExchange(&reboot_enabled, 0, 0) &&
        game == reboot_pending.game && context == reboot_pending.context &&
        owner == reboot_pending.flags_owner &&
        (BYTE *)stance_ptr(reboot_base + 0x476e6b8) == reboot_pending.history &&
        (uint64_t)stance_ptr(reboot_pending.history + 0x3d8) == reboot_pending.match &&
        reboot_br_mode() == reboot_pending.mode && context &&
        (BYTE *)stance_ptr(context + 0x780) == reboot_pending.actor && reboot_unfinished() &&
        stance_ptr(reboot_pending.actor) == (uintptr_t)(reboot_base + 0x387fdb0) &&
        (uint64_t)stance_ptr(reboot_pending.actor + 0x338) == reboot_pending.actor_id &&
        (uint64_t)stance_ptr(reboot_pending.actor + 0x1d8) == reboot_pending.actor_id &&
        (uint64_t)stance_ptr(reboot_pending.actor + 0x728) == reboot_pending.character;
}
static BOOL reboot_player_type(unsigned int type) {
    return type == 1 || type == 0x13 || type == 0x18;
}
static unsigned int reboot_view_type(BYTE *view) {
    uintptr_t fn = view ? reboot_virtual(view, 8) : 0;
    return fn ? ((unsigned int (*)(BYTE *))fn)(view) : 0;
}
/* The response gate is reached only after native parsing and its local
 * owner check. UseNewUI (game+38951) skips the stock UI response event.
 * The bridge supplies R15, BL and the parsed character ID at RBP+420.
 * Snapshot identities, not a retained pointer to an allocation's mutable byte.
 */
static BOOL reboot_arm(BYTE success, BYTE *game, uint64_t character) {
    BYTE *context, *actor, *owner, *view, *history, *mode; BYTE flags, finished[2];
    uint64_t actor_id, match;
    if (!InterlockedCompareExchange(&reboot_enabled, 0, 0) || success != 1 || !game ||
        game != (BYTE *)stance_ptr(reboot_base + 0x476dc08)) return FALSE;
    /* A second reply must not erase the first accepted life after its two
     * history latches were cleared. Invalid/rejected replies grant nothing. */
    if (reboot_pending.applying) return FALSE;
    if (reboot_same_life() && character == reboot_pending.character) return TRUE;
    mode = reboot_br_mode();
    if (!mode) return FALSE;
    context = (BYTE *)stance_ptr(game + 0x382a0);
    actor = context ? (BYTE *)stance_ptr(context + 0x780) : NULL;
    owner = (BYTE *)stance_ptr(game + 0x37680);
    owner = owner ? (BYTE *)stance_ptr(owner + 0x1710) : NULL;
    view = (BYTE *)stance_ptr(game + 0x382d8);
    if (!actor || stance_ptr(actor) != (uintptr_t)(reboot_base + 0x387fdb0) || !owner ||
        !reboot_byte(owner + 0x108fc, &flags)) {
        reboot_report("ROTK trio reboot: response refused (local actor guard).\n"); return FALSE;
    }
    actor_id = (uint64_t)stance_ptr(actor + 0x338);
    if (!actor_id || actor_id != (uint64_t)stance_ptr(actor + 0x1d8) ||
        !character || character != (uint64_t)stance_ptr(actor + 0x728)) {
        reboot_report("ROTK trio reboot: response refused (native actor/character identity).\n"); return FALSE;
    }
    history = (BYTE *)stance_ptr(reboot_base + 0x476e6b8);
    match = history ? (uint64_t)stance_ptr(history + 0x3d8) : 0;
    if (!match || !stance_read(history + 0x438, finished, sizeof(finished)) ||
        finished[0] != 1 || finished[1] > 1 ||
        !reboot_data_byte(history + 0x438) || !reboot_data_byte(history + 0x439)) {
        reboot_report("ROTK trio reboot: local respawn refused (match-history guard).\n");
        return FALSE;
    }
    /* 5c/08 publishes current booleans, but native 141ad2b30 only sets these
     * death-notification latches to one; packet false never clears them.
     * A parsed successful LOCAL BR 0f/2f with a prior terminal death and the
     * same dead/spectating actor authorizes a new life. Reset only two latches,
     * before the deferred alive transition. The in-game UI watches this
     * terminal-to-unfinished transition and waits for native alive/player
     * camera state; the Lua response event is not an AS3 notification. No
     * match data, scores, inventory or other history bytes are changed here.
     */
    reboot_clear();
    reboot_reports = 0;
    history[0x438] = history[0x439] = 0;
    reboot_pending.game = game; reboot_pending.context = context; reboot_pending.actor = actor;
    reboot_pending.flags_owner = owner; reboot_pending.history = history;
    reboot_pending.mode = mode;
    reboot_pending.actor_id = actor_id; reboot_pending.character = character;
    reboot_pending.match = match;
    /* Native e9/03 sets flags before the deferred camera is installed. They
     * are presentation, not authority for the authenticated next life. */
    reboot_pending.team_hidden = reboot_team_type(view) != 0 || (flags & 8) != 0;
    reboot_report("ROTK trio reboot: successful local respawn; camera reset armed.\n");
    return TRUE;
}
static BYTE reboot_response(BYTE *game, BYTE success, uint64_t character) {
    BYTE new_ui;
    if (!game || !reboot_byte(game + 0x38951, &new_ui)) return 0;
    reboot_arm(success, game, character);
    /* Preserve BOTH stock Lua paths. UI restoration observes the guarded
     * native latches and applied alive/controller state, not this Lua call.
     */
    return !new_ui ? 1 : 0;
}
static void reboot_after_actor(BYTE *actor) {
    BYTE *game, *owner, *view; BYTE flags, original_flags;
    uintptr_t is_dead, visibility; unsigned int desired, type;
    BOOL already_player;
    if (!reboot_pending.game || reboot_pending.applying) return;
    if (!reboot_same_life()) {
        reboot_report("ROTK trio reboot: pending cancelled (identity/state changed).\n"); reboot_clear(); return;
    }
    if (actor != reboot_pending.actor) return;
    game = reboot_pending.game; owner = reboot_pending.flags_owner;
    if (stance_u32(game + 0x382d0) != 0) { reboot_note(2, "ROTK trio reboot: waiting (native transition pending).\n"); return; }
    is_dead = reboot_virtual(actor + 0x310, 0xb0);
    visibility = reboot_virtual(actor, 0x380);
    if (!is_dead || visibility != (uintptr_t)(reboot_base + 0xadd55)) {
        reboot_note(4, "ROTK trio reboot: waiting (native actor guard mismatch).\n"); return;
    }
    if (((BYTE (*)(BYTE *))is_dead)(actor + 0x310)) {
        reboot_note(8, "ROTK trio reboot: waiting (native actor still dead).\n"); return;
    }
    view = (BYTE *)stance_ptr(game + 0x382d8); type = reboot_dead_type(view);
    already_player = !type && reboot_player_type(reboot_view_type(view));
    if (!type && !already_player) {
        reboot_note(64, "ROTK trio reboot: waiting (camera transition).\n"); return;
    }
    if (!reboot_byte(owner + 0x108fc, &flags) || !reboot_data_byte(owner + 0x108fc)) return;
    reboot_pending.team_hidden |= reboot_team_type(view) != 0 || (flags & 8) != 0;
    if (GetTickCount64() < reboot_pending.next_attempt) return;
    /* Inverse of e9/03 and e9/04. The recognized current camera may differ
     * from the one at the response; its flags may already be cleared. */
    original_flags = flags;
    owner[0x108fc] = (BYTE)(flags & 0xe7);
    if (already_player) goto restored;
    desired = ((unsigned int (*)(BYTE *))(uintptr_t)(reboot_base + 0xee0f20))(game);
    if (!reboot_player_type(desired)) {
        owner[0x108fc] = original_flags;
        reboot_note(32, "ROTK trio reboot: waiting (native selector not a player view).\n"); return;
    }
    /* Native Exit sends e9/05. Block re-entry without discarding the recovery
     * before the fallible setter has actually installed a player controller. */
    reboot_pending.applying = TRUE;
    ((void (*)(BYTE *, unsigned int))(uintptr_t)(reboot_base + 0xf71710))(game, desired);
    reboot_pending.applying = FALSE;
    if (!reboot_same_life()) { reboot_clear(); return; }
    view = (BYTE *)stance_ptr(game + 0x382d8);
    if (!reboot_player_type(reboot_view_type(view))) {
        /* Roll back only our two bits; a native call may change other flags. */
        if (reboot_byte(owner + 0x108fc, &flags) && reboot_data_byte(owner + 0x108fc))
            owner[0x108fc] = (BYTE)((flags & 0xe7) | (original_flags & 0x18));
        reboot_pending.next_attempt = GetTickCount64() + REBOOT_RETRY_MS;
        reboot_note(128, "ROTK trio reboot: camera setter deferred; retry pending.\n"); return;
    }
restored:
    /* TeamSpectator::Enter adds hidden reason zero independently of 0f/3e.
     * Invert that native call, preserving every other hidden reason, then
     * re-evaluate the model through the same virtual used by 0f/3e.
     */
    reboot_pending.applying = TRUE;
    if (reboot_pending.team_hidden)
        ((void (*)(BYTE *, BYTE, unsigned int))(uintptr_t)(reboot_base + 0x10876b0))(actor, 0, 0);
    ((void (*)(BYTE *))visibility)(actor);
    reboot_clear();
    reboot_report("ROTK trio reboot: native player camera and visibility restored.\n");
}
static void reboot_actor(BYTE *actor) {
    /* 141078c60 consumes the queue populated by 0f3f/0f0a, applies KO/death
     * bits and all their native side effects, then returns. Never execute
     * the consumer ourselves, force a state bit, or reset during its loop.
     */
    reboot_original_actor(actor);
    reboot_after_actor(actor);
}
/* Two native windows are committed while all other threads are suspended.
 * Neither window contains RIP-relative instructions in its displaced prologue.
 */
static BOOL reboot_commit(BYTE *base, const BYTE *actor_jump, const BYTE *response_call) {
    BYTE *actor = base + REBOOT_ACTOR_RVA, *call = base + REBOOT_RESPONSE_RVA;
    const thread_gate_window windows[] = {{actor, REBOOT_ACTOR_STOLEN}, {call, REBOOT_RESPONSE_STOLEN}};
    thread_gate gate;
    DWORD p1 = 0, p2 = 0;
    BOOL ok = FALSE, writable1 = FALSE, writable2 = FALSE;
    if (!thread_gate_freeze(&gate, "trio reboot", windows, ARRAYSIZE(windows))) return FALSE;
    if (exact_bytes(actor, reboot_actor_guard, sizeof(reboot_actor_guard)) &&
        exact_bytes(call, reboot_response_guard, sizeof(reboot_response_guard))) {
        writable1 = VirtualProtect(actor, REBOOT_ACTOR_STOLEN, PAGE_EXECUTE_READWRITE, &p1);
        writable2 = VirtualProtect(call, REBOOT_RESPONSE_STOLEN, PAGE_EXECUTE_READWRITE, &p2);
        if (writable1 && writable2) {
            memcpy(actor, actor_jump, REBOOT_ACTOR_STOLEN); memcpy(call, response_call, REBOOT_RESPONSE_STOLEN);
            ok = FlushInstructionCache(GetCurrentProcess(), actor, REBOOT_ACTOR_STOLEN) && FlushInstructionCache(GetCurrentProcess(), call, REBOOT_RESPONSE_STOLEN);
            if (!ok) {
                memcpy(actor, reboot_actor_guard, REBOOT_ACTOR_STOLEN);
                memcpy(call, reboot_response_guard, REBOOT_RESPONSE_STOLEN); FlushInstructionCache(GetCurrentProcess(), NULL, 0);
            }
        }
        if (writable1 && !restore_page_protection(actor, REBOOT_ACTOR_STOLEN, p1)) ok = FALSE;
        if (writable2 && !restore_page_protection(call, REBOOT_RESPONSE_STOLEN, p2)) ok = FALSE;
    }
    thread_gate_thaw(&gate);
    return ok;
}
static void reboot_install(BYTE *base) {
    BYTE *memory = NULL, actor_jump[REBOOT_ACTOR_STOLEN], call[REBOOT_RESPONSE_STOLEN]; DWORD old;
    int64_t distance; int32_t relative; uintptr_t callback = (uintptr_t)reboot_response;
    const BYTE bridge[] = {
        0x48,0x83,0xec,0x20, /* JMP entry: native RSP aligned, shadow space */
        0x4c,0x89,0xf9, 0x0f,0xb6,0xd3, /* RCX=R15, EDX=BL */
        0x4c,0x8b,0x85,0x20,0x04,0x00,0x00, /* R8=parsed character [RBP+420] */
        0x48,0xb8,0,0,0,0,0,0,0,0, 0xff,0xd0,
        0x48,0x83,0xc4,0x20, 0x84,0xc0, 0x75,0x0e,
        /* Two absolute JMP slots: stock skip and stock event fallthrough. */
        0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0
    };
    if (!exact_bytes(base + REBOOT_ACTOR_RVA, reboot_actor_guard, sizeof(reboot_actor_guard)) ||
        !exact_bytes(base + REBOOT_RESPONSE_RVA, reboot_response_guard, sizeof(reboot_response_guard)) ||
        !exact_bytes(base + 0xee0f20, reboot_selector_guard, sizeof(reboot_selector_guard)) ||
        !exact_bytes(base + 0xf71710, reboot_setter_guard, sizeof(reboot_setter_guard)) ||
        !exact_bytes(base + 0x10876b0, reboot_hidden_guard, sizeof(reboot_hidden_guard)) ||
        !exact_bytes(base + 0x16d5131, reboot_match_guard, sizeof(reboot_match_guard))) {
        patch_log("ROTK trio reboot: native signature mismatch; skipped.\n"); return;
    }
    memory = bridge_page(base);
    if (!memory) { bridge_refused("ROTK trio reboot", base); return; }
    memcpy(memory, reboot_actor_guard, REBOOT_ACTOR_STOLEN);
    stance_jump(memory + REBOOT_ACTOR_STOLEN, base + REBOOT_ACTOR_RVA + REBOOT_ACTOR_STOLEN);
    memcpy(memory + 64, bridge, sizeof(bridge)); memcpy(memory + 83, &callback, sizeof(callback));
    stance_jump(memory + 101, base + 0xef4e6d);
    stance_jump(memory + 115, base + 0xef4e05);
    distance = (int64_t)(uintptr_t)(memory + 64) - (int64_t)(uintptr_t)(base + REBOOT_RESPONSE_RVA + 5);
    if (distance < INT32_MIN || distance > INT32_MAX ||
        !VirtualProtect(memory, 4096, PAGE_EXECUTE_READ, &old) || !FlushInstructionCache(GetCurrentProcess(), memory, 4096)) {
        bridge_release(memory);
        patch_log("ROTK trio reboot: bridge out of reach or protection refused; skipped.\n"); return;
    }
    reboot_base = base; reboot_original_actor = (reboot_actor_fn)(uintptr_t)memory;
    memset(actor_jump, 0x90, sizeof(actor_jump)); stance_jump(actor_jump, (void *)(uintptr_t)reboot_actor);
    memset(call, 0x90, sizeof(call)); call[0] = 0xe9;
    relative = (int32_t)distance; memcpy(call + 1, &relative, 4);
    if (!reboot_commit(base, actor_jump, call)) {
        /* Keep the bridge alive if a protection-restoration error left a hook
         * installed. Disabled wrappers preserve the complete original path. */
        patch_log("ROTK trio reboot: guarded installation refused; disabled.\n"); return;
    }
    InterlockedExchange(&reboot_enabled, 1);
    patch_log("ROTK trio reboot: native response/alive camera restoration installed.\n");
}
