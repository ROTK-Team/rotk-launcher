#ifndef ROTK_CROUCH_PARITY_PATCH_H
#define ROTK_CROUCH_PARITY_PATCH_H

/*
 * Runtime-only crouch parity probe/patch support.
 *
 * The feature is deliberately gated by rotk-crouch-parity.ini next to the
 * proxy.  It never edits H1Z1.exe on disk.  Runtime mutations target the
 * pinned BR1315 image (timestamp/size below); target code is not compared
 * with its original bytes.
 */

#include <math.h>
#include <stdarg.h>

#include "crouch_state_cache.h"

#define CROUCH_MARKER_NAME L"rotk-crouch-parity.ini"
#define CROUCH_LOG_NAME L"rotk-crouch-parity.log"
#define CROUCH_MOVE_NODE_ID 6834U
#define CROUCH_IDLE_NODE_ID 10151U
#define CROUCH_CONTROL_NODE_ID 20U
#define CROUCH_NODE_TYPE 107U
#define CROUCH_BLEND_WEIGHT_RVA ((uintptr_t)0x03211fe0U)
#define CROUCH_SCALE_PITCH_RVA ((uintptr_t)0x012c76b0U)
#define CROUCH_SCALE_PITCH_X_RVA ((uintptr_t)0x04457138U)
#define CROUCH_SCALE_PITCH_Y_RVA ((uintptr_t)0x04457128U)
#define CROUCH_EXPECTED_TIMESTAMP 0x5d56e9abU
#define CROUCH_EXPECTED_IMAGE_SIZE 0x072b4000U
#define CROUCH_IDLE_ENTER_SECONDS 0.4000000059604645
#define CROUCH_IDLE_EXIT_SECONDS 0.20000000298023224
#define CROUCH_MOVE_SECONDS 0.25
#define CROUCH_MOVE_RECENT_SECONDS 0.10000000149011612

typedef enum crouch_mode {
    CROUCH_MODE_DISABLED = 0,
    CROUCH_MODE_TELEMETRY = 1,
    CROUCH_MODE_PATCH_V1 = 2,
    CROUCH_MODE_PATCH_V2 = 3
} crouch_mode;

typedef uint16_t (*crouch_blend_weight_fn)(
    void *attrib_blend_weights,
    void *node_child_weights,
    void *active_node_connections,
    void *network,
    void *node_def,
    float trajectory_weight,
    float events_weight,
    float sampled_events_weight,
    float sync_events_weight,
    unsigned char is_additive);

static volatile LONG g_crouch_worker_started;
static volatile LONG64 g_crouch_blend_call_count;
static volatile LONG g_crouch_state_eviction_count;
static volatile LONG g_crouch_state_pressure_count;
static volatile LONG g_crouch_state_reset_count;
static volatile LONG g_crouch_state_out_of_order_count;
static uintptr_t g_crouch_image_base;
static void *g_crouch_original_blend_trampoline;
static BOOL g_crouch_enable_camera;
static LARGE_INTEGER g_crouch_qpc_frequency;
static SRWLOCK g_crouch_state_lock = SRWLOCK_INIT;
static crouch_transition_state
    g_crouch_states[CROUCH_STATE_CAPACITY];
static size_t g_crouch_state_hints[512U];

static size_t crouch_scan_node_defs(void);

static BOOL crouch_sibling_path(const WCHAR *name,
                                WCHAR *path,
                                size_t path_count) {
    DWORD length;
    WCHAR *separator;
    size_t name_count;

    if (path == NULL || path_count == 0U) {
        return FALSE;
    }
    length = GetModuleFileNameW(g_proxy_module, path, (DWORD)path_count);
    if (length == 0U || length >= path_count) {
        return FALSE;
    }
    separator = wcsrchr(path, L'\\');
    if (separator == NULL) {
        return FALSE;
    }
    name_count = wcslen(name) + 1U;
    if ((size_t)(separator - path) + 1U + name_count > path_count) {
        return FALSE;
    }
    memcpy(separator + 1, name, name_count * sizeof(WCHAR));
    return TRUE;
}

static void crouch_log(const char *format, ...) {
#if defined(ROTK_CROUCH_LOGGING) && ROTK_CROUCH_LOGGING
    WCHAR path[32768];
    SYSTEMTIME now;
    char message[1536];
    char line[1792];
    va_list args;
    int message_bytes;
    int line_bytes;
    HANDLE file;
    DWORD written;

    if (!crouch_sibling_path(
            CROUCH_LOG_NAME,
            path,
            sizeof(path) / sizeof(path[0]))) {
        return;
    }
    va_start(args, format);
    message_bytes = vsnprintf(message, sizeof(message), format, args);
    va_end(args);
    if (message_bytes <= 0 || (size_t)message_bytes >= sizeof(message)) {
        return;
    }
    GetSystemTime(&now);
    line_bytes = snprintf(
        line,
        sizeof(line),
        "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ pid=%lu tid=%lu %s\r\n",
        (unsigned int)now.wYear,
        (unsigned int)now.wMonth,
        (unsigned int)now.wDay,
        (unsigned int)now.wHour,
        (unsigned int)now.wMinute,
        (unsigned int)now.wSecond,
        (unsigned int)now.wMilliseconds,
        (unsigned long)GetCurrentProcessId(),
        (unsigned long)GetCurrentThreadId(),
        message);
    if (line_bytes <= 0 || (size_t)line_bytes >= sizeof(line)) {
        return;
    }
    file = CreateFileW(
        path,
        FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return;
    }
    (void)WriteFile(file, line, (DWORD)line_bytes, &written, NULL);
    CloseHandle(file);
#else
    /* Release builds: no formatting, timestamp lookup or disk I/O. */
    (void)format;
#endif
}

