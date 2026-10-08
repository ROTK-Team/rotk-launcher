#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <time.h>

typedef int32_t HSteamPipe;
typedef int32_t HSteamUser;
typedef int SteamAPICall_t;

#define GENERIC_VTABLE_SIZE 256
#define INTERFACE_VTABLE_SIZE 256
#define STEAMCLIENT_VTABLE_SIZE 64
#define MAX_REGISTERED_CALLBACKS 128
#define MAX_REGISTERED_CALLRESULTS 64

EXTERN_C IMAGE_DOS_HEADER __ImageBase;

typedef struct DummyObject {
    void **vtable;
    const char *name;
} DummyObject;

typedef struct RegisteredCallback {
    void *callback;
    int callback_id;
    int dispatched_once;
} RegisteredCallback;

typedef struct RegisteredCallResult {
    void *callback;
    SteamAPICall_t api_call;
} RegisteredCallResult;

static CRITICAL_SECTION g_log_lock;
static int g_log_lock_ready = 0;
static LONG g_log_config_initialized = 0;
static LONG g_log_enabled = 0;
static const DWORD64 g_log_size_limit_bytes = 16ULL * 1024ULL * 1024ULL;
static LONG g_interface_counter = 0;
static LONG g_run_callbacks_counter = 0;
static RegisteredCallback g_registered_callbacks[MAX_REGISTERED_CALLBACKS];
static LONG g_registered_callback_count = 0;
static RegisteredCallResult g_registered_callresults[MAX_REGISTERED_CALLRESULTS];
static LONG g_registered_callresult_count = 0;
static LONG g_boot_callbacks_dispatched = 0;
static uint64_t g_fake_steam_id = 76561198000000001ULL;
static LONG g_fake_steam_id_initialized = 0;
static const uint64_t g_fake_lobby_id = 109775241000000001ULL;
static const uint32_t g_fake_app_id = 295110U;
static char g_fake_persona_name[128] = "LocalPlayer";
static const unsigned char g_fake_ticket[] = {
    0x48, 0x31, 0x5A, 0x31, 0x2D, 0x4E, 0x4F, 0x53,
    0x54, 0x45, 0x41, 0x4D, 0x2D, 0x54, 0x49, 0x43,
    0x4B, 0x45, 0x54, 0x2D, 0x30, 0x31, 0x00, 0x11,
    0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99
};
static const char g_fake_country[] = "FR";
static const char g_fake_language[] = "english";
static const char g_fake_empty[] = "";
static char g_fake_match_id[32] = "0";
static char g_fake_selected_match[32] = "0";
static char g_fake_lobby_member_in_game[8] = "0";
static char g_fake_lobby_status[128] = "Z1BR  - Main Menu";
static char g_fake_lobby_name[128] = "Codex Lobby";
static char g_fake_lobby_owner[128] = "LocalPlayer";
static char g_fake_lobby_server[128] = "";
static char g_fake_lobby_character[64] = "";
static char g_fake_lobby_daybreak_user_id[32] = "";
static char g_fake_lobby_daybreak_char_id[64] = "";
static char g_fake_lobby_datacenter[32] = "AMS";
static char g_fake_lobby_ready[8] = "0";
static char g_fake_lobby_viewing_hosted_games[8] = "0";
static char g_fake_selected_match_role[8] = "0";
static char g_fake_selected_match_can_enter[8] = "-1";
static char g_fake_selected_match_id[32] = "0";
static const uintptr_t g_fake_lobby_member_limit = 5;
static LONG g_fake_lobby_data_dispatched = 0;
static const char *g_fake_rich_presence_keys[] = {
    "status",
    "h1z1_server",
    "h1z1_character",
    "matchId",
    "inGame",
    "h1z1_inmatch"
};

static void log_line(const char *format, ...);

static int is_env_truthy(const char *value) {
    if (value == NULL || value[0] == '\0') {
        return 0;
    }
    return (
        _stricmp(value, "1") == 0 ||
        _stricmp(value, "true") == 0 ||
        _stricmp(value, "yes") == 0 ||
        _stricmp(value, "on") == 0
    );
}

static int is_logging_enabled(void) {
    char value[32];
    DWORD length;

    if (InterlockedCompareExchange(&g_log_config_initialized, 1, 0) == 0) {
        length = GetEnvironmentVariableA("H1Z1_STEAMSHIM_LOG", value, (DWORD)sizeof(value));
        if (length > 0 && length < sizeof(value) && is_env_truthy(value)) {
            InterlockedExchange(&g_log_enabled, 1);
        }
    }

    return InterlockedCompareExchange(&g_log_enabled, 0, 0) != 0;
}

static uint64_t parse_steam_id_env_value(const char *name) {
    char value[64];
    DWORD length = GetEnvironmentVariableA(name, value, (DWORD)sizeof(value));
    uint64_t parsed = 0;

    if (length == 0 || length >= sizeof(value)) {
        return 0;
    }

    for (DWORD i = 0; i < length; i++) {
        char c = value[i];
        if (c < '0' || c > '9') {
            return 0;
        }
        parsed = (parsed * 10ULL) + (uint64_t)(c - '0');
    }

    return parsed;
}

static void initialize_fake_steam_id_from_env(void) {
    uint64_t parsed = 0;

    if (InterlockedCompareExchange(&g_fake_steam_id_initialized, 1, 0) != 0) {
        return;
    }

    parsed = parse_steam_id_env_value("STEAMID");
    if (parsed == 0) {
        parsed = parse_steam_id_env_value("H1Z1_OVERRIDE_STEAMID");
    }
    if (parsed != 0) {
        g_fake_steam_id = parsed;
    }

    log_line("NoSteam fake SteamID=%llu", (unsigned long long)g_fake_steam_id);
}

static int is_fake_or_self_steam_id(uint64_t steam_id) {
    initialize_fake_steam_id_from_env();
    return steam_id == 0 || steam_id == g_fake_steam_id;
}

static const char *get_fake_rich_presence_value(const char *key) {
    if (key == NULL || key[0] == '\0') {
        return g_fake_empty;
    }
    if (_stricmp(key, "status") == 0) {
        return g_fake_lobby_status;
    }
    if (_stricmp(key, "h1z1_server") == 0) {
        return g_fake_lobby_server;
    }
    if (_stricmp(key, "h1z1_character") == 0) {
        return g_fake_lobby_character;
    }
    if (_stricmp(key, "matchId") == 0) {
        return g_fake_match_id;
    }
    if (_stricmp(key, "SelectedMatch") == 0) {
        return g_fake_selected_match;
    }
    if (_stricmp(key, "inGame") == 0) {
        return g_fake_lobby_member_in_game;
    }
    if (_stricmp(key, "h1z1_inmatch") == 0) {
        return g_fake_lobby_member_in_game;
    }
    return g_fake_empty;
}

static void log_line(const char *format, ...);
static uintptr_t generic_interface_method(DummyObject *self, int index, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4);
static DummyObject *create_interface_for_version(const char *version);
static int try_read_ascii_c_string(uintptr_t address, char *buffer, size_t buffer_len);
static int try_format_pointer_preview(uintptr_t address, char *buffer, size_t buffer_len);
static int can_access_process_memory(uintptr_t address, size_t size, int require_write);
static void populate_callback_payload(int callback_id, unsigned char *buffer, size_t size);
static void dispatch_callbacks_by_id(int callback_id, const char *origin, int force_repeat);
static uintptr_t write_steam_id_return_buffer(const char *method_name, uintptr_t return_buffer, uint64_t steam_id);
static uint64_t normalize_steam_id_argument(uintptr_t raw_value);
#include "menu_duo_native.h"

static const char *get_callback_name(int callback_id) {
    switch (callback_id) {
        case 152: return "MicroTxnAuthorizationResponse_t";
        case 154: return "EncryptedAppTicketResponse_t";
        case 304: return "PersonaStateChange_t";
        case 331: return "GameOverlayActivated_t";
        case 333: return "GameLobbyJoinRequested_t";
        case 504: return "LobbyEnter_t";
        case 334: return "AvatarImageLoaded_t";
        case 505: return "LobbyDataUpdate_t";
        case 506: return "LobbyChatUpdate_t";
        case 507: return "LobbyChatMsg_t";
        case 513: return "LobbyCreated_t";
        case 1101: return "UserStatsReceived_t";
        case 1102: return "UserStatsStored_t";
        case 1103: return "UserAchievementStored_t";
        default: return "UnknownCallback";
    }
}

typedef struct CallbackBaseLayout {
    void **vtable;
    int callback_flags;
    int callback_id;
} CallbackBaseLayout;

typedef void (*SteamCallbackRunFn)(void *self, void *param);
typedef void (*SteamCallbackRunCallResultFn)(void *self, void *param, uint8_t io_failure, SteamAPICall_t api_call);
typedef int (*SteamCallbackGetSizeFn)(void *self);

static int get_callback_size_fallback(int callback_id) {
    switch (callback_id) {
        case 152: return 24;
        case 304: return 16;
        case 331: return 8;
        case 333: return 16;
        case 504: return 24;
        case 334: return 24;
        case 505: return 24;
        case 506: return 32;
        case 507: return 24;
        case 154: return 4;
        case 513: return 16;
        case 1101: return 24;
        case 1102: return 16;
        case 1103: return 160;
        default: return 32;
    }
}

static int should_dispatch_boot_callback(int callback_id) {
    switch (callback_id) {
        case 304:
        case 331:
        case 334:
            return 1;
        default:
            return 0;
    }
}

static void maybe_dispatch_lobby_data_update(const char *origin, int force_repeat) {
    if (force_repeat || InterlockedCompareExchange(&g_fake_lobby_data_dispatched, 1, 0) == 0) {
        dispatch_callbacks_by_id(505, origin, 1);
    }
}

static void write_u8(unsigned char *buffer, size_t size, size_t offset, uint8_t value) {
    if (offset + 1 <= size) {
        buffer[offset] = value;
    }
}

static void write_u32(unsigned char *buffer, size_t size, size_t offset, uint32_t value) {
    if (offset + sizeof(uint32_t) <= size) {
        memcpy(buffer + offset, &value, sizeof(uint32_t));
    }
}

static void write_u16(unsigned char *buffer, size_t size, size_t offset, uint16_t value) {
    if (offset + sizeof(uint16_t) <= size) {
        memcpy(buffer + offset, &value, sizeof(uint16_t));
    }
}

static void write_u64(unsigned char *buffer, size_t size, size_t offset, uint64_t value) {
    if (offset + sizeof(uint64_t) <= size) {
        memcpy(buffer + offset, &value, sizeof(uint64_t));
    }
}

static void write_string(unsigned char *buffer, size_t size, size_t offset, const char *value, size_t max_write) {
    if (offset >= size || value == NULL) {
        return;
    }
    size_t remaining = size - offset;
    size_t to_copy = strlen(value);
    if (to_copy > max_write) {
        to_copy = max_write;
    }
    if (to_copy > remaining) {
        to_copy = remaining;
    }
    memcpy(buffer + offset, value, to_copy);
}

static void populate_callback_payload(int callback_id, unsigned char *buffer, size_t size) {
    memset(buffer, 0, size);

    switch (callback_id) {
        case 152:
            write_u32(buffer, size, 0, g_fake_app_id);
            write_u64(buffer, size, 8, 0x100000000ULL);
            write_u8(buffer, size, 16, 1);
            break;
        case 304:
            write_u64(buffer, size, 0, g_fake_steam_id);
            write_u32(buffer, size, 8, 0xFFFFFFFFU);
            break;
        case 331:
            write_u8(buffer, size, 0, 0);
            write_u8(buffer, size, 1, 0);
            write_u32(buffer, size, 4, g_fake_app_id);
            break;
        case 333:
            write_u64(buffer, size, 0, g_fake_lobby_id);
            write_u64(buffer, size, 8, g_fake_steam_id);
            break;
        case 504:
            write_u64(buffer, size, 0, g_fake_lobby_id);
            write_u32(buffer, size, 8, 0xFFFFFFFFU);
            write_u8(buffer, size, 12, 0);
            write_u32(buffer, size, 16, 1);
            break;
        case 334:
            write_u64(buffer, size, 0, g_fake_steam_id);
            write_u32(buffer, size, 8, 1);
            write_u32(buffer, size, 12, 184);
            write_u32(buffer, size, 16, 184);
            break;
        case 505:
            write_u64(buffer, size, 0, g_fake_lobby_id);
            write_u64(buffer, size, 8, g_menu_duo_callback_member ? g_menu_duo_callback_member : g_fake_steam_id);
            write_u8(buffer, size, 16, 1);
            break;
        case 506:
            write_u64(buffer, size, 0, g_fake_lobby_id);
            write_u64(buffer, size, 8, g_menu_duo_callback_member ? g_menu_duo_callback_member : g_fake_steam_id);
            write_u64(buffer, size, 16, g_menu_duo_callback_member ? g_menu_duo_callback_member : g_fake_steam_id);
            write_u32(buffer, size, 24, g_menu_duo_callback_change);
            break;
        case 507:
            write_u64(buffer, size, 0, g_fake_lobby_id);
            write_u64(buffer, size, 8, g_fake_steam_id);
            write_u8(buffer, size, 16, 1);
            write_u32(buffer, size, 20, 1);
            break;
        case 513:
            write_u32(buffer, size, 0, 1);
            write_u64(buffer, size, 8, g_fake_lobby_id);
            break;
        case 154:
            write_u32(buffer, size, 0, 1);
            break;
        case 1101:
            write_u64(buffer, size, 0, (uint64_t)g_fake_app_id);
            write_u32(buffer, size, 8, 1);
            write_u64(buffer, size, 16, g_fake_steam_id);
            break;
        case 1102:
            write_u64(buffer, size, 0, (uint64_t)g_fake_app_id);
            write_u32(buffer, size, 8, 1);
            break;
        case 1103:
            write_u64(buffer, size, 0, (uint64_t)g_fake_app_id);
            write_u8(buffer, size, 8, 0);
            write_string(buffer, size, 16, "boot", 127);
            write_u32(buffer, size, 144, 0);
            write_u32(buffer, size, 148, 0);
            break;
        default:
            break;
    }
}

static void dispatch_single_callback(RegisteredCallback *entry, const char *origin) {
    if (entry == NULL || entry->callback == NULL) {
        return;
    }

    CallbackBaseLayout *callback = (CallbackBaseLayout *)entry->callback;
    if (callback->vtable == NULL) {
        log_line("Callback dispatch skipped: callback=%p has null vtable", entry->callback);
        return;
    }

    int size = 0;
    SteamCallbackGetSizeFn get_size = (SteamCallbackGetSizeFn)callback->vtable[2];
    if (get_size != NULL) {
        size = get_size(entry->callback);
    }
    if (size <= 0 || size > 4096) {
        size = get_callback_size_fallback(entry->callback_id);
    }

    unsigned char *buffer = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)size);
    if (buffer == NULL) {
        log_line("Callback dispatch failed: out of memory for callback_id=%d", entry->callback_id);
        return;
    }

    populate_callback_payload(entry->callback_id, buffer, (size_t)size);

    SteamCallbackRunFn run_fn = (SteamCallbackRunFn)callback->vtable[0];
    if (run_fn != NULL) {
        log_line(
            "Dispatching callback from %s: id=%d name=%s callback=%p size=%d",
            origin,
            entry->callback_id,
            get_callback_name(entry->callback_id),
            entry->callback,
            size
        );
        run_fn(entry->callback, buffer);
        entry->dispatched_once = 1;
    }

    HeapFree(GetProcessHeap(), 0, buffer);
}

static void dispatch_boot_callbacks_if_needed(const char *origin) {
    for (int i = 0; i < MAX_REGISTERED_CALLBACKS; ++i) {
        RegisteredCallback *entry = &g_registered_callbacks[i];
        if (entry->callback == NULL || entry->dispatched_once) {
            continue;
        }
        if (!should_dispatch_boot_callback(entry->callback_id)) {
            continue;
        }
        dispatch_single_callback(entry, origin);
    }
}

static void dispatch_callbacks_by_id(int callback_id, const char *origin, int force_repeat) {
    for (int i = 0; i < MAX_REGISTERED_CALLBACKS; ++i) {
        RegisteredCallback *entry = &g_registered_callbacks[i];
        if (entry->callback == NULL) {
            continue;
        }
        if (entry->callback_id != callback_id) {
            continue;
        }
        if (!force_repeat && entry->dispatched_once) {
            continue;
        }
        if (force_repeat) {
            entry->dispatched_once = 0;
        }
        dispatch_single_callback(entry, origin);
    }
}

