/* Retry a rejected named exit in the vehicle's full rotation before the
 * native seat search tries the other side. Every collision test stays native.
 */
typedef BYTE (*vehicle_exit_point_fn)(BYTE *, float *, const char *, void *, float, BYTE, BYTE, BYTE);
typedef float *(*vehicle_exit_inverse_fn)(float *, const float *);
typedef struct vehicle_exit_scope {
    BOOL retry, tilted;
    struct vehicle_exit_scope *previous;
} vehicle_exit_scope;
static BYTE *vehicle_exit_base;
static volatile LONG vehicle_exit_enabled;
static _Thread_local vehicle_exit_scope *vehicle_exit_current;
static const BYTE vehicle_exit_candidate_guard[] = {0xe8,0x37,0xec,0xd7,0xfe,0x0f,0xb6,0xd8};
static const BYTE vehicle_exit_bailout_guard[] = {0xe8,0xe5,0xf7,0xd7,0xfe,0x0f,0xb6,0xd8};
static const BYTE vehicle_exit_inverse_guard[] = {0xe8,0xf6,0x51,0x08,0xff,0x0f,0x10,0x48,0x30};
static const BYTE vehicle_exit_frame_guard[] = {0x41,0x0f,0x10,0x4f,0x30};
static const BYTE vehicle_exit_cached_guard[] = {0xff,0x90,0xd0,0x02,0x00,0x00,0x84,0xc0};

static float *vehicle_exit_inverse(float *out, const float *source, const float *upright) {
    vehicle_exit_inverse_fn inverse = (vehicle_exit_inverse_fn)(uintptr_t)(vehicle_exit_base + 0xf2fb60);
    vehicle_exit_scope *scope = vehicle_exit_current;
    if (scope) {
        for (unsigned int i = 0; i < 12; ++i) {
            float difference = source[i] - upright[i];
            if (difference > 0.0001f || difference < -0.0001f) scope->tilted = TRUE;
        }
        if (scope->retry) {
            float leveled[16];
            /* The following native multiplication uses the upright frame.
             * Its inverse must use that same frame to retain the world point.
             */
            memcpy(leveled, upright, 12 * sizeof(float));
            memcpy(leveled + 12, source + 12, 4 * sizeof(float));
            return inverse(out, leveled);
        }
    }
    return inverse(out, source);
}

static BYTE vehicle_exit_candidate(BYTE *vehicle, float *out, const char *bone, void *auxiliary,
                                   float heading, BYTE check_geometry, BYTE special, BYTE allow_air) {
    vehicle_exit_point_fn point = (vehicle_exit_point_fn)(uintptr_t)(vehicle_exit_base + 0x10577c0);
    vehicle_exit_scope scope = {FALSE, FALSE, vehicle_exit_current};
    BYTE accepted;
    if (!InterlockedCompareExchange(&vehicle_exit_enabled, 0, 0) || !bone || !check_geometry || special)
        return point(vehicle, out, bone, auxiliary, heading, check_geometry, special, allow_air);
    vehicle_exit_current = &scope;
    accepted = point(vehicle, out, bone, auxiliary, heading, check_geometry, special, allow_air);
    if (!accepted && scope.tilted) {
        float original[16];
        memcpy(original, out, sizeof(original));
        scope.retry = TRUE;
        accepted = point(vehicle, out, bone, auxiliary, heading, check_geometry, special, allow_air);
        if (!accepted) memcpy(out, original, sizeof(original));
    }
    vehicle_exit_current = scope.previous;
    return accepted;
}

/* The exit point is chosen and stored in world space when the player presses
 * the key; the dismount reply then places the player there verbatim. While
 * driving, the vehicle keeps moving and turning during that round trip, so a
 * late reply can put the driver behind or beside the other door. When the
 * reply finds a cached point, rerun the native seat search with the current
 * vehicle pose. A failed search keeps the cached point.
 */