static BOOL crouch_page_is_readable(DWORD protect) {
    const DWORD readable =
        PAGE_READONLY |
        PAGE_READWRITE |
        PAGE_WRITECOPY |
        PAGE_EXECUTE_READ |
        PAGE_EXECUTE_READWRITE |
        PAGE_EXECUTE_WRITECOPY;

    return (protect & PAGE_GUARD) == 0U &&
           (protect & PAGE_NOACCESS) == 0U &&
           (protect & readable) != 0U;
}

static BOOL crouch_page_is_writable(DWORD protect) {
    const DWORD writable =
        PAGE_READWRITE |
        PAGE_WRITECOPY |
        PAGE_EXECUTE_READWRITE |
        PAGE_EXECUTE_WRITECOPY;

    return (protect & PAGE_GUARD) == 0U &&
           (protect & PAGE_NOACCESS) == 0U &&
           (protect & writable) != 0U;
}

static crouch_mode crouch_read_mode(void) {
    WCHAR marker[32768];
    char contents[1024];
    HANDLE file;
    DWORD read_bytes = 0U;

    if (!crouch_sibling_path(
            CROUCH_MARKER_NAME,
            marker,
            sizeof(marker) / sizeof(marker[0]))) {
        return CROUCH_MODE_DISABLED;
    }
    file = CreateFileW(
        marker,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return CROUCH_MODE_DISABLED;
    }
    if (!ReadFile(
            file,
            contents,
            (DWORD)(sizeof(contents) - 1U),
            &read_bytes,
            NULL)) {
        CloseHandle(file);
        return CROUCH_MODE_DISABLED;
    }
    CloseHandle(file);
    contents[read_bytes] = '\0';
    if (strstr(contents, "mode=patch-v2") != NULL) {
        g_crouch_enable_camera =
            strstr(contents, "cameraScalePitch=direct") != NULL;
        return CROUCH_MODE_PATCH_V2;
    }
    if (strstr(contents, "mode=patch-v1") != NULL) {
        g_crouch_enable_camera =
            strstr(contents, "cameraScalePitch=direct") != NULL;
        return CROUCH_MODE_PATCH_V1;
    }
    if (strstr(contents, "mode=telemetry") != NULL) {
        return CROUCH_MODE_TELEMETRY;
    }
    return CROUCH_MODE_DISABLED;
}

static BOOL crouch_validate_h1z1_image(uintptr_t *image_base) {
    HMODULE module = GetModuleHandleW(NULL);
    const IMAGE_DOS_HEADER *dos;
    const IMAGE_NT_HEADERS64 *nt;

    if (module == NULL) {
        crouch_log("[crouch-parity] refused: main module unavailable");
        return FALSE;
    }
    dos = (const IMAGE_DOS_HEADER *)(const void *)module;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE ||
        dos->e_lfanew <= 0 || dos->e_lfanew > 0x1000) {
        crouch_log("[crouch-parity] refused: invalid DOS header");
        return FALSE;
    }
    nt = (const IMAGE_NT_HEADERS64 *)(const void *)(
        (const uint8_t *)(const void *)module + (size_t)dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE ||
        nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
        crouch_log("[crouch-parity] refused: invalid AMD64 PE header");
        return FALSE;
    }
    if (nt->FileHeader.TimeDateStamp != CROUCH_EXPECTED_TIMESTAMP ||
        nt->OptionalHeader.SizeOfImage != CROUCH_EXPECTED_IMAGE_SIZE) {
        crouch_log(
            "[crouch-parity] refused: unsupported H1Z1 image "
            "timestamp=0x%08lx size=0x%08lx",
            (unsigned long)nt->FileHeader.TimeDateStamp,
            (unsigned long)nt->OptionalHeader.SizeOfImage);
        return FALSE;
    }
    *image_base = (uintptr_t)(void *)module;
    return TRUE;
}

static BOOL crouch_code_readable(const void *address, size_t length) {
    MEMORY_BASIC_INFORMATION region;
    uintptr_t start = (uintptr_t)address;
    uintptr_t region_end;

    if (VirtualQuery(address, &region, sizeof(region)) != sizeof(region) ||
        region.State != MEM_COMMIT ||
        !crouch_page_is_readable(region.Protect)) {
        return FALSE;
    }
    region_end = (uintptr_t)region.BaseAddress + (uintptr_t)region.RegionSize;
    return start <= region_end && length <= (size_t)(region_end - start);
}