static void remember_registered_callback(void *callback, int callback_id) {
    for (int i = 0; i < MAX_REGISTERED_CALLBACKS; ++i) {
        if (g_registered_callbacks[i].callback == callback || g_registered_callbacks[i].callback == NULL) {
            if (g_registered_callbacks[i].callback == NULL) {
                InterlockedIncrement(&g_registered_callback_count);
            }
            g_registered_callbacks[i].callback = callback;
            g_registered_callbacks[i].callback_id = callback_id;
            g_registered_callbacks[i].dispatched_once = 0;
            return;
        }
    }
}

static void forget_registered_callback(void *callback) {
    for (int i = 0; i < MAX_REGISTERED_CALLBACKS; ++i) {
        if (g_registered_callbacks[i].callback == callback) {
            g_registered_callbacks[i].callback = NULL;
            g_registered_callbacks[i].callback_id = 0;
            g_registered_callbacks[i].dispatched_once = 0;
            InterlockedDecrement(&g_registered_callback_count);
            return;
        }
    }
}

static void remember_registered_callresult(void *callback, SteamAPICall_t api_call) {
    for (int i = 0; i < MAX_REGISTERED_CALLRESULTS; ++i) {
        if (g_registered_callresults[i].callback == callback || g_registered_callresults[i].callback == NULL) {
            if (g_registered_callresults[i].callback == NULL) {
                InterlockedIncrement(&g_registered_callresult_count);
            }
            g_registered_callresults[i].callback = callback;
            g_registered_callresults[i].api_call = api_call;
            return;
        }
    }
}

static void forget_registered_callresult(void *callback, SteamAPICall_t api_call) {
    for (int i = 0; i < MAX_REGISTERED_CALLRESULTS; ++i) {
        if (g_registered_callresults[i].callback == callback && g_registered_callresults[i].api_call == api_call) {
            g_registered_callresults[i].callback = NULL;
            g_registered_callresults[i].api_call = 0;
            InterlockedDecrement(&g_registered_callresult_count);
            return;
        }
    }
}

typedef struct PendingCallResult {
    SteamAPICall_t api_call;
    int callback_id;
} PendingCallResult;

#define MAX_PENDING_CALLRESULTS 64
static PendingCallResult g_pending_callresults[MAX_PENDING_CALLRESULTS];
static LONG g_pending_callresult_count = 0;
static LONG g_next_api_call_handle = 100;

static SteamAPICall_t queue_callresult(int callback_id) {
    SteamAPICall_t handle = (SteamAPICall_t)InterlockedIncrement(&g_next_api_call_handle);
    for (int i = 0; i < MAX_PENDING_CALLRESULTS; ++i) {
        if (g_pending_callresults[i].api_call == 0) {
            g_pending_callresults[i].api_call = handle;
            g_pending_callresults[i].callback_id = callback_id;
            InterlockedIncrement(&g_pending_callresult_count);
            return handle;
        }
    }
    return handle;
}

static int get_callresult_callback_id(SteamAPICall_t api_call) {
    for (int i = 0; i < MAX_PENDING_CALLRESULTS; ++i) {
        if (g_pending_callresults[i].api_call == api_call) {
            int cb_id = g_pending_callresults[i].callback_id;
            g_pending_callresults[i].api_call = 0;
            g_pending_callresults[i].callback_id = 0;
            InterlockedDecrement(&g_pending_callresult_count);
            return cb_id;
        }
    }
    return 0;
}

static void dispatch_registered_callresults_if_needed(const char *origin) {
    for (int i = 0; i < MAX_REGISTERED_CALLRESULTS; ++i) {
        RegisteredCallResult *entry = &g_registered_callresults[i];
        if (entry->callback == NULL || entry->api_call == 0) {
            continue;
        }

        int callback_id = get_callresult_callback_id(entry->api_call);
        if (callback_id == 0) {
            continue;
        }

        CallbackBaseLayout *callback = (CallbackBaseLayout *)entry->callback;
        if (callback->vtable == NULL) {
            continue;
        }

        int size = 0;
        SteamCallbackGetSizeFn get_size = (SteamCallbackGetSizeFn)callback->vtable[2];
        if (get_size != NULL) {
            size = get_size(entry->callback);
        }
        if (size <= 0 || size > 4096) {
            size = get_callback_size_fallback(callback_id);
        }

        unsigned char *buffer = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)size);
        if (buffer == NULL) {
            continue;
        }

        populate_callback_payload(callback_id, buffer, (size_t)size);

        SteamCallbackRunCallResultFn run_callresult_fn = (SteamCallbackRunCallResultFn)callback->vtable[1];
        if (run_callresult_fn != NULL) {
            log_line(
                "Dispatching call result from %s: api_call=%d callback_id=%d name=%s callback=%p size=%d",
                origin,
                entry->api_call,
                callback_id,
                get_callback_name(callback_id),
                entry->callback,
                size
            );
            run_callresult_fn(entry->callback, buffer, 0, entry->api_call);
        }

        HeapFree(GetProcessHeap(), 0, buffer);
        void *callback_ptr = entry->callback;
        SteamAPICall_t api_call = entry->api_call;
        forget_registered_callresult(callback_ptr, api_call);
    }
}

static void ensure_log_lock(void) {
    if (g_log_lock_ready) {
        return;
    }
    InitializeCriticalSection(&g_log_lock);
    g_log_lock_ready = 1;
}

static void get_game_directory(char *buffer, size_t buffer_len) {
    char module_path[MAX_PATH];
    DWORD size = GetModuleFileNameA((HMODULE)&__ImageBase, module_path, MAX_PATH);
    if (size == 0 || size >= MAX_PATH) {
        lstrcpynA(buffer, ".", (int)buffer_len);
        return;
    }

    char *last_sep = module_path;
    for (char *cursor = module_path; *cursor; ++cursor) {
        if (*cursor == '\\' || *cursor == '/') {
            last_sep = cursor;
        }
    }

    if (*last_sep == '\\' || *last_sep == '/') {
        *last_sep = '\0';
    }

    _snprintf(buffer, buffer_len, "%s", module_path);
    buffer[buffer_len - 1] = '\0';
}

static void get_log_path(char *buffer, size_t buffer_len) {
    char game_dir[MAX_PATH];
    get_game_directory(game_dir, sizeof(game_dir));
    _snprintf(buffer, buffer_len, "%s\\steam_api64.log", game_dir);
    buffer[buffer_len - 1] = '\0';
}

static void log_line(const char *format, ...) {
    if (!is_logging_enabled()) {
        return;
    }

    ensure_log_lock();
    EnterCriticalSection(&g_log_lock);

    char log_path[MAX_PATH];
    get_log_path(log_path, sizeof(log_path));

    WIN32_FILE_ATTRIBUTE_DATA log_attributes;
    if (GetFileAttributesExA(log_path, GetFileExInfoStandard, &log_attributes)) {
        DWORD64 size =
            ((DWORD64)log_attributes.nFileSizeHigh << 32) |
            (DWORD64)log_attributes.nFileSizeLow;
        if (size >= g_log_size_limit_bytes) {
            LeaveCriticalSection(&g_log_lock);
            return;
        }
    }

    FILE *file = fopen(log_path, "a");
    if (file != NULL) {
        SYSTEMTIME st;
        GetLocalTime(&st);
        fprintf(
            file,
            "[%04d-%02d-%02d %02d:%02d:%02d.%03d] ",
            st.wYear,
            st.wMonth,
            st.wDay,
            st.wHour,
            st.wMinute,
            st.wSecond,
            st.wMilliseconds
        );

        va_list args;
        va_start(args, format);
        vfprintf(file, format, args);
        va_end(args);

        fputc('\n', file);
        fclose(file);
    }

    LeaveCriticalSection(&g_log_lock);
}

static uint32_t get_unix_time_now(void) {
    FILETIME file_time;
    GetSystemTimeAsFileTime(&file_time);
    ULARGE_INTEGER ull;
    ull.LowPart = file_time.dwLowDateTime;
    ull.HighPart = file_time.dwHighDateTime;
    return (uint32_t)((ull.QuadPart - 116444736000000000ULL) / 10000000ULL);
}

static void fill_buffer_with_ticket(void *buffer, int max_size, unsigned int *out_size) {
    unsigned int to_copy = (unsigned int)sizeof(g_fake_ticket);
    if (max_size < 0) {
        max_size = 0;
    }
    if ((unsigned int)max_size < to_copy) {
        to_copy = (unsigned int)max_size;
    }

    if (buffer != NULL && to_copy > 0) {
        memcpy(buffer, g_fake_ticket, to_copy);
    }
    if (out_size != NULL) {
        *out_size = to_copy;
    }
}

static void set_fake_lobby_value(char *target, size_t target_size, const char *value) {
    if (target == NULL || target_size == 0 || value == NULL || value[0] == '\0') {
        return;
    }
    lstrcpynA(target, value, (int)target_size);
}

static void trim_trailing_ascii_whitespace(char *value) {
    if (value == NULL) {
        return;
    }

    size_t length = strlen(value);
    while (length > 0) {
        char tail = value[length - 1];
        if (tail != '\r' && tail != '\n' && tail != '\t' && tail != ' ') {
            break;
        }
        value[length - 1] = '\0';
        length -= 1;
    }
}

static void get_persona_name_path(char *buffer, size_t buffer_len) {
    char game_dir[MAX_PATH];
    get_game_directory(game_dir, sizeof(game_dir));
    _snprintf(buffer, buffer_len, "%s\\steam_persona_name.txt", game_dir);
    buffer[buffer_len - 1] = '\0';
}

static void set_fake_persona_name_value(const char *value) {
    if (value == NULL || value[0] == '\0') {
        return;
    }

    lstrcpynA(g_fake_persona_name, value, (int)sizeof(g_fake_persona_name));
    set_fake_lobby_value(g_fake_lobby_owner, sizeof(g_fake_lobby_owner), value);
}

static void refresh_fake_persona_name_from_disk(void) {
    char persona_path[MAX_PATH];
    char persona_name[sizeof(g_fake_persona_name)];
    FILE *file;
    size_t bytes_read;

    get_persona_name_path(persona_path, sizeof(persona_path));
    file = fopen(persona_path, "rb");
    if (file == NULL) {
        return;
    }

    bytes_read = fread(persona_name, 1, sizeof(persona_name) - 1, file);
    fclose(file);
    if (bytes_read == 0) {
        return;
    }

    persona_name[bytes_read] = '\0';
    trim_trailing_ascii_whitespace(persona_name);
    set_fake_persona_name_value(persona_name);
}

static const char *get_active_fake_persona_name(void) {
    refresh_fake_persona_name_from_disk();
    if (g_fake_lobby_character[0] != '\0') {
        return g_fake_lobby_character;
    }
    if (g_fake_persona_name[0] != '\0') {
        return g_fake_persona_name;
    }
    return "LocalPlayer";
}

static void clear_fake_lobby_value(char *target, size_t target_size) {
    if (target == NULL || target_size == 0) {
        return;
    }
    target[0] = '\0';
}

static void reset_fake_main_menu_state(void) {
    lstrcpynA(g_fake_match_id, "0", (int)sizeof(g_fake_match_id));
    lstrcpynA(g_fake_selected_match, "0", (int)sizeof(g_fake_selected_match));
    lstrcpynA(g_fake_selected_match_id, "0", (int)sizeof(g_fake_selected_match_id));
    lstrcpynA(g_fake_lobby_member_in_game, "0", (int)sizeof(g_fake_lobby_member_in_game));
    lstrcpynA(g_fake_lobby_status, "Z1BR  - Main Menu", (int)sizeof(g_fake_lobby_status));
    lstrcpynA(g_fake_lobby_ready, "0", (int)sizeof(g_fake_lobby_ready));
    lstrcpynA(g_fake_lobby_viewing_hosted_games, "0", (int)sizeof(g_fake_lobby_viewing_hosted_games));
    lstrcpynA(g_fake_selected_match_role, "0", (int)sizeof(g_fake_selected_match_role));
    lstrcpynA(g_fake_selected_match_can_enter, "-1", (int)sizeof(g_fake_selected_match_can_enter));
    if (g_fake_lobby_datacenter[0] == '\0') {
        lstrcpynA(g_fake_lobby_datacenter, "AMS", (int)sizeof(g_fake_lobby_datacenter));
    }
    g_fake_lobby_server[0] = '\0';
    g_fake_lobby_character[0] = '\0';
}

static void ensure_fake_lobby_selection_state(const char *origin) {
    if (g_fake_match_id[0] == '\0') {
        lstrcpynA(g_fake_match_id, "0", (int)sizeof(g_fake_match_id));
    }
    if (g_fake_selected_match[0] == '\0') {
        lstrcpynA(g_fake_selected_match, g_fake_match_id, (int)sizeof(g_fake_selected_match));
    }
    if (origin != NULL) {
        log_line(
            "%s -> ensured fake lobby selection state matchId=%s selectedMatch=%s",
            origin,
            g_fake_match_id,
            g_fake_selected_match
        );
    }
}

static void ensure_fake_lobby_bootstrap_state(const char *origin) {
    ensure_fake_lobby_selection_state(origin);

    if (g_fake_lobby_datacenter[0] == '\0') {
        lstrcpynA(g_fake_lobby_datacenter, "AMS", (int)sizeof(g_fake_lobby_datacenter));
    }
    if (g_fake_lobby_ready[0] == '\0') {
        lstrcpynA(g_fake_lobby_ready, "0", (int)sizeof(g_fake_lobby_ready));
    }
    if (g_fake_lobby_viewing_hosted_games[0] == '\0') {
        lstrcpynA(g_fake_lobby_viewing_hosted_games, "0", (int)sizeof(g_fake_lobby_viewing_hosted_games));
    }
    if (g_fake_selected_match_role[0] == '\0') {
        lstrcpynA(g_fake_selected_match_role, "0", (int)sizeof(g_fake_selected_match_role));
    }
    if (g_fake_selected_match_can_enter[0] == '\0') {
        lstrcpynA(g_fake_selected_match_can_enter, "-1", (int)sizeof(g_fake_selected_match_can_enter));
    }
    if (g_fake_selected_match_id[0] == '\0' && g_fake_selected_match[0] != '\0') {
        lstrcpynA(g_fake_selected_match_id, g_fake_selected_match, (int)sizeof(g_fake_selected_match_id));
    }
}

static const char *lookup_fake_lobby_value(const char *key) {
    if (key == NULL || key[0] == '\0') {
        return g_fake_empty;
    }
    if (_stricmp(key, "status") == 0) {
        return g_fake_lobby_status;
    }
    if (_stricmp(key, "name") == 0) {
        return g_fake_lobby_name;
    }
    if (_stricmp(key, "owner") == 0) {
        return g_fake_lobby_owner;
    }
    if (_stricmp(key, "h1z1_server") == 0) {
        return g_fake_lobby_server;
    }
    if (_stricmp(key, "h1z1_character") == 0) {
        return g_fake_lobby_character;
    }
    if (_stricmp(key, "daybreakUserId") == 0) {
        return g_fake_lobby_daybreak_user_id;
    }
    if (_stricmp(key, "daybreakCharId") == 0) {
        return g_fake_lobby_daybreak_char_id[0] ? g_fake_lobby_daybreak_char_id : g_fake_lobby_character;
    }
    if (_stricmp(key, "matchId") == 0) {
        return g_fake_match_id;
    }
    if (_stricmp(key, "SelectedMatch") == 0) {
        return g_fake_selected_match;
    }
    if (_stricmp(key, "inGame") == 0 || _stricmp(key, "h1z1_inmatch") == 0) {
        return g_fake_lobby_member_in_game;
    }
    if (_stricmp(key, "datacenter") == 0) {
        return g_fake_lobby_datacenter;
    }
    if (_stricmp(key, "ready") == 0) {
        return g_fake_lobby_ready;
    }
    if (_stricmp(key, "ViewingHostedGames") == 0) {
        return g_fake_lobby_viewing_hosted_games;
    }
    if (_stricmp(key, "SelectedMatchRole") == 0) {
        return g_fake_selected_match_role;
    }
    if (_stricmp(key, "SelectedMatchCanEnter") == 0) {
        return g_fake_selected_match_can_enter;
    }
    if (_stricmp(key, "SelectedMatchId") == 0) {
        return g_fake_selected_match_id[0] ? g_fake_selected_match_id : g_fake_selected_match;
    }
    return g_fake_empty;
}

static void sync_fake_boot_match_state(const char *origin, const char *value) {
    if (value == NULL) {
        return;
    }

    if (value[0] == '\0' || strcmp(value, "0") == 0) {
        lstrcpynA(g_fake_lobby_member_in_game, "0", (int)sizeof(g_fake_lobby_member_in_game));
        ensure_fake_lobby_selection_state(origin);
        log_line(
            "%s -> cleared fake NoSteam inGame only (matchId=%s selectedMatch=%s)",
            origin,
            g_fake_match_id,
            g_fake_selected_match
        );
        return;
    }

    set_fake_lobby_value(g_fake_lobby_member_in_game, sizeof(g_fake_lobby_member_in_game), "1");
    ensure_fake_lobby_selection_state(origin);

    log_line(
        "%s -> ensured fake NoSteam boot match state matchId=%s selectedMatch=%s inGame=%s",
        origin,
        g_fake_match_id,
        g_fake_selected_match,
        g_fake_lobby_member_in_game
    );
}

