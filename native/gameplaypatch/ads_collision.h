/* The transition solver must measure the collision-resolved pose. A later
 * transverse camera escape otherwise invalidates its accepted aim angles.
 * Keep native geometry, filters, target, angle setters and rollback policy.
 */
#include "ads_step.h"

typedef void (*ads_solver_fn)(BYTE *, float *, float *, const float *, BYTE);
typedef float (*ads_rotation_fn)(BYTE *, const float *, float, BYTE);
typedef void (*ads_collision_fn)(BYTE *, float *, float *, float, BYTE);
static BYTE *ads_base;
static volatile LONG ads_enabled;
static _Thread_local BYTE *ads_solving_camera;
static _Thread_local float ads_last_progress;
static _Thread_local AdsStep *ads_step_context;
static RUNTIME_FUNCTION ads_unwind;
static const BYTE ads_call_guard[] = {
    0xe8,0x2e,0x40,0xd9,0xfe,0xc6,0x44,0x24,0x20,0x01,0x0f,0x57,0xdb,
    0x4c,0x8d,0x44,0x24,0x30,0x49,0x8b,0xd7,0x48,0x8b,0xcf,
    0xe8,0xb5,0xab,0xdd,0xfe
};
static const BYTE ads_eval_guard[] = {0x0f,0x10,0x9f,0x40,0x08,0x00,0x00};
static const BYTE ads_rotation_guard[] = {0xff,0x90,0x90,0x03,0x00,0x00};
static BOOL ads_active(BYTE *camera) {
    return InterlockedCompareExchange(&ads_enabled, 0, 0) &&
        *(uintptr_t *)camera == (uintptr_t)(ads_base + 0x37eb858) && camera[0x834];
}
static void ads_evaluate(BYTE *camera, float *eye, float *look, float progress) {
    if (camera == ads_solving_camera) {
        ads_last_progress = progress;
        if (progress == 1.0f) {
            typedef float (*yaw_fn)(BYTE *);
            typedef void (*pose_fn)(BYTE *, float, float *, float *, BYTE);
            float yaw = ((yaw_fn)(uintptr_t)(ads_base + 0x12bcc30))(camera);
            /* Use the published TP builder at completion: one float ULP from
             * the solver's redundant eye reconstruction can change a sweep.
             */
            ((pose_fn)(uintptr_t)(ads_base + 0x12ba300))(camera, yaw, eye, look, 0);
        }
        ((ads_collision_fn)(uintptr_t)(ads_base + 0x12b5120))(camera, eye, look, 0.0f, 1);
        if (progress == 1.0f && ads_step_context)
            ads_step_observe(ads_step_context, (const float *)(camera + 0xf0), eye, look,
                             (const float *)(camera + 0x840));
    }
}
static float ads_rotate(BYTE *camera, const float *delta, float dt, BYTE supplied) {
    ads_rotation_fn rotate = *(ads_rotation_fn *)(*(BYTE **)camera + 0x390);
    float adjusted[2];
    if (camera == ads_solving_camera && ads_last_progress == 1.0f && ads_step_context && supplied &&
        ads_step_propose(ads_step_context, (const float *)(camera + 0xf0),
                         *(float *)(camera + 0x880), adjusted))
        delta = adjusted;
    return rotate(camera, delta, dt, supplied);
}
static void ads_transition(BYTE *camera, float *eye, float *look, const float *target, BYTE supplied) {
    ads_solver_fn solve = (ads_solver_fn)(uintptr_t)(ads_base + 0x12b7070);
    ads_collision_fn collide = (ads_collision_fn)(uintptr_t)(ads_base + 0x12b5120);
    BYTE *previous = ads_solving_camera;
    float previous_progress = ads_last_progress;
    AdsStep step, *previous_step = ads_step_context;
    BOOL active = supplied && ads_active(camera);
    /* Snapshot once: watchdog disable must not interrupt a coupled solve. */
    ads_solving_camera = active ? camera : NULL;
    ads_last_progress = 0.0f;
    ads_step_init(&step); ads_step_context = active ? &step : NULL;
    if (active) {
        float raw_eye[4], raw_look[4], initial_eye[4], initial_look[4];
        memcpy(raw_eye, eye, sizeof(raw_eye)); memcpy(raw_look, look, sizeof(raw_look));
        /* Also physical when native progress is zero or the solver rolls back.
         * Do not collide a second time after accepting the solved pose.
         */
        collide(camera, eye, look, 0.0f, 1);
        memcpy(initial_eye, eye, sizeof(initial_eye)); memcpy(initial_look, look, sizeof(initial_look));
        solve(camera, eye, look, target, supplied);
        if (!memcmp(eye, initial_eye, sizeof(initial_eye)) && !memcmp(look, initial_look, sizeof(initial_look))) {
            /* Native rejection applies sensitivity to its return rotation, so
             * its final angles can differ from the saved pose at completion.
             */
            if (ads_last_progress == 1.0f) {
                ads_evaluate(camera, eye, look, 1.0f);
            } else {
                memcpy(eye, raw_eye, sizeof(raw_eye)); memcpy(look, raw_look, sizeof(raw_look));
                collide(camera, eye, look, 0.0f, 1);
            }
        }
    } else {
        solve(camera, eye, look, target, supplied);
        collide(camera, eye, look, 0.0f, 1);
    }
    ads_solving_camera = previous;
    ads_last_progress = previous_progress;
    ads_step_context = previous_step;
}