static void crouch_build_absolute_jump(uint8_t *buffer,
                                       size_t length,
                                       const void *destination) {
    uint32_t displacement = 0U;
    uintptr_t destination_value = (uintptr_t)destination;

    memset(buffer, 0x90, length);
    buffer[0] = 0xffU;
    buffer[1] = 0x25U;
    memcpy(buffer + 2U, &displacement, sizeof(displacement));
    memcpy(buffer + 6U, &destination_value, sizeof(destination_value));
}

static BOOL crouch_write_code(void *target,
                              const uint8_t *bytes,
                              size_t length) {
    DWORD old_protect;
    DWORD ignored_protect;

    if (!VirtualProtect(target, length, PAGE_EXECUTE_READWRITE, &old_protect)) {
        return FALSE;
    }
    memcpy(target, bytes, length);
    FlushInstructionCache(GetCurrentProcess(), target, length);
    if (!VirtualProtect(target, length, old_protect, &ignored_protect)) {
        crouch_log(
            "[crouch-parity] warning: code protection restore failed "
            "target=%p error=%lu",
            target,
            (unsigned long)GetLastError());
    }
    return TRUE;
}

static BOOL crouch_commit_jump(void *target,
                               size_t overwrite_length,
                               const void *destination) {
    uint8_t patch[32];

    if (overwrite_length < 14U || overwrite_length > sizeof(patch)) {
        return FALSE;
    }
    crouch_build_absolute_jump(patch, overwrite_length, destination);
    return crouch_write_code(target, patch, overwrite_length);
}

static BOOL crouch_prepare_trampoline(const void *target,
                                      size_t copied_length,
                                      void **trampoline_result) {
    uint8_t *trampoline;
    DWORD ignored_protect;

    trampoline = (uint8_t *)VirtualAlloc(
        NULL,
        copied_length + 14U,
        MEM_COMMIT | MEM_RESERVE,
        PAGE_READWRITE);
    if (trampoline == NULL) {
        return FALSE;
    }
    memcpy(trampoline, target, copied_length);
    crouch_build_absolute_jump(
        trampoline + copied_length,
        14U,
        (const uint8_t *)target + copied_length);
    FlushInstructionCache(
        GetCurrentProcess(), trampoline, copied_length + 14U);
    if (!VirtualProtect(
            trampoline,
            copied_length + 14U,
            PAGE_EXECUTE_READ,
            &ignored_protect)) {
        VirtualFree(trampoline, 0U, MEM_RELEASE);
        return FALSE;
    }
    *trampoline_result = trampoline;
    return TRUE;
}

static BOOL crouch_read_exact(const void *address,
                              void *destination,
                              size_t length) {
    SIZE_T copied = 0U;

    return address != NULL && destination != NULL && length != 0U &&
           ReadProcessMemory(
               GetCurrentProcess(),
               address,
               destination,
               length,
               &copied) &&
           copied == length;
}

/*
 * FUN_1431338d0 resolves an input CP from Network::m_nodeBins.  For output pin
 * zero of NodeDef 20 the exact v26 path is:
 *
 *   *(network + 0x08)                         node-bin array
 *   *(nodeBins + 0x10 + 20 * 0x28)           output-pin entry array
 *   *(pinEntry + 0x00)                        AttribDataFloat
 *   *(attrib + 0x10)                          State_Crouching value
 *
 * Reading this binary CP avoids treating out-of-order worker results from the
 * mobile Blend2 as fresh crouch commands.
 */
static BOOL crouch_read_state_control(void *network,
                                      float *value,
                                      uintptr_t *generation,
                                      uintptr_t *control_generation) {
    uintptr_t node_bins = 0U;
    uintptr_t confirmed_node_bins = 0U;
    uintptr_t pin_entries = 0U;
    uintptr_t confirmed_pin_entries = 0U;
    uintptr_t attrib = 0U;
    float control = 0.0f;
    const uintptr_t pin_offset =
        0x10U + (uintptr_t)CROUCH_CONTROL_NODE_ID * 0x28U;

    if (!crouch_read_exact(
            (const uint8_t *)network + 0x08U,
            &node_bins,
            sizeof(node_bins)) ||
        node_bins == 0U ||
        !crouch_read_exact(
            (const void *)(node_bins + pin_offset),
            &pin_entries,
            sizeof(pin_entries)) ||
        pin_entries == 0U ||
        !crouch_read_exact(
            (const void *)pin_entries,
            &attrib,
            sizeof(attrib)) ||
        attrib == 0U ||
        !crouch_read_exact(
            (const void *)(attrib + 0x10U),
            &control,
            sizeof(control)) ||
        !(control >= 0.0f && control <= 1.0f) ||
        !crouch_read_exact(
            (const uint8_t *)network + 0x08U,
            &confirmed_node_bins,
            sizeof(confirmed_node_bins)) ||
        confirmed_node_bins != node_bins ||
        !crouch_read_exact(
            (const void *)(confirmed_node_bins + pin_offset),
            &confirmed_pin_entries,
            sizeof(confirmed_pin_entries)) ||
        confirmed_pin_entries != pin_entries) {
        return FALSE;
    }
    *value = control;
    *generation = node_bins;
    *control_generation = pin_entries;
    return TRUE;
}