static int should_ignore_boot_lobby_value(const char *key, const char *value) {
    if (key == NULL || value == NULL) {
        return 0;
    }

    if (
        (_stricmp(key, "inGame") == 0 || _stricmp(key, "h1z1_inmatch") == 0) &&
        strcmp(value, "1") == 0 &&
        g_fake_lobby_server[0] == '\0' &&
        g_fake_lobby_character[0] == '\0' &&
        strstr(g_fake_lobby_status, "Main Menu") != NULL
    ) {
        return 1;
    }

    if (
        _stricmp(key, "h1z1_server") == 0 ||
        _stricmp(key, "h1z1_character") == 0
    ) {
        return value[0] != '\0';
    }

    return 0;
}

static void store_fake_lobby_value(const char *key, const char *value, const char *origin) {
    if (key == NULL || value == NULL || key[0] == '\0') {
        return;
    }

    if (_stricmp(key, "matchId") == 0) {
        set_fake_lobby_value(g_fake_match_id, sizeof(g_fake_match_id), value);
        if (value[0] != '\0' && g_fake_selected_match[0] == '\0') {
            set_fake_lobby_value(g_fake_selected_match, sizeof(g_fake_selected_match), value);
        }
        return;
    }
    if (_stricmp(key, "SelectedMatch") == 0) {
        set_fake_lobby_value(g_fake_selected_match, sizeof(g_fake_selected_match), value);
        return;
    }
    if (_stricmp(key, "inGame") == 0 || _stricmp(key, "h1z1_inmatch") == 0) {
        set_fake_lobby_value(g_fake_lobby_member_in_game, sizeof(g_fake_lobby_member_in_game), value);
        sync_fake_boot_match_state(origin, value);
        return;
    }
    if (_stricmp(key, "status") == 0) {
        set_fake_lobby_value(g_fake_lobby_status, sizeof(g_fake_lobby_status), value);
        if (strstr(value, "Main Menu") != NULL) {
            reset_fake_main_menu_state();
        }
        return;
    }
    if (_stricmp(key, "name") == 0) {
        set_fake_lobby_value(g_fake_lobby_name, sizeof(g_fake_lobby_name), value);
        return;
    }
    if (_stricmp(key, "owner") == 0) {
        set_fake_lobby_value(g_fake_lobby_owner, sizeof(g_fake_lobby_owner), value);
        return;
    }
    if (_stricmp(key, "h1z1_server") == 0) {
        set_fake_lobby_value(g_fake_lobby_server, sizeof(g_fake_lobby_server), value);
        return;
    }
    if (_stricmp(key, "h1z1_character") == 0) {
        set_fake_lobby_value(g_fake_lobby_character, sizeof(g_fake_lobby_character), value);
        return;
    }
    if (_stricmp(key, "daybreakUserId") == 0) {
        set_fake_lobby_value(g_fake_lobby_daybreak_user_id, sizeof(g_fake_lobby_daybreak_user_id), value);
        return;
    }
    if (_stricmp(key, "daybreakCharId") == 0) {
        set_fake_lobby_value(g_fake_lobby_daybreak_char_id, sizeof(g_fake_lobby_daybreak_char_id), value);
        return;
    }
    if (_stricmp(key, "datacenter") == 0) {
        set_fake_lobby_value(g_fake_lobby_datacenter, sizeof(g_fake_lobby_datacenter), value);
        return;
    }
    if (_stricmp(key, "ready") == 0) {
        set_fake_lobby_value(g_fake_lobby_ready, sizeof(g_fake_lobby_ready), value);
        return;
    }
    if (_stricmp(key, "ViewingHostedGames") == 0) {
        set_fake_lobby_value(g_fake_lobby_viewing_hosted_games, sizeof(g_fake_lobby_viewing_hosted_games), value);
        return;
    }
    if (_stricmp(key, "SelectedMatchRole") == 0) {
        set_fake_lobby_value(g_fake_selected_match_role, sizeof(g_fake_selected_match_role), value);
        return;
    }
    if (_stricmp(key, "SelectedMatchCanEnter") == 0) {
        set_fake_lobby_value(g_fake_selected_match_can_enter, sizeof(g_fake_selected_match_can_enter), value);
        return;
    }
    if (_stricmp(key, "SelectedMatchId") == 0) {
        set_fake_lobby_value(g_fake_selected_match_id, sizeof(g_fake_selected_match_id), value);
        if (g_fake_selected_match[0] == '\0') {
            set_fake_lobby_value(g_fake_selected_match, sizeof(g_fake_selected_match), value);
        }
        return;
    }
}

static uintptr_t steam_matchmaking_get_lobby_member_data(
    DummyObject *self,
    uintptr_t lobby,
    uintptr_t member_arg,
    uintptr_t key_ptr,
    uintptr_t a4
) {
    char key[96];
    key[0] = '\0';
    try_read_ascii_c_string(key_ptr, key, sizeof(key));

    uint64_t member_steam_id = normalize_steam_id_argument(member_arg);
    const char *value = g_fake_empty;

    if (lobby != 0) {
        ensure_fake_lobby_bootstrap_state("GetLobbyMemberData");
    }
    if (is_fake_or_self_steam_id(member_steam_id)) {
        value = lookup_fake_lobby_value(key);
    } else {
        MenuTeamMember *member = menu_team_find(member_steam_id);
        if (member) value = menu_team_member_value(member, key);
    }

    log_line(
        "SteamMatchMaking009::GetLobbyMemberData(self=%p, lobby=%p, member=%llu, key=%p keyText=%s, a4=%p) -> %s",
        self,
        (void *)lobby,
        (unsigned long long)member_steam_id,
        (void *)key_ptr,
        key[0] ? key : "<unreadable>",
        (void *)a4,
        value[0] ? value : "<empty>"
    );
    return (uintptr_t)value;
}

static uintptr_t generic_interface_method(DummyObject *self, int index, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    const char *name = (self != NULL && self->name != NULL) ? self->name : "GenericInterface";
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 26) {
        int accepted = receive_menu_duo_native((const char *)a2, (size_t)a3, GetTickCount64());
        log_line("MenuDuo lobby transport bytes=%llu accepted=%d", (unsigned long long)a3, accepted);
        return accepted;
    }
    if (strcmp(name, "STEAMUSERSTATS_INTERFACE_VERSION011") == 0 && index == 0) {
        log_line(
            "STEAMUSERSTATS_INTERFACE_VERSION011::RequestCurrentStats(self=%p) -> 1",
            self
        );
        dispatch_callbacks_by_id(1101, "RequestCurrentStats", 1);
        return 1;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 19) {
        char key[64];
        key[0] = '\0';
        try_read_ascii_c_string(a2, key, sizeof(key));

        ensure_fake_lobby_bootstrap_state("GetLobbyData");
        const char *value = lookup_fake_lobby_value(key);

        log_line(
            "SteamMatchMaking009::method[19](self=%p, lobby=%p, key=%p keyText=%s, extra=%p, a4=%p) -> %s",
            self,
            (void *)a1,
            (void *)a2,
            key[0] ? key : "<unreadable>",
            (void *)a3,
            (void *)a4,
            value[0] ? value : "<empty>"
        );
        return (uintptr_t)value;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 17) {
        log_line(
            "SteamMatchMaking009::GetNumLobbyMembers(self=%p, lobby=%p, a2=%p, a3=%p, a4=%p) -> %d",
            self,
            (void *)a1,
            (void *)a2,
            (void *)a3,
            (void *)a4,
            menu_team_count()
        );
        return menu_team_count();
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 15) {
        log_line(
            "SteamMatchMaking009::LeaveLobby(self=%p, lobby=%p, a2=%p, a3=%p, a4=%p)",
            self,
            (void *)a1,
            (void *)a2,
            (void *)a3,
            (void *)a4
        );
        return 0;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 21) {
        ensure_fake_lobby_bootstrap_state("GetLobbyDataCount");
        log_line(
            "SteamMatchMaking009::GetLobbyDataCount(self=%p, lobby=%p, a2=%p, a3=%p, a4=%p) -> 11",
            self,
            (void *)a1,
            (void *)a2,
            (void *)a3,
            (void *)a4
        );
        return 11;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 18) {
        uintptr_t return_buffer = 0;
        uintptr_t lobby = a1;
        uintptr_t member_index = a2;
        uintptr_t extra = a3;
        uint64_t result = 0;

        if (can_access_process_memory(a1, sizeof(uint64_t), 1)) {
            return_buffer = a1;
            lobby = a2;
            member_index = a3;
            extra = a4;
        }

        result = menu_team_member_at(member_index);
        if (!result && menu_team_count() == 1 && member_index < 8) {
            result = g_fake_steam_id;
        }

        log_line(
            "SteamMatchMaking009::GetLobbyMemberByIndex(self=%p, return_buffer=%p, lobby=%p, member_index=%llu, extra=%p) -> %llu",
            self,
            (void *)return_buffer,
            (void *)lobby,
            (unsigned long long)member_index,
            (void *)extra,
            (unsigned long long)result
        );

        if (return_buffer != 0) {
            uintptr_t buffered = write_steam_id_return_buffer("SteamMatchMaking009::GetLobbyMemberByIndex", return_buffer, result);
            if (buffered != 0) {
                return buffered;
            }
        }

        return (uintptr_t)result;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 28) {
        ensure_fake_lobby_bootstrap_state("RequestLobbyData");
        log_line(
            "SteamMatchMaking009::RequestLobbyData(self=%p, lobby=%p, a2=%p, a3=%p, a4=%p) -> 1",
            self,
            (void *)a1,
            (void *)a2,
            (void *)a3,
            (void *)a4
        );
        maybe_dispatch_lobby_data_update("RequestLobbyData", 1);
        return 1;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 20) {
        char key[96];
        char value[160];
        key[0] = '\0';
        value[0] = '\0';
        try_read_ascii_c_string(a2, key, sizeof(key));
        try_read_ascii_c_string(a3, value, sizeof(value));

        if (should_ignore_boot_lobby_value(key, value)) {
            log_line(
                "SteamMatchMaking009::SetLobbyData(self=%p, lobby=%p, key=%p keyText=%s, value=%p valueText=%s, a4=%p) -> 1 (ignored during NoSteam boot)",
                self,
                (void *)a1,
                (void *)a2,
                key[0] ? key : "<unreadable>",
                (void *)a3,
                value[0] ? value : "<unreadable>",
                (void *)a4
            );
            return 1;
        }

        store_fake_lobby_value(key, value, "SetLobbyData");

        log_line(
            "SteamMatchMaking009::SetLobbyData(self=%p, lobby=%p, key=%p keyText=%s, value=%p valueText=%s, a4=%p) -> 1",
            self,
            (void *)a1,
            (void *)a2,
            key[0] ? key : "<unreadable>",
            (void *)a3,
            value[0] ? value : "<unreadable>",
            (void *)a4
        );
        if (key[0]) {
            maybe_dispatch_lobby_data_update("SetLobbyData", 1);
        }
        return 1;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 24) {
        return steam_matchmaking_get_lobby_member_data(self, a1, a2, a3, a4);
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 25) {
        char key[64];
        char value[64];
        key[0] = '\0';
        value[0] = '\0';
        try_read_ascii_c_string(a2, key, sizeof(key));
        try_read_ascii_c_string(a3, value, sizeof(value));

        if (should_ignore_boot_lobby_value(key, value)) {
            log_line(
                "SteamMatchMaking009::method[25](self=%p, lobby=%p, key=%p keyText=%s, value=%p valueText=%s, a4=%p) -> 1 (ignored during NoSteam boot)",
                self,
                (void *)a1,
                (void *)a2,
                key[0] ? key : "<unreadable>",
                (void *)a3,
                value[0] ? value : "<unreadable>",
                (void *)a4
            );
            return 1;
        }

        store_fake_lobby_value(key, value, "SetLobbyMemberData");

        log_line(
            "SteamMatchMaking009::method[25](self=%p, lobby=%p, key=%p keyText=%s, value=%p valueText=%s, a4=%p) -> 1",
            self,
            (void *)a1,
            (void *)a2,
            key[0] ? key : "<unreadable>",
            (void *)a3,
            value[0] ? value : "<unreadable>",
            (void *)a4
        );
        if (key[0]) {
            maybe_dispatch_lobby_data_update("SetLobbyMemberData", 1);
        }
        return 1;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 35) {
        uintptr_t return_buffer = 0;
        uintptr_t lobby = a1;
        if (can_access_process_memory(a1, sizeof(uint64_t), 1)) {
            return_buffer = a1;
            lobby = a2;
        }

        log_line(
            "SteamMatchMaking009::GetLobbyOwner(self=%p, return_buffer=%p, lobby=%p) -> %llu",
            self,
            (void *)return_buffer,
            (void *)lobby,
            (unsigned long long)g_fake_steam_id
        );

        if (return_buffer != 0) {
            uintptr_t buffered = write_steam_id_return_buffer("SteamMatchMaking009::GetLobbyOwner", return_buffer, g_fake_steam_id);
            if (buffered != 0) {
                return buffered;
            }
        }

        return (uintptr_t)g_fake_steam_id;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 32) {
        log_line(
            "SteamMatchMaking009::GetLobbyMemberLimit(self=%p, lobby=%p, a2=%p, a3=%p, a4=%p) -> %llu",
            self,
            (void *)a1,
            (void *)a2,
            (void *)a3,
            (void *)a4,
            (unsigned long long)g_fake_lobby_member_limit
        );
        return g_fake_lobby_member_limit;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 13) {
        SteamAPICall_t handle = queue_callresult(513);
        log_line(
            "SteamMatchMaking009::CreateLobby(self=%p, lobby_type=%p, max_members=%p, a3=%p, a4=%p) -> api_call=%d",
            self,
            (void *)a1,
            (void *)a2,
            (void *)a3,
            (void *)a4,
            handle
        );
        return (uintptr_t)handle;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && index == 14) {
        SteamAPICall_t handle = queue_callresult(504);
        log_line(
            "SteamMatchMaking009::JoinLobby(self=%p, lobby=%p, a2=%p, a3=%p, a4=%p) -> api_call=%d",
            self,
            (void *)a1,
            (void *)a2,
            (void *)a3,
            (void *)a4,
            handle
        );
        return (uintptr_t)handle;
    }
    if (strcmp(name, "SteamMatchMaking009") == 0 && (index == 19 || index == 25)) {
        char preview1[96];
        char preview2[96];
        char preview3[96];
        char preview4[96];
        preview1[0] = '\0';
        preview2[0] = '\0';
        preview3[0] = '\0';
        preview4[0] = '\0';
        try_format_pointer_preview(a1, preview1, sizeof(preview1));
        try_format_pointer_preview(a2, preview2, sizeof(preview2));
        try_format_pointer_preview(a3, preview3, sizeof(preview3));
        try_format_pointer_preview(a4, preview4, sizeof(preview4));
        log_line(
            "%s::method[%d](self=%p, a1=%p%s, a2=%p%s, a3=%p%s, a4=%p%s)",
            name,
            index,
            self,
            (void *)a1,
            preview1,
            (void *)a2,
            preview2,
            (void *)a3,
            preview3,
            (void *)a4,
            preview4
        );
        return 1;
    }
    log_line(
        "%s::method[%d](self=%p, a1=%p, a2=%p, a3=%p, a4=%p)",
        name,
        index,
        self,
        (void *)a1,
        (void *)a2,
        (void *)a3,
        (void *)a4
    );
    return 1;
}

static uintptr_t generic_interface_method_extended(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    const char *name = (self != NULL && self->name != NULL) ? self->name : "GenericInterface";
    log_line(
        "%s::method[extended](self=%p, a1=%p, a2=%p, a3=%p, a4=%p)",
        name,
        self,
        (void *)a1,
        (void *)a2,
        (void *)a3,
        (void *)a4
    );
    return 1;
}

#define DEFINE_GENERIC_METHOD(N) \
    static uintptr_t generic_method_##N(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) { \
        return generic_interface_method(self, N, a1, a2, a3, a4); \
    }