/* CALL, rather than a mid-frame JMP, gives the bridge a normal return address
 * and independent unwind metadata. Original RSP is entry RSP+8.
 */
static SIZE_T ads_build_eval(BYTE *out) {
    BYTE *p = out;
    const BYTE prologue[] = {0x48,0x81,0xec,0xe8,0,0,0,0x44,0x0f,0x29,0x8c,0x24,0xd0,0,0,0};
    const BYTE save_gpr[][5] = {
        {0x48,0x89,0x44,0x24,0x30},{0x48,0x89,0x4c,0x24,0x38},
        {0x48,0x89,0x54,0x24,0x40},{0x4c,0x89,0x44,0x24,0x48},
        {0x4c,0x89,0x4c,0x24,0x50},{0x4c,0x89,0x54,0x24,0x58},
        {0x4c,0x89,0x5c,0x24,0x60}
    };
    const BYTE args[] = {0x48,0x89,0xf9,0x48,0x8d,0x94,0x24,0x50,0x01,0,0,
                        0x4c,0x8d,0x84,0x24,0x20,0x01,0,0,
                        0xf3,0x0f,0x10,0x9c,0x24,0x60,0x01,0,0};
    const BYTE reload_eye[] = {0x44,0x0f,0x28,0x8c,0x24,0x50,0x01,0,0};
    const BYTE epilogue[] = {0x48,0x81,0xc4,0xe8,0,0,0,0xc3};
    uintptr_t helper = (uintptr_t)ads_evaluate;
    memcpy(p, prologue, sizeof(prologue)); p += sizeof(prologue);
    memcpy(p, save_gpr, sizeof(save_gpr)); p += sizeof(save_gpr);
    for (unsigned int i = 0; i < 6; ++i) {
        BYTE save[] = {0x0f,0x11,(BYTE)(0x84 + i * 8),0x24,0,0,0,0};
        uint32_t offset = 0x70 + i * 16;
        memcpy(save + 4, &offset, 4); memcpy(p, save, sizeof(save)); p += sizeof(save);
    }
    memcpy(p, args, sizeof(args)); p += sizeof(args);
    *p++ = 0x48; *p++ = 0xb8; memcpy(p, &helper, 8); p += 8; *p++ = 0xff; *p++ = 0xd0;
    for (unsigned int i = 0; i < 6; ++i) {
        BYTE load[] = {0x0f,0x10,(BYTE)(0x84 + i * 8),0x24,0,0,0,0};
        uint32_t offset = 0x70 + i * 16;
        memcpy(load + 4, &offset, 4); memcpy(p, load, sizeof(load)); p += sizeof(load);
    }
    for (unsigned int i = 0; i < ARRAYSIZE(save_gpr); ++i) {
        memcpy(p, save_gpr[i], 5); p[1] = 0x8b; p += 5;
    }
    /* XMM9 caches the eye used by the following native residual calculation.
     * Flags are dead here: the next reader follows native atan2 calls.
     */
    memcpy(p, reload_eye, sizeof(reload_eye)); p += sizeof(reload_eye);
    memcpy(p, ads_eval_guard, sizeof(ads_eval_guard)); p += sizeof(ads_eval_guard);
    memcpy(p, epilogue, sizeof(epilogue)); p += sizeof(epilogue);
    return (SIZE_T)(p - out);
}