static BOOL crouch_validate_state_identity(
    void *network,
    uintptr_t generation,
    uintptr_t control_generation) {
    uintptr_t confirmed_generation = 0U;
    uintptr_t confirmed_control_generation = 0U;
    const uintptr_t pin_offset =
        0x10U + (uintptr_t)CROUCH_CONTROL_NODE_ID * 0x28U;

    return crouch_read_exact(
               (const uint8_t *)network + 0x08U,
               &confirmed_generation,
               sizeof(confirmed_generation)) &&
        confirmed_generation == generation &&
        crouch_read_exact(
            (const void *)(confirmed_generation + pin_offset),
            &confirmed_control_generation,
            sizeof(confirmed_control_generation)) &&
        confirmed_control_generation == control_generation;
}

static float crouch_current_transition_value(
    crouch_transition_state *state,
    int64_t now_counter,
    BOOL *completed) {
    double duration = state->duration_seconds;
    double elapsed = (double)(now_counter - state->start_counter) /
                     (double)g_crouch_qpc_frequency.QuadPart;
    double unit;
    double blend;

    *completed = FALSE;
    if (elapsed <= 0.0) {
        return state->start_output;
    }
    if (duration <= 0.0) {
        *completed = TRUE;
        return state->target;
    }
    unit = elapsed / duration;
    if (unit >= 1.0) {
        *completed = TRUE;
        return state->target;
    }
    blend = (1.0 - cos(3.14159265358979323846 * unit)) * 0.5;
    return (float)((double)state->start_output +
                   ((double)state->target -
                    (double)state->start_output) * blend);
}

static BOOL crouch_should_log_cache_count(LONG count) {
    return count > 0L &&
        (count <= 8L || (count & (count - 1L)) == 0L);
}