DEFINE_GENERIC_METHOD(0)
DEFINE_GENERIC_METHOD(1)
DEFINE_GENERIC_METHOD(2)
DEFINE_GENERIC_METHOD(3)
DEFINE_GENERIC_METHOD(4)
DEFINE_GENERIC_METHOD(5)
DEFINE_GENERIC_METHOD(6)
DEFINE_GENERIC_METHOD(7)
DEFINE_GENERIC_METHOD(8)
DEFINE_GENERIC_METHOD(9)
DEFINE_GENERIC_METHOD(10)
DEFINE_GENERIC_METHOD(11)
DEFINE_GENERIC_METHOD(12)
DEFINE_GENERIC_METHOD(13)
DEFINE_GENERIC_METHOD(14)
DEFINE_GENERIC_METHOD(15)
DEFINE_GENERIC_METHOD(16)
DEFINE_GENERIC_METHOD(17)
DEFINE_GENERIC_METHOD(18)
DEFINE_GENERIC_METHOD(19)
DEFINE_GENERIC_METHOD(20)
DEFINE_GENERIC_METHOD(21)
DEFINE_GENERIC_METHOD(22)
DEFINE_GENERIC_METHOD(23)
DEFINE_GENERIC_METHOD(24)
DEFINE_GENERIC_METHOD(25)
DEFINE_GENERIC_METHOD(26)
DEFINE_GENERIC_METHOD(27)
DEFINE_GENERIC_METHOD(28)
DEFINE_GENERIC_METHOD(29)
DEFINE_GENERIC_METHOD(30)
DEFINE_GENERIC_METHOD(31)
DEFINE_GENERIC_METHOD(32)
DEFINE_GENERIC_METHOD(33)
DEFINE_GENERIC_METHOD(34)
DEFINE_GENERIC_METHOD(35)
DEFINE_GENERIC_METHOD(36)
DEFINE_GENERIC_METHOD(37)
DEFINE_GENERIC_METHOD(38)
DEFINE_GENERIC_METHOD(39)
DEFINE_GENERIC_METHOD(40)

static void *g_generic_vtable[GENERIC_VTABLE_SIZE];

static DummyObject g_generic_object = { g_generic_vtable, "GenericInterface" };

static void *g_steam_user_vtable[INTERFACE_VTABLE_SIZE];
static void *g_steam_utils_vtable[INTERFACE_VTABLE_SIZE];
static void *g_steam_apps_vtable[INTERFACE_VTABLE_SIZE];
static void *g_steam_friends_vtable[INTERFACE_VTABLE_SIZE];
static void *g_steam_client_vtable[STEAMCLIENT_VTABLE_SIZE];

static DummyObject g_steam_user_object = { g_steam_user_vtable, "SteamUser019" };
static DummyObject g_steam_utils_object = { g_steam_utils_vtable, "SteamUtils008" };
static DummyObject g_steam_apps_object = { g_steam_apps_vtable, "SteamApps" };
static DummyObject g_steam_friends_object = { g_steam_friends_vtable, "SteamFriends" };
static DummyObject g_steam_inventory_object = { g_generic_vtable, "SteamInventory" };
static DummyObject g_steam_input_object = { g_generic_vtable, "SteamInput" };
static DummyObject g_steam_controller_object = { g_generic_vtable, "SteamController" };
static DummyObject g_steam_remote_storage_object = { g_generic_vtable, "SteamRemoteStorage" };
static DummyObject g_steam_generic_object = { g_generic_vtable, "SteamGenericInterface" };
static DummyObject g_steam_client_object;

static int is_probable_user_pointer(uintptr_t value) {
    return value >= 0x10000ULL && value < 0x0000800000000000ULL;
}

static int has_readable_protection(DWORD protect) {
    protect &= 0xFF;
    return protect == PAGE_READONLY ||
           protect == PAGE_READWRITE ||
           protect == PAGE_WRITECOPY ||
           protect == PAGE_EXECUTE_READ ||
           protect == PAGE_EXECUTE_READWRITE ||
           protect == PAGE_EXECUTE_WRITECOPY;
}

static int has_writable_protection(DWORD protect) {
    protect &= 0xFF;
    return protect == PAGE_READWRITE ||
           protect == PAGE_WRITECOPY ||
           protect == PAGE_EXECUTE_READWRITE ||
           protect == PAGE_EXECUTE_WRITECOPY;
}

static int can_access_process_memory(uintptr_t address, size_t size, int require_write) {
    if (!is_probable_user_pointer(address) || size == 0) {
        return 0;
    }

    uintptr_t end = address + size;
    if (end < address) {
        return 0;
    }

    uintptr_t cursor = address;
    while (cursor < end) {
        MEMORY_BASIC_INFORMATION mbi;
        SIZE_T queried = VirtualQuery((LPCVOID)cursor, &mbi, sizeof(mbi));
        if (queried != sizeof(mbi)) {
            return 0;
        }

        if (mbi.State != MEM_COMMIT || (mbi.Protect & PAGE_GUARD) || (mbi.Protect & PAGE_NOACCESS)) {
            return 0;
        }

        if (require_write) {
            if (!has_writable_protection(mbi.Protect)) {
                return 0;
            }
        } else if (!has_readable_protection(mbi.Protect)) {
            return 0;
        }

        uintptr_t region_end = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
        if (region_end <= cursor) {
            return 0;
        }
        cursor = region_end;
    }

    return 1;
}

static int try_read_u64_from_process(uintptr_t address, uint64_t *value) {
    if (value == NULL || !can_access_process_memory(address, sizeof(uint64_t), 0)) {
        return 0;
    }

    memcpy(value, (const void *)address, sizeof(uint64_t));
    return 1;
}

static uint64_t normalize_steam_id_argument(uintptr_t raw_value) {
    uint64_t direct = (uint64_t)raw_value;
    if (is_fake_or_self_steam_id(direct)) {
        return direct;
    }

    uint64_t indirect = 0;
    if (try_read_u64_from_process(raw_value, &indirect) && is_fake_or_self_steam_id(indirect)) {
        if (indirect == 0 && can_access_process_memory(raw_value, sizeof(uint64_t), 1)) {
            memcpy((void *)raw_value, &g_fake_steam_id, sizeof(uint64_t));
            log_line(
                "Hydrated zero steam_id buffer %p -> %llu",
                (void *)raw_value,
                (unsigned long long)g_fake_steam_id
            );
            return g_fake_steam_id;
        }
        log_line(
            "Normalized indirect steam_id pointer %p -> %llu",
            (void *)raw_value,
            (unsigned long long)indirect
        );
        return indirect;
    }

    return direct;
}

static int is_printable_ascii_byte(unsigned char value) {
    return (value >= 32 && value <= 126) || value == '\t' || value == '\r' || value == '\n';
}

static int try_read_ascii_c_string(uintptr_t address, char *buffer, size_t buffer_len) {
    if (buffer == NULL || buffer_len == 0) {
        return 0;
    }
    buffer[0] = '\0';

    if (!is_probable_user_pointer(address) || !can_access_process_memory(address, 1, 0)) {
        return 0;
    }

    size_t offset = 0;
    while (offset + 1 < buffer_len) {
        if (!can_access_process_memory(address + offset, 1, 0)) {
            break;
        }

        unsigned char value = ((const unsigned char *)address)[offset];
        if (value == 0) {
            break;
        }
        if (!is_printable_ascii_byte(value)) {
            buffer[0] = '\0';
            return 0;
        }

        buffer[offset++] = (char)value;
    }

    buffer[offset] = '\0';
    return offset > 0;
}

static int try_format_pointer_preview(uintptr_t address, char *buffer, size_t buffer_len) {
    if (buffer == NULL || buffer_len == 0) {
        return 0;
    }
    buffer[0] = '\0';

    if (!can_access_process_memory(address, 16, 0)) {
        return 0;
    }

    unsigned char raw[16];
    memcpy(raw, (const void *)address, sizeof(raw));

    size_t ascii_len = 0;
    while (ascii_len < sizeof(raw) && raw[ascii_len] != 0 && is_printable_ascii_byte(raw[ascii_len])) {
        ascii_len++;
    }

    if (ascii_len >= 3) {
        _snprintf(buffer, buffer_len, " ascii=\"%.*s\"", (int)ascii_len, (const char *)raw);
        buffer[buffer_len - 1] = '\0';
        return 1;
    }

    _snprintf(
        buffer,
        buffer_len,
        " bytes=%02X-%02X-%02X-%02X-%02X-%02X-%02X-%02X",
        raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7]
    );
    buffer[buffer_len - 1] = '\0';
    return 1;
}

static uintptr_t return_steam_id_value(
    const char *method_name,
    DummyObject *self,
    uintptr_t shifted_self,
    DummyObject *expected_self,
    uint64_t steam_id
) {
    if (self != expected_self && (DummyObject *)shifted_self == expected_self) {
        uintptr_t return_buffer = (uintptr_t)self;
        if (can_access_process_memory(return_buffer, sizeof(uint64_t), 1)) {
            memcpy((void *)return_buffer, &steam_id, sizeof(uint64_t));
            log_line(
                "%s(hidden-ret=%p) -> %llu",
                method_name,
                (void *)return_buffer,
                (unsigned long long)steam_id
            );
            return return_buffer;
        }

        log_line(
            "%s(hidden-ret=%p) failed write, falling back to scalar return",
            method_name,
            (void *)return_buffer
        );
    }

    log_line("%s() -> %llu", method_name, (unsigned long long)steam_id);
    return (uintptr_t)steam_id;
}

static uintptr_t write_steam_id_return_buffer(const char *method_name, uintptr_t return_buffer, uint64_t steam_id) {
    if (can_access_process_memory(return_buffer, sizeof(uint64_t), 1)) {
        memcpy((void *)return_buffer, &steam_id, sizeof(uint64_t));
        log_line(
            "%s(hidden-ret=%p) -> %llu",
            method_name,
            (void *)return_buffer,
            (unsigned long long)steam_id
        );
        return return_buffer;
    }

    return 0;
}

static DummyObject *allocate_named_generic_interface(const char *name) {
    DummyObject *object = (DummyObject *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(DummyObject));
    if (object == NULL) {
        return &g_generic_object;
    }
    object->vtable = g_generic_vtable;
    object->name = name != NULL ? name : "GenericInterface";
    return object;
}

static DummyObject *create_interface_for_version(const char *version) {
    if (version == NULL || version[0] == '\0') {
        return &g_generic_object;
    }
    if (strcmp(version, "SteamUser019") == 0) {
        return &g_steam_user_object;
    }
    if (strcmp(version, "SteamUtils008") == 0) {
        return &g_steam_utils_object;
    }
    if (strncmp(version, "STEAMAPPS_INTERFACE_VERSION", 27) == 0) {
        return &g_steam_apps_object;
    }
    if (strncmp(version, "SteamFriends", 12) == 0) {
        return &g_steam_friends_object;
    }
    if (strncmp(version, "STEAMINVENTORY_INTERFACE", 24) == 0) {
        return &g_steam_inventory_object;
    }
    if (strncmp(version, "SteamInput", 10) == 0) {
        return &g_steam_input_object;
    }
    if (strncmp(version, "SteamController", 15) == 0) {
        return &g_steam_controller_object;
    }
    if (strncmp(version, "STEAMREMOTESTORAGE_INTERFACE", 28) == 0) {
        return &g_steam_remote_storage_object;
    }
    return allocate_named_generic_interface(version);
}

static uintptr_t steamclient_create_steam_pipe(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::CreateSteamPipe()");
    return 1;
}

static uintptr_t steamclient_brelease_steam_pipe(DummyObject *self, uintptr_t pipe, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::BReleaseSteamPipe(pipe=%lld)", (long long)pipe);
    return 1;
}

static uintptr_t steamclient_connect_to_global_user(DummyObject *self, uintptr_t pipe, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::ConnectToGlobalUser(pipe=%lld)", (long long)pipe);
    return 1;
}

static uintptr_t steamclient_create_local_user(DummyObject *self, uintptr_t pipe_out, uintptr_t account_type, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    if (pipe_out != 0) {
        *(HSteamPipe *)pipe_out = 1;
    }
    log_line("SteamClient017::CreateLocalUser(pipe_out=%p, account_type=%lld)", (void *)pipe_out, (long long)account_type);
    return 1;
}

static uintptr_t steamclient_release_user(DummyObject *self, uintptr_t pipe, uintptr_t user, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    log_line("SteamClient017::ReleaseUser(pipe=%lld, user=%lld)", (long long)pipe, (long long)user);
    return 0;
}

static uintptr_t steamclient_get_isteam_user(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)self; (void)a4;
    const char *version_string = (const char *)version;
    DummyObject *object = create_interface_for_version(version_string);
    log_line(
        "SteamClient017::GetISteamUser(user=%lld, pipe=%lld, version=%s) -> %s",
        (long long)user,
        (long long)pipe,
        version_string ? version_string : "<null>",
        object->name ? object->name : "<unnamed>"
    );
    return (uintptr_t)object;
}

static uintptr_t steamclient_get_interface_with_user(DummyObject *self, const char *method_name, uintptr_t user, uintptr_t pipe, uintptr_t version) {
    (void)self;
    const char *version_string = (const char *)version;
    DummyObject *object = create_interface_for_version(version_string);
    log_line(
        "SteamClient017::%s(user=%lld, pipe=%lld, version=%s) -> %s",
        method_name,
        (long long)user,
        (long long)pipe,
        version_string ? version_string : "<null>",
        object->name ? object->name : "<unnamed>"
    );
    return (uintptr_t)object;
}

static uintptr_t steamclient_get_interface_slot(DummyObject *self, int slot, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)self; (void)a4;
    const char *version_string = (const char *)version;
    DummyObject *object = create_interface_for_version(version_string);
    log_line(
        "SteamClient017::slot[%d](user=%lld, pipe=%lld, version=%s) -> %s",
        slot,
        (long long)user,
        (long long)pipe,
        version_string ? version_string : "<null>",
        object->name ? object->name : "<unnamed>"
    );
    return (uintptr_t)object;
}

static uintptr_t steamclient_get_interface_with_pipe(DummyObject *self, const char *method_name, uintptr_t pipe, uintptr_t version) {
    (void)self;
    const char *version_string = (const char *)version;
    DummyObject *object = create_interface_for_version(version_string);
    log_line(
        "SteamClient017::%s(pipe=%lld, version=%s) -> %s",
        method_name,
        (long long)pipe,
        version_string ? version_string : "<null>",
        object->name ? object->name : "<unnamed>"
    );
    return (uintptr_t)object;
}

static uintptr_t steamclient_get_isteam_friends(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamFriends", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_utils(DummyObject *self, uintptr_t pipe, uintptr_t version, uintptr_t a3, uintptr_t a4) {
    (void)a3; (void)a4;
    return steamclient_get_interface_with_pipe(self, "GetISteamUtils", pipe, version);
}

static uintptr_t steamclient_get_isteam_matchmaking(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamMatchmaking", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_matchmaking_servers(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamMatchmakingServers", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_generic_interface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamGenericInterface", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_user_stats(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamUserStats", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_apps(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamApps", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_networking(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamNetworking", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_remote_storage(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamRemoteStorage", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_screenshots(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamScreenshots", user, pipe, version);
}

static uintptr_t steamclient_run_frame(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::RunFrame()");
    return 0;
}

static uintptr_t steamclient_get_ipc_call_count(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::GetIPCCallCount()");
    return 0;
}

static uintptr_t steamclient_set_warning_message_hook(DummyObject *self, uintptr_t hook, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::SetWarningMessageHook(hook=%p)", (void *)hook);
    return 0;
}

static uintptr_t steamclient_shutdown_if_all_pipes_closed(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::BShutdownIfAllPipesClosed()");
    return 0;
}

static uintptr_t steamclient_get_isteam_controller(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamController", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_http(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamHTTP", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_ugc(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamUGC", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_app_list(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamAppList", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_music(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamMusic", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_music_remote(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamMusicRemote", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_html_surface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamHTMLSurface", user, pipe, version);
}

static uintptr_t steamclient_slot24_interface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    return steamclient_get_interface_slot(self, 24, user, pipe, version, a4);
}

static uintptr_t steamclient_slot25_interface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    return steamclient_get_interface_slot(self, 25, user, pipe, version, a4);
}

static uintptr_t steamclient_slot26_interface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    return steamclient_get_interface_slot(self, 26, user, pipe, version, a4);
}

static uintptr_t steamclient_slot27_interface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    return steamclient_get_interface_slot(self, 27, user, pipe, version, a4);
}

static uintptr_t steamclient_slot28_interface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    return steamclient_get_interface_slot(self, 28, user, pipe, version, a4);
}

static uintptr_t steamclient_slot29_interface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    return steamclient_get_interface_slot(self, 29, user, pipe, version, a4);
}

static uintptr_t steamclient_slot30_interface(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    return steamclient_get_interface_slot(self, 30, user, pipe, version, a4);
}

static uintptr_t steamclient_deprecated_set_post_api_result(DummyObject *self, uintptr_t fn, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::DEPRECATED_Set_SteamAPI_CPostAPIResultInProcess(fn=%p)", (void *)fn);
    return 0;
}