typedef BYTE (*vehicle_exit_cached_fn)(BYTE *, float *);
typedef BYTE (*vehicle_exit_search_fn)(BYTE *);
static BYTE vehicle_exit_cached(BYTE *character, float *out) {
    vehicle_exit_cached_fn cached = *(vehicle_exit_cached_fn *)(*(BYTE **)character + 0x2d0);
    vehicle_exit_search_fn search = (vehicle_exit_search_fn)(uintptr_t)(vehicle_exit_base + 0x164d3e0);
    float fresh[4];
    BYTE found = cached(character, out);
    if (!found || !InterlockedCompareExchange(&vehicle_exit_enabled, 0, 0)) return found;
    if (search(character) && cached(character, fresh)) memcpy(out, fresh, sizeof(fresh));
    return found;
}

/* Both bridges tail-call C helpers, retaining the caller's normal Windows
 * stack/unwind chain. R15 is the native validator's upright output matrix.
 */
static void vehicle_exit_build_bridges(BYTE *memory) {
    stance_jump(memory, (void *)(uintptr_t)vehicle_exit_candidate);
    memory[32] = 0x4d; memory[33] = 0x89; memory[34] = 0xf8; /* mov r8,r15 */
    stance_jump(memory + 35, (void *)(uintptr_t)vehicle_exit_inverse);
    stance_jump(memory + 64, (void *)(uintptr_t)vehicle_exit_cached);
}

typedef enum {
    VEHICLE_EXIT_REFUSED, VEHICLE_EXIT_BUSY, VEHICLE_EXIT_INSTALLED
} vehicle_exit_commit_result;

static vehicle_exit_commit_result vehicle_exit_commit(BYTE *base, const BYTE patches[4][6]) {
    HANDLE handles[256], snapshot;
    THREADENTRY32 row;
    unsigned int count = 0, stopped = 0;
    DWORD self = GetCurrentThreadId(), process = GetCurrentProcessId(), old[4] = {0,0,0,0};
    BYTE *sites[] = {base + 0x12e6635, base + 0x10579a0, base + 0x12e5a87, base + 0x10753c0};
    SIZE_T lengths[] = {5, 5, 5, 6};
    const BYTE *guards[] = {vehicle_exit_candidate_guard, vehicle_exit_inverse_guard, vehicle_exit_bailout_guard, vehicle_exit_cached_guard};
    SIZE_T guard_sizes[] = {sizeof(vehicle_exit_candidate_guard), sizeof(vehicle_exit_inverse_guard), sizeof(vehicle_exit_bailout_guard), sizeof(vehicle_exit_cached_guard)};
    BOOL writable[4] = {FALSE,FALSE,FALSE,FALSE}, ok = FALSE;
    vehicle_exit_commit_result result = VEHICLE_EXIT_BUSY;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return result;
    row.dwSize = sizeof(row);
    if (!Thread32First(snapshot, &row)) { CloseHandle(snapshot); return result; }
    do {
        if (row.th32OwnerProcessID != process || row.th32ThreadID == self) continue;
        if (count == ARRAYSIZE(handles)) { result = VEHICLE_EXIT_REFUSED; goto close_handles; }
        handles[count] = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT, FALSE, row.th32ThreadID);
        if (!handles[count]) goto close_handles;
        ++count;
    } while (Thread32Next(snapshot, &row));
    if (GetLastError() != ERROR_NO_MORE_FILES) goto close_handles;
    CloseHandle(snapshot); snapshot = INVALID_HANDLE_VALUE;
    for (unsigned int i = 0; i < count; ++i) {
        CONTEXT context; memset(&context, 0, sizeof(context)); context.ContextFlags = CONTEXT_CONTROL;
        if (SuspendThread(handles[i]) == (DWORD)-1) goto resume_threads;
        ++stopped;
        if (!GetThreadContext(handles[i], &context)) goto resume_threads;
        for (unsigned int j = 0; j < 4; ++j)
            if (context.Rip >= (uintptr_t)sites[j] && context.Rip < (uintptr_t)sites[j] + lengths[j]) goto resume_threads;
    }
    /* Once signatures/protections are involved, a refusal is terminal: a
     * retry must never treat a partially installed bridge as original code. */
    result = VEHICLE_EXIT_REFUSED;
    for (unsigned int i = 0; i < 4; ++i)
        if (!exact_bytes(sites[i], guards[i], guard_sizes[i])) goto resume_threads;
    for (unsigned int i = 0; i < 4; ++i)
        writable[i] = VirtualProtect(sites[i], lengths[i], PAGE_EXECUTE_READWRITE, &old[i]);
    if (writable[0] && writable[1] && writable[2] && writable[3]) {
        for (unsigned int i = 0; i < 4; ++i) memcpy(sites[i], patches[i], lengths[i]);
        ok = FlushInstructionCache(GetCurrentProcess(), NULL, 0);
        if (!ok) {
            for (unsigned int i = 0; i < 4; ++i) memcpy(sites[i], guards[i], lengths[i]);
            FlushInstructionCache(GetCurrentProcess(), NULL, 0);
        }
    }
    for (unsigned int i = 0; i < 4; ++i)
        if (writable[i] && !restore_page_protection(sites[i], lengths[i], old[i])) ok = FALSE;