static uint16_t crouch_blend_weight_hook(
    void *attrib_blend_weights,
    void *node_child_weights,
    void *active_node_connections,
    void *network,
    void *node_def,
    float trajectory_weight,
    float events_weight,
    float sampled_events_weight,
    float sync_events_weight,
    unsigned char is_additive) {
    crouch_blend_weight_fn original =
        (crouch_blend_weight_fn)(uintptr_t)
            g_crouch_original_blend_trampoline;
    uint32_t node_type;
    uint16_t node_id;
    float raw = trajectory_weight;
    float control = 0.0f;
    float output;
    float logged_target = 0.0f;
    float logged_start = 0.0f;
    float logged_complete_target = 0.0f;
    float logged_control = 0.0f;
    unsigned int logged_duration_ms = 0U;
    BOOL logged_moving = FALSE;
    BOOL log_started = FALSE;
    BOOL log_completed = FALSE;
    LARGE_INTEGER now;
    uintptr_t network_generation = 0U;
    uintptr_t control_generation = 0U;
    int64_t stale_after_ticks;
    crouch_transition_state *state;
    crouch_state_cache_lookup cache_lookup;
    LONG cache_event_count = 0L;
    LONG64 call_sequence;

    if (original == NULL) {
        return 0xffffU;
    }
    if (node_def == NULL || network == NULL) {
        return original(
            attrib_blend_weights,
            node_child_weights,
            active_node_connections,
            network,
            node_def,
            trajectory_weight,
            events_weight,
            sampled_events_weight,
            sync_events_weight,
            is_additive);
    }
    memcpy(&node_type, node_def, sizeof(node_type));
    memcpy(&node_id, (const uint8_t *)node_def + 8U, sizeof(node_id));
    if (node_type != CROUCH_NODE_TYPE ||
        (node_id != CROUCH_MOVE_NODE_ID &&
         node_id != CROUCH_IDLE_NODE_ID)) {
        return original(
            attrib_blend_weights,
            node_child_weights,
            active_node_connections,
            network,
            node_def,
            trajectory_weight,
            events_weight,
            sampled_events_weight,
            sync_events_weight,
            is_additive);
    }
    if (!(raw >= 0.0f && raw <= 1.0f) ||
        g_crouch_qpc_frequency.QuadPart <= 0) {
        return original(
            attrib_blend_weights,
            node_child_weights,
            active_node_connections,
            network,
            node_def,
            trajectory_weight,
            events_weight,
            sampled_events_weight,
            sync_events_weight,
            is_additive);
    }
    call_sequence = InterlockedIncrement64(&g_crouch_blend_call_count);
    if (!crouch_read_state_control(
            network,
            &control,
            &network_generation,
            &control_generation)) {
        return original(
            attrib_blend_weights,
            node_child_weights,
            active_node_connections,
            network,
            node_def,
            trajectory_weight,
            events_weight,
            sampled_events_weight,
            sync_events_weight,
            is_additive);
    }
    AcquireSRWLockExclusive(&g_crouch_state_lock);
    if (!crouch_validate_state_identity(
            network,
            network_generation,
            control_generation)) {
        ReleaseSRWLockExclusive(&g_crouch_state_lock);
        return original(
            attrib_blend_weights,
            node_child_weights,
            active_node_connections,
            network,
            node_def,
            trajectory_weight,
            events_weight,
            sampled_events_weight,
            sync_events_weight,
            is_additive);
    }
    QueryPerformanceCounter(&now);
    stale_after_ticks = (int64_t)(
        CROUCH_STATE_STALE_SECONDS *
        (double)g_crouch_qpc_frequency.QuadPart +
        0.5);
    state = crouch_state_cache_acquire_hint(
        g_crouch_states,
        CROUCH_STATE_CAPACITY,
        g_crouch_state_hints,
        sizeof(g_crouch_state_hints) / sizeof(g_crouch_state_hints[0]),
        network,
        network_generation,
        control_generation,
        now.QuadPart,
        stale_after_ticks,
        (int64_t)call_sequence,
        &cache_lookup);
    if (state == NULL) {
        BOOL out_of_order =
            cache_lookup.event == CROUCH_STATE_CACHE_OUT_OF_ORDER;

        cache_event_count = InterlockedIncrement(out_of_order
            ? &g_crouch_state_out_of_order_count
            : &g_crouch_state_pressure_count);
        ReleaseSRWLockExclusive(&g_crouch_state_lock);
        if (crouch_should_log_cache_count(cache_event_count)) {
            crouch_log(
                "[crouch-parity] state cache %s count=%ld "
                "capacity=%u network=%p generation=%p controlGeneration=%p; "
                "stock blend retained",
                out_of_order ? "out-of-order" : "pressure",
                (long)cache_event_count,
                (unsigned int)CROUCH_STATE_CAPACITY,
                network,
                (void *)network_generation,
                (void *)control_generation);
        }
        return original(
            attrib_blend_weights,
            node_child_weights,
            active_node_connections,
            network,
            node_def,
            trajectory_weight,
            events_weight,
            sampled_events_weight,
            sync_events_weight,
            is_additive);
    }
    if (cache_lookup.event == CROUCH_STATE_CACHE_EVICTED) {
        cache_event_count = InterlockedIncrement(
            &g_crouch_state_eviction_count);
    } else if (
        cache_lookup.event == CROUCH_STATE_CACHE_STALE_RESET ||
        cache_lookup.event == CROUCH_STATE_CACHE_GENERATION_RESET) {
        cache_event_count = InterlockedIncrement(
            &g_crouch_state_reset_count);
    }
    if (node_id == CROUCH_MOVE_NODE_ID) {
        state->last_move_counter = now.QuadPart;
        state->move_seen = TRUE;
    }
    if (!state->initialized) {
        float desired = control >= 0.5f ? 1.0f : 0.0f;

        state->last_raw = raw;
        state->last_control = control;
        state->last_output = desired;
        state->start_output = desired;
        state->target = desired;
        state->duration_seconds = 0.0;
        state->start_counter = now.QuadPart;
        state->transition_end_counter = 0;
        state->initialized = TRUE;
        output = desired;
    } else {
        BOOL completed = FALSE;
        float desired = control >= 0.5f ? 1.0f : 0.0f;

        if (state->transitioning) {
            output = crouch_current_transition_value(
                state,
                now.QuadPart,
                &completed);
            if (completed) {
                state->transitioning = FALSE;
                state->transition_end_counter = 0;
                log_completed = TRUE;
                logged_complete_target = state->target;
            }
        } else {
            output = state->target;
        }
        if (!state->transitioning) {
            if (desired != state->target) {
                double since_move = state->move_seen
                    ? (double)(now.QuadPart -
                               state->last_move_counter) /
                          (double)g_crouch_qpc_frequency.QuadPart
                    : CROUCH_MOVE_RECENT_SECONDS + 1.0;

                logged_moving = node_id == CROUCH_MOVE_NODE_ID ||
                    (since_move >= 0.0 &&
                     since_move <= CROUCH_MOVE_RECENT_SECONDS);
                state->start_output = state->target;
                state->target = desired;
                state->duration_seconds = logged_moving
                    ? CROUCH_MOVE_SECONDS
                    : (desired > 0.5f
                        ? CROUCH_IDLE_ENTER_SECONDS
                        : CROUCH_IDLE_EXIT_SECONDS);
                state->start_counter = now.QuadPart;
                state->transition_end_counter = now.QuadPart +
                    (int64_t)(
                        state->duration_seconds *
                        (double)g_crouch_qpc_frequency.QuadPart +
                        0.5);
                state->transitioning = TRUE;
                output = state->start_output;
                log_started = TRUE;
                logged_target = desired;
                logged_start = output;
                logged_control = control;
                logged_duration_ms = (unsigned int)(
                    state->duration_seconds * 1000.0 + 0.5);
            }
        }
        state->last_raw = raw;
        state->last_control = control;
        state->last_output = output;
    }
    ReleaseSRWLockExclusive(&g_crouch_state_lock);
    if ((cache_lookup.event == CROUCH_STATE_CACHE_EVICTED ||
         cache_lookup.event == CROUCH_STATE_CACHE_STALE_RESET ||
         cache_lookup.event == CROUCH_STATE_CACHE_GENERATION_RESET) &&
        crouch_should_log_cache_count(cache_event_count)) {
        const char *event_name = cache_lookup.event == CROUCH_STATE_CACHE_EVICTED
            ? "stale-eviction"
            : (cache_lookup.event == CROUCH_STATE_CACHE_GENERATION_RESET
                ? "generation-reset"
                : "stale-reset");

        crouch_log(
            "[crouch-parity] state cache %s count=%ld capacity=%u "
            "oldNetwork=%p oldGeneration=%p oldControlGeneration=%p "
            "network=%p generation=%p controlGeneration=%p",
            event_name,
            (long)cache_event_count,
            (unsigned int)CROUCH_STATE_CAPACITY,
            cache_lookup.previous_network,
            (void *)cache_lookup.previous_generation,
            (void *)cache_lookup.previous_control_generation,
            network,
            (void *)network_generation,
            (void *)control_generation);
    }
    if (log_completed) {
        crouch_log(
            "[crouch-parity] blend transition complete "
            "network=%p sourceNode=%u target=%.3f",
            network,
            (unsigned int)node_id,
            (double)logged_complete_target);
    }
    if (log_started) {
        crouch_log(
            "[crouch-parity] blend transition start "
            "network=%p sourceNode=%u from=%.6f target=%.3f "
            "control=%.3f durationMs=%u moving=%s",
            network,
            (unsigned int)node_id,
            (double)logged_start,
            (double)logged_target,
            (double)logged_control,
            logged_duration_ms,
            logged_moving ? "yes" : "no");
    }
    if (call_sequence <= 16LL) {
        crouch_log(
            "[crouch-parity] blend hook call=%lld node=%u raw=%.6f "
            "events=%.6f sampled=%.6f sync=%.6f control=%.6f "
            "output=%.6f network=%p trampoline=%p",
            (long long)call_sequence,
            (unsigned int)node_id,
            (double)raw,
            (double)events_weight,
            (double)sampled_events_weight,
            (double)sync_events_weight,
            (double)control,
            (double)output,
            network,
            g_crouch_original_blend_trampoline);
    }
    /*
     * Only trajectory/transforms own the visible crouch pose.  The other
     * three weights drive Morpheme event selection and synchronisation and
     * must retain the values computed by the stock graph.  V10 replaced all
     * four with output, which could strand the weapon/ADS event state after
     * the first aim transition.
     */
    return original(
        attrib_blend_weights,
        node_child_weights,
        active_node_connections,
        network,
        node_def,
        output,
        events_weight,
        sampled_events_weight,
        sync_events_weight,
        is_additive);
}