static uintptr_t steamclient_deprecated_remove_post_api_result(DummyObject *self, uintptr_t fn, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::DEPRECATED_Remove_SteamAPI_CPostAPIResultInProcess(fn=%p)", (void *)fn);
    return 0;
}

static uintptr_t steamclient_set_check_callback_registered(DummyObject *self, uintptr_t fn, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::Set_SteamAPI_CCheckCallbackRegisteredInProcess(fn=%p)", (void *)fn);
    return 0;
}

static uintptr_t steamclient_get_isteam_inventory(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamInventory", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_video(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamVideo", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_parental_settings(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamParentalSettings", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_input(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamInput", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_parties(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamParties", user, pipe, version);
}

static uintptr_t steamclient_get_isteam_remote_play(DummyObject *self, uintptr_t user, uintptr_t pipe, uintptr_t version, uintptr_t a4) {
    (void)a4;
    return steamclient_get_interface_with_user(self, "GetISteamRemotePlay", user, pipe, version);
}

static uintptr_t steamclient_destroy_all_interfaces(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamClient017::DestroyAllInterfaces()");
    return 0;
}

#define DEFINE_STEAMCLIENT_FALLBACK(N) \
    static uintptr_t steamclient_fallback_##N(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) { \
        return generic_interface_method(self, N, a1, a2, a3, a4); \
    }

DEFINE_STEAMCLIENT_FALLBACK(0)
DEFINE_STEAMCLIENT_FALLBACK(1)
DEFINE_STEAMCLIENT_FALLBACK(2)
DEFINE_STEAMCLIENT_FALLBACK(3)
DEFINE_STEAMCLIENT_FALLBACK(4)
DEFINE_STEAMCLIENT_FALLBACK(5)
DEFINE_STEAMCLIENT_FALLBACK(6)
DEFINE_STEAMCLIENT_FALLBACK(7)
DEFINE_STEAMCLIENT_FALLBACK(8)
DEFINE_STEAMCLIENT_FALLBACK(9)
DEFINE_STEAMCLIENT_FALLBACK(10)
DEFINE_STEAMCLIENT_FALLBACK(11)
DEFINE_STEAMCLIENT_FALLBACK(12)
DEFINE_STEAMCLIENT_FALLBACK(13)
DEFINE_STEAMCLIENT_FALLBACK(14)
DEFINE_STEAMCLIENT_FALLBACK(15)
DEFINE_STEAMCLIENT_FALLBACK(16)
DEFINE_STEAMCLIENT_FALLBACK(17)
DEFINE_STEAMCLIENT_FALLBACK(18)
DEFINE_STEAMCLIENT_FALLBACK(19)
DEFINE_STEAMCLIENT_FALLBACK(20)
DEFINE_STEAMCLIENT_FALLBACK(21)
DEFINE_STEAMCLIENT_FALLBACK(22)
DEFINE_STEAMCLIENT_FALLBACK(23)
DEFINE_STEAMCLIENT_FALLBACK(24)
DEFINE_STEAMCLIENT_FALLBACK(25)
DEFINE_STEAMCLIENT_FALLBACK(26)
DEFINE_STEAMCLIENT_FALLBACK(27)
DEFINE_STEAMCLIENT_FALLBACK(28)
DEFINE_STEAMCLIENT_FALLBACK(29)
DEFINE_STEAMCLIENT_FALLBACK(30)
DEFINE_STEAMCLIENT_FALLBACK(31)
DEFINE_STEAMCLIENT_FALLBACK(32)
DEFINE_STEAMCLIENT_FALLBACK(33)
DEFINE_STEAMCLIENT_FALLBACK(34)
DEFINE_STEAMCLIENT_FALLBACK(35)
DEFINE_STEAMCLIENT_FALLBACK(36)
DEFINE_STEAMCLIENT_FALLBACK(37)
DEFINE_STEAMCLIENT_FALLBACK(38)
DEFINE_STEAMCLIENT_FALLBACK(39)

static uintptr_t steamutils_get_seconds_since_app_active(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::GetSecondsSinceAppActive()");
    return 1;
}

static uintptr_t steamutils_get_seconds_since_computer_active(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::GetSecondsSinceComputerActive()");
    return 1;
}

static uintptr_t steamutils_get_connected_universe(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::GetConnectedUniverse()");
    return 1;
}

static uintptr_t steamutils_get_server_real_time(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::GetServerRealTime()");
    return get_unix_time_now();
}

static uintptr_t steamutils_get_ip_country(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::GetIPCountry() -> %s", g_fake_country);
    return (uintptr_t)g_fake_country;
}

static uintptr_t steamutils_get_app_id(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::GetAppID() -> %u", g_fake_app_id);
    return g_fake_app_id;
}

static uintptr_t steamutils_run_frame(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::RunFrame()");
    return 0;
}

static uintptr_t steamutils_get_ipc_call_count(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::GetIPCCallCount()");
    return 0;
}

static uintptr_t steamutils_set_warning_message_hook(DummyObject *self, uintptr_t hook, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::SetWarningMessageHook(hook=%p)", (void *)hook);
    return 0;
}

static uintptr_t steamutils_is_overlay_enabled(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUtils008::IsOverlayEnabled()");
    return 0;
}

static uintptr_t steamapps_bis_subscribed(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::BIsSubscribed()");
    return 1;
}

static uintptr_t steamapps_get_current_game_language(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::GetCurrentGameLanguage() -> %s", g_fake_language);
    return (uintptr_t)g_fake_language;
}

static uintptr_t steamapps_get_available_game_languages(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::GetAvailableGameLanguages() -> %s", g_fake_language);
    return (uintptr_t)g_fake_language;
}

static uintptr_t steamapps_bis_subscribed_app(DummyObject *self, uintptr_t app_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::BIsSubscribedApp(app_id=%llu)", (unsigned long long)app_id);
    return ((uint32_t)app_id == g_fake_app_id) ? 1 : 0;
}

static uintptr_t steamapps_get_app_install_dir(DummyObject *self, uintptr_t app_id, uintptr_t folder, uintptr_t folder_len, uintptr_t a4) {
    (void)self; (void)a4;
    char game_dir[MAX_PATH];
    get_game_directory(game_dir, sizeof(game_dir));
    if (folder != 0 && folder_len != 0) {
        lstrcpynA((char *)folder, game_dir, (int)folder_len);
    }
    log_line("SteamApps::GetAppInstallDir(app_id=%llu, folder=%p, len=%llu) -> %s", (unsigned long long)app_id, (void *)folder, (unsigned long long)folder_len, game_dir);
    return (uintptr_t)strlen(game_dir);
}

static uintptr_t steamapps_bis_app_installed(DummyObject *self, uintptr_t app_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::BIsAppInstalled(app_id=%llu)", (unsigned long long)app_id);
    return ((uint32_t)app_id == g_fake_app_id) ? 1 : 0;
}

static uintptr_t steamapps_get_app_owner(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::GetAppOwner entry self=%p shifted_self=%p", self, (void *)a1);
    uintptr_t buffered = write_steam_id_return_buffer("SteamApps::GetAppOwner", a1, g_fake_steam_id);
    if (buffered != 0) {
        return buffered;
    }
    return return_steam_id_value("SteamApps::GetAppOwner", self, a1, &g_steam_apps_object, g_fake_steam_id);
}

static uintptr_t steamapps_get_launch_query_param(DummyObject *self, uintptr_t key, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::GetLaunchQueryParam(key=%s)", key ? (const char *)key : "<null>");
    return (uintptr_t)g_fake_empty;
}

static uintptr_t steamapps_false_with_log(DummyObject *self, int index, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self;
    log_line("SteamApps::method[%d](a1=%p, a2=%p, a3=%p, a4=%p) -> false", index, (void *)a1, (void *)a2, (void *)a3, (void *)a4);
    return 0;
}

static uintptr_t steamapps_bis_low_violence(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 1, a1, a2, a3, a4);
}

static uintptr_t steamapps_bis_cybercafe(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 2, a1, a2, a3, a4);
}

static uintptr_t steamapps_bis_vac_banned(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 3, a1, a2, a3, a4);
}

static uintptr_t steamapps_bis_dlc_installed(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 7, a1, a2, a3, a4);
}

static uintptr_t steamapps_get_earliest_purchase_time(DummyObject *self, uintptr_t app_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint32_t now = get_unix_time_now();
    log_line("SteamApps::GetEarliestPurchaseUnixTime(app_id=%llu) -> %u", (unsigned long long)app_id, now - 86400U);
    return now - 86400U;
}

static uintptr_t steamapps_bis_subscribed_from_free_weekend(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 9, a1, a2, a3, a4);
}

static uintptr_t steamapps_get_dlc_count(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::GetDLCCount() -> 0");
    return 0;
}

static uintptr_t steamapps_bget_dlc_data_by_index(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 11, a1, a2, a3, a4);
}

static uintptr_t steamapps_get_current_beta_name(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 15, a1, a2, a3, a4);
}

static uintptr_t steamapps_mark_content_corrupt(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 16, a1, a2, a3, a4);
}

static uintptr_t steamapps_get_installed_depots(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::GetInstalledDepots() -> 0");
    return 0;
}

static uintptr_t steamapps_get_dlc_download_progress(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 22, a1, a2, a3, a4);
}

static uintptr_t steamapps_get_app_build_id(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::GetAppBuildId() -> 0");
    return 0;
}

static uintptr_t steamapps_get_file_details(DummyObject *self, uintptr_t file_name, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamApps::GetFileDetails(file=%s) -> 1", file_name ? (const char *)file_name : "<null>");
    return 1;
}

static uintptr_t steamapps_get_launch_command_line(DummyObject *self, uintptr_t buffer, uintptr_t size, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    if (buffer != 0 && size != 0) {
        ((char *)buffer)[0] = '\0';
    }
    log_line("SteamApps::GetLaunchCommandLine(buffer=%p, size=%llu) -> 0", (void *)buffer, (unsigned long long)size);
    return 0;
}

static uintptr_t steamapps_bis_subscribed_from_family_sharing(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 27, a1, a2, a3, a4);
}

static uintptr_t steamapps_bis_timed_trial(DummyObject *self, uintptr_t allowed, uintptr_t played, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    if (allowed != 0) {
        *(uint32_t *)allowed = 0;
    }
    if (played != 0) {
        *(uint32_t *)played = 0;
    }
    log_line("SteamApps::BIsTimedTrial(allowed=%p, played=%p) -> false", (void *)allowed, (void *)played);
    return 0;
}

static uintptr_t steamapps_set_dlc_context(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamapps_false_with_log(self, 29, a1, a2, a3, a4);
}

static uintptr_t steamfriends_get_persona_name(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    const char *persona_name = get_active_fake_persona_name();
    log_line("SteamFriends::GetPersonaName() -> %s", persona_name);
    return (uintptr_t)persona_name;
}

static uintptr_t steamfriends_set_persona_name(DummyObject *self, uintptr_t persona_name, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    const char *name = (persona_name != 0 && can_access_process_memory(persona_name, 1, 0))
        ? (const char *)persona_name
        : "<null>";
    if (name[0] != '\0' && strcmp(name, "<null>") != 0) {
        set_fake_persona_name_value(name);
    }
    log_line("SteamFriends015::SetPersonaName(%s) -> 0", name);
    return 0;
}

static uintptr_t steamfriends_get_persona_state(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetPersonaState() -> 1");
    return 1;
}

static uintptr_t steamfriends_get_friend_count(DummyObject *self, uintptr_t flags, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetFriendCount(flags=%llu) -> 0", (unsigned long long)flags);
    return 0;
}

static uintptr_t steamfriends_get_friend_by_index(DummyObject *self, uintptr_t index, uintptr_t flags, uintptr_t a3, uintptr_t a4) {
    uintptr_t actual_index = index;
    uintptr_t actual_flags = flags;
    uintptr_t return_buffer = 0;

    if (can_access_process_memory(index, sizeof(uint64_t), 1)) {
        return_buffer = index;
        actual_index = flags;
        actual_flags = a3;
    }
    (void)a4;

    uint64_t result = 0;
    log_line(
        "SteamFriends::GetFriendByIndex entry self=%p return_buffer=%p index=%llu flags=%llu candidate=%llu",
        self,
        (void *)return_buffer,
        (unsigned long long)actual_index,
        (unsigned long long)actual_flags,
        (unsigned long long)result
    );
    if (return_buffer != 0) {
        uintptr_t buffered = write_steam_id_return_buffer("SteamFriends::GetFriendByIndex", return_buffer, result);
        if (buffered != 0) {
            return buffered;
        }
    }
    return return_steam_id_value("SteamFriends::GetFriendByIndex", self, (uintptr_t)&g_steam_friends_object, &g_steam_friends_object, result);
}

static uintptr_t steamfriends_get_friend_relationship(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    uintptr_t relationship = 0;
    log_line("SteamFriends::GetFriendRelationship(steam_id=%llu) -> %llu", (unsigned long long)normalized_steam_id, (unsigned long long)relationship);
    return relationship;
}

static uintptr_t steamfriends_get_friend_persona_state(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    uintptr_t state = is_fake_or_self_steam_id(normalized_steam_id) ? 1 : 0;
    log_line("SteamFriends::GetFriendPersonaState(steam_id=%llu) -> %llu", (unsigned long long)normalized_steam_id, (unsigned long long)state);
    return state;
}

static uintptr_t steamfriends_get_friend_persona_name(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    const char *name = is_fake_or_self_steam_id(normalized_steam_id) ? get_active_fake_persona_name() : g_fake_empty;
    MenuTeamMember *menu_member = menu_team_find(normalized_steam_id);
    if (menu_member) name = menu_member->name;
    log_line("SteamFriends::GetFriendPersonaName(steam_id=%llu) -> %s", (unsigned long long)normalized_steam_id, name[0] ? name : "<empty>");
    return (uintptr_t)name;
}

static uintptr_t steamfriends_request_user_information(DummyObject *self, uintptr_t steam_id, uintptr_t require_name_only, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    log_line("SteamFriends::RequestUserInformation(steam_id=%llu, require_name_only=%llu) -> false", (unsigned long long)normalized_steam_id, (unsigned long long)require_name_only);
    return 0;
}

static uintptr_t steamfriends_get_user_restrictions(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends015::GetUserRestrictions() -> 0");
    return 0;
}

static uintptr_t steamfriends_get_friend_game_played(DummyObject *self, uintptr_t steam_id, uintptr_t game_info, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    uintptr_t in_game = 0;

    if (is_fake_or_self_steam_id(normalized_steam_id)) {
        int has_live_server = g_fake_lobby_server[0] != '\0';
        int has_live_character = g_fake_lobby_character[0] != '\0';
        int explicit_in_game = g_fake_lobby_member_in_game[0] != '\0' && strcmp(g_fake_lobby_member_in_game, "0") != 0;
        int main_menu_state = strstr(g_fake_lobby_status, "Main Menu") != NULL;
        in_game = (has_live_server || has_live_character || explicit_in_game) && !main_menu_state;
    }

    if (game_info != 0 && can_access_process_memory(game_info, 24, 1)) {
        ZeroMemory((void *)game_info, 24);
        if (in_game) {
            write_u64((void *)game_info, 24, 0, (uint64_t)g_fake_app_id);
            write_u32((void *)game_info, 24, 8, 0);
            write_u16((void *)game_info, 24, 12, 0);
            write_u16((void *)game_info, 24, 14, 0);
            write_u64((void *)game_info, 24, 16, 0);
        }
    }

    log_line(
        "SteamFriends::GetFriendGamePlayed(steam_id=%llu, game_info=%p, server=%s, character=%s, inGame=%s, status=%s) -> %s",
        (unsigned long long)normalized_steam_id,
        (void *)game_info,
        g_fake_lobby_server[0] ? g_fake_lobby_server : "<empty>",
        g_fake_lobby_character[0] ? g_fake_lobby_character : "<empty>",
        g_fake_lobby_member_in_game[0] ? g_fake_lobby_member_in_game : "<empty>",
        g_fake_lobby_status[0] ? g_fake_lobby_status : "<empty>",
        in_game ? "true" : "false"
    );
    return in_game;
}

static uintptr_t steamfriends_get_friend_persona_name_history(DummyObject *self, uintptr_t steam_id, uintptr_t persona_index, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    log_line("SteamFriends::GetFriendPersonaNameHistory(steam_id=%llu, persona_index=%llu) -> <empty>", (unsigned long long)normalized_steam_id, (unsigned long long)persona_index);
    return (uintptr_t)g_fake_empty;
}

static uintptr_t steamfriends_get_friend_steam_level(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    log_line("SteamFriends::GetFriendSteamLevel(steam_id=%llu) -> 1", (unsigned long long)normalized_steam_id);
    return 1;
}

static uintptr_t steamfriends_get_player_nickname(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    log_line("SteamFriends::GetPlayerNickname(steam_id=%llu) -> <null>", (unsigned long long)normalized_steam_id);
    return 0;
}