static BOOL ads_commit(BYTE *base, const BYTE *call_patch, const BYTE *eval_patch, const BYTE *rotation_patch) {
    DWORD old[3] = {0,0,0}; unsigned int i;
    BYTE *sites[] = {base + 0x12bfa93, base + 0x12b763b, base + 0x12b73f9};
    const BYTE *original[] = {ads_call_guard, ads_eval_guard, ads_rotation_guard};
    const BYTE *replacement[] = {call_patch, eval_patch, rotation_patch};
    SIZE_T sizes[] = {sizeof(ads_call_guard), sizeof(ads_eval_guard), sizeof(ads_rotation_guard)};
    const thread_gate_window windows[] = {{sites[0], sizes[0]}, {sites[1], sizes[1]}, {sites[2], sizes[2]}};
    BOOL writable[3] = {FALSE,FALSE,FALSE}, ok = FALSE;
    thread_gate gate;
    if (!thread_gate_freeze(&gate, "ADS", windows, ARRAYSIZE(windows))) return FALSE;
    for (i = 0; i < ARRAYSIZE(sites); ++i)
        if (!exact_bytes(sites[i], original[i], sizes[i])) goto thaw;
    for (i = 0; i < ARRAYSIZE(sites); ++i) writable[i] = VirtualProtect(sites[i], sizes[i], PAGE_EXECUTE_READWRITE, &old[i]);
    if (writable[0] && writable[1] && writable[2]) {
        for (i = 0; i < ARRAYSIZE(sites); ++i) memcpy(sites[i], replacement[i], sizes[i]);
        ok = FlushInstructionCache(GetCurrentProcess(), sites[0], sizes[0]) &&
             FlushInstructionCache(GetCurrentProcess(), sites[1], sizes[1]) &&
             FlushInstructionCache(GetCurrentProcess(), sites[2], sizes[2]);
        if (!ok) {
            for (i = 0; i < ARRAYSIZE(sites); ++i) memcpy(sites[i], original[i], sizes[i]);
            FlushInstructionCache(GetCurrentProcess(), NULL, 0);
        }
    }
    /* Evaluation and rotation share a page; unwind protection changes in reverse. */
    for (i = ARRAYSIZE(sites); i-- > 0;)
        if (writable[i] && !restore_page_protection(sites[i], sizes[i], old[i])) ok = FALSE;
thaw:
    thread_gate_thaw(&gate);
    return ok;
}