static void crouch_scale_pitch_direct_hook(void *camera,
                                           float delta_seconds) {
    float x;
    float y;

    (void)delta_seconds;
    if (camera == NULL || g_crouch_image_base == 0U) {
        return;
    }
    memcpy(&x, (const uint8_t *)camera + 0x810U, sizeof(x));
    memcpy(&y, (const uint8_t *)camera + 0x814U, sizeof(y));
    *(volatile float *)(void *)(
        g_crouch_image_base + CROUCH_SCALE_PITCH_X_RVA) = x;
    *(volatile float *)(void *)(
        g_crouch_image_base + CROUCH_SCALE_PITCH_Y_RVA) = y;
}

static int crouch_install_runtime_patch(void) {
    uint8_t *blend_target = (uint8_t *)(void *)(
        g_crouch_image_base + CROUCH_BLEND_WEIGHT_RVA);
    uint8_t *scale_pitch_target = (uint8_t *)(void *)(
        g_crouch_image_base + CROUCH_SCALE_PITCH_RVA);
    uint8_t scale_pitch_saved[16];
    void *trampoline = NULL;

    if (!crouch_code_readable(blend_target, 16U) ||
        (g_crouch_enable_camera &&
         !crouch_code_readable(scale_pitch_target, sizeof(scale_pitch_saved)))) {
        return 0;
    }
    if (!QueryPerformanceFrequency(&g_crouch_qpc_frequency) ||
        g_crouch_qpc_frequency.QuadPart <= 0) {
        crouch_log("[crouch-parity] refused: QPC unavailable");
        return -1;
    }
    if (!crouch_prepare_trampoline(blend_target, 16U, &trampoline)) {
        crouch_log(
            "[crouch-parity] trampoline allocation failed error=%lu",
            (unsigned long)GetLastError());
        return -1;
    }
    g_crouch_original_blend_trampoline = trampoline;
    if (g_crouch_enable_camera) {
        memcpy(scale_pitch_saved, scale_pitch_target, sizeof(scale_pitch_saved));
        if (!crouch_commit_jump(
                scale_pitch_target,
                16U,
                (const void *)(uintptr_t)crouch_scale_pitch_direct_hook)) {
            g_crouch_original_blend_trampoline = NULL;
            VirtualFree(trampoline, 0U, MEM_RELEASE);
            crouch_log(
                "[crouch-parity] camera hook failed error=%lu",
                (unsigned long)GetLastError());
            return -1;
        }
    }
    if (!crouch_commit_jump(
            blend_target,
            16U,
            (const void *)(uintptr_t)crouch_blend_weight_hook)) {
        if (g_crouch_enable_camera) {
            (void)crouch_write_code(
                scale_pitch_target,
                scale_pitch_saved,
                sizeof(scale_pitch_saved));
        }
        g_crouch_original_blend_trampoline = NULL;
        VirtualFree(trampoline, 0U, MEM_RELEASE);
        crouch_log(
            "[crouch-parity] animation hook failed; camera hook rolled back "
            "error=%lu",
            (unsigned long)GetLastError());
        return -1;
    }
    crouch_log(
        "[crouch-parity] patch-v2 ADS-safe v12 installed image=%p "
        "animationRva=0x%llx cameraRva=0x%llx "
        "idleEnterMs=400 idleExitMs=200 moveMs=250 "
        "stateCapacity=%u staleMs=2000 camera=%s",
        (void *)g_crouch_image_base,
        (unsigned long long)CROUCH_BLEND_WEIGHT_RVA,
        (unsigned long long)CROUCH_SCALE_PITCH_RVA,
        (unsigned int)CROUCH_STATE_CAPACITY,
        g_crouch_enable_camera ? "direct" : "disabled");
    return 1;
}