static uintptr_t steamfriends_get_friends_group_count(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetFriendsGroupCount() -> 0");
    return 0;
}

static uintptr_t steamfriends_get_friends_group_id_by_index(DummyObject *self, uintptr_t index, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetFriendsGroupIDByIndex(index=%llu) -> -1", (unsigned long long)index);
    return (uintptr_t)-1;
}

static uintptr_t steamfriends_get_friends_group_name(DummyObject *self, uintptr_t group_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetFriendsGroupName(group_id=%llu) -> <empty>", (unsigned long long)group_id);
    return (uintptr_t)g_fake_empty;
}

static uintptr_t steamfriends_get_friends_group_members_count(DummyObject *self, uintptr_t group_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetFriendsGroupMembersCount(group_id=%llu) -> 0", (unsigned long long)group_id);
    return 0;
}

static uintptr_t steamfriends_get_friends_group_members_list(DummyObject *self, uintptr_t group_id, uintptr_t out_members, uintptr_t member_count, uintptr_t a4) {
    (void)self; (void)a4;
    if (out_members != 0 && member_count != 0 && can_access_process_memory(out_members, (size_t)(member_count * sizeof(uint64_t)), 1)) {
        ZeroMemory((void *)out_members, (size_t)(member_count * sizeof(uint64_t)));
    }
    log_line(
        "SteamFriends::GetFriendsGroupMembersList(group_id=%llu, out_members=%p, member_count=%llu)",
        (unsigned long long)group_id,
        (void *)out_members,
        (unsigned long long)member_count
    );
    return 0;
}

static uintptr_t steamfriends_has_friend(DummyObject *self, uintptr_t steam_id, uintptr_t friend_flags, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    uintptr_t has_friend = 0;
    log_line("SteamFriends::HasFriend(steam_id=%llu, flags=%llu) -> %llu", (unsigned long long)normalized_steam_id, (unsigned long long)friend_flags, (unsigned long long)has_friend);
    return has_friend;
}

static uintptr_t steamfriends_get_clan_count(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetClanCount() -> 0");
    return 0;
}

static uintptr_t steamfriends_get_clan_by_index(DummyObject *self, uintptr_t index, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetClanByIndex(index=%llu) -> 0", (unsigned long long)index);
    return 0;
}

static uintptr_t steamfriends_get_clan_name(DummyObject *self, uintptr_t clan_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetClanName(clan_id=%p) -> <empty>", (void *)clan_id);
    return (uintptr_t)g_fake_empty;
}

static uintptr_t steamfriends_get_clan_tag(DummyObject *self, uintptr_t clan_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetClanTag(clan_id=%p) -> <empty>", (void *)clan_id);
    return (uintptr_t)g_fake_empty;
}

static uintptr_t steamfriends_get_clan_activity_counts(DummyObject *self, uintptr_t clan_id, uintptr_t online, uintptr_t in_game, uintptr_t chatting) {
    (void)self;
    if (online != 0 && can_access_process_memory(online, sizeof(int), 1)) {
        *(int *)online = 0;
    }
    if (in_game != 0 && can_access_process_memory(in_game, sizeof(int), 1)) {
        *(int *)in_game = 0;
    }
    if (chatting != 0 && can_access_process_memory(chatting, sizeof(int), 1)) {
        *(int *)chatting = 0;
    }
    log_line("SteamFriends::GetClanActivityCounts(clan_id=%p, online=%p, in_game=%p, chatting=%p) -> false", (void *)clan_id, (void *)online, (void *)in_game, (void *)chatting);
    return 0;
}

static uintptr_t steamfriends_download_clan_activity_counts(DummyObject *self, uintptr_t clans, uintptr_t clan_count, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)clans; (void)a3; (void)a4;
    log_line("SteamFriends::DownloadClanActivityCounts(clans=%p, clan_count=%llu) -> api_call=4", (void *)clans, (unsigned long long)clan_count);
    return 4;
}

static uintptr_t steamfriends_get_friend_count_from_source(DummyObject *self, uintptr_t source_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamFriends::GetFriendCountFromSource(source_id=%p) -> 0", (void *)source_id);
    return 0;
}

static uintptr_t steamfriends_get_friend_from_source_by_index(DummyObject *self, uintptr_t source_id, uintptr_t index, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    uint64_t result = 0;
    log_line("SteamFriends::GetFriendFromSourceByIndex(source_id=%p, index=%llu) -> %llu", (void *)source_id, (unsigned long long)index, (unsigned long long)result);
    return result;
}

static uintptr_t steamfriends_is_user_in_source(DummyObject *self, uintptr_t user_id, uintptr_t source_id, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)source_id; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(user_id);
    uintptr_t in_source = 0;
    log_line("SteamFriends::IsUserInSource(user_id=%llu, source_id=%p) -> %llu", (unsigned long long)normalized_steam_id, (void *)source_id, (unsigned long long)in_source);
    return in_source;
}

static uintptr_t steamfriends_get_small_friend_avatar(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    log_line("SteamFriends::GetSmallFriendAvatar(steam_id=%llu) -> 0", (unsigned long long)normalized_steam_id);
    return 0;
}

static uintptr_t steamfriends_get_medium_friend_avatar(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    log_line("SteamFriends::GetMediumFriendAvatar(steam_id=%llu) -> 0", (unsigned long long)normalized_steam_id);
    return 0;
}

static uintptr_t steamfriends_get_large_friend_avatar(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    log_line("SteamFriends::GetLargeFriendAvatar(steam_id=%llu) -> 0", (unsigned long long)normalized_steam_id);
    return 0;
}

static uintptr_t steamfriends_set_rich_presence(DummyObject *self, uintptr_t key_ptr, uintptr_t value_ptr, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    char key[96];
    char value[160];
    key[0] = '\0';
    value[0] = '\0';
    try_read_ascii_c_string(key_ptr, key, sizeof(key));
    try_read_ascii_c_string(value_ptr, value, sizeof(value));

    if (should_ignore_boot_lobby_value(key, value)) {
        log_line("SteamFriends::SetRichPresence(key=%s, value=%s) -> true (ignored during NoSteam boot)", key[0] ? key : "<unreadable>", value[0] ? value : "<empty>");
        return 1;
    }

    if (_stricmp(key, "status") == 0) {
        set_fake_lobby_value(g_fake_lobby_status, sizeof(g_fake_lobby_status), value);
    } else if (_stricmp(key, "h1z1_server") == 0) {
        set_fake_lobby_value(g_fake_lobby_server, sizeof(g_fake_lobby_server), value);
    } else if (_stricmp(key, "h1z1_character") == 0) {
        set_fake_lobby_value(g_fake_lobby_character, sizeof(g_fake_lobby_character), value);
    } else if (_stricmp(key, "matchId") == 0) {
        set_fake_lobby_value(g_fake_match_id, sizeof(g_fake_match_id), value);
    } else if (_stricmp(key, "SelectedMatch") == 0) {
        set_fake_lobby_value(g_fake_selected_match, sizeof(g_fake_selected_match), value);
    } else if (_stricmp(key, "inGame") == 0) {
        set_fake_lobby_value(g_fake_lobby_member_in_game, sizeof(g_fake_lobby_member_in_game), value);
        sync_fake_boot_match_state("SteamFriends::SetRichPresence(inGame)", value);
    } else if (_stricmp(key, "h1z1_inmatch") == 0) {
        set_fake_lobby_value(g_fake_lobby_member_in_game, sizeof(g_fake_lobby_member_in_game), value);
        sync_fake_boot_match_state("SteamFriends::SetRichPresence(h1z1_inmatch)", value);
    }

    log_line("SteamFriends::SetRichPresence(key=%s, value=%s) -> true", key[0] ? key : "<unreadable>", value[0] ? value : "<empty>");
    return 1;
}

static uintptr_t steamfriends_clear_rich_presence(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    reset_fake_main_menu_state();
    log_line("SteamFriends::ClearRichPresence()");
    return 0;
}

static uintptr_t steamfriends_get_friend_rich_presence(DummyObject *self, uintptr_t steam_id, uintptr_t key_ptr, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    char key[96];
    key[0] = '\0';
    try_read_ascii_c_string(key_ptr, key, sizeof(key));
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    const char *value = is_fake_or_self_steam_id(normalized_steam_id) ? get_fake_rich_presence_value(key) : g_fake_empty;
    log_line("SteamFriends::GetFriendRichPresence(steam_id=%llu, key=%s) -> %s", (unsigned long long)normalized_steam_id, key[0] ? key : "<unreadable>", value[0] ? value : "<empty>");
    return (uintptr_t)value;
}

static uintptr_t steamfriends_get_friend_rich_presence_key_count(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    uintptr_t count = is_fake_or_self_steam_id(normalized_steam_id) ? ARRAYSIZE(g_fake_rich_presence_keys) : 0;
    log_line("SteamFriends::GetFriendRichPresenceKeyCount(steam_id=%llu) -> %llu", (unsigned long long)normalized_steam_id, (unsigned long long)count);
    return count;
}

static uintptr_t steamfriends_get_friend_rich_presence_key_by_index(DummyObject *self, uintptr_t steam_id, uintptr_t index, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    const char *value = g_fake_empty;
    if (is_fake_or_self_steam_id(normalized_steam_id) && index < ARRAYSIZE(g_fake_rich_presence_keys)) {
        value = g_fake_rich_presence_keys[index];
    }
    log_line("SteamFriends::GetFriendRichPresenceKeyByIndex(steam_id=%llu, index=%llu) -> %s", (unsigned long long)normalized_steam_id, (unsigned long long)index, value[0] ? value : "<empty>");
    return (uintptr_t)value;
}

static uintptr_t steamfriends_request_friend_rich_presence(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    log_line("SteamFriends::RequestFriendRichPresence(steam_id=%llu)", (unsigned long long)normalized_steam_id);
    maybe_dispatch_lobby_data_update("RequestFriendRichPresence", 1);
    return 0;
}

static uintptr_t steamfriends_invite_user_to_game(DummyObject *self, uintptr_t steam_id, uintptr_t connect_string, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    uint64_t normalized_steam_id = normalize_steam_id_argument(steam_id);
    char connect[192];
    connect[0] = '\0';
    try_read_ascii_c_string(connect_string, connect, sizeof(connect));
    log_line("SteamFriends::InviteUserToGame(steam_id=%llu, connect=%s) -> true", (unsigned long long)normalized_steam_id, connect[0] ? connect : "<empty>");
    return 1;
}

#define DEFINE_STEAMFRIENDS_SLOT(N) \
    static uintptr_t steamfriends_slot_##N(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) { \
        return generic_interface_method(self, N, a1, a2, a3, a4); \
    }

DEFINE_STEAMFRIENDS_SLOT(0)
DEFINE_STEAMFRIENDS_SLOT(1)
DEFINE_STEAMFRIENDS_SLOT(2)
DEFINE_STEAMFRIENDS_SLOT(3)
DEFINE_STEAMFRIENDS_SLOT(4)
DEFINE_STEAMFRIENDS_SLOT(5)
DEFINE_STEAMFRIENDS_SLOT(6)
DEFINE_STEAMFRIENDS_SLOT(7)
DEFINE_STEAMFRIENDS_SLOT(8)
DEFINE_STEAMFRIENDS_SLOT(9)
DEFINE_STEAMFRIENDS_SLOT(10)
DEFINE_STEAMFRIENDS_SLOT(11)
DEFINE_STEAMFRIENDS_SLOT(12)
DEFINE_STEAMFRIENDS_SLOT(13)
DEFINE_STEAMFRIENDS_SLOT(14)
DEFINE_STEAMFRIENDS_SLOT(15)
DEFINE_STEAMFRIENDS_SLOT(16)
DEFINE_STEAMFRIENDS_SLOT(17)
DEFINE_STEAMFRIENDS_SLOT(18)
DEFINE_STEAMFRIENDS_SLOT(19)
DEFINE_STEAMFRIENDS_SLOT(20)
DEFINE_STEAMFRIENDS_SLOT(21)
DEFINE_STEAMFRIENDS_SLOT(22)
DEFINE_STEAMFRIENDS_SLOT(23)
DEFINE_STEAMFRIENDS_SLOT(24)
DEFINE_STEAMFRIENDS_SLOT(25)
DEFINE_STEAMFRIENDS_SLOT(26)
DEFINE_STEAMFRIENDS_SLOT(27)
DEFINE_STEAMFRIENDS_SLOT(28)
DEFINE_STEAMFRIENDS_SLOT(29)
DEFINE_STEAMFRIENDS_SLOT(30)
DEFINE_STEAMFRIENDS_SLOT(31)
DEFINE_STEAMFRIENDS_SLOT(32)
DEFINE_STEAMFRIENDS_SLOT(33)
DEFINE_STEAMFRIENDS_SLOT(34)
DEFINE_STEAMFRIENDS_SLOT(35)
DEFINE_STEAMFRIENDS_SLOT(36)
DEFINE_STEAMFRIENDS_SLOT(37)
DEFINE_STEAMFRIENDS_SLOT(38)
DEFINE_STEAMFRIENDS_SLOT(39)
DEFINE_STEAMFRIENDS_SLOT(40)
DEFINE_STEAMFRIENDS_SLOT(41)
DEFINE_STEAMFRIENDS_SLOT(42)
DEFINE_STEAMFRIENDS_SLOT(43)
DEFINE_STEAMFRIENDS_SLOT(44)
DEFINE_STEAMFRIENDS_SLOT(45)
DEFINE_STEAMFRIENDS_SLOT(46)
DEFINE_STEAMFRIENDS_SLOT(47)
DEFINE_STEAMFRIENDS_SLOT(48)
DEFINE_STEAMFRIENDS_SLOT(49)
DEFINE_STEAMFRIENDS_SLOT(50)
DEFINE_STEAMFRIENDS_SLOT(51)
DEFINE_STEAMFRIENDS_SLOT(52)
DEFINE_STEAMFRIENDS_SLOT(53)
DEFINE_STEAMFRIENDS_SLOT(54)
DEFINE_STEAMFRIENDS_SLOT(55)
DEFINE_STEAMFRIENDS_SLOT(56)
DEFINE_STEAMFRIENDS_SLOT(57)
DEFINE_STEAMFRIENDS_SLOT(58)
DEFINE_STEAMFRIENDS_SLOT(59)
DEFINE_STEAMFRIENDS_SLOT(60)
DEFINE_STEAMFRIENDS_SLOT(61)
DEFINE_STEAMFRIENDS_SLOT(62)
DEFINE_STEAMFRIENDS_SLOT(63)

static uintptr_t steamfriends_slot_43_candidate(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    char preview1[96];
    char preview2[96];
    char preview4[96];
    preview1[0] = '\0';
    preview2[0] = '\0';
    preview4[0] = '\0';

    try_format_pointer_preview(a1, preview1, sizeof(preview1));
    try_format_pointer_preview(a2, preview2, sizeof(preview2));
    try_format_pointer_preview(a4, preview4, sizeof(preview4));

    log_line(
        "SteamFriends::method[43](self=%p, a1=%p%s, a2=%p%s, a3=%p, a4=%p%s) -> 1",
        self,
        (void *)a1,
        preview1,
        (void *)a2,
        preview2,
        (void *)a3,
        (void *)a4,
        preview4
    );
    return 1;
}

static uintptr_t steamuser_get_hsteam_user(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::GetHSteamUser()");
    return 1;
}

static uintptr_t steamuser_blogged_on(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::BLoggedOn()");
    return 1;
}

static uintptr_t steamuser_get_steam_id(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::GetSteamID entry self=%p shifted_self=%p", self, (void *)a1);
    uintptr_t buffered = write_steam_id_return_buffer("SteamUser019::GetSteamID", a1, g_fake_steam_id);
    if (buffered != 0) {
        return buffered;
    }
    return return_steam_id_value("SteamUser019::GetSteamID", self, a1, &g_steam_user_object, g_fake_steam_id);
}

static uintptr_t steamuser_initiate_game_connection_deprecated(DummyObject *self, uintptr_t auth_blob, uintptr_t max_blob, uintptr_t server_steam_id, uintptr_t server_ip) {
    (void)self;
    unsigned int size = 0;
    fill_buffer_with_ticket((void *)auth_blob, (int)max_blob, &size);
    log_line(
        "SteamUser019::InitiateGameConnection_DEPRECATED(auth_blob=%p, max=%lld, server_steam_id=%llu, server_ip=%llu) -> %u",
        (void *)auth_blob,
        (long long)max_blob,
        (unsigned long long)server_steam_id,
        (unsigned long long)server_ip,
        size
    );
    return size;
}