resume_threads:
    while (stopped) ResumeThread(handles[--stopped]);
close_handles:
    if (snapshot != INVALID_HANDLE_VALUE) CloseHandle(snapshot);
    while (count) CloseHandle(handles[--count]);
    return ok ? VEHICLE_EXIT_INSTALLED : result;
}

static void vehicle_exit_install(BYTE *base) {
    BYTE *memory = NULL, patches[4][6];
    DWORD protection;
    SYSTEM_INFO info;
    vehicle_exit_commit_result result = VEHICLE_EXIT_BUSY;
    if (!exact_bytes(base + 0x12e6635, vehicle_exit_candidate_guard, sizeof(vehicle_exit_candidate_guard)) ||
        !exact_bytes(base + 0x10579a0, vehicle_exit_inverse_guard, sizeof(vehicle_exit_inverse_guard)) ||
        !exact_bytes(base + 0x12e5a87, vehicle_exit_bailout_guard, sizeof(vehicle_exit_bailout_guard)) ||
        !exact_bytes(base + 0x10753c0, vehicle_exit_cached_guard, sizeof(vehicle_exit_cached_guard)) ||
        !exact_bytes(base + 0x1057a12, vehicle_exit_frame_guard, sizeof(vehicle_exit_frame_guard))) {
        patch_log("ROTK vehicle exit: native signature mismatch; skipped.\n"); return;
    }
    GetSystemInfo(&info);
    for (uintptr_t delta = 0x08000000; delta < 0x70000000 && !memory; delta += info.dwAllocationGranularity)
        memory = VirtualAlloc(base + delta, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!memory) return;
    vehicle_exit_build_bridges(memory);
    if (!VirtualProtect(memory, 4096, PAGE_EXECUTE_READ, &protection) ||
        !FlushInstructionCache(GetCurrentProcess(), memory, 4096)) {
        VirtualFree(memory, 0, MEM_RELEASE); return;
    }
    for (unsigned int i = 0; i < 4; ++i) {
        static const uintptr_t offsets[] = {0, 32, 0, 64}, returns[] = {0x12e663a, 0x10579a5, 0x12e5a8c, 0x10753c5};
        int32_t relative = (int32_t)((memory + offsets[i] - base) - returns[i]);
        patches[i][0] = 0xe8; memcpy(patches[i] + 1, &relative, 4); patches[i][5] = 0x90;
    }
    vehicle_exit_base = base;
    /* Startup threads can exit after enumeration. Resume/close everything,
     * then take a fresh snapshot; never sleep with another thread suspended. */
    for (unsigned int attempt = 0; attempt < 20; ++attempt) {
        if (attempt) Sleep(10);
        result = vehicle_exit_commit(base, patches);
        if (result != VEHICLE_EXIT_BUSY) break;
    }
    if (result != VEHICLE_EXIT_INSTALLED) {
        /* A failed protection restore can leave disabled, original-only bridges. */
        patch_log(result == VEHICLE_EXIT_BUSY ?
                  "ROTK vehicle exit: thread state did not stabilize; disabled.\n" :
                  "ROTK vehicle exit: guarded installation refused; disabled.\n"); return;
    }
    InterlockedExchange(&vehicle_exit_enabled, 1);
    patch_log("ROTK vehicle exit: slope retry installed.\n");
}