static DWORD WINAPI crouch_patch_worker(LPVOID parameter) {
    unsigned int attempt;
    BOOL node_ready = FALSE;

    (void)parameter;
    crouch_log("[crouch-parity] patch-v2 ADS-safe v12 worker started");
    if (!crouch_validate_h1z1_image(&g_crouch_image_base)) {
        return 0U;
    }
    for (attempt = 0U; attempt < 240U; ++attempt) {
        if (!node_ready) {
            size_t candidates = crouch_scan_node_defs();
            if (candidates == 0U) {
                Sleep(250U);
                continue;
            }
            node_ready = TRUE;
            crouch_log(
                "[crouch-parity] NodeDef10151 ready candidates=%llu "
                "attempt=%u",
                (unsigned long long)candidates,
                attempt + 1U);
        }
        int installed = crouch_install_runtime_patch();
        if (installed > 0) {
            return 0U;
        }
        if (installed < 0) {
            return 0U;
        }
        Sleep(100U);
    }
    crouch_log(
        "[crouch-parity] patch-v2 timeout: runtime signatures not found");
    return 0U;
}

static size_t crouch_scan_node_defs(void) {
    /*
     * Exact first 32 bytes of BR1315 v26 NodeDef 10151, the idle
     * StandOrCrouch Blend2 that consumes SmoothFloat node 10154. Relocation
     * starts at +0x20, so this header remains stable after asset loading.
     *
     * This scanner is telemetry-only while the marker selects telemetry. It
     * lets the next patch target the Blend2 connection/weight path actually
     * consumed by the pose graph instead of mutating SmoothFloat's cached
     * AttribData after evaluation.
     */
    static const uint8_t node_header[32] = {
        0x6b, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00,
        0xa7, 0x27, 0xbc, 0x27, 0x02, 0x00, 0x02, 0x00,
        0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0xcd, 0xcd
    };
    SYSTEM_INFO info;
    uintptr_t cursor;
    uintptr_t maximum;
    size_t candidate_count = 0U;
    const size_t chunk_bytes = 256U * 1024U;
    const size_t probe_bytes = sizeof(node_header) + 0xb0U;
    uint8_t *buffer = (uint8_t *)VirtualAlloc(
        NULL,
        chunk_bytes + probe_bytes,
        MEM_COMMIT | MEM_RESERVE,
        PAGE_READWRITE);

    if (buffer == NULL) {
        crouch_log(
            "[crouch-parity] scanner buffer allocation failed error=%lu",
            (unsigned long)GetLastError());
        return 0U;
    }

    GetSystemInfo(&info);
    cursor = (uintptr_t)info.lpMinimumApplicationAddress;
    maximum = (uintptr_t)info.lpMaximumApplicationAddress;
    while (cursor < maximum) {
        MEMORY_BASIC_INFORMATION region;
        SIZE_T queried = VirtualQuery(
            (const void *)cursor, &region, sizeof(region));
        uintptr_t base;
        size_t size;
        size_t region_offset;

        if (queried != sizeof(region)) {
            break;
        }
        base = (uintptr_t)region.BaseAddress;
        size = (size_t)region.RegionSize;
        if (size == 0U || base > UINTPTR_MAX - size) {
            break;
        }
        if (region.State != MEM_COMMIT ||
            region.Type != MEM_PRIVATE ||
            !crouch_page_is_writable(region.Protect) ||
            size < sizeof(node_header) + 0xb0U) {
            cursor = base + size;
            continue;
        }
        for (region_offset = 0U; region_offset < size;) {
            size_t primary_bytes = size - region_offset;
            size_t trailing_bytes;
            size_t requested_bytes;
            SIZE_T copied_bytes = 0U;

            if (primary_bytes > chunk_bytes) {
                primary_bytes = chunk_bytes;
            }
            trailing_bytes = size - region_offset - primary_bytes;
            if (trailing_bytes > probe_bytes - 1U) {
                trailing_bytes = probe_bytes - 1U;
            }
            requested_bytes = primary_bytes + trailing_bytes;
            if (ReadProcessMemory(
                    GetCurrentProcess(),
                    (const void *)(base + region_offset),
                    buffer,
                    requested_bytes,
                    &copied_bytes)) {
                const uint8_t *scan = buffer;
                size_t searchable = primary_bytes;

                if (searchable > (size_t)copied_bytes) {
                    searchable = (size_t)copied_bytes;
                }
                while (searchable != 0U) {
                    const uint8_t *found = (const uint8_t *)memchr(
                        scan, node_header[0], searchable);
                    size_t consumed;
                    size_t found_offset;

                    if (found == NULL) {
                        break;
                    }
                    consumed = (size_t)(found - scan);
                    found_offset = (size_t)(found - buffer);
                    if ((size_t)copied_bytes - found_offset >= probe_bytes &&
                        memcmp(
                            found,
                            node_header,
                            sizeof(node_header)) == 0) {
                        uint64_t qwords[18];
                        size_t index;
                        char values[1024];
                        size_t used = 0U;

                        for (index = 0U; index < 18U; ++index) {
                            memcpy(
                                &qwords[index],
                                found + 0x20U +
                                    index * sizeof(uint64_t),
                                sizeof(uint64_t));
                        }
                        values[0] = '\0';
                        for (index = 0U;
                             index < 18U && used < sizeof(values);
                             ++index) {
                            int appended = snprintf(
                                values + used,
                                sizeof(values) - used,
                                "%s%02x=%016llx",
                                index == 0U ? "" : " ",
                                (unsigned int)(0x20U + index * 8U),
                                (unsigned long long)qwords[index]);
                            if (appended <= 0 ||
                                (size_t)appended >=
                                    sizeof(values) - used) {
                                break;
                            }
                            used += (size_t)appended;
                        }
                        ++candidate_count;
                        crouch_log(
                            "[crouch-parity] NodeDef10151 candidate=%p "
                            "regionType=0x%lx protect=0x%lx %s",
                            (const void *)(
                                base + region_offset + found_offset),
                            (unsigned long)region.Type,
                            (unsigned long)region.Protect,
                            values);
                    }
                    scan = found + 1;
                    searchable -= consumed + 1U;
                }
            }
            region_offset += primary_bytes;
        }
        cursor = base + size;
    }
    VirtualFree(buffer, 0U, MEM_RELEASE);
    return candidate_count;
}