static uintptr_t steamuser_terminate_game_connection_deprecated(DummyObject *self, uintptr_t server_ip, uintptr_t server_port, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    log_line("SteamUser019::TerminateGameConnection_DEPRECATED(server_ip=%llu, server_port=%llu)", (unsigned long long)server_ip, (unsigned long long)server_port);
    return 0;
}

static uintptr_t steamuser_track_app_usage_event(DummyObject *self, uintptr_t game_id, uintptr_t usage_event, uintptr_t extra_info, uintptr_t a4) {
    (void)self; (void)a4;
    log_line(
        "SteamUser019::TrackAppUsageEvent(game_id=%llu, usage_event=%llu, extra=%s)",
        (unsigned long long)game_id,
        (unsigned long long)usage_event,
        extra_info ? (const char *)extra_info : "<null>"
    );
    return 0;
}

static uintptr_t steamuser_get_user_data_folder(DummyObject *self, uintptr_t buffer, uintptr_t buffer_size, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    char game_dir[MAX_PATH];
    get_game_directory(game_dir, sizeof(game_dir));
    if (buffer != 0 && buffer_size != 0) {
        lstrcpynA((char *)buffer, game_dir, (int)buffer_size);
    }
    log_line("SteamUser019::GetUserDataFolder(buffer=%p, size=%llu) -> %s", (void *)buffer, (unsigned long long)buffer_size, game_dir);
    return 1;
}

static uintptr_t steamuser_start_voice_recording(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::StartVoiceRecording()");
    return 0;
}

static uintptr_t steamuser_stop_voice_recording(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::StopVoiceRecording()");
    return 0;
}

static uintptr_t steamuser_get_available_voice(DummyObject *self, uintptr_t compressed, uintptr_t uncompressed, uintptr_t sample_rate, uintptr_t a4) {
    (void)self; (void)a4;
    if (compressed != 0) {
        *(uint32_t *)compressed = 0;
    }
    if (uncompressed != 0) {
        *(uint32_t *)uncompressed = 0;
    }
    log_line("SteamUser019::GetAvailableVoice(compressed=%p, uncompressed=%p, sample_rate=%llu) -> 3", (void *)compressed, (void *)uncompressed, (unsigned long long)sample_rate);
    return 3;
}

static uintptr_t steamuser_get_voice(DummyObject *self, uintptr_t want_compressed, uintptr_t dest, uintptr_t dest_size, uintptr_t bytes_written) {
    (void)self;
    if (bytes_written != 0) {
        *(uint32_t *)bytes_written = 0;
    }
    log_line("SteamUser019::GetVoice(want_compressed=%llu, dest=%p, size=%llu, written=%p) -> 3", (unsigned long long)want_compressed, (void *)dest, (unsigned long long)dest_size, (void *)bytes_written);
    return 3;
}

static uintptr_t steamuser_decompress_voice(DummyObject *self, uintptr_t compressed, uintptr_t compressed_size, uintptr_t dest, uintptr_t dest_size) {
    (void)self;
    log_line("SteamUser019::DecompressVoice(compressed=%p, compressed_size=%llu, dest=%p, dest_size=%llu) -> 3", (void *)compressed, (unsigned long long)compressed_size, (void *)dest, (unsigned long long)dest_size);
    return 3;
}

static uintptr_t steamuser_get_voice_optimal_sample_rate(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::GetVoiceOptimalSampleRate() -> 24000");
    return 24000;
}

static uintptr_t steamuser_get_auth_session_ticket_v019(DummyObject *self, uintptr_t ticket_buffer, uintptr_t max_ticket, uintptr_t ticket_size_out, uintptr_t identity_ptr) {
    (void)self;
    fill_buffer_with_ticket((void *)ticket_buffer, (int)max_ticket, (unsigned int *)ticket_size_out);
    log_line(
        "SteamUser019::GetAuthSessionTicket(buffer=%p, max=%llu, out=%p, identity=%p) -> 1",
        (void *)ticket_buffer,
        (unsigned long long)max_ticket,
        (void *)ticket_size_out,
        (void *)identity_ptr
    );
    return 1;
}

static uintptr_t steamuser_get_auth_ticket_for_web_api(DummyObject *self, uintptr_t identity, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::GetAuthTicketForWebApi(identity=%s) -> 1", identity ? (const char *)identity : "<null>");
    return 1;
}

static uintptr_t steamuser_begin_auth_session(DummyObject *self, uintptr_t ticket, uintptr_t ticket_size, uintptr_t steam_id, uintptr_t a4) {
    (void)self; (void)a4;
    log_line("SteamUser019::BeginAuthSession(ticket=%p, size=%llu, steam_id=%llu) -> 0", (void *)ticket, (unsigned long long)ticket_size, (unsigned long long)steam_id);
    return 0;
}

static uintptr_t steamuser_end_auth_session(DummyObject *self, uintptr_t steam_id, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::EndAuthSession(steam_id=%llu)", (unsigned long long)steam_id);
    return 0;
}

static uintptr_t steamuser_cancel_auth_ticket_v019(DummyObject *self, uintptr_t auth_ticket, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::CancelAuthTicket(ticket=%llu)", (unsigned long long)auth_ticket);
    return 0;
}

static uintptr_t steamuser_user_has_license_for_app(DummyObject *self, uintptr_t steam_id, uintptr_t app_id, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    log_line("SteamUser019::UserHasLicenseForApp(steam_id=%llu, app_id=%llu) -> 0", (unsigned long long)steam_id, (unsigned long long)app_id);
    return 0;
}

static uintptr_t steamuser_bis_behind_nat(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::BIsBehindNAT() -> false");
    return 0;
}

static uintptr_t steamuser_advertise_game(DummyObject *self, uintptr_t server_steam_id, uintptr_t server_ip, uintptr_t server_port, uintptr_t a4) {
    (void)self; (void)a4;
    log_line("SteamUser019::AdvertiseGame(server_steam_id=%llu, server_ip=%llu, server_port=%llu)", (unsigned long long)server_steam_id, (unsigned long long)server_ip, (unsigned long long)server_port);
    return 0;
}

static uintptr_t steamuser_request_encrypted_app_ticket_v019(DummyObject *self, uintptr_t data, uintptr_t data_size, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    SteamAPICall_t handle = queue_callresult(154);
    log_line("SteamUser019::RequestEncryptedAppTicket(data=%p, size=%llu) -> api_call=%d (queued EncryptedAppTicketResponse_t)", (void *)data, (unsigned long long)data_size, handle);
    return (uintptr_t)handle;
}

static uintptr_t steamuser_get_encrypted_app_ticket_v019(DummyObject *self, uintptr_t ticket_buffer, uintptr_t max_ticket, uintptr_t ticket_size_out, uintptr_t a4) {
    (void)self; (void)a4;
    fill_buffer_with_ticket((void *)ticket_buffer, (int)max_ticket, (unsigned int *)ticket_size_out);
    log_line("SteamUser019::GetEncryptedAppTicket(buffer=%p, max=%llu, out=%p) -> true", (void *)ticket_buffer, (unsigned long long)max_ticket, (void *)ticket_size_out);
    return 1;
}

static uintptr_t steamuser_get_game_badge_level(DummyObject *self, uintptr_t series, uintptr_t foil, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a3; (void)a4;
    log_line("SteamUser019::GetGameBadgeLevel(series=%llu, foil=%llu) -> 0", (unsigned long long)series, (unsigned long long)foil);
    return 0;
}

static uintptr_t steamuser_get_player_steam_level(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::GetPlayerSteamLevel() -> 1");
    return 1;
}

static uintptr_t steamuser_request_store_auth_url(DummyObject *self, uintptr_t url, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::RequestStoreAuthURL(url=%s) -> 1", url ? (const char *)url : "<null>");
    return 1;
}

static uintptr_t steamuser_bool_false(DummyObject *self, int index, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self;
    log_line("SteamUser019::method[%d](a1=%p, a2=%p, a3=%p, a4=%p) -> false", index, (void *)a1, (void *)a2, (void *)a3, (void *)a4);
    return 0;
}

static uintptr_t steamuser_bis_phone_verified(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamuser_bool_false(self, 24, a1, a2, a3, a4);
}

static uintptr_t steamuser_bis_two_factor_enabled(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamuser_bool_false(self, 25, a1, a2, a3, a4);
}

static uintptr_t steamuser_bis_phone_identifying(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamuser_bool_false(self, 26, a1, a2, a3, a4);
}

static uintptr_t steamuser_bis_phone_requiring_verification(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    return steamuser_bool_false(self, 27, a1, a2, a3, a4);
}

static uintptr_t steamuser_get_market_eligibility(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::GetMarketEligibility() -> 1");
    return 1;
}

static uintptr_t steamuser_get_duration_control(DummyObject *self, uintptr_t a1, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a1; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::GetDurationControl() -> 1");
    return 1;
}

static uintptr_t steamuser_bset_duration_control_online_state(DummyObject *self, uintptr_t state, uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    (void)self; (void)a2; (void)a3; (void)a4;
    log_line("SteamUser019::BSetDurationControlOnlineState(state=%llu) -> true", (unsigned long long)state);
    return 1;
}

