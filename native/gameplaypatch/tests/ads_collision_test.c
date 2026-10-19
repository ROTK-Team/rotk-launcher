#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static HANDLE WINAPI test_open_thread(DWORD access, BOOL inherit, DWORD id);
#define OpenThread test_open_thread
#define DirectInput8Create RotkTestDirectInput8Create
#define DllCanUnloadNow RotkTestDllCanUnloadNow
#define DllGetClassObject RotkTestDllGetClassObject
#define DllRegisterServer RotkTestDllRegisterServer
#define DllUnregisterServer RotkTestDllUnregisterServer
#define GetdfDIJoystick RotkTestGetdfDIJoystick
#define DllMain RotkTestDllMain
#include "../dinput8_proxy.c"
#undef OpenThread
#undef NDEBUG
#include <assert.h>

static HANDLE retiring_thread, retire_event;
static DWORD retiring_id;
static unsigned int retired_open_errors, denied_opens, forced_open_failures;
static DWORD WINAPI retire_worker(LPVOID unused) {
    (void)unused;
    assert(WaitForSingleObject(retire_event, 5000) == WAIT_OBJECT_0);
    return 0;
}
/* A snapshot thread exits before OpenThread and the call fails with the
 * error 87 seen in H1Z1. */
static HANDLE WINAPI test_open_thread(DWORD access, BOOL inherit, DWORD id) {
    if (id == retiring_id) {
        assert(SetEvent(retire_event));
        assert(WaitForSingleObject(retiring_thread, 5000) == WAIT_OBJECT_0);
        assert(CloseHandle(retiring_thread));
        retiring_thread = NULL; retiring_id = 0;
        ++retired_open_errors;
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

static BYTE camera[0xc00];
static float eye[4], look[4], target[4];
static char order[16];
static unsigned int calls;
static BOOL refuse_pose;
static BOOL disable_during_solve;
static BOOL reject_after_complete;
static float rotation_delta[2];
static float original_rotation(BYTE *c, const float *delta, float dt, BYTE supplied) {
    assert(c == camera && dt == 0.25f && supplied == 1);
    memcpy(rotation_delta, delta, sizeof(rotation_delta)); return 7.0f;
}
static float relative_yaw(BYTE *c) {
    assert(c == camera); order[calls++] = 'Y'; return 0.125f;
}
static void normal_pose(BYTE *c, float yaw, float *e, float *l, BYTE special) {
    assert(c == camera && yaw == 0.125f && e == eye && l == look && !special);
    order[calls++] = 'P'; e[0] = l[0] = 0;
    e[1] = l[1] = *(float *)(c + 0xf4); e[2] = 4.0f; l[2] = 5.0f;
}
static void collide(BYTE *c, float *e, float *l, float dt, BYTE force) {
    assert(c == camera && e == eye && l == look && dt == 0.0f && force == 1);
    order[calls++] = 'C'; e[0] += 1.0f; l[0] += 1.0f;
}
static void solve(BYTE *c, float *e, float *l, const float *t, BYTE supplied) {
    assert(c == camera && e == eye && l == look && t == target && supplied == 1);
    order[calls++] = 'S';
    if (reject_after_complete) {
        float saved_eye[4], saved_look[4];
        memcpy(saved_eye, e, sizeof(saved_eye)); memcpy(saved_look, l, sizeof(saved_look));
        ads_evaluate(c, e, l, 1.0f);
        *(float *)(c + 0xf4) = 0.5f;
        memcpy(e, saved_eye, sizeof(saved_eye)); memcpy(l, saved_look, sizeof(saved_look));
        return;
    }
    if (disable_during_solve) {
        InterlockedExchange(&ads_enabled, 0);
        ads_evaluate(c, e, l, 0.5f);
    }
    if (!refuse_pose) { e[1] = 2.0f; l[1] = 3.0f; }
}
static void fresh(void) {
    memset(camera, 0, sizeof(camera)); memset(order, 0, sizeof(order)); calls = 0;
    memset(eye, 0, sizeof(eye)); memset(look, 0, sizeof(look)); refuse_pose = FALSE;
    disable_during_solve = FALSE; reject_after_complete = FALSE;
    ads_solving_camera = NULL; ads_last_progress = 0.0f; ads_step_context = NULL;
    *(uintptr_t *)camera = (uintptr_t)(ads_base + 0x37eb858); camera[0x834] = 1;
    InterlockedExchange(&ads_enabled, 1);
}
static DWORD WINAPI foreign_evaluate(LPVOID ignored) {
    (void)ignored; ads_evaluate(camera, eye, look, 1.0f); return 0;
}
static void step_regression(void) {
    AdsStep s; float angle[2] = {0.1f,0.1f}, eye0[3] = {0,0,0}, target0[3] = {0,0,10}, proposal[2];
    unsigned int iterations;
    ads_step_init(&s);
    assert(!ads_step_propose(&s, angle, 0.4f, proposal));
    for (iterations = 0; iterations < 12; ++iterations) {
        double yaw = 1.3*angle[0]+0.2*angle[1]-0.1;
        double pitch = 0.15*angle[0]+0.8*angle[1]+0.05;
        float ray[3] = {(float)(sin(yaw)*cos(pitch)),(float)sin(pitch),(float)(cos(yaw)*cos(pitch))};
        ads_step_observe(&s, angle, eye0, ray, target0);
        if (hypot(yaw,pitch) < 1e-6) break;
        assert(ads_step_propose(&s, angle, 0.4f, proposal));
        angle[0] += proposal[0]; angle[1] += proposal[1]*0.4f;
    }
    assert(iterations < 12);
    assert(!ads_step_propose(&s, angle, 0, proposal));
    assert(!ads_step_propose(&s, angle, NAN, proposal));
    target0[0] = NAN; ads_step_observe(&s, angle, eye0, target0, target0);
    assert(!ads_step_propose(&s, angle, 0.4f, proposal));
    assert(fabs(ads_step_difference(-3.14,3.14)) < 0.01);
}
static void step_backtracking_regression(void) {
    AdsStep s;
    float angle[2] = {2,0}, eye0[3] = {0,0,0}, target0[3] = {0,0,1}, proposal[2];
    unsigned int iterations;
    ads_step_init(&s);
    /* A steep response overshoots; the next trial must reduce the bad step. */
    for (iterations = 0; iterations < 32; ++iterations) {
        double yaw = 0.25*(angle[0]*angle[0]*angle[0]-1);
        float ray[3] = {(float)sin(yaw),0,(float)cos(yaw)};
        ads_step_observe(&s, angle, eye0, ray, target0);
        if (fabs(yaw) < 1e-6) break;
        assert(ads_step_propose(&s, angle, 1, proposal));
        angle[0] += proposal[0]; angle[1] += proposal[1];
    }
    assert(iterations < 32);
    /* Identical float angles cannot backtrack: retry a fresh corrective step. */
    ads_step_init(&s); angle[0] = 0.5f; angle[1] = 0;
    float ray[3] = {0.25f,0,1};
    ads_step_observe(&s, angle, eye0, ray, target0);
    assert(ads_step_propose(&s, angle, 1, proposal));
    float retry = proposal[0];
    ads_step_observe(&s, angle, eye0, ray, target0);
    assert(ads_step_propose(&s, angle, 1, proposal));
    assert(retry < -0.2f && proposal[0] == retry && proposal[1] == 0);
}
int main(int argc, char **argv) {
    DWORD protection;
    step_regression();
    step_backtracking_regression();
    BYTE *bridge = VirtualAlloc(NULL, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    ads_base = VirtualAlloc(NULL, 0x4000000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(bridge && ads_base);
    stance_jump(ads_base + 0x12b7070, (void *)(uintptr_t)solve);
    stance_jump(ads_base + 0x12b5120, (void *)(uintptr_t)collide);
    stance_jump(ads_base + 0x12bcc30, (void *)(uintptr_t)relative_yaw);
    stance_jump(ads_base + 0x12ba300, (void *)(uintptr_t)normal_pose);
    *(ads_rotation_fn *)(ads_base + 0x37eb858 + 0x390) = original_rotation;
    assert(VirtualProtect(ads_base, 0x4000000, PAGE_EXECUTE_READWRITE, &protection));
    assert(FlushInstructionCache(GetCurrentProcess(), ads_base, 0x4000000));
    fresh(); ads_transition(camera, eye, look, target, 1);
    assert(strcmp(order, "CS") == 0 && eye[0] == 1 && eye[1] == 2);
    fresh(); refuse_pose = TRUE; ads_transition(camera, eye, look, target, 1);
    assert(strcmp(order, "CSC") == 0 && eye[0] == 1 && eye[1] == 0);
    fresh(); reject_after_complete = TRUE; ads_last_progress = 0.25f;
    ads_transition(camera, eye, look, target, 1);
    assert(strcmp(order, "CSYPCYPC") == 0 && eye[0] == 1 && eye[1] == 0.5f && eye[2] == 4);
    assert(!ads_solving_camera && ads_last_progress == 0.25f);
    fresh(); disable_during_solve = TRUE; ads_transition(camera, eye, look, target, 1);
    assert(strcmp(order, "CSC") == 0 && !ads_solving_camera);
    fresh(); InterlockedExchange(&ads_enabled, 0); ads_transition(camera, eye, look, target, 1);
    assert(strcmp(order, "SC") == 0);
    fresh(); camera[0x834] = 0; ads_transition(camera, eye, look, target, 1);
    assert(strcmp(order, "SC") == 0);
    fresh(); *(uintptr_t *)camera = 0; ads_transition(camera, eye, look, target, 1);
    assert(strcmp(order, "SC") == 0);
    fresh(); ads_solving_camera = camera; ads_evaluate(camera, eye, look, 0.5f); assert(strcmp(order, "C") == 0);
    fresh(); ads_solving_camera = camera; ads_evaluate(camera, eye, look, 1.0f);
    assert(strcmp(order, "YPC") == 0 && eye[2] == 4.0f && look[2] == 5.0f);
    fresh(); ads_evaluate(camera, eye, look, 1.0f); assert(calls == 0);
    fresh(); InterlockedExchange(&ads_enabled, 0); ads_evaluate(camera, eye, look, 1.0f); assert(calls == 0);
    fresh(); *(uintptr_t *)camera = 0; ads_evaluate(camera, eye, look, 1.0f); assert(calls == 0);
    fresh(); ads_solving_camera = camera;
    HANDLE other = CreateThread(NULL, 0, foreign_evaluate, NULL, 0, NULL);
    assert(other && WaitForSingleObject(other, 1000) == WAIT_OBJECT_0);
    CloseHandle(other); assert(calls == 0); ads_solving_camera = NULL;
    fresh();
    AdsStep step; ads_step_init(&step);
    float controls[2] = {0.1f,0.2f}, a[2] = {0,0}, e0[3] = {0,0,0}, l0[3] = {0,0,1}, t0[3] = {1,0,1};
    ads_step_observe(&step, a, e0, l0, t0);
    ads_step_context = &step; ads_last_progress = 1;
    assert(ads_rotate(camera, controls, 0.25f, 1) == 7);
    assert(rotation_delta[0] == controls[0] && rotation_delta[1] == controls[1]);
    ads_solving_camera = camera; ads_last_progress = 0.5f;
    assert(ads_rotate(camera, controls, 0.25f, 1) == 7 && rotation_delta[0] == controls[0]);
    ads_last_progress = 1; *(float *)(camera + 0x880) = 0.4f;
    InterlockedExchange(&ads_enabled, 0); /* A snapshotted solve completes when disabled. */
    assert(ads_rotate(camera, controls, 0.25f, 1) == 7);
    assert(fabsf(rotation_delta[0] - 0.7853982f) < 1e-6f && rotation_delta[1] == 0);
    assert(controls[0] == 0.1f && controls[1] == 0.2f);
    ads_solving_camera = NULL; ads_step_context = NULL;
    /* Refuse a foreign/partially patched image without publishing either site. */
    InterlockedExchange(&ads_enabled, 0); ads_install(ads_base);
    assert(!InterlockedCompareExchange(&ads_enabled, 0, 0));
    BYTE call_patch[sizeof(ads_call_guard)], eval_patch[sizeof(ads_eval_guard)], rotation_patch[sizeof(ads_rotation_guard)];
    memset(call_patch, 0x90, sizeof(call_patch)); memset(eval_patch, 0x90, sizeof(eval_patch));
    memset(rotation_patch, 0x90, sizeof(rotation_patch));
    stance_jump(ads_base + 0x700000, (void *)(uintptr_t)ads_rotate);
    int32_t rotation_relative = (int32_t)(0x700000 - 0x12b73fe);
    rotation_patch[0] = 0xe8; memcpy(rotation_patch + 1, &rotation_relative, 4);
    memcpy(ads_base + 0x12bfa93, ads_call_guard, sizeof(ads_call_guard));
    assert(!ads_commit(ads_base, call_patch, eval_patch, rotation_patch));
    assert(memcmp(ads_base + 0x12bfa93, ads_call_guard, sizeof(ads_call_guard)) == 0);
    memcpy(ads_base + 0x12b763b, ads_eval_guard, sizeof(ads_eval_guard));
    assert(!ads_commit(ads_base, call_patch, eval_patch, rotation_patch));
    assert(memcmp(ads_base + 0x12bfa93, ads_call_guard, sizeof(ads_call_guard)) == 0);
    memcpy(ads_base + 0x12b73f9, ads_rotation_guard, sizeof(ads_rotation_guard));
    assert(ads_commit(ads_base, call_patch, eval_patch, rotation_patch));
    assert(memcmp(ads_base + 0x12bfa93, call_patch, sizeof(call_patch)) == 0);
    assert(memcmp(ads_base + 0x12b763b, eval_patch, sizeof(eval_patch)) == 0);
    assert(memcmp(ads_base + 0x12b73f9, rotation_patch, sizeof(rotation_patch)) == 0);
    memcpy(ads_base + 0x12bfa93, ads_call_guard, sizeof(ads_call_guard));
    memcpy(ads_base + 0x12b763b, ads_eval_guard, sizeof(ads_eval_guard));
    memcpy(ads_base + 0x12b73f9, ads_rotation_guard, sizeof(ads_rotation_guard));
    assert(VirtualProtect(ads_base + 0x12bf000, 4096, PAGE_EXECUTE_READ, &protection));
    assert(VirtualProtect(ads_base + 0x12b7000, 4096, PAGE_EXECUTE_READ, &protection));
    assert(ads_commit(ads_base, call_patch, eval_patch, rotation_patch));
    MEMORY_BASIC_INFORMATION page;
    assert(VirtualQuery(ads_base + 0x12b763b, &page, sizeof(page)) && page.Protect == PAGE_EXECUTE_READ);
    assert(VirtualQuery(ads_base + 0x12bfa93, &page, sizeof(page)) && page.Protect == PAGE_EXECUTE_READ);
    assert(VirtualProtect(ads_base + 0x12b7000, 4096, PAGE_EXECUTE_READWRITE, &protection));
    /* Reproduce the native call-site stack alignment and shadow space. */
    BYTE call_entry[] = {0x48,0x83,0xec,0x28,0xe9,0,0,0,0};
    int32_t enter_relative = (int32_t)(0x12b73f9 - (0x6ffff0 + sizeof(call_entry)));
    memcpy(call_entry + 5, &enter_relative, 4);
    const BYTE call_exit[] = {0x48,0x83,0xc4,0x28,0xc3};
    memcpy(ads_base + 0x6ffff0, call_entry, sizeof(call_entry));
    memcpy(ads_base + 0x12b73ff, call_exit, sizeof(call_exit));
    assert(FlushInstructionCache(GetCurrentProcess(), ads_base, 0x4000000));
    assert(((ads_rotation_fn)(uintptr_t)(ads_base + 0x6ffff0))(camera, controls, 0.25f, 1) == 7);
    assert(rotation_delta[0] == controls[0] && rotation_delta[1] == controls[1]);

    SIZE_T length = ads_build_eval(bridge);
    assert(length < 448);
    const BYTE unwind[] = {1,16,4,0,16,0x98,13,0,7,1,29,0};
    memcpy(bridge + 512, unwind, sizeof(unwind));
    RUNTIME_FUNCTION entry = {0,(DWORD)length,512};
    assert(VirtualProtect(bridge, 4096, PAGE_EXECUTE_READ, &protection));
    assert(FlushInstructionCache(GetCurrentProcess(), bridge, 4096));
    assert(RtlAddFunctionTable(&entry, 1, (DWORD64)(uintptr_t)bridge));
    BYTE stack[1024]; memset(stack, 0, sizeof(stack));
    uintptr_t frame = ((uintptr_t)stack + 31) & ~(uintptr_t)15;
    *(uintptr_t *)(frame + 0xe8) = 0x12345678;
    M128A expected = {0x1122334455667788ULL,0x12345678};
    memcpy((void *)(frame + 0xd0), &expected, sizeof(expected));
    CONTEXT ctx; memset(&ctx, 0, sizeof(ctx)); ctx.Rsp = frame; ctx.Rip = (uintptr_t)bridge + 16;
    PVOID handler = NULL; DWORD64 establisher = 0;
    RtlVirtualUnwind(UNW_FLAG_NHANDLER, (DWORD64)(uintptr_t)bridge, ctx.Rip, &entry,
                     &ctx, &handler, &establisher, NULL);
    assert(ctx.Rsp == frame + 0xf0 && ctx.Rip == 0x12345678);
    assert(memcmp(&ctx.Xmm9, &expected, sizeof(expected)) == 0);
    assert(RtlDeleteFunctionTable(&entry));
    if (argc == 2) {
        FILE *f = fopen(argv[1], "wb"); assert(f);
        assert(fwrite(bridge, 1, length, f) == length); assert(fclose(f) == 0);
    }
    VirtualFree(bridge, 0, MEM_RELEASE); VirtualFree(ads_base, 0, MEM_RELEASE);

    /* Full install on a private image with every guard. A snapshot thread
     * that exits before OpenThread is retried with a fresh snapshot; a
     * persistent failure stops after 20 attempts and writes nothing. */
    const BYTE solver_guard[] = {0x48,0x8b,0xc4,0x55,0x41,0x54,0x41,0x55,0x41,0x56,0x41,0x57};
    const BYTE collision_guard[] = {0x48,0x8b,0xc4,0x48,0x89,0x50,0x10,0x48,0x89,0x48,0x08};
    const BYTE pose_guard[] = {0x48,0x8b,0xc4,0x4c,0x89,0x48,0x20,0x4c,0x89,0x40,0x18};
    const BYTE yaw_guard[] = {0x40,0x53,0x48,0x83,0xec,0x30,0x48,0x8b,0xd9};
    const BYTE rotate_guard[] = {0x48,0x8b,0xc4,0x44,0x88,0x48,0x20,0xf3,0x0f,0x11,0x50,0x18};
    BYTE *stock = VirtualAlloc(NULL, 0x1300000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    int32_t site_relative;
    assert(stock);
    memcpy(stock + 0x12bfa93, ads_call_guard, sizeof(ads_call_guard));
    memcpy(stock + 0x12b763b, ads_eval_guard, sizeof(ads_eval_guard));
    memcpy(stock + 0x12b73f9, ads_rotation_guard, sizeof(ads_rotation_guard));
    memcpy(stock + 0x12b7070, solver_guard, sizeof(solver_guard));
    memcpy(stock + 0x12b5120, collision_guard, sizeof(collision_guard));
    memcpy(stock + 0x12ba300, pose_guard, sizeof(pose_guard));
    memcpy(stock + 0x12bcc30, yaw_guard, sizeof(yaw_guard));
    memcpy(stock + 0x12b6760, rotate_guard, sizeof(rotate_guard));
    assert(VirtualProtect(stock, 0x1300000, PAGE_EXECUTE_READ, &protection));
    retire_event = CreateEventW(NULL, TRUE, FALSE, NULL); assert(retire_event);
    retiring_thread = CreateThread(NULL, 0, retire_worker, NULL, 0, &retiring_id);
    assert(retiring_thread);
    InterlockedExchange(&ads_enabled, 0); ads_install(stock);
    assert(retired_open_errors == 1 && !retiring_thread);
    assert(InterlockedCompareExchange(&ads_enabled, 0, 0) && ads_base == stock);
    assert(stock[0x12bfa93] == 0xe8 && stock[0x12b763b] == 0xe8 && stock[0x12b73f9] == 0xe8);
    memcpy(&site_relative, stock + 0x12bfa94, 4);
    BYTE *installed = stock + 0x12bfa98 + site_relative;
    memcpy(&site_relative, stock + 0x12b763c, 4);
    assert(stock + 0x12b7640 + site_relative == installed + 64);
    memcpy(&site_relative, stock + 0x12b73fa, 4);
    assert(stock + 0x12b73fe + site_relative == installed + 544);
    assert(RtlDeleteFunctionTable(&ads_unwind));
    assert(VirtualProtect(stock, 0x1300000, PAGE_READWRITE, &protection));
    memcpy(stock + 0x12bfa93, ads_call_guard, sizeof(ads_call_guard));
    memcpy(stock + 0x12b763b, ads_eval_guard, sizeof(ads_eval_guard));
    memcpy(stock + 0x12b73f9, ads_rotation_guard, sizeof(ads_rotation_guard));
    assert(VirtualProtect(stock, 0x1300000, PAGE_EXECUTE_READ, &protection));
    assert(ResetEvent(retire_event));
    retiring_thread = CreateThread(NULL, 0, retire_worker, NULL, 0, NULL); assert(retiring_thread);
    forced_open_failures = 100; denied_opens = 0;
    InterlockedExchange(&ads_enabled, 0); ads_install(stock);
    assert(!InterlockedCompareExchange(&ads_enabled, 0, 0) && denied_opens == 20 && forced_open_failures == 80);
    assert(!memcmp(stock + 0x12bfa93, ads_call_guard, sizeof(ads_call_guard)));
    assert(!memcmp(stock + 0x12b763b, ads_eval_guard, sizeof(ads_eval_guard)));
    assert(!memcmp(stock + 0x12b73f9, ads_rotation_guard, sizeof(ads_rotation_guard)));
    assert(RtlDeleteFunctionTable(&ads_unwind));
    forced_open_failures = 0;
    assert(SetEvent(retire_event) && WaitForSingleObject(retiring_thread, 5000) == WAIT_OBJECT_0);
    CloseHandle(retiring_thread); CloseHandle(retire_event);
    VirtualFree(stock, 0, MEM_RELEASE);
    puts("PASS: ADS ordering, fallback, rollback input, gates, guarded commit, emitted bridge and Windows unwind; install retries a thread that exits during the snapshot and stops after 20 attempts.");
    return 0;
}