static void ads_install(BYTE *base) {
    BYTE *memory = NULL, call_patch[sizeof(ads_call_guard)], eval_patch[sizeof(ads_eval_guard)];
    BYTE rotation_patch[sizeof(ads_rotation_guard)];
    DWORD protection; int32_t relative; SIZE_T length;
    const BYTE solver_guard[] = {0x48,0x8b,0xc4,0x55,0x41,0x54,0x41,0x55,0x41,0x56,0x41,0x57};
    const BYTE collision_guard[] = {0x48,0x8b,0xc4,0x48,0x89,0x50,0x10,0x48,0x89,0x48,0x08};
    const BYTE pose_guard[] = {0x48,0x8b,0xc4,0x4c,0x89,0x48,0x20,0x4c,0x89,0x40,0x18};
    const BYTE yaw_guard[] = {0x40,0x53,0x48,0x83,0xec,0x30,0x48,0x8b,0xd9};
    const BYTE rotate_guard[] = {0x48,0x8b,0xc4,0x44,0x88,0x48,0x20,0xf3,0x0f,0x11,0x50,0x18};
    const BYTE unwind[] = {1,16,4,0,16,0x98,13,0,7,1,29,0};
    if (!exact_bytes(base + 0x12bfa93, ads_call_guard, sizeof(ads_call_guard)) ||
        !exact_bytes(base + 0x12b763b, ads_eval_guard, sizeof(ads_eval_guard)) ||
        !exact_bytes(base + 0x12b73f9, ads_rotation_guard, sizeof(ads_rotation_guard)) ||
        !exact_bytes(base + 0x12b7070, solver_guard, sizeof(solver_guard)) ||
        !exact_bytes(base + 0x12b5120, collision_guard, sizeof(collision_guard)) ||
        !exact_bytes(base + 0x12ba300, pose_guard, sizeof(pose_guard)) ||
        !exact_bytes(base + 0x12bcc30, yaw_guard, sizeof(yaw_guard)) ||
        !exact_bytes(base + 0x12b6760, rotate_guard, sizeof(rotate_guard))) {
        patch_log("ROTK ADS: native signature mismatch; skipped.\n"); return;
    }
    memory = bridge_page(base);
    if (!memory) { bridge_refused("ROTK ADS", base); return; }
    stance_jump(memory, (void *)(uintptr_t)ads_transition);
    stance_jump(memory + 544, (void *)(uintptr_t)ads_rotate);
    length = ads_build_eval(memory + 64);
    memcpy(memory + 512, unwind, sizeof(unwind));
    ads_unwind.BeginAddress = 64; ads_unwind.EndAddress = (DWORD)(64 + length); ads_unwind.UnwindData = 512;
    if (!VirtualProtect(memory, 4096, PAGE_EXECUTE_READ, &protection) ||
        !FlushInstructionCache(GetCurrentProcess(), memory, 4096) ||
        !RtlAddFunctionTable(&ads_unwind, 1, (DWORD64)(uintptr_t)memory)) {
        bridge_release(memory);
        patch_log("ROTK ADS: bridge protection or unwind registration refused; skipped.\n"); return;
    }
    memset(call_patch, 0x90, sizeof(call_patch)); call_patch[0] = 0xe8;
    relative = (int32_t)((memory - base) - 0x12bfa98); memcpy(call_patch + 1, &relative, 4);
    memset(eval_patch, 0x90, sizeof(eval_patch)); eval_patch[0] = 0xe8;
    relative = (int32_t)((memory + 64 - base) - 0x12b7640); memcpy(eval_patch + 1, &relative, 4);
    memset(rotation_patch, 0x90, sizeof(rotation_patch)); rotation_patch[0] = 0xe8;
    relative = (int32_t)((memory + 544 - base) - 0x12b73fe); memcpy(rotation_patch + 1, &relative, 4);
    ads_base = base;
    if (!ads_commit(base, call_patch, eval_patch, rotation_patch)) {
        /* Keep registered bridges alive on a protection restoration failure;
         * disabled wrappers preserve the original solver/collision ordering.
         */
        patch_log("ROTK ADS: guarded installation refused; disabled.\n"); return;
    }
    InterlockedExchange(&ads_enabled, 1);
    patch_log("ROTK ADS: collision-aware transition solver installed.\n");
}