static void init_specific_vtables(void) {
    static int initialized = 0;
    if (initialized) {
        return;
    }
    initialized = 1;

    for (int i = 0; i < GENERIC_VTABLE_SIZE; ++i) {
        g_generic_vtable[i] = (void *)generic_interface_method_extended;
    }

    g_generic_vtable[0] = (void *)generic_method_0;
    g_generic_vtable[1] = (void *)generic_method_1;
    g_generic_vtable[2] = (void *)generic_method_2;
    g_generic_vtable[3] = (void *)generic_method_3;
    g_generic_vtable[4] = (void *)generic_method_4;
    g_generic_vtable[5] = (void *)generic_method_5;
    g_generic_vtable[6] = (void *)generic_method_6;
    g_generic_vtable[7] = (void *)generic_method_7;
    g_generic_vtable[8] = (void *)generic_method_8;
    g_generic_vtable[9] = (void *)generic_method_9;
    g_generic_vtable[10] = (void *)generic_method_10;
    g_generic_vtable[11] = (void *)generic_method_11;
    g_generic_vtable[12] = (void *)generic_method_12;
    g_generic_vtable[13] = (void *)generic_method_13;
    g_generic_vtable[14] = (void *)generic_method_14;
    g_generic_vtable[15] = (void *)generic_method_15;
    g_generic_vtable[16] = (void *)generic_method_16;
    g_generic_vtable[17] = (void *)generic_method_17;
    g_generic_vtable[18] = (void *)generic_method_18;
    g_generic_vtable[19] = (void *)generic_method_19;
    g_generic_vtable[20] = (void *)generic_method_20;
    g_generic_vtable[21] = (void *)generic_method_21;
    g_generic_vtable[22] = (void *)generic_method_22;
    g_generic_vtable[23] = (void *)generic_method_23;
    g_generic_vtable[24] = (void *)generic_method_24;
    g_generic_vtable[25] = (void *)generic_method_25;
    g_generic_vtable[26] = (void *)generic_method_26;
    g_generic_vtable[27] = (void *)generic_method_27;
    g_generic_vtable[28] = (void *)generic_method_28;
    g_generic_vtable[29] = (void *)generic_method_29;
    g_generic_vtable[30] = (void *)generic_method_30;
    g_generic_vtable[31] = (void *)generic_method_31;
    g_generic_vtable[32] = (void *)generic_method_32;
    g_generic_vtable[33] = (void *)generic_method_33;
    g_generic_vtable[34] = (void *)generic_method_34;
    g_generic_vtable[35] = (void *)generic_method_35;
    g_generic_vtable[36] = (void *)generic_method_36;
    g_generic_vtable[37] = (void *)generic_method_37;
    g_generic_vtable[38] = (void *)generic_method_38;
    g_generic_vtable[39] = (void *)generic_method_39;
    g_generic_vtable[40] = (void *)generic_method_40;

    for (int i = 0; i < INTERFACE_VTABLE_SIZE; ++i) {
        g_steam_user_vtable[i] = g_generic_vtable[i];
        g_steam_utils_vtable[i] = g_generic_vtable[i];
        g_steam_apps_vtable[i] = g_generic_vtable[i];
        g_steam_friends_vtable[i] = g_generic_vtable[i];
    }

    for (int i = 0; i < STEAMCLIENT_VTABLE_SIZE; ++i) {
        g_steam_client_vtable[i] = (void *)generic_interface_method_extended;
    }

    g_steam_client_vtable[0] = (void *)steamclient_create_steam_pipe;
    g_steam_client_vtable[1] = (void *)steamclient_brelease_steam_pipe;
    g_steam_client_vtable[2] = (void *)steamclient_connect_to_global_user;
    g_steam_client_vtable[3] = (void *)steamclient_create_local_user;
    g_steam_client_vtable[4] = (void *)steamclient_release_user;
    g_steam_client_vtable[5] = (void *)steamclient_get_isteam_user;
    g_steam_client_vtable[6] = (void *)steamclient_fallback_6;
    g_steam_client_vtable[7] = (void *)steamclient_fallback_7;
    g_steam_client_vtable[8] = (void *)steamclient_get_isteam_friends;
    g_steam_client_vtable[9] = (void *)steamclient_get_isteam_utils;
    g_steam_client_vtable[10] = (void *)steamclient_get_isteam_matchmaking;
    g_steam_client_vtable[11] = (void *)steamclient_get_isteam_matchmaking_servers;
    g_steam_client_vtable[12] = (void *)steamclient_get_isteam_generic_interface;
    g_steam_client_vtable[13] = (void *)steamclient_get_isteam_user_stats;
    g_steam_client_vtable[14] = (void *)steamclient_fallback_14;
    g_steam_client_vtable[15] = (void *)steamclient_get_isteam_apps;
    g_steam_client_vtable[16] = (void *)steamclient_get_isteam_networking;
    g_steam_client_vtable[17] = (void *)steamclient_get_isteam_remote_storage;
    g_steam_client_vtable[18] = (void *)steamclient_get_isteam_screenshots;
    g_steam_client_vtable[19] = (void *)steamclient_run_frame;
    g_steam_client_vtable[20] = (void *)steamclient_get_ipc_call_count;
    g_steam_client_vtable[21] = (void *)steamclient_set_warning_message_hook;
    g_steam_client_vtable[22] = (void *)steamclient_shutdown_if_all_pipes_closed;
    g_steam_client_vtable[23] = (void *)steamclient_get_isteam_http;
    g_steam_client_vtable[24] = (void *)steamclient_slot24_interface;
    g_steam_client_vtable[25] = (void *)steamclient_slot25_interface;
    g_steam_client_vtable[26] = (void *)steamclient_slot26_interface;
    g_steam_client_vtable[27] = (void *)steamclient_slot27_interface;
    g_steam_client_vtable[28] = (void *)steamclient_slot28_interface;
    g_steam_client_vtable[29] = (void *)steamclient_slot29_interface;
    g_steam_client_vtable[30] = (void *)steamclient_slot30_interface;
    g_steam_client_vtable[31] = (void *)steamclient_deprecated_set_post_api_result;
    g_steam_client_vtable[32] = (void *)steamclient_deprecated_remove_post_api_result;
    g_steam_client_vtable[33] = (void *)steamclient_set_check_callback_registered;
    g_steam_client_vtable[34] = (void *)steamclient_get_isteam_inventory;
    g_steam_client_vtable[35] = (void *)steamclient_get_isteam_video;
    g_steam_client_vtable[36] = (void *)steamclient_fallback_36;
    g_steam_client_vtable[37] = (void *)steamclient_fallback_37;
    g_steam_client_vtable[38] = (void *)steamclient_fallback_38;
    g_steam_client_vtable[39] = (void *)steamclient_fallback_39;

    g_steam_user_vtable[0] = (void *)steamuser_get_hsteam_user;
    g_steam_user_vtable[1] = (void *)steamuser_blogged_on;
    g_steam_user_vtable[2] = (void *)steamuser_get_steam_id;
    g_steam_user_vtable[3] = (void *)steamuser_initiate_game_connection_deprecated;
    g_steam_user_vtable[4] = (void *)steamuser_terminate_game_connection_deprecated;
    g_steam_user_vtable[5] = (void *)steamuser_track_app_usage_event;
    g_steam_user_vtable[6] = (void *)steamuser_get_user_data_folder;
    g_steam_user_vtable[7] = (void *)steamuser_start_voice_recording;
    g_steam_user_vtable[8] = (void *)steamuser_stop_voice_recording;
    g_steam_user_vtable[9] = (void *)steamuser_get_available_voice;
    g_steam_user_vtable[10] = (void *)steamuser_get_voice;
    g_steam_user_vtable[11] = (void *)steamuser_decompress_voice;
    g_steam_user_vtable[12] = (void *)steamuser_get_voice_optimal_sample_rate;
    g_steam_user_vtable[13] = (void *)steamuser_get_auth_session_ticket_v019;
    g_steam_user_vtable[14] = (void *)steamuser_begin_auth_session;
    g_steam_user_vtable[15] = (void *)steamuser_end_auth_session;
    g_steam_user_vtable[16] = (void *)steamuser_cancel_auth_ticket_v019;
    g_steam_user_vtable[17] = (void *)steamuser_user_has_license_for_app;
    g_steam_user_vtable[18] = (void *)steamuser_bis_behind_nat;
    g_steam_user_vtable[19] = (void *)steamuser_advertise_game;
    g_steam_user_vtable[20] = (void *)steamuser_request_encrypted_app_ticket_v019;
    g_steam_user_vtable[21] = (void *)steamuser_get_encrypted_app_ticket_v019;
    g_steam_user_vtable[22] = (void *)steamuser_get_game_badge_level;
    g_steam_user_vtable[23] = (void *)steamuser_get_player_steam_level;
    g_steam_user_vtable[24] = (void *)steamuser_request_store_auth_url;
    g_steam_user_vtable[25] = (void *)steamuser_bis_phone_verified;
    g_steam_user_vtable[26] = (void *)steamuser_bis_two_factor_enabled;
    g_steam_user_vtable[27] = (void *)steamuser_bis_phone_identifying;
    g_steam_user_vtable[28] = (void *)steamuser_bis_phone_requiring_verification;
    g_steam_user_vtable[29] = (void *)steamuser_get_market_eligibility;
    g_steam_user_vtable[30] = (void *)steamuser_get_duration_control;

    g_steam_utils_vtable[0] = (void *)steamutils_get_seconds_since_app_active;
    g_steam_utils_vtable[1] = (void *)steamutils_get_seconds_since_computer_active;
    g_steam_utils_vtable[2] = (void *)steamutils_get_connected_universe;
    g_steam_utils_vtable[3] = (void *)steamutils_get_server_real_time;
    g_steam_utils_vtable[4] = (void *)steamutils_get_ip_country;
    g_steam_utils_vtable[9] = (void *)steamutils_get_app_id;
    g_steam_utils_vtable[14] = (void *)steamutils_run_frame;
    g_steam_utils_vtable[15] = (void *)steamutils_get_ipc_call_count;
    g_steam_utils_vtable[16] = (void *)steamutils_set_warning_message_hook;
    g_steam_utils_vtable[17] = (void *)steamutils_is_overlay_enabled;

    g_steam_apps_vtable[0] = (void *)steamapps_bis_subscribed;
    g_steam_apps_vtable[1] = (void *)steamapps_bis_low_violence;
    g_steam_apps_vtable[2] = (void *)steamapps_bis_cybercafe;
    g_steam_apps_vtable[3] = (void *)steamapps_bis_vac_banned;
    g_steam_apps_vtable[4] = (void *)steamapps_get_current_game_language;
    g_steam_apps_vtable[5] = (void *)steamapps_get_available_game_languages;
    g_steam_apps_vtable[6] = (void *)steamapps_bis_subscribed_app;
    g_steam_apps_vtable[7] = (void *)steamapps_bis_dlc_installed;
    g_steam_apps_vtable[8] = (void *)steamapps_get_earliest_purchase_time;
    g_steam_apps_vtable[9] = (void *)steamapps_bis_subscribed_from_free_weekend;
    g_steam_apps_vtable[10] = (void *)steamapps_get_dlc_count;
    g_steam_apps_vtable[11] = (void *)steamapps_bget_dlc_data_by_index;
    g_steam_apps_vtable[15] = (void *)steamapps_get_current_beta_name;
    g_steam_apps_vtable[16] = (void *)steamapps_mark_content_corrupt;
    g_steam_apps_vtable[17] = (void *)steamapps_get_installed_depots;
    g_steam_apps_vtable[18] = (void *)steamapps_get_app_install_dir;
    g_steam_apps_vtable[19] = (void *)steamapps_bis_app_installed;
    g_steam_apps_vtable[20] = (void *)steamapps_get_app_owner;
    g_steam_apps_vtable[21] = (void *)steamapps_get_launch_query_param;
    g_steam_apps_vtable[22] = (void *)steamapps_get_dlc_download_progress;
    g_steam_apps_vtable[23] = (void *)steamapps_get_app_build_id;
    g_steam_apps_vtable[25] = (void *)steamapps_get_file_details;
    g_steam_apps_vtable[26] = (void *)steamapps_get_launch_command_line;
    g_steam_apps_vtable[27] = (void *)steamapps_bis_subscribed_from_family_sharing;
    g_steam_apps_vtable[28] = (void *)steamapps_bis_timed_trial;
    g_steam_apps_vtable[29] = (void *)steamapps_set_dlc_context;

    g_steam_friends_vtable[0] = (void *)steamfriends_slot_0;
    g_steam_friends_vtable[1] = (void *)steamfriends_slot_1;
    g_steam_friends_vtable[2] = (void *)steamfriends_slot_2;
    g_steam_friends_vtable[3] = (void *)steamfriends_slot_3;
    g_steam_friends_vtable[4] = (void *)steamfriends_slot_4;
    g_steam_friends_vtable[5] = (void *)steamfriends_slot_5;
    g_steam_friends_vtable[6] = (void *)steamfriends_slot_6;
    g_steam_friends_vtable[7] = (void *)steamfriends_slot_7;
    g_steam_friends_vtable[8] = (void *)steamfriends_slot_8;
    g_steam_friends_vtable[9] = (void *)steamfriends_slot_9;
    g_steam_friends_vtable[10] = (void *)steamfriends_slot_10;
    g_steam_friends_vtable[11] = (void *)steamfriends_slot_11;
    g_steam_friends_vtable[12] = (void *)steamfriends_slot_12;
    g_steam_friends_vtable[13] = (void *)steamfriends_slot_13;
    g_steam_friends_vtable[14] = (void *)steamfriends_slot_14;
    g_steam_friends_vtable[15] = (void *)steamfriends_slot_15;
    g_steam_friends_vtable[16] = (void *)steamfriends_slot_16;
    g_steam_friends_vtable[17] = (void *)steamfriends_slot_17;
    g_steam_friends_vtable[18] = (void *)steamfriends_slot_18;
    g_steam_friends_vtable[19] = (void *)steamfriends_slot_19;
    g_steam_friends_vtable[20] = (void *)steamfriends_slot_20;
    g_steam_friends_vtable[21] = (void *)steamfriends_slot_21;
    g_steam_friends_vtable[22] = (void *)steamfriends_slot_22;
    g_steam_friends_vtable[23] = (void *)steamfriends_slot_23;
    g_steam_friends_vtable[24] = (void *)steamfriends_slot_24;
    g_steam_friends_vtable[25] = (void *)steamfriends_slot_25;
    g_steam_friends_vtable[26] = (void *)steamfriends_slot_26;
    g_steam_friends_vtable[27] = (void *)steamfriends_slot_27;
    g_steam_friends_vtable[28] = (void *)steamfriends_slot_28;
    g_steam_friends_vtable[29] = (void *)steamfriends_slot_29;
    g_steam_friends_vtable[30] = (void *)steamfriends_slot_30;
    g_steam_friends_vtable[31] = (void *)steamfriends_slot_31;
    g_steam_friends_vtable[32] = (void *)steamfriends_slot_32;
    g_steam_friends_vtable[33] = (void *)steamfriends_slot_33;
    g_steam_friends_vtable[34] = (void *)steamfriends_slot_34;
    g_steam_friends_vtable[35] = (void *)steamfriends_slot_35;
    g_steam_friends_vtable[36] = (void *)steamfriends_slot_36;
    g_steam_friends_vtable[37] = (void *)steamfriends_slot_37;
    g_steam_friends_vtable[38] = (void *)steamfriends_slot_38;
    g_steam_friends_vtable[39] = (void *)steamfriends_slot_39;
    g_steam_friends_vtable[40] = (void *)steamfriends_slot_40;
    g_steam_friends_vtable[41] = (void *)steamfriends_slot_41;
    g_steam_friends_vtable[42] = (void *)steamfriends_slot_42;
    g_steam_friends_vtable[43] = (void *)steamfriends_slot_43_candidate;
    g_steam_friends_vtable[44] = (void *)steamfriends_slot_44;
    g_steam_friends_vtable[45] = (void *)steamfriends_slot_45;
    g_steam_friends_vtable[46] = (void *)steamfriends_slot_46;
    g_steam_friends_vtable[47] = (void *)steamfriends_slot_47;
    g_steam_friends_vtable[48] = (void *)steamfriends_slot_48;
    g_steam_friends_vtable[49] = (void *)steamfriends_slot_49;
    g_steam_friends_vtable[50] = (void *)steamfriends_slot_50;
    g_steam_friends_vtable[51] = (void *)steamfriends_slot_51;
    g_steam_friends_vtable[52] = (void *)steamfriends_slot_52;
    g_steam_friends_vtable[53] = (void *)steamfriends_slot_53;
    g_steam_friends_vtable[54] = (void *)steamfriends_slot_54;
    g_steam_friends_vtable[55] = (void *)steamfriends_slot_55;
    g_steam_friends_vtable[56] = (void *)steamfriends_slot_56;
    g_steam_friends_vtable[57] = (void *)steamfriends_slot_57;
    g_steam_friends_vtable[58] = (void *)steamfriends_slot_58;
    g_steam_friends_vtable[59] = (void *)steamfriends_slot_59;
    g_steam_friends_vtable[60] = (void *)steamfriends_slot_60;
    g_steam_friends_vtable[61] = (void *)steamfriends_slot_61;
    g_steam_friends_vtable[62] = (void *)steamfriends_slot_62;
    g_steam_friends_vtable[63] = (void *)steamfriends_slot_63;

    g_steam_friends_vtable[0] = (void *)steamfriends_get_persona_name;
    g_steam_friends_vtable[1] = (void *)steamfriends_set_persona_name;
    g_steam_friends_vtable[2] = (void *)steamfriends_get_persona_state;
    g_steam_friends_vtable[3] = (void *)steamfriends_get_friend_count;
    g_steam_friends_vtable[4] = (void *)steamfriends_get_friend_by_index;
    g_steam_friends_vtable[5] = (void *)steamfriends_get_friend_relationship;
    g_steam_friends_vtable[6] = (void *)steamfriends_get_friend_persona_state;
    g_steam_friends_vtable[7] = (void *)steamfriends_get_friend_persona_name;
    g_steam_friends_vtable[8] = (void *)steamfriends_get_friend_game_played;
    g_steam_friends_vtable[9] = (void *)steamfriends_get_friend_persona_name_history;
    g_steam_friends_vtable[10] = (void *)steamfriends_get_friend_steam_level;
    g_steam_friends_vtable[11] = (void *)steamfriends_get_player_nickname;
    g_steam_friends_vtable[12] = (void *)steamfriends_get_friends_group_count;
    g_steam_friends_vtable[13] = (void *)steamfriends_get_friends_group_id_by_index;
    g_steam_friends_vtable[14] = (void *)steamfriends_get_friends_group_name;
    g_steam_friends_vtable[15] = (void *)steamfriends_get_friends_group_members_count;
    g_steam_friends_vtable[16] = (void *)steamfriends_get_friends_group_members_list;
    g_steam_friends_vtable[17] = (void *)steamfriends_has_friend;
    g_steam_friends_vtable[18] = (void *)steamfriends_get_clan_count;
    g_steam_friends_vtable[19] = (void *)steamfriends_get_clan_by_index;
    g_steam_friends_vtable[20] = (void *)steamfriends_get_clan_name;
    g_steam_friends_vtable[21] = (void *)steamfriends_get_clan_tag;
    g_steam_friends_vtable[22] = (void *)steamfriends_get_clan_activity_counts;
    g_steam_friends_vtable[23] = (void *)steamfriends_download_clan_activity_counts;
    g_steam_friends_vtable[24] = (void *)steamfriends_get_friend_count_from_source;
    g_steam_friends_vtable[25] = (void *)steamfriends_get_friend_from_source_by_index;
    g_steam_friends_vtable[26] = (void *)steamfriends_is_user_in_source;
    g_steam_friends_vtable[34] = (void *)steamfriends_get_small_friend_avatar;
    g_steam_friends_vtable[35] = (void *)steamfriends_get_medium_friend_avatar;
    g_steam_friends_vtable[36] = (void *)steamfriends_get_large_friend_avatar;
    g_steam_friends_vtable[37] = (void *)steamfriends_request_user_information;
    g_steam_friends_vtable[42] = (void *)steamfriends_get_user_restrictions;
    g_steam_friends_vtable[43] = (void *)steamfriends_set_rich_presence;
    g_steam_friends_vtable[44] = (void *)steamfriends_clear_rich_presence;
    g_steam_friends_vtable[45] = (void *)steamfriends_get_friend_rich_presence;
    g_steam_friends_vtable[46] = (void *)steamfriends_get_friend_rich_presence_key_count;
    g_steam_friends_vtable[47] = (void *)steamfriends_get_friend_rich_presence_key_by_index;
    g_steam_friends_vtable[48] = (void *)steamfriends_request_friend_rich_presence;
    g_steam_friends_vtable[49] = (void *)steamfriends_invite_user_to_game;
}

__declspec(dllexport) int SteamAPI_Init(void) {
    log_line("SteamAPI_Init()");
    return 1;
}

__declspec(dllexport) void SteamAPI_Shutdown(void) {
    log_line("SteamAPI_Shutdown()");
}

__declspec(dllexport) void SteamAPI_RunCallbacks(void) {
    LONG count = InterlockedIncrement(&g_run_callbacks_counter);
    if (count <= 10 || (count % 100) == 0) {
        log_line(
            "SteamAPI_RunCallbacks(count=%ld, callbacks=%ld, callresults=%ld)",
            count,
            g_registered_callback_count,
            g_registered_callresult_count
        );
    }
    dispatch_boot_callbacks_if_needed("RunCallbacks");
    dispatch_registered_callresults_if_needed("RunCallbacks");
    poll_menu_duo_native(GetTickCount64());
}

__declspec(dllexport) HSteamUser SteamAPI_GetHSteamUser(void) {
    log_line("SteamAPI_GetHSteamUser()");
    return 1;
}

__declspec(dllexport) HSteamPipe SteamAPI_GetHSteamPipe(void) {
    log_line("SteamAPI_GetHSteamPipe()");
    return 1;
}

__declspec(dllexport) void SteamAPI_RegisterCallback(void *callback, int callback_id) {
    remember_registered_callback(callback, callback_id);
    log_line(
        "SteamAPI_RegisterCallback(callback=%p, callback_id=%d, name=%s)",
        callback,
        callback_id,
        get_callback_name(callback_id)
    );
    if (g_registered_callback_count >= 11 && InterlockedCompareExchange(&g_boot_callbacks_dispatched, 1, 0) == 0) {
        dispatch_boot_callbacks_if_needed("RegisterCallback");
    }
}

__declspec(dllexport) void SteamAPI_UnregisterCallback(void *callback) {
    forget_registered_callback(callback);
    log_line("SteamAPI_UnregisterCallback(callback=%p)", callback);
}

__declspec(dllexport) void SteamAPI_RegisterCallResult(void *callback, SteamAPICall_t api_call) {
    remember_registered_callresult(callback, api_call);
    log_line(
        "SteamAPI_RegisterCallResult(callback=%p, api_call=%d, registered=%ld)",
        callback,
        api_call,
        g_registered_callresult_count
    );
}

__declspec(dllexport) void SteamAPI_UnregisterCallResult(void *callback, SteamAPICall_t api_call) {
    forget_registered_callresult(callback, api_call);
    log_line(
        "SteamAPI_UnregisterCallResult(callback=%p, api_call=%d)",
        callback,
        api_call
    );
}

__declspec(dllexport) void *SteamInternal_CreateInterface(const char *version) {
    LONG count = InterlockedIncrement(&g_interface_counter);
    DummyObject *object = NULL;

    if (version != NULL && strcmp(version, "SteamClient017") == 0) {
        object = &g_steam_client_object;
    } else {
        object = create_interface_for_version(version);
    }

    log_line(
        "SteamInternal_CreateInterface(version=%s, count=%ld) -> %s",
        version ? version : "<null>",
        count,
        object->name ? object->name : "<unnamed>"
    );
    return object;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance;
    (void)reserved;

    if (reason == DLL_PROCESS_ATTACH) {
        init_specific_vtables();
        g_steam_client_object.vtable = g_steam_client_vtable;
        g_steam_client_object.name = "SteamClient017";
        ensure_log_lock();
        initialize_fake_steam_id_from_env();
        log_line("steam_api64.dll shim attached");
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_log_lock_ready) {
            log_line("steam_api64.dll shim detached");
            DeleteCriticalSection(&g_log_lock);
            g_log_lock_ready = 0;
        }
    }

    return TRUE;
}