static DWORD WINAPI crouch_probe_worker(LPVOID parameter) {
    unsigned int attempt;

    (void)parameter;
    crouch_log(
        "[crouch-parity] telemetry worker started nodeType=%u "
        "moveNodeId=%u idleNodeId=%u",
        (unsigned int)CROUCH_NODE_TYPE,
        (unsigned int)CROUCH_MOVE_NODE_ID,
        (unsigned int)CROUCH_IDLE_NODE_ID);
    for (attempt = 0U; attempt < 240U; ++attempt) {
        size_t candidates = crouch_scan_node_defs();
        if (candidates != 0U) {
            crouch_log(
                "[crouch-parity] telemetry complete candidates=%llu attempt=%u",
                (unsigned long long)candidates,
                attempt + 1U);
            return 0U;
        }
        Sleep(250U);
    }
    crouch_log("[crouch-parity] telemetry timeout: NodeDef10151 not found");
    return 0U;
}

static void crouch_parity_start(void) {
    crouch_mode mode;
    LPTHREAD_START_ROUTINE worker_entry;
    HANDLE worker;

    if (InterlockedCompareExchange(
            &g_crouch_worker_started, 1L, 0L) != 0L) {
        return;
    }
    mode = crouch_read_mode();
    if (mode == CROUCH_MODE_DISABLED) {
        return;
    }
    worker_entry = (mode == CROUCH_MODE_PATCH_V1 ||
                    mode == CROUCH_MODE_PATCH_V2)
        ? crouch_patch_worker
        : crouch_probe_worker;
    worker = CreateThread(NULL, 0U, worker_entry, NULL, 0U, NULL);
    if (worker == NULL) {
        crouch_log(
            "[crouch-parity] CreateThread failed error=%lu",
            (unsigned long)GetLastError());
        return;
    }
    CloseHandle(worker);
}

#endif
