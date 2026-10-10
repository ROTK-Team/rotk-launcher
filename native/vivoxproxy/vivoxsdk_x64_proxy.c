#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#include "voice_hud_protocol.h"
#if defined(ROTK_VIVOX_V5_COMPAT)
#include "voice_volume_compat.h"
static SRWLOCK g_volume_lock = SRWLOCK_INIT;
static rotk_volume_table g_volume_pending;
static rotk_volume_destroy_fn g_volume_destroy;
#endif

#if defined(ROTK_VIVOX_IAT_HOOK)
#define ORIGINAL_DLL_NAME L"vivoxsdk_x64.dll"
#define TRACE_FILE_NAME L"rotk-vivox-hook.log"
#elif defined(ROTK_VIVOX_V5_COMPAT)
#define ORIGINAL_DLL_NAME L"vivoxsdk_x64_v5.dll"
#define TRACE_FILE_NAME L"rotk-vivox-v5-compat.log"
#else
#define ORIGINAL_DLL_NAME L"vivoxsdk_x64_original.dll"
#define TRACE_FILE_NAME L"rotk-vivoxproxy.log"
#endif
#define VOICE_TIMEOUT_MS 2000U
#define VOICE_ERROR (-1)

#define REQUEST_TYPE_OFFSET 0x18U
#define REQUEST_LOGIN 0x83U
#define REQUEST_SESSIONGROUP_CREATE 0x06U
#define REQUEST_SESSION 0x10U
#define REQUEST_SESSIONGROUP_ADD 0x08U
#define REQUEST_SESSION_SEND_NOTIFICATION 0x4bU
#define REQUEST_SESSION_SET_3D_POSITION 0x1cU
#define POSITION_REQUEST_BYTES 0x130U
#define POSITION_DISPOSITION_OFFSET 0x12cU
#define POSITION_NO_REPLY_REQUIRED 1U
#define LOGIN_REQUEST_BYTES 0x90U
#define SESSION_REQUEST_BYTES 0x90U
#define SESSIONGROUP_REQUEST_BYTES 0x80U
#define LOGIN_DISPLAY_NAME_OFFSET 0x38U
#define LOGIN_ACCOUNT_OFFSET 0x80U
#define LOGIN_TOKEN_OFFSET 0x88U
#define SESSION_URI_OFFSET 0x40U
#define SESSION_TOKEN_OFFSET 0x88U
#define SESSIONGROUP_URI_OFFSET 0x38U
#define SESSIONGROUP_SESSION_HANDLE_OFFSET 0x68U
#define SESSIONGROUP_TOKEN_OFFSET 0x70U
#define SESSIONGROUP_ACCOUNT_OFFSET 0x78U
#define SESSIONGROUP_CREATE_ACCOUNT_OFFSET 0x30U
#define SESSIONGROUP_CREATE_TYPE_OFFSET 0x38U
#define SESSIONGROUP_CREATE_ALIAS_OFFSET 0x50U
#define SESSIONGROUP_CREATE_HANDLE_OFFSET 0x58U
#define RESPONSE_RETURN_CODE_OFFSET 0x1cU
#define RESPONSE_STATUS_CODE_OFFSET 0x20U
#define RESPONSE_STATUS_STRING_OFFSET 0x28U
#define RESPONSE_REQUEST_OFFSET 0x30U
#define RESPONSE_EXTENDED_STATUS_OFFSET 0x38U
#define RESPONSE_SESSIONGROUP_HANDLE_OFFSET 0x40U

#define VIVOX_MESSAGE_RESPONSE 2
#define VIVOX_MESSAGE_EVENT 3
#define VIVOX_EVENT_SESSIONGROUP_ADDED 22
#define VIVOX_EVENT_SESSION_ADDED 24
#define VIVOX_EVENT_PARTICIPANT_ADDED 26
#define VIVOX_EVENT_PARTICIPANT_REMOVED 27
#define VIVOX_EVENT_PARTICIPANT_UPDATED 28
#define VIVOX_PARTICIPANT_VOLUME 50
#define VIVOX_PARTICIPANT_ENERGY_ACTIVE 1.0

#define HUD_PIPE_RECONNECT_MS 1000U
#define HUD_RECEIVE_BUFFER_BYTES 4096U
#define HUD_EVENT_QUEUE_LIMIT 128U
#define HUD_SPEAKER_LIMIT 64U
#define HUD_HANDLE_BYTES 256U
#define HUD_URI_BYTES 256U

#define GRANT_HEADER_BYTES 16U
#define GRANT_ACCOUNT_MAX 128U
#define GRANT_CHANNEL_MAX 512U
#define GRANT_TOKEN_MAX 2048U
#define GRANT_DISPLAY_NAME_MAX 128U
#define GRANT_WIRE_MAX \
    (GRANT_HEADER_BYTES + GRANT_ACCOUNT_MAX + \
     GRANT_CHANNEL_MAX + GRANT_TOKEN_MAX + \
     GRANT_DISPLAY_NAME_MAX)

#define TRACE_ORIGINAL_PATH_FAILED 0x00000001L
#define TRACE_ORIGINAL_LOAD_FAILED 0x00000002L
#define TRACE_ORIGINAL_EXPORTS_FAILED 0x00000004L
#define TRACE_ORIGINAL_READY 0x00000008L
#define TRACE_GET_MESSAGE 0x00000010L
#define TRACE_HUD_PIPE_CONNECTED 0x00000020L
#define TRACE_HUD_SESSION_CAPTURED 0x00000040L
#define TRACE_ISSUE_LOGIN 0x00000080L
#define TRACE_ISSUE_SESSION 0x00000100L
#define TRACE_ISSUE_SESSIONGROUP 0x00000200L
#define TRACE_CONFIG_INVALID 0x00000400L
#define TRACE_GRANT_FAILED 0x00000800L
#define TRACE_GRANT_READY 0x00001000L
#define TRACE_MUTATION_FAILED 0x00002000L
#define TRACE_MUTATION_READY 0x00004000L
#define TRACE_FALLBACK_ACCEPTED 0x00008000L
#define TRACE_FALLBACK_REJECTED 0x00010000L
#define TRACE_MUTATED_ACCEPTED 0x00020000L
#define TRACE_MUTATED_REJECTED 0x00040000L
#define TRACE_SESSIONGROUP_COMPAT 0x00080000L
#define TRACE_SESSIONGROUP_REQUESTED_HANDLE 0x00100000L
#define TRACE_SESSIONGROUP_GENERATED_HANDLE 0x00200000L
#define TRACE_SESSIONGROUP_EVENT 0x00400000L
#define TRACE_SESSIONGROUP_EVENT_BAD_MESSAGE 0x00800000L
#define TRACE_SESSIONGROUP_EVENT_BAD_REQUEST 0x01000000L
#define TRACE_SESSIONGROUP_EVENT_BAD_HANDLES 0x02000000L
#define TRACE_SESSIONGROUP_EVENT_ALLOC_FAILED 0x04000000L
#define TRACE_SESSIONGROUP_REAL_EVENT_SUPPRESSED 0x08000000L
#define TRACE_SESSION_URI_RESTORED 0x10000000L
#define TRACE_LOGIN_DISPLAY_NAME_APPLIED 0x20000000L
typedef int(__cdecl *vx_issue_request3_fn)(void *request,
                                           int *request_count);
typedef int(__cdecl *vx_get_message_fn)(void **message);
typedef int(__cdecl *destroy_evt_fn)(void *event);
typedef char *(__cdecl *vx_strdup_fn)(const char *value);
typedef int(__cdecl *vx_free_fn)(char *value);
/*
 * Vivox 4.9.0002.26798 layout used by BR1315.
 *
 * This is deliberately not copied from a newer Vivox SDK. BR1315 reads the
 * event type at +0x18, participant handles at +0x28/+0x30, speaking at +0x44,
 * and energy at +0x50. The compile-time assertions keep those reverse-
 * engineered offsets from silently drifting.
 */
#pragma pack(push, 8)
typedef struct rotk_vx_message_base {
    int32_t type;
    uint32_t reserved;
    void *sdk_handle;
    uint64_t create_time_ms;
} rotk_vx_message_base;

typedef struct rotk_vx_evt_base {
    rotk_vx_message_base message;
    int32_t type;
    uint32_t reserved;
    char *extended_status_info;
} rotk_vx_evt_base;

typedef struct rotk_vx_evt_sessiongroup_added {
    rotk_vx_evt_base base;
    char *sessiongroup_handle;
    char *account_handle;
    int32_t type;
    uint32_t reserved_3c;
    char *alias_username;
} rotk_vx_evt_sessiongroup_added;

typedef struct rotk_vx_evt_session_added {
    rotk_vx_evt_base base;
    char *sessiongroup_handle;
    char *session_handle;
    char *uri;
    int32_t is_channel;
    int32_t incoming;
    char *channel_name;
    char *displayname;
    char *application;
    char *alias_username;
} rotk_vx_evt_session_added;

typedef struct rotk_vx_evt_participant_added {
    rotk_vx_evt_base base;
    char *sessiongroup_handle;
    char *session_handle;
    char *participant_uri;
    char *account_name;
    char *display_name;
    int32_t participant_type;
    uint32_t reserved_54;
    char *application;
    int32_t is_anonymous_login;
    uint32_t reserved_64;
    char *displayname;
    char *alias_username;
    char *encoded_uri_with_tag;
    int32_t is_current_user;
    uint32_t reserved_84;
} rotk_vx_evt_participant_added;

typedef struct rotk_vx_evt_participant_updated {
    rotk_vx_evt_base base;
    char *sessiongroup_handle;
    char *session_handle;
    char *participant_uri;
    int32_t is_moderator_muted;
    int32_t is_speaking;
    int32_t volume;
    uint32_t reserved_4c;
    double energy;
    int32_t active_media;
    int32_t is_muted_for_me;
    int32_t is_text_muted_for_me;
    int32_t is_moderator_text_muted;
    int32_t participant_type;
    uint32_t reserved_6c;
    void *diagnostic_states;
    int32_t diagnostic_state_count;
    uint32_t reserved_7c;
    char *alias_username;
    char *encoded_uri_with_tag;
    int32_t is_current_user;
    int32_t has_unavailable_capture_device;
    int32_t has_unavailable_render_device;
    uint32_t reserved_9c;
} rotk_vx_evt_participant_updated;
#pragma pack(pop)

_Static_assert(sizeof(rotk_vx_evt_base) == 0x28U,
               "Vivox 4.9 event base size changed");
_Static_assert(offsetof(rotk_vx_evt_base, type) == 0x18U,
               "Vivox 4.9 event type offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_sessiongroup_added, sessiongroup_handle) == 0x28U,
    "Vivox sessiongroup-added handle offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_sessiongroup_added, alias_username) == 0x40U,
    "Vivox sessiongroup-added alias offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_session_added, session_handle) == 0x30U,
    "Vivox session-added handle offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_session_added, uri) == 0x38U,
    "Vivox session-added URI offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_session_added, alias_username) == 0x60U,
    "Vivox session-added alias offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_participant_added, sessiongroup_handle) == 0x28U,
    "Vivox participant-added sessiongroup offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_participant_added, participant_uri) == 0x38U,
    "Vivox participant-added URI offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_participant_updated, is_speaking) == 0x44U,
    "Vivox participant-updated speaking offset changed");
_Static_assert(
    offsetof(rotk_vx_evt_participant_updated, energy) == 0x50U,
    "Vivox participant-updated energy offset changed");

typedef struct hud_synthetic_event {
    struct hud_synthetic_event *next;
    size_t event_bytes;
    union {
        rotk_vx_evt_base base;
        rotk_vx_evt_sessiongroup_added sessiongroup_added;
        rotk_vx_evt_session_added session_added;
        rotk_vx_evt_participant_added participant_added;
        rotk_vx_evt_participant_updated participant_updated;
    } event;
    char strings[1];
} hud_synthetic_event;

typedef struct hud_speaker {
    BOOL occupied;
    BOOL active;
    BOOL added;
    uint32_t sequence;
    char profile[ROTK_VOICE_HUD_MAX_PROFILE_BYTES + 1U];
    char display_name[ROTK_VOICE_HUD_MAX_NAME_BYTES + 1U];
    char participant_uri[HUD_URI_BYTES];
} hud_speaker;

typedef enum voice_action {
    VOICE_ACTION_NONE = 0,
    VOICE_ACTION_LOGIN = 1,
    VOICE_ACTION_JOIN = 2
} voice_action;

typedef struct voice_config {
    WCHAR session_id[513];
    WCHAR host[256];
    INTERNET_PORT port;
    BOOL secure;
    BOOL valid;
} voice_config;

typedef struct voice_grant {
    uint32_t expires;
    char account[GRANT_ACCOUNT_MAX + 1U];
    char channel[GRANT_CHANNEL_MAX + 1U];
    char token[GRANT_TOKEN_MAX + 1U];
    char display_name[GRANT_DISPLAY_NAME_MAX + 1U];
} voice_grant;

static HMODULE g_proxy_module;
static HMODULE g_original_module;
#if !defined(ROTK_VIVOX_IAT_HOOK)
static WCHAR g_original_path[32768];
#endif
static INIT_ONCE g_original_once = INIT_ONCE_STATIC_INIT;
static INIT_ONCE g_config_once = INIT_ONCE_STATIC_INIT;
static SRWLOCK g_voice_lock = SRWLOCK_INIT;
/* Serialize grant/credential mutations without blocking vx_get_message's
 * account/session bookkeeping for the duration of a network request. Neither
 * lock crosses the original SDK call (which may call back into the proxy). */
static SRWLOCK g_grant_lock = SRWLOCK_INIT;
static vx_issue_request3_fn g_issue_request;
static vx_get_message_fn g_get_message;
static destroy_evt_fn g_destroy_evt;
static vx_strdup_fn g_strdup;
static vx_free_fn g_free;
static voice_config g_config;
static char g_account[GRANT_ACCOUNT_MAX + 1U];
static char g_account_handle[HUD_HANDLE_BYTES];
static char g_compat_sessiongroup_handle[HUD_HANDLE_BYTES];
static volatile LONG g_suppress_sessiongroup_added;
static volatile LONG g_trace_flags;
static volatile LONG g_message_trace_count;
static volatile LONG g_participant_display_restored;
static volatile LONG g_notification_response_compat;
static volatile LONG g_remote_speaking_observed;

static SRWLOCK g_hud_lock = SRWLOCK_INIT;
static HANDLE g_hud_pipe = INVALID_HANDLE_VALUE;
static ULONGLONG g_hud_next_connect_ms;
static uint8_t g_hud_receive_buffer[HUD_RECEIVE_BUFFER_BYTES];
static size_t g_hud_receive_bytes;
static char g_hud_sessiongroup_handle[HUD_HANDLE_BYTES];
static char g_hud_session_handle[HUD_HANDLE_BYTES];
static BOOL g_hud_session_ready;
static hud_speaker g_hud_speakers[HUD_SPEAKER_LIMIT];
static hud_synthetic_event *g_hud_pending_head;
static hud_synthetic_event *g_hud_pending_tail;
static size_t g_hud_pending_count;
static hud_synthetic_event *g_hud_inflight;

#if defined(ROTK_VIVOX_V5_COMPAT)
/*
 * Vivox 5 made the SDK process-global and removed the legacy multi-handle
 * allocation API. BR1315 still imports these two functions, but it only uses
 * the returned value as the request-base sdk_handle. Zero is the process-
 * global handle expected by the current SDK.
 */
unsigned int __cdecl vx_alloc_sdk_handle(void) {
    return 0U;
}

int __cdecl vx_free_sdk_handle(unsigned int sdk_handle) {
    (void)sdk_handle;
    return 0;
}

/*
 * These four account-management request factories were removed from Vivox 5.
 * They are unrelated to login, positional channel join, audio, or participant
 * events. Fail closed if the legacy game ever invokes one instead of handing
 * an invalid pointer to the current SDK.
 */
static int unavailable_account_management_request(void **request) {
    if (request != NULL) {
        *request = NULL;
    }
    return VOICE_ERROR;
}

int __cdecl vx_req_account_channel_add_moderator_create(void **request) {
    return unavailable_account_management_request(request);
}

int __cdecl vx_req_account_channel_get_moderators_create(void **request) {
    return unavailable_account_management_request(request);
}

int __cdecl vx_req_account_channel_remove_moderator_create(void **request) {
    return unavailable_account_management_request(request);
}

int __cdecl vx_req_account_channel_update_create(void **request) {
    return unavailable_account_management_request(request);
}
#endif

/*
 * Best-effort diagnostics for bootstrap failures. Each event is emitted at
 * most once per process, so a retry loop cannot grow the file or materially
 * slow the game. Messages are compile-time stage names only: credentials,
 * account names, channel URIs, and tokens are never logged. Numeric SDK
 * return codes may be included when they are needed to identify a failed
 * compatibility call.
 */
static void proxy_trace_line(const char *event) {
    static const WCHAR trace_file_name[] = TRACE_FILE_NAME;
    WCHAR path[32768];
    WCHAR *separator;
    SYSTEMTIME now;
    char line[384];
    HANDLE file;
    DWORD path_chars;
    DWORD bytes_written;
    int line_bytes;

    GetSystemTime(&now);
    line_bytes = snprintf(
        line,
        sizeof(line),
        "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ "
        "pid=%lu tid=%lu %s\r\n",
        (unsigned int)now.wYear,
        (unsigned int)now.wMonth,
        (unsigned int)now.wDay,
        (unsigned int)now.wHour,
        (unsigned int)now.wMinute,
        (unsigned int)now.wSecond,
        (unsigned int)now.wMilliseconds,
        (unsigned long)GetCurrentProcessId(),
        (unsigned long)GetCurrentThreadId(),
        event);
    if (line_bytes <= 0 ||
        (size_t)line_bytes >= sizeof(line)) {
        return;
    }
    OutputDebugStringA(line);

    path_chars = GetModuleFileNameW(
        g_proxy_module,
        path,
        (DWORD)(sizeof(path) / sizeof(path[0])));
    if (path_chars == 0U ||
        path_chars >=
            (DWORD)(sizeof(path) / sizeof(path[0]))) {
        return;
    }
    separator = wcsrchr(path, L'\\');
    if (separator == NULL ||
        (size_t)(separator - path) + 1U +
                sizeof(trace_file_name) / sizeof(trace_file_name[0]) >
            sizeof(path) / sizeof(path[0])) {
        return;
    }
    memcpy(separator + 1,
           trace_file_name,
           sizeof(trace_file_name));
    file = CreateFileW(path,
                       FILE_APPEND_DATA,
                       FILE_SHARE_READ |
                           FILE_SHARE_WRITE |
                           FILE_SHARE_DELETE,
                       NULL,
                       OPEN_ALWAYS,
                       FILE_ATTRIBUTE_NORMAL,
                       NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return;
    }
    (void)WriteFile(file,
                    line,
                    (DWORD)line_bytes,
                    &bytes_written,
                    NULL);
    CloseHandle(file);
}

static void proxy_trace_once(LONG flag, const char *event) {
    if ((InterlockedOr(&g_trace_flags, flag) & flag) != 0L) {
        return;
    }
    proxy_trace_line(event);
}

#include "crouch_parity_patch.h"
/* Retain the draft's safe log rotation; transition code stays Alpha/Bravo v12. */
static void crouch_delete_stale_log(void) {
    static WCHAR path[32768];
    if (crouch_sibling_path(CROUCH_LOG_NAME, path, sizeof(path) / sizeof(path[0]))) {
        (void)DeleteFileW(path);
    }
}
#include "voice_rank_patch.h"

static uint16_t load_le16(const uint8_t *value) {
    return (uint16_t)((uint16_t)value[0] |
                      ((uint16_t)value[1] << 8U));
}

static uint32_t load_le32(const uint8_t *value) {
    return (uint32_t)value[0] |
           ((uint32_t)value[1] << 8U) |
           ((uint32_t)value[2] << 16U) |
           ((uint32_t)value[3] << 24U);
}

static uint32_t unix_time_seconds(void) {
    FILETIME file_time;
    ULARGE_INTEGER ticks;
    const uint64_t epoch = UINT64_C(116444736000000000);

    GetSystemTimeAsFileTime(&file_time);
    ticks.LowPart = file_time.dwLowDateTime;
    ticks.HighPart = file_time.dwHighDateTime;
    if (ticks.QuadPart <= epoch) {
        return 0U;
    }
    return (uint32_t)((ticks.QuadPart - epoch) /
                      UINT64_C(10000000));
}

#if !defined(ROTK_VIVOX_IAT_HOOK)
static BOOL build_original_path(void) {
    DWORD length;
    WCHAR *separator;
    size_t directory_bytes;
    size_t name_bytes = sizeof(ORIGINAL_DLL_NAME);

    length = GetModuleFileNameW(
        g_proxy_module,
        g_original_path,
        (DWORD)(sizeof(g_original_path) /
                sizeof(g_original_path[0])));
    if (length == 0U ||
        length >= (DWORD)(sizeof(g_original_path) /
                          sizeof(g_original_path[0]))) {
        return FALSE;
    }
    separator = wcsrchr(g_original_path, L'\\');
    if (separator == NULL) {
        return FALSE;
    }
    directory_bytes =
        ((size_t)(separator - g_original_path) + 1U) *
        sizeof(WCHAR);
    if (directory_bytes + name_bytes > sizeof(g_original_path)) {
        return FALSE;
    }
    memcpy((uint8_t *)g_original_path + directory_bytes,
           ORIGINAL_DLL_NAME,
           name_bytes);
    return TRUE;
}
#endif

static BOOL CALLBACK initialize_original(PINIT_ONCE once,
                                         PVOID parameter,
                                         PVOID *context) {
    HMODULE module;
    FARPROC issue;
    FARPROC get_message;
    FARPROC destroy_event;
    FARPROC duplicate;
    FARPROC release;

    (void)once;
    (void)parameter;
    (void)context;
#if defined(ROTK_VIVOX_IAT_HOOK)
    module = GetModuleHandleW(ORIGINAL_DLL_NAME);
    if (module == NULL) {
        proxy_trace_once(
            TRACE_ORIGINAL_LOAD_FAILED,
            "[rotk-vivoxproxy] original init: module not loaded");
        return TRUE;
    }
#else
    if (!build_original_path()) {
        proxy_trace_once(
            TRACE_ORIGINAL_PATH_FAILED,
            "[rotk-vivoxproxy] original init: path failed");
        return TRUE;
    }
    module = LoadLibraryExW(
        g_original_path,
        NULL,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
            LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (module == NULL) {
        proxy_trace_once(
            TRACE_ORIGINAL_LOAD_FAILED,
            "[rotk-vivoxproxy] original init: load failed");
        return TRUE;
    }
#endif
    issue = GetProcAddress(module, "vx_issue_request3");
    get_message = GetProcAddress(module, "vx_get_message");
    destroy_event = GetProcAddress(module, "destroy_evt");
    duplicate = GetProcAddress(module, "vx_strdup");
    release = GetProcAddress(module, "vx_free");
    if (issue == NULL ||
        get_message == NULL ||
        destroy_event == NULL ||
        duplicate == NULL ||
        release == NULL) {
#if !defined(ROTK_VIVOX_IAT_HOOK)
        FreeLibrary(module);
#endif
        proxy_trace_once(
            TRACE_ORIGINAL_EXPORTS_FAILED,
            "[rotk-vivoxproxy] original init: exports failed");
        return TRUE;
    }
    g_original_module = module;
    g_issue_request =
        (vx_issue_request3_fn)(uintptr_t)issue;
    g_get_message =
        (vx_get_message_fn)(uintptr_t)get_message;
    g_destroy_evt =
        (destroy_evt_fn)(uintptr_t)destroy_event;
    g_strdup = (vx_strdup_fn)(uintptr_t)duplicate;
    g_free = (vx_free_fn)(uintptr_t)release;
    proxy_trace_once(
        TRACE_ORIGINAL_READY,
        "[rotk-vivoxproxy] original init: ready");
    /*
     * Never create the crouch worker from DllMain.  In the combined Vivox 5
     * proxy, starting it while the Windows loader lock is held terminates
     * BR1315 in PreInitialize (0xc00000fd).  The first proxied Vivox call is
     * made after loader initialization and before character animation assets
     * are used, which is the safe and deterministic start point.
     */
    crouch_parity_start();
    return TRUE;
}

static BOOL bearer_is_safe(const WCHAR *value) {
    size_t index;
    size_t length = wcslen(value);

    if (length == 0U || length > 512U) {
        return FALSE;
    }
    for (index = 0U; index < length; ++index) {
        WCHAR c = value[index];
        if (!((c >= L'a' && c <= L'z') ||
              (c >= L'A' && c <= L'Z') ||
              (c >= L'0' && c <= L'9') ||
              c == L'-' || c == L'_' || c == L'.' ||
              c == L'~' || c == L'+' || c == L'/' ||
              c == L'=')) {
            return FALSE;
        }
    }
    return TRUE;
}

static BOOL host_is_loopback(const WCHAR *host) {
    return _wcsicmp(host, L"127.0.0.1") == 0 ||
           _wcsicmp(host, L"localhost") == 0 ||
           _wcsicmp(host, L"::1") == 0 ||
           _wcsicmp(host, L"0:0:0:0:0:0:0:1") == 0;
}

static BOOL parse_gateway_url(const WCHAR *url,
                              voice_config *config) {
    URL_COMPONENTS parts;

    SecureZeroMemory(&parts, sizeof(parts));
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = (DWORD)-1;
    parts.dwUrlPathLength = (DWORD)-1;
    parts.dwExtraInfoLength = (DWORD)-1;
    parts.dwUserNameLength = (DWORD)-1;
    parts.dwPasswordLength = (DWORD)-1;
    if (!WinHttpCrackUrl(url, 0U, 0U, &parts) ||
        parts.dwHostNameLength == 0U ||
        parts.dwHostNameLength >=
            (DWORD)(sizeof(config->host) /
                    sizeof(config->host[0])) ||
        parts.dwUserNameLength != 0U ||
        parts.dwPasswordLength != 0U) {
        return FALSE;
    }
    memcpy(config->host,
           parts.lpszHostName,
           parts.dwHostNameLength * sizeof(WCHAR));
    config->host[parts.dwHostNameLength] = L'\0';
    config->port = parts.nPort;
    if (parts.nScheme == INTERNET_SCHEME_HTTPS) {
        config->secure = TRUE;
        return TRUE;
    }
    if (parts.nScheme == INTERNET_SCHEME_HTTP &&
        host_is_loopback(config->host)) {
        config->secure = FALSE;
        return TRUE;
    }
    return FALSE;
}

static BOOL CALLBACK initialize_config(PINIT_ONCE once,
                                       PVOID parameter,
                                       PVOID *context) {
    LPWSTR *argv;
    int argc = 0;
    int index;
    BOOL have_session = FALSE;
    BOOL have_gateway = FALSE;
    BOOL have_explicit_voice_gateway = FALSE;
    static const WCHAR session_prefix[] = L"sessionid=";
    static const WCHAR gateway_prefix[] = L"SteamGatewayUrl=";
    static const WCHAR voice_gateway_prefix[] = L"VivoxGrantUrl=";

    (void)once;
    (void)parameter;
    (void)context;
    SecureZeroMemory(&g_config, sizeof(g_config));
    argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv == NULL) {
        return TRUE;
    }
    for (index = 1; index < argc; ++index) {
        const WCHAR *argument = argv[index];
        if (_wcsnicmp(argument,
                      session_prefix,
                      (sizeof(session_prefix) / sizeof(WCHAR)) - 1U) == 0) {
            const WCHAR *value =
                argument +
                (sizeof(session_prefix) / sizeof(WCHAR)) - 1U;
            size_t length = wcslen(value);
            if (have_session ||
                length >= sizeof(g_config.session_id) /
                              sizeof(g_config.session_id[0])) {
                goto cleanup;
            }
            memcpy(g_config.session_id,
                   value,
                   (length + 1U) * sizeof(WCHAR));
            have_session = bearer_is_safe(g_config.session_id);
            if (!have_session) {
                goto cleanup;
            }
        } else if (_wcsnicmp(
                       argument,
                       voice_gateway_prefix,
                       (sizeof(voice_gateway_prefix) / sizeof(WCHAR)) - 1U) == 0) {
            const WCHAR *value =
                argument +
                (sizeof(voice_gateway_prefix) / sizeof(WCHAR)) - 1U;
            if (have_explicit_voice_gateway ||
                !parse_gateway_url(value, &g_config)) {
                goto cleanup;
            }
            have_gateway = TRUE;
            have_explicit_voice_gateway = TRUE;
        } else if (_wcsnicmp(
                       argument,
                       gateway_prefix,
                       (sizeof(gateway_prefix) / sizeof(WCHAR)) - 1U) == 0) {
            const WCHAR *value =
                argument +
                (sizeof(gateway_prefix) / sizeof(WCHAR)) - 1U;
            if (have_explicit_voice_gateway) {
                continue;
            }
            if (have_gateway ||
                !parse_gateway_url(value, &g_config)) {
                goto cleanup;
            }
            have_gateway = TRUE;
        }
    }
    g_config.valid = have_session && have_gateway;

cleanup:
    if (!g_config.valid) {
        SecureZeroMemory(&g_config, sizeof(g_config));
    }
    LocalFree(argv);
    return TRUE;
}

static DWORD remaining_timeout(ULONGLONG deadline) {
    ULONGLONG now = GetTickCount64();
    ULONGLONG remaining;

    if (now >= deadline) {
        return 0U;
    }
    remaining = deadline - now;
    return remaining > VOICE_TIMEOUT_MS
        ? VOICE_TIMEOUT_MS
        : (DWORD)remaining;
}

static BOOL set_remaining_timeouts(HINTERNET handle,
                                   ULONGLONG deadline) {
    DWORD timeout = remaining_timeout(deadline);
    return timeout != 0U &&
           WinHttpSetTimeouts(handle,
                              (int)timeout,
                              (int)timeout,
                              (int)timeout,
                              (int)timeout);
}

static BOOL bytes_are_visible_ascii(const uint8_t *value,
                                    size_t bytes) {
    size_t index;
    for (index = 0U; index < bytes; ++index) {
        if (value[index] < 0x21U || value[index] > 0x7EU) {
            return FALSE;
        }
    }
    return TRUE;
}

static BOOL parse_grant(const uint8_t *wire,
                        size_t wire_bytes,
                        voice_action action,
                        voice_grant *grant) {
    uint16_t account_bytes;
    uint16_t channel_bytes;
    uint16_t token_bytes;
    uint16_t display_name_bytes;
    BOOL version_two;
    size_t offset;
    uint32_t now;

    if (wire_bytes < GRANT_HEADER_BYTES) {
        return FALSE;
    }
    version_two = memcmp(wire, "RVG2", 4U) == 0;
    if (!version_two && memcmp(wire, "RVG1", 4U) != 0) {
        return FALSE;
    }
    grant->expires = load_le32(wire + 4U);
    account_bytes = load_le16(wire + 8U);
    channel_bytes = load_le16(wire + 10U);
    token_bytes = load_le16(wire + 12U);
    display_name_bytes = load_le16(wire + 14U);
    if (account_bytes < 3U ||
        account_bytes > GRANT_ACCOUNT_MAX ||
        channel_bytes > GRANT_CHANNEL_MAX ||
        token_bytes == 0U ||
        token_bytes > GRANT_TOKEN_MAX ||
        display_name_bytes > GRANT_DISPLAY_NAME_MAX ||
        (!version_two && display_name_bytes != 0U) ||
        (version_two && display_name_bytes == 0U) ||
        GRANT_HEADER_BYTES + (size_t)account_bytes +
                (size_t)channel_bytes + (size_t)token_bytes +
                (size_t)display_name_bytes !=
            wire_bytes ||
        (action == VOICE_ACTION_LOGIN && channel_bytes != 0U) ||
        (action == VOICE_ACTION_JOIN && channel_bytes < 4U)) {
        return FALSE;
    }
    now = unix_time_seconds();
    if (now == 0U || grant->expires <= now) {
        return FALSE;
    }

    offset = GRANT_HEADER_BYTES;
    if (!bytes_are_visible_ascii(wire + offset, account_bytes) ||
        wire[offset] != (uint8_t)'.' ||
        wire[offset + account_bytes - 1U] != (uint8_t)'.') {
        return FALSE;
    }
    memcpy(grant->account, wire + offset, account_bytes);
    grant->account[account_bytes] = '\0';
    offset += account_bytes;
    if (channel_bytes > 0U) {
        if (!bytes_are_visible_ascii(wire + offset, channel_bytes) ||
            memcmp(wire + offset, "sip:", 4U) != 0) {
            return FALSE;
        }
        memcpy(grant->channel, wire + offset, channel_bytes);
        grant->channel[channel_bytes] = '\0';
        offset += channel_bytes;
    }
    if (!bytes_are_visible_ascii(wire + offset, token_bytes)) {
        return FALSE;
    }
    memcpy(grant->token, wire + offset, token_bytes);
    grant->token[token_bytes] = '\0';
    offset += token_bytes;
    if (display_name_bytes > 0U) {
        if (!bytes_are_visible_ascii(
                wire + offset,
                display_name_bytes)) {
            return FALSE;
        }
        memcpy(grant->display_name,
               wire + offset,
               display_name_bytes);
        grant->display_name[display_name_bytes] = '\0';
    }
    return TRUE;
}

static BOOL fetch_grant(voice_action action, const WCHAR *channel, voice_grant *grant) {
    static const WCHAR user_agent[] = L"ROTK-VivoxProxy/1";
    static const WCHAR login_path[] = L"/voice/v1/login";
    static const WCHAR join_path[] = L"/voice/v1/join";
    static const WCHAR content_type_expected[] =
        L"application/octet-stream";
    HINTERNET session = NULL;
    HINTERNET connection = NULL;
    HINTERNET request = NULL;
    WCHAR authorization[800];
    WCHAR content_type[64];
    uint8_t wire[GRANT_WIRE_MAX + 1U];
    DWORD status = 0U;
    DWORD status_bytes = sizeof(status);
    DWORD content_type_bytes = sizeof(content_type);
    DWORD disabled_features = WINHTTP_DISABLE_REDIRECTS;
    DWORD read_bytes;
    size_t wire_bytes = 0U;
    ULONGLONG deadline = GetTickCount64() + VOICE_TIMEOUT_MS;
    BOOL result = FALSE;
    int written;

    SecureZeroMemory(grant, sizeof(*grant));
    SecureZeroMemory(authorization, sizeof(authorization));
    SecureZeroMemory(content_type, sizeof(content_type));
    SecureZeroMemory(wire, sizeof(wire));
    if (!g_config.valid) {
        goto cleanup;
    }
    written = swprintf(
        authorization,
        sizeof(authorization) / sizeof(authorization[0]),
        L"Authorization: Bearer %ls\r\n"
        L"Accept: application/octet-stream\r\n"
        L"X-ROTK-Vivox-Grant-Version: 2\r\n"
        L"%ls%ls%ls",
        g_config.session_id,
        action == VOICE_ACTION_JOIN ? L"X-ROTK-Vivox-Channel: " : L"",
        action == VOICE_ACTION_JOIN ? channel : L"",
        action == VOICE_ACTION_JOIN ? L"\r\n" : L"");
    if (written <= 0 ||
        written >=
            (int)(sizeof(authorization) /
                  sizeof(authorization[0]))) {
        goto cleanup;
    }

    session = WinHttpOpen(user_agent,
                          WINHTTP_ACCESS_TYPE_NO_PROXY,
                          WINHTTP_NO_PROXY_NAME,
                          WINHTTP_NO_PROXY_BYPASS,
                          0U);
    if (session == NULL ||
        !set_remaining_timeouts(session, deadline)) {
        goto cleanup;
    }
    connection = WinHttpConnect(
        session, g_config.host, g_config.port, 0U);
    if (connection == NULL) {
        goto cleanup;
    }
    request = WinHttpOpenRequest(
        connection,
        L"POST",
        action == VOICE_ACTION_LOGIN ? login_path : join_path,
        NULL,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        g_config.secure ? WINHTTP_FLAG_SECURE : 0U);
    if (request == NULL ||
        !WinHttpSetOption(request,
                          WINHTTP_OPTION_DISABLE_FEATURE,
                          &disabled_features,
                          sizeof(disabled_features)) ||
        !set_remaining_timeouts(request, deadline) ||
        !WinHttpSendRequest(request,
                            authorization,
                            (DWORD)-1L,
                            WINHTTP_NO_REQUEST_DATA,
                            0U,
                            0U,
                            0U) ||
        remaining_timeout(deadline) == 0U ||
        !set_remaining_timeouts(request, deadline) ||
        !WinHttpReceiveResponse(request, NULL) ||
        remaining_timeout(deadline) == 0U ||
        !WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE |
                WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX,
            &status,
            &status_bytes,
            WINHTTP_NO_HEADER_INDEX) ||
        status != 200U ||
        !WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_CONTENT_TYPE,
            WINHTTP_HEADER_NAME_BY_INDEX,
            content_type,
            &content_type_bytes,
            WINHTTP_NO_HEADER_INDEX) ||
        _wcsicmp(content_type, content_type_expected) != 0) {
        goto cleanup;
    }

    for (;;) {
        if (wire_bytes == sizeof(wire) ||
            !set_remaining_timeouts(request, deadline) ||
            !WinHttpReadData(
                request,
                wire + wire_bytes,
                (DWORD)(sizeof(wire) - wire_bytes),
                &read_bytes)) {
            goto cleanup;
        }
        if (read_bytes == 0U) {
            break;
        }
        wire_bytes += read_bytes;
        if (wire_bytes > GRANT_WIRE_MAX ||
            remaining_timeout(deadline) == 0U) {
            goto cleanup;
        }
    }
    if (remaining_timeout(deadline) != 0U) {
        result = parse_grant(wire, wire_bytes, action, grant);
    }

cleanup:
    if (request != NULL) {
        WinHttpCloseHandle(request);
    }
    if (connection != NULL) {
        WinHttpCloseHandle(connection);
    }
    if (session != NULL) {
        WinHttpCloseHandle(session);
    }
    SecureZeroMemory(authorization, sizeof(authorization));
    SecureZeroMemory(content_type, sizeof(content_type));
    SecureZeroMemory(wire, sizeof(wire));
    if (!result) {
        SecureZeroMemory(grant, sizeof(*grant));
    }
    return result;
}

static BOOL protection_is_writable(DWORD protection) {
    DWORD base = protection & 0xFFU;
    return base == PAGE_READWRITE ||
           base == PAGE_WRITECOPY ||
           base == PAGE_EXECUTE_READWRITE ||
           base == PAGE_EXECUTE_WRITECOPY;
}

static BOOL protection_is_readable(DWORD protection) {
    DWORD base = protection & 0xFFU;
    return base == PAGE_READONLY ||
           base == PAGE_READWRITE ||
           base == PAGE_WRITECOPY ||
           base == PAGE_EXECUTE_READ ||
           base == PAGE_EXECUTE_READWRITE ||
           base == PAGE_EXECUTE_WRITECOPY;
}

static BOOL request_is_accessible(void *request,
                                  size_t bytes,
                                  BOOL require_writable) {
    MEMORY_BASIC_INFORMATION memory;
    uintptr_t start;
    uintptr_t end;
    uintptr_t region_end;

    if (request == NULL ||
        VirtualQuery(request, &memory, sizeof(memory)) != sizeof(memory) ||
        memory.State != MEM_COMMIT ||
        (memory.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0U ||
        (require_writable
             ? !protection_is_writable(memory.Protect)
             : !protection_is_readable(memory.Protect))) {
        return FALSE;
    }
    start = (uintptr_t)request;
    if (bytes > UINTPTR_MAX - start) {
        return FALSE;
    }
    end = start + bytes;
    region_end = (uintptr_t)memory.BaseAddress +
                 memory.RegionSize;
    return end <= region_end;
}

/*
 * Temporary, credential-safe ABI diagnostics. Numeric response fields are
 * sufficient to identify why BR1315 does not advance from login to session
 * creation; strings, handles, account names, URIs, and tokens stay unlogged.
 */
static void trace_vivox_message(void *message) {
    uint32_t message_type;
    uint32_t subtype;
    uint32_t return_code = 0U;
    uint32_t status_code = 0U;
    uint32_t request_type = 0U;
    void *request = NULL;
    LONG trace_index;
    char line[256];

    trace_index = InterlockedIncrement(&g_message_trace_count);
    if (trace_index > 128L ||
        !request_is_accessible(message, 0x40U, FALSE)) {
        return;
    }
    memcpy(&message_type, (uint8_t *)message, sizeof(message_type));
    memcpy(&subtype,
           (uint8_t *)message + 0x18U,
           sizeof(subtype));
    if (message_type == VIVOX_MESSAGE_RESPONSE) {
        memcpy(&return_code,
               (uint8_t *)message + 0x1cU,
               sizeof(return_code));
        memcpy(&status_code,
               (uint8_t *)message + 0x20U,
               sizeof(status_code));
        memcpy(&request,
               (uint8_t *)message + 0x30U,
               sizeof(request));
        if (request_is_accessible(
                request,
                REQUEST_TYPE_OFFSET + sizeof(request_type),
                FALSE)) {
            memcpy(&request_type,
                   (uint8_t *)request + REQUEST_TYPE_OFFSET,
                   sizeof(request_type));
        }
    }
    (void)snprintf(
        line,
        sizeof(line),
        "[rotk-vivoxproxy] message[%ld]: kind=%lu subtype=0x%lx "
        "request=0x%lx return=%lu status=%lu",
        (long)trace_index,
        (unsigned long)message_type,
        (unsigned long)subtype,
        (unsigned long)request_type,
        (unsigned long)return_code,
        (unsigned long)status_code);
    proxy_trace_line(line);
}

static BOOL bounded_string(const char *value,
                           size_t maximum,
                           size_t *length_out) {
    size_t length = 0U;

    if (value == NULL) {
        return FALSE;
    }
    while (length <= maximum) {
        MEMORY_BASIC_INFORMATION memory;
        uintptr_t base = (uintptr_t)value;
        uintptr_t current;
        uintptr_t region_end;
        size_t available;
        size_t index;

        if (length > UINTPTR_MAX - base) {
            return FALSE;
        }
        current = base + length;
        if (VirtualQuery((const void *)current,
                         &memory,
                         sizeof(memory)) != sizeof(memory) ||
            memory.State != MEM_COMMIT ||
            (memory.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0U ||
            !protection_is_readable(memory.Protect)) {
            return FALSE;
        }
        region_end = (uintptr_t)memory.BaseAddress +
                     memory.RegionSize;
        available = (size_t)(region_end - current);
        if (available > maximum + 1U - length) {
            available = maximum + 1U - length;
        }
        for (index = 0U; index < available; ++index) {
            unsigned char c = (unsigned char)value[length + index];
            if (c == 0U) {
                *length_out = length + index;
                return TRUE;
            }
            if (c < 0x21U || c > 0x7EU) {
                return FALSE;
            }
        }
        length += available;
    }
    return FALSE;
}

static void read_pointer(void *request,
                         size_t offset,
                         char **value) {
    memcpy(value, (uint8_t *)request + offset, sizeof(*value));
}

static void write_pointer(void *request,
                          size_t offset,
                          char *value) {
    memcpy((uint8_t *)request + offset, &value, sizeof(value));
}

/*
 * Vivox 5's XMPP backend rejects the legacy explicit session-group creation
 * used by BR1315 with VX_E_SIP_BACKEND_REQUIRED (1105). A following
 * sessiongroup_add_session request can create the group implicitly, so expose
 * the legacy success shape to the game and let that supported request proceed.
 */
static BOOL compat_sessiongroup_create_response(void *message) {
#if defined(ROTK_VIVOX_V5_COMPAT)
    uint32_t message_type;
    uint32_t response_type;
    uint32_t return_code;
    uint32_t status_code;
    uint32_t request_type;
    void *request = NULL;
    char *requested_handle = NULL;
    char *response_handle = NULL;
    char *status_string = NULL;
    char *extended_status = NULL;
    char generated_handle[96];
    const char *handle_source;
    size_t handle_length = 0U;
    uint32_t success = 0U;

    if (!request_is_accessible(message, 0x48U, TRUE)) {
        return FALSE;
    }
    memcpy(&message_type, (uint8_t *)message, sizeof(message_type));
    memcpy(&response_type,
           (uint8_t *)message + REQUEST_TYPE_OFFSET,
           sizeof(response_type));
    memcpy(&return_code,
           (uint8_t *)message + RESPONSE_RETURN_CODE_OFFSET,
           sizeof(return_code));
    memcpy(&status_code,
           (uint8_t *)message + RESPONSE_STATUS_CODE_OFFSET,
           sizeof(status_code));
    if (message_type != VIVOX_MESSAGE_RESPONSE ||
        response_type != REQUEST_SESSIONGROUP_CREATE ||
        return_code == 0U ||
        status_code != 1105U) {
        return FALSE;
    }
    memcpy(&request,
           (uint8_t *)message + RESPONSE_REQUEST_OFFSET,
           sizeof(request));
    if (request_is_accessible(
            request,
            SESSIONGROUP_CREATE_HANDLE_OFFSET + sizeof(requested_handle),
            FALSE)) {
        memcpy(&request_type,
               (uint8_t *)request + REQUEST_TYPE_OFFSET,
               sizeof(request_type));
        if (request_type == REQUEST_SESSIONGROUP_CREATE) {
            read_pointer(
                request,
                SESSIONGROUP_CREATE_HANDLE_OFFSET,
                &requested_handle);
        }
    }
    if (bounded_string(requested_handle, HUD_HANDLE_BYTES - 1U, &handle_length) &&
        handle_length > 0U) {
        handle_source = requested_handle;
        proxy_trace_once(
            TRACE_SESSIONGROUP_REQUESTED_HANDLE,
            "[rotk-vivoxproxy] compat: requested sessiongroup handle retained");
    } else {
        (void)snprintf(
            generated_handle,
            sizeof(generated_handle),
            "rotk-sessiongroup-%lu",
            (unsigned long)GetCurrentProcessId());
        handle_source = generated_handle;
        proxy_trace_once(
            TRACE_SESSIONGROUP_GENERATED_HANDLE,
            "[rotk-vivoxproxy] compat: generated fallback sessiongroup handle");
    }
    response_handle = g_strdup(handle_source);
    if (response_handle == NULL) {
        return FALSE;
    }
    write_pointer(
        message,
        RESPONSE_SESSIONGROUP_HANDLE_OFFSET,
        response_handle);
    memcpy((uint8_t *)message + RESPONSE_RETURN_CODE_OFFSET,
           &success,
           sizeof(success));
    memcpy((uint8_t *)message + RESPONSE_STATUS_CODE_OFFSET,
           &success,
           sizeof(success));
    read_pointer(message, RESPONSE_STATUS_STRING_OFFSET, &status_string);
    if (request_is_accessible(status_string, 1U, TRUE)) {
        status_string[0] = '\0';
    }
    read_pointer(message, RESPONSE_EXTENDED_STATUS_OFFSET, &extended_status);
    if (request_is_accessible(extended_status, 1U, TRUE)) {
        extended_status[0] = '\0';
    }
    proxy_trace_once(
        TRACE_SESSIONGROUP_COMPAT,
        "[rotk-vivoxproxy] compat: legacy sessiongroup create accepted");
    return TRUE;
#else
    (void)message;
    return FALSE;
#endif
}

/*
 * Vivox 5's XMPP backend does not implement BR1315's legacy hand-raised
 * notification. Audio transmission and speaking events are independent from
 * that notification, so acknowledge only this specific unsupported response
 * to keep the old client from treating a normal PTT press as an operation
 * failure.
 */
static BOOL compat_session_notification_response(void *message) {
#if defined(ROTK_VIVOX_V5_COMPAT)
    uint32_t message_type;
    uint32_t response_type;
    uint32_t return_code;
    uint32_t status_code;
    uint32_t request_type;
    uint32_t success = 0U;
    void *request = NULL;
    char *status_string = NULL;
    char *extended_status = NULL;

    if (!request_is_accessible(message, 0x40U, TRUE)) {
        return FALSE;
    }
    memcpy(&message_type, message, sizeof(message_type));
    memcpy(&response_type,
           (uint8_t *)message + REQUEST_TYPE_OFFSET,
           sizeof(response_type));
    memcpy(&return_code,
           (uint8_t *)message + RESPONSE_RETURN_CODE_OFFSET,
           sizeof(return_code));
    memcpy(&status_code,
           (uint8_t *)message + RESPONSE_STATUS_CODE_OFFSET,
           sizeof(status_code));
    memcpy(&request,
           (uint8_t *)message + RESPONSE_REQUEST_OFFSET,
           sizeof(request));
    if (message_type != VIVOX_MESSAGE_RESPONSE ||
        response_type != REQUEST_SESSION_SEND_NOTIFICATION ||
        return_code == 0U ||
        status_code != 5018U ||
        !request_is_accessible(
            request,
            REQUEST_TYPE_OFFSET + sizeof(request_type),
            FALSE)) {
        return FALSE;
    }
    memcpy(&request_type,
           (uint8_t *)request + REQUEST_TYPE_OFFSET,
           sizeof(request_type));
    if (request_type != REQUEST_SESSION_SEND_NOTIFICATION) {
        return FALSE;
    }
    memcpy((uint8_t *)message + RESPONSE_RETURN_CODE_OFFSET,
           &success,
           sizeof(success));
    memcpy((uint8_t *)message + RESPONSE_STATUS_CODE_OFFSET,
           &success,
           sizeof(success));
    read_pointer(message, RESPONSE_STATUS_STRING_OFFSET, &status_string);
    if (request_is_accessible(status_string, 1U, TRUE)) {
        status_string[0] = '\0';
    }
    read_pointer(message, RESPONSE_EXTENDED_STATUS_OFFSET, &extended_status);
    if (request_is_accessible(extended_status, 1U, TRUE)) {
        extended_status[0] = '\0';
    }
    if (InterlockedCompareExchange(
            &g_notification_response_compat,
            1L,
            0L) == 0L) {
        proxy_trace_line(
            "[rotk-vivoxproxy] compat: legacy PTT notification acknowledged");
    }
    return TRUE;
#else
    (void)message;
    return FALSE;
#endif
}

static BOOL mutate_login(void *request,
                         const voice_grant *grant) {
    char *old_display_name;
    char *old_account;
    char *old_token;
    char *new_display_name = NULL;
    char *new_account;
    char *new_token;

    if (!request_is_accessible(request, LOGIN_REQUEST_BYTES, TRUE)) {
        return FALSE;
    }
    new_account = g_strdup(grant->account);
    if (new_account == NULL) {
        return FALSE;
    }
    new_token = g_strdup(grant->token);
    if (new_token == NULL) {
        (void)g_free(new_account);
        return FALSE;
    }
    if (grant->display_name[0] != '\0') {
        new_display_name = g_strdup(grant->display_name);
        if (new_display_name == NULL) {
            (void)g_free(new_account);
            (void)g_free(new_token);
            return FALSE;
        }
    }
    read_pointer(
        request,
        LOGIN_DISPLAY_NAME_OFFSET,
        &old_display_name);
    read_pointer(request, LOGIN_ACCOUNT_OFFSET, &old_account);
    read_pointer(request, LOGIN_TOKEN_OFFSET, &old_token);
    if (new_display_name != NULL) {
        write_pointer(
            request,
            LOGIN_DISPLAY_NAME_OFFSET,
            new_display_name);
    }
    write_pointer(request, LOGIN_ACCOUNT_OFFSET, new_account);
    write_pointer(request, LOGIN_TOKEN_OFFSET, new_token);
    if (old_display_name != NULL &&
        new_display_name != NULL) {
        (void)g_free(old_display_name);
    }
    if (old_account != NULL &&
        (new_display_name == NULL ||
         old_account != old_display_name)) {
        (void)g_free(old_account);
    }
    if (old_token != NULL &&
        old_token != old_account &&
        (new_display_name == NULL ||
         old_token != old_display_name)) {
        (void)g_free(old_token);
    }
    memcpy(g_account,
           grant->account,
           strlen(grant->account) + 1U);
    if (new_display_name != NULL) {
        proxy_trace_once(
            TRACE_LOGIN_DISPLAY_NAME_APPLIED,
            "[rotk-vivoxproxy] compat: native participant display name applied");
    }
    return TRUE;
}

static BOOL mutate_join(void *request,
                        size_t request_bytes,
                        size_t uri_offset,
                        size_t token_offset,
                        const voice_grant *grant) {
    char *uri;
    char *old_token;
    char *new_token;
    size_t uri_bytes;
    size_t expected_bytes = strlen(grant->channel);

    if (!request_is_accessible(request, request_bytes, TRUE) ||
        g_account[0] == '\0' ||
        strcmp(g_account, grant->account) != 0) {
        return FALSE;
    }
    read_pointer(request, uri_offset, &uri);
    if (!bounded_string(uri, GRANT_CHANNEL_MAX, &uri_bytes) ||
        uri_bytes != expected_bytes ||
        memcmp(uri, grant->channel, expected_bytes) != 0) {
        return FALSE;
    }
    new_token = g_strdup(grant->token);
    if (new_token == NULL) {
        return FALSE;
    }
    read_pointer(request, token_offset, &old_token);
    write_pointer(request, token_offset, new_token);
    if (old_token != NULL) {
        (void)g_free(old_token);
    }
    return TRUE;
}

static BOOL mutate_sessiongroup_context(
    void *request,
    const voice_grant *grant) {
    char *old_account_handle;
    char *old_session_handle;
    char *new_account_handle;
    char *new_session_handle;

    if (!request_is_accessible(
            request,
            SESSIONGROUP_REQUEST_BYTES,
            TRUE) ||
        g_account_handle[0] == '\0' ||
        grant == NULL ||
        grant->channel[0] == '\0') {
        return FALSE;
    }
    new_account_handle = g_strdup(g_account_handle);
    if (new_account_handle == NULL) {
        return FALSE;
    }
    new_session_handle = g_strdup(grant->channel);
    if (new_session_handle == NULL) {
        (void)g_free(new_account_handle);
        return FALSE;
    }
    read_pointer(
        request,
        SESSIONGROUP_ACCOUNT_OFFSET,
        &old_account_handle);
    read_pointer(
        request,
        SESSIONGROUP_SESSION_HANDLE_OFFSET,
        &old_session_handle);
    write_pointer(
        request,
        SESSIONGROUP_ACCOUNT_OFFSET,
        new_account_handle);
    write_pointer(
        request,
        SESSIONGROUP_SESSION_HANDLE_OFFSET,
        new_session_handle);
    if (old_account_handle != NULL) {
        (void)g_free(old_account_handle);
    }
    if (old_session_handle != NULL &&
        old_session_handle != old_account_handle) {
        (void)g_free(old_session_handle);
    }
    return TRUE;
}

/* Snapshot the exact native room without accepting HTTP header injection. */
static BOOL copy_requested_channel(void *request, uint32_t request_type,
                                   WCHAR channel[64]) {
    char *uri = NULL;
    size_t uri_bytes = 0U;
    size_t request_bytes = request_type == REQUEST_SESSION
        ? SESSION_REQUEST_BYTES : SESSIONGROUP_REQUEST_BYTES;
    size_t uri_offset = request_type == REQUEST_SESSION
        ? SESSION_URI_OFFSET : SESSIONGROUP_URI_OFFSET;
    channel[0] = L'\0';
    if (request_type == REQUEST_LOGIN) return TRUE;
    if ((request_type != REQUEST_SESSION && request_type != REQUEST_SESSIONGROUP_ADD) ||
        !request_is_accessible(request, request_bytes, FALSE)) return FALSE;
    read_pointer(request, uri_offset, &uri);
    if (!bounded_string(uri, 63U, &uri_bytes) || uri_bytes < 13U ||
        !bytes_are_visible_ascii((const uint8_t *)uri, uri_bytes) ||
        memcmp(uri, "sip:confctl-", 12U) != 0) return FALSE;
    for (size_t index = 0U; index < uri_bytes; ++index) {
        channel[index] = (WCHAR)(unsigned char)uri[index];
    }
    channel[uri_bytes] = L'\0';
    return TRUE;
}

static voice_action action_for_type(uint32_t request_type) {
    if (request_type == REQUEST_LOGIN) {
        return VOICE_ACTION_LOGIN;
    }
    if (request_type == REQUEST_SESSION ||
        request_type == REQUEST_SESSIONGROUP_ADD) {
        return VOICE_ACTION_JOIN;
    }
    return VOICE_ACTION_NONE;
}

static void hud_free_event(hud_synthetic_event *event) {
    if (event != NULL) {
        size_t allocation_bytes =
            offsetof(hud_synthetic_event, strings) +
            event->event_bytes;
        SecureZeroMemory(event, allocation_bytes);
        HeapFree(GetProcessHeap(), 0U, event);
    }
}

static void hud_clear_pending_locked(void) {
    hud_synthetic_event *event = g_hud_pending_head;

    while (event != NULL) {
        hud_synthetic_event *next = event->next;
        hud_free_event(event);
        event = next;
    }
    g_hud_pending_head = NULL;
    g_hud_pending_tail = NULL;
    g_hud_pending_count = 0U;
}

static BOOL hud_discard_oldest_update_locked(void) {
    hud_synthetic_event *previous = NULL;
    hud_synthetic_event *event = g_hud_pending_head;

    while (event != NULL) {
        if (event->event.base.type ==
            VIVOX_EVENT_PARTICIPANT_UPDATED) {
            if (previous == NULL) {
                g_hud_pending_head = event->next;
            } else {
                previous->next = event->next;
            }
            if (g_hud_pending_tail == event) {
                g_hud_pending_tail = previous;
            }
            --g_hud_pending_count;
            hud_free_event(event);
            return TRUE;
        }
        previous = event;
        event = event->next;
    }
    return FALSE;
}

static BOOL hud_queue_event_locked(hud_synthetic_event *event) {
    if (event == NULL) {
        return FALSE;
    }
    if (g_hud_pending_count >= HUD_EVENT_QUEUE_LIMIT &&
        !hud_discard_oldest_update_locked()) {
        hud_free_event(event);
        return FALSE;
    }
    event->next = NULL;
    if (g_hud_pending_tail == NULL) {
        g_hud_pending_head = event;
    } else {
        g_hud_pending_tail->next = event;
    }
    g_hud_pending_tail = event;
    ++g_hud_pending_count;
    return TRUE;
}

static char *hud_copy_event_string(char **cursor,
                                   const char *source) {
    size_t bytes = strlen(source) + 1U;
    char *result = *cursor;

    memcpy(result, source, bytes);
    *cursor += bytes;
    return result;
}

static hud_synthetic_event *hud_allocate_event(size_t string_bytes) {
    size_t fixed_bytes = offsetof(hud_synthetic_event, strings);
    hud_synthetic_event *event;

    if (string_bytes == 0U ||
        string_bytes > SIZE_MAX - fixed_bytes) {
        return NULL;
    }
    event = (hud_synthetic_event *)HeapAlloc(
        GetProcessHeap(),
        HEAP_ZERO_MEMORY,
        fixed_bytes + string_bytes);
    if (event != NULL) {
        event->event_bytes = string_bytes;
    }
    return event;
}

static void hud_initialize_event_base(rotk_vx_evt_base *base,
                                      int32_t event_type) {
    base->message.type = VIVOX_MESSAGE_EVENT;
    base->message.sdk_handle = NULL;
    base->message.create_time_ms = (uint64_t)GetTickCount64();
    base->type = event_type;
    base->extended_status_info = NULL;
}

/*
 * A successful Vivox 4 session-group create emits both the response and an
 * evt_sessiongroup_added message. Vivox 5 rejects the obsolete explicit
 * create request before it can emit that event. BR1315 waits for the event
 * before submitting its queued session join, so reproduce the legacy event
 * immediately after adapting the response.
 */
static void compat_queue_sessiongroup_added(void *message) {
#if defined(ROTK_VIVOX_V5_COMPAT)
    void *request = NULL;
    char *sessiongroup_handle = NULL;
    char *account_handle = NULL;
    char *alias_username = NULL;
    size_t sessiongroup_bytes = 0U;
    size_t account_bytes = 0U;
    size_t alias_bytes = 0U;
    size_t string_bytes;
    uint32_t request_type;
    int32_t sessiongroup_type = 0;
    hud_synthetic_event *node;
    rotk_vx_evt_sessiongroup_added *event;
    char *cursor;

    if (!request_is_accessible(message, 0x48U, FALSE)) {
        proxy_trace_once(
            TRACE_SESSIONGROUP_EVENT_BAD_MESSAGE,
            "[rotk-vivoxproxy] compat: sessiongroup event message unavailable");
        return;
    }
    read_pointer(
        message,
        RESPONSE_SESSIONGROUP_HANDLE_OFFSET,
        &sessiongroup_handle);
    memcpy(&request,
           (uint8_t *)message + RESPONSE_REQUEST_OFFSET,
           sizeof(request));
    if (!request_is_accessible(request, 0x58U, FALSE)) {
        proxy_trace_once(
            TRACE_SESSIONGROUP_EVENT_BAD_REQUEST,
            "[rotk-vivoxproxy] compat: sessiongroup event request unavailable");
        return;
    }
    memcpy(&request_type,
           (uint8_t *)request + REQUEST_TYPE_OFFSET,
           sizeof(request_type));
    if (request_type != REQUEST_SESSIONGROUP_CREATE) {
        proxy_trace_once(
            TRACE_SESSIONGROUP_EVENT_BAD_REQUEST,
            "[rotk-vivoxproxy] compat: sessiongroup event request mismatch");
        return;
    }
    read_pointer(
        request,
        SESSIONGROUP_CREATE_ACCOUNT_OFFSET,
        &account_handle);
    memcpy(&sessiongroup_type,
           (uint8_t *)request + SESSIONGROUP_CREATE_TYPE_OFFSET,
           sizeof(sessiongroup_type));
    read_pointer(
        request,
        SESSIONGROUP_CREATE_ALIAS_OFFSET,
        &alias_username);
    if (!bounded_string(sessiongroup_handle,
                        HUD_HANDLE_BYTES - 1U,
                        &sessiongroup_bytes) ||
        sessiongroup_bytes == 0U ||
        !bounded_string(account_handle,
                        HUD_HANDLE_BYTES - 1U,
                        &account_bytes) ||
        account_bytes == 0U) {
        proxy_trace_once(
            TRACE_SESSIONGROUP_EVENT_BAD_HANDLES,
            "[rotk-vivoxproxy] compat: sessiongroup event handles unavailable");
        return;
    }
    if (!bounded_string(alias_username,
                        HUD_HANDLE_BYTES - 1U,
                        &alias_bytes)) {
        alias_username = NULL;
        alias_bytes = 0U;
    }
    AcquireSRWLockExclusive(&g_voice_lock);
    memcpy(g_account_handle,
           account_handle,
           account_bytes + 1U);
    ReleaseSRWLockExclusive(&g_voice_lock);
    string_bytes =
        sessiongroup_bytes + 1U +
        account_bytes + 1U +
        (alias_username == NULL ? 0U : alias_bytes + 1U);
    node = hud_allocate_event(string_bytes);
    if (node == NULL) {
        proxy_trace_once(
            TRACE_SESSIONGROUP_EVENT_ALLOC_FAILED,
            "[rotk-vivoxproxy] compat: sessiongroup event allocation failed");
        return;
    }
    event = &node->event.sessiongroup_added;
    cursor = node->strings;
    hud_initialize_event_base(
        &event->base,
        VIVOX_EVENT_SESSIONGROUP_ADDED);
    event->sessiongroup_handle =
        hud_copy_event_string(&cursor, sessiongroup_handle);
    event->account_handle =
        hud_copy_event_string(&cursor, account_handle);
    event->type = sessiongroup_type;
    event->alias_username =
        alias_username == NULL
            ? NULL
            : hud_copy_event_string(&cursor, alias_username);

    AcquireSRWLockExclusive(&g_hud_lock);
    if (hud_queue_event_locked(node)) {
        AcquireSRWLockExclusive(&g_voice_lock);
        memcpy(g_compat_sessiongroup_handle,
               sessiongroup_handle,
               sessiongroup_bytes + 1U);
        InterlockedExchange(
            &g_suppress_sessiongroup_added,
            1L);
        ReleaseSRWLockExclusive(&g_voice_lock);
        proxy_trace_once(
            TRACE_SESSIONGROUP_EVENT,
            "[rotk-vivoxproxy] compat: legacy sessiongroup event queued");
    }
    ReleaseSRWLockExclusive(&g_hud_lock);
#else
    (void)message;
#endif
}

static BOOL compat_suppress_real_sessiongroup_added(
    void *message) {
#if defined(ROTK_VIVOX_V5_COMPAT)
    rotk_vx_evt_base *base;
    char *sessiongroup_handle = NULL;
    size_t sessiongroup_bytes = 0U;
    BOOL suppress = FALSE;

    if (InterlockedCompareExchange(
            &g_suppress_sessiongroup_added,
            0L,
            0L) == 0L ||
        !request_is_accessible(
            message,
            sizeof(rotk_vx_evt_sessiongroup_added),
            FALSE)) {
        return FALSE;
    }
    base = (rotk_vx_evt_base *)message;
    if (base->message.type != VIVOX_MESSAGE_EVENT ||
        base->type != VIVOX_EVENT_SESSIONGROUP_ADDED) {
        return FALSE;
    }
    read_pointer(message, 0x28U, &sessiongroup_handle);
    if (!bounded_string(sessiongroup_handle,
                        HUD_HANDLE_BYTES - 1U,
                        &sessiongroup_bytes) ||
        sessiongroup_bytes == 0U) {
        return FALSE;
    }
    AcquireSRWLockExclusive(&g_voice_lock);
    if (g_suppress_sessiongroup_added != 0L &&
        strcmp(g_compat_sessiongroup_handle,
               sessiongroup_handle) == 0) {
        SecureZeroMemory(
            g_compat_sessiongroup_handle,
            sizeof(g_compat_sessiongroup_handle));
        InterlockedExchange(
            &g_suppress_sessiongroup_added,
            0L);
        suppress = TRUE;
    }
    ReleaseSRWLockExclusive(&g_voice_lock);
    if (suppress) {
        proxy_trace_once(
            TRACE_SESSIONGROUP_REAL_EVENT_SUPPRESSED,
            "[rotk-vivoxproxy] compat: duplicate sessiongroup event suppressed");
    }
    return suppress;
#else
    (void)message;
    return FALSE;
#endif
}

/*
 * Vivox 5 deliberately leaves evt_session_added::uri empty. BR1315 predates
 * that API change and uses the URI to match the event to its pending session.
 * The proxy gives Vivox 5 a URI-based session handle and restores the same
 * channel URI from that event's handle before BR1315 sees the event. A shared
 * last-joined URI mixes up overlapping Proximity/Group joins and late events
 * from an earlier lobby or match.
 */
static void compat_restore_session_added_uri(void *message) {
#if defined(ROTK_VIVOX_V5_COMPAT)
    rotk_vx_evt_session_added *event;
    char *uri = NULL;
    char *session_handle = NULL;
    char *restored_uri;
    size_t uri_bytes = 0U;
    size_t handle_bytes = 0U;

    if (!request_is_accessible(
            message,
            sizeof(rotk_vx_evt_session_added),
            TRUE)) {
        return;
    }
    event = (rotk_vx_evt_session_added *)message;
    if (event->base.message.type != VIVOX_MESSAGE_EVENT ||
        event->base.type != VIVOX_EVENT_SESSION_ADDED) {
        return;
    }
    read_pointer(message, 0x38U, &uri);
    if (uri != NULL &&
        (!bounded_string(uri, GRANT_CHANNEL_MAX, &uri_bytes) || uri_bytes != 0U)) {
        return;
    }
    read_pointer(message, 0x30U, &session_handle);
    // Match the native join URI bound; leave unrelated SDK handles untouched.
    if (!bounded_string(session_handle, 63U, &handle_bytes) ||
        handle_bytes <= 14U ||
        (memcmp(session_handle, "sip:confctl-d-", 14U) != 0 &&
         memcmp(session_handle, "sip:confctl-g-", 14U) != 0)) {
        return;
    }
    restored_uri = g_strdup(session_handle);
    if (restored_uri == NULL) {
        return;
    }
    write_pointer(message, 0x38U, restored_uri);
    if (uri != NULL) {
        (void)g_free(uri);
    }
    proxy_trace_once(
        TRACE_SESSION_URI_RESTORED,
        "[rotk-vivoxproxy] compat: legacy session URI restored");
#else
    (void)message;
#endif
}

/*
 * BR1315 resolves a voice participant through the deprecated display_name
 * member. Vivox 5 keeps the newer displayname member populated but can leave
 * display_name empty. Restore the legacy member so the existing H1Z1
 * nameplate/speaker-icon path can associate later speaking updates with the
 * correct player entity.
 */
static void compat_restore_participant_display_name(void *message) {
#if defined(ROTK_VIVOX_V5_COMPAT)
    rotk_vx_evt_participant_added *event =
        (rotk_vx_evt_participant_added *)message;
    size_t old_name_bytes = 0U;
    size_t current_name_bytes = 0U;
    char *restored_name;

    if (!request_is_accessible(
            message,
            sizeof(*event),
            TRUE) ||
        event->base.message.type != VIVOX_MESSAGE_EVENT ||
        event->base.type != VIVOX_EVENT_PARTICIPANT_ADDED) {
        return;
    }
    if (bounded_string(
            event->display_name,
            ROTK_VOICE_HUD_MAX_NAME_BYTES,
            &old_name_bytes) &&
        old_name_bytes != 0U) {
        return;
    }
    if (!bounded_string(
            event->displayname,
            ROTK_VOICE_HUD_MAX_NAME_BYTES,
            &current_name_bytes) ||
        current_name_bytes == 0U) {
        return;
    }
    restored_name = g_strdup(event->displayname);
    if (restored_name == NULL) {
        return;
    }
    event->display_name = restored_name;
    if (InterlockedCompareExchange(
            &g_participant_display_restored,
            1L,
            0L) == 0L) {
        proxy_trace_line(
            "[rotk-vivoxproxy] compat: legacy participant display name restored");
    }
#else
    (void)message;
#endif
}

static void compat_observe_remote_speaking(void *message) {
#if defined(ROTK_VIVOX_V5_COMPAT)
    const rotk_vx_evt_participant_updated *event =
        (const rotk_vx_evt_participant_updated *)message;

    if (!request_is_accessible(
            message,
            sizeof(*event),
            FALSE) ||
        event->base.message.type != VIVOX_MESSAGE_EVENT ||
        event->base.type != VIVOX_EVENT_PARTICIPANT_UPDATED ||
        event->is_speaking == 0 ||
        event->is_current_user != 0) {
        return;
    }
    if (InterlockedCompareExchange(
            &g_remote_speaking_observed,
            1L,
            0L) == 0L) {
        proxy_trace_line(
            "[rotk-vivoxproxy] compat: authenticated remote speaking event observed");
    }
#else
    (void)message;
#endif
}

static hud_synthetic_event *hud_build_participant_added_locked(
    const hud_speaker *speaker) {
    size_t sessiongroup_bytes = strlen(g_hud_sessiongroup_handle) + 1U;
    size_t session_bytes = strlen(g_hud_session_handle) + 1U;
    size_t uri_bytes = strlen(speaker->participant_uri) + 1U;
    size_t profile_bytes = strlen(speaker->profile) + 1U;
    size_t name_bytes = strlen(speaker->display_name) + 1U;
    size_t string_bytes =
        sessiongroup_bytes + session_bytes + uri_bytes +
        profile_bytes + name_bytes;
    hud_synthetic_event *node = hud_allocate_event(string_bytes);
    rotk_vx_evt_participant_added *event;
    char *cursor;
    char *profile;
    char *display_name;
    char *uri;

    if (node == NULL) {
        return NULL;
    }
    event = &node->event.participant_added;
    cursor = node->strings;
    hud_initialize_event_base(&event->base,
                              VIVOX_EVENT_PARTICIPANT_ADDED);
    event->sessiongroup_handle =
        hud_copy_event_string(&cursor, g_hud_sessiongroup_handle);
    event->session_handle =
        hud_copy_event_string(&cursor, g_hud_session_handle);
    uri = hud_copy_event_string(&cursor, speaker->participant_uri);
    profile = hud_copy_event_string(&cursor, speaker->profile);
    display_name =
        hud_copy_event_string(&cursor, speaker->display_name);
    event->participant_uri = uri;
    event->account_name = profile;
    event->display_name = display_name;
    event->participant_type = 0;
    event->application = NULL;
    event->is_anonymous_login = 0;
    event->displayname = display_name;
    event->alias_username = profile;
    event->encoded_uri_with_tag = uri;
    event->is_current_user = 0;
    return node;
}

static hud_synthetic_event *hud_build_participant_updated_locked(
    const hud_speaker *speaker,
    BOOL active) {
    size_t sessiongroup_bytes = strlen(g_hud_sessiongroup_handle) + 1U;
    size_t session_bytes = strlen(g_hud_session_handle) + 1U;
    size_t uri_bytes = strlen(speaker->participant_uri) + 1U;
    size_t string_bytes =
        sessiongroup_bytes + session_bytes + uri_bytes;
    hud_synthetic_event *node = hud_allocate_event(string_bytes);
    rotk_vx_evt_participant_updated *event;
    char *cursor;
    char *uri;

    if (node == NULL) {
        return NULL;
    }
    event = &node->event.participant_updated;
    cursor = node->strings;
    hud_initialize_event_base(&event->base,
                              VIVOX_EVENT_PARTICIPANT_UPDATED);
    event->sessiongroup_handle =
        hud_copy_event_string(&cursor, g_hud_sessiongroup_handle);
    event->session_handle =
        hud_copy_event_string(&cursor, g_hud_session_handle);
    uri = hud_copy_event_string(&cursor, speaker->participant_uri);
    event->participant_uri = uri;
    event->is_moderator_muted = 0;
    event->is_speaking = active ? 1 : 0;
    event->volume = VIVOX_PARTICIPANT_VOLUME;
    event->energy =
        active ? VIVOX_PARTICIPANT_ENERGY_ACTIVE : 0.0;
    event->active_media = active ? 1 : 0;
    event->is_muted_for_me = 0;
    event->is_text_muted_for_me = 0;
    event->is_moderator_text_muted = 0;
    event->participant_type = 0;
    event->alias_username = NULL;
    event->encoded_uri_with_tag = uri;
    event->is_current_user = 0;
    return node;
}

static void hud_emit_speaker_locked(hud_speaker *speaker,
                                    BOOL active) {
    hud_synthetic_event *event;

    if (!g_hud_session_ready) {
        speaker->active = active;
        return;
    }
    if (active && !speaker->added) {
        event = hud_build_participant_added_locked(speaker);
        if (event == NULL) {
            speaker->active = active;
            return;
        }
        if (!hud_queue_event_locked(event)) {
            speaker->active = active;
            return;
        }
        speaker->added = TRUE;
    }
    if (speaker->added) {
        event = hud_build_participant_updated_locked(speaker, active);
        if (event != NULL) {
            (void)hud_queue_event_locked(event);
        }
    }
    speaker->active = active;
}

static void hud_emit_waiting_speakers_locked(void) {
    size_t index;

    if (!g_hud_session_ready) {
        return;
    }
    for (index = 0U; index < HUD_SPEAKER_LIMIT; ++index) {
        hud_speaker *speaker = &g_hud_speakers[index];
        if (speaker->occupied &&
            speaker->active &&
            !speaker->added) {
            hud_emit_speaker_locked(speaker, TRUE);
        }
    }
}

static void hud_reset_speakers_locked(void) {
    size_t index;

    for (index = 0U; index < HUD_SPEAKER_LIMIT; ++index) {
        hud_speaker *speaker = &g_hud_speakers[index];
        if (speaker->occupied &&
            speaker->added &&
            speaker->active) {
            hud_emit_speaker_locked(speaker, FALSE);
        } else if (speaker->occupied) {
            speaker->active = FALSE;
        }
        if (speaker->occupied) {
            /*
             * The sidecar sequence restarts when its process restarts. A
             * reset is therefore also the sequence epoch boundary.
             */
            speaker->sequence = 0U;
        }
    }
}

static hud_speaker *hud_find_speaker_locked(
    const char *profile,
    size_t profile_bytes,
    BOOL create) {
    hud_speaker *empty = NULL;
    hud_speaker *reusable = NULL;
    size_t index;

    for (index = 0U; index < HUD_SPEAKER_LIMIT; ++index) {
        hud_speaker *speaker = &g_hud_speakers[index];
        if (!speaker->occupied) {
            if (empty == NULL) {
                empty = speaker;
            }
            continue;
        }
        if (!speaker->active &&
            (reusable == NULL ||
             speaker->sequence < reusable->sequence)) {
            reusable = speaker;
        }
        if (strlen(speaker->profile) == profile_bytes &&
            memcmp(speaker->profile, profile, profile_bytes) == 0) {
            return speaker;
        }
    }
    if (!create) {
        return NULL;
    }
    if (empty == NULL) {
        empty = reusable;
    }
    if (empty == NULL) {
        return NULL;
    }
    SecureZeroMemory(empty, sizeof(*empty));
    empty->occupied = TRUE;
    memcpy(empty->profile, profile, profile_bytes);
    empty->profile[profile_bytes] = '\0';
    if (snprintf(empty->participant_uri,
                 sizeof(empty->participant_uri),
                 "sip:rotk-%s@local.invalid",
                 empty->profile) < 0) {
        SecureZeroMemory(empty, sizeof(*empty));
        return NULL;
    }
    return empty;
}

static BOOL hud_profile_is_safe(const uint8_t *profile,
                                size_t bytes) {
    size_t index;

    if (bytes == 0U ||
        bytes > ROTK_VOICE_HUD_MAX_PROFILE_BYTES) {
        return FALSE;
    }
    for (index = 0U; index < bytes; ++index) {
        uint8_t value = profile[index];
        if (!((value >= (uint8_t)'a' &&
               value <= (uint8_t)'z') ||
              (value >= (uint8_t)'A' &&
               value <= (uint8_t)'Z') ||
              (value >= (uint8_t)'0' &&
               value <= (uint8_t)'9') ||
              value == (uint8_t)'-' ||
              value == (uint8_t)'_' ||
              value == (uint8_t)'.')) {
            return FALSE;
        }
    }
    return TRUE;
}

static BOOL hud_name_is_safe(const uint8_t *name,
                             size_t bytes) {
    size_t index;

    if (bytes == 0U ||
        bytes > ROTK_VOICE_HUD_MAX_NAME_BYTES) {
        return FALSE;
    }
    for (index = 0U; index < bytes; ++index) {
        if (name[index] == 0U ||
            name[index] < 0x20U ||
            name[index] == 0x7FU) {
            return FALSE;
        }
    }
    return TRUE;
}

static void hud_apply_speaking_frame_locked(
    uint32_t sequence,
    BOOL active,
    const uint8_t *profile,
    size_t profile_bytes,
    const uint8_t *name,
    size_t name_bytes) {
    hud_speaker *speaker;

    if (!hud_profile_is_safe(profile, profile_bytes) ||
        !hud_name_is_safe(name, name_bytes)) {
        return;
    }
    speaker = hud_find_speaker_locked((const char *)profile,
                                      profile_bytes,
                                      TRUE);
    if (speaker == NULL ||
        (speaker->sequence != 0U &&
         sequence <= speaker->sequence)) {
        return;
    }
    speaker->sequence = sequence;
    memcpy(speaker->display_name, name, name_bytes);
    speaker->display_name[name_bytes] = '\0';
    hud_emit_speaker_locked(speaker, active);
}

static BOOL hud_consume_frames_locked(void) {
    size_t consumed = 0U;

    while (g_hud_receive_bytes - consumed >=
           ROTK_VOICE_HUD_HEADER_BYTES) {
        const uint8_t *frame = g_hud_receive_buffer + consumed;
        uint32_t magic = load_le32(frame);
        uint16_t version = load_le16(frame + 4U);
        uint8_t opcode = frame[6U];
        uint8_t flags = frame[7U];
        uint32_t sequence = load_le32(frame + 8U);
        uint16_t profile_bytes = load_le16(frame + 12U);
        uint16_t name_bytes = load_le16(frame + 14U);
        size_t frame_bytes =
            ROTK_VOICE_HUD_HEADER_BYTES +
            (size_t)profile_bytes +
            (size_t)name_bytes;

        if (magic != ROTK_VOICE_HUD_MAGIC ||
            version != ROTK_VOICE_HUD_PROTOCOL_VERSION ||
            frame_bytes > ROTK_VOICE_HUD_MAX_FRAME_BYTES ||
            profile_bytes > ROTK_VOICE_HUD_MAX_PROFILE_BYTES ||
            name_bytes > ROTK_VOICE_HUD_MAX_NAME_BYTES) {
            return FALSE;
        }
        if (g_hud_receive_bytes - consumed < frame_bytes) {
            break;
        }
        if (opcode == ROTK_VOICE_HUD_OPCODE_RESET &&
            profile_bytes == 0U &&
            name_bytes == 0U) {
            hud_reset_speakers_locked();
        } else if (opcode == ROTK_VOICE_HUD_OPCODE_HEARTBEAT &&
                   profile_bytes == 0U &&
                   name_bytes == 0U) {
            /* Valid no-op used by the server end to detect disconnects. */
        } else if (opcode == ROTK_VOICE_HUD_OPCODE_SPEAKING) {
            hud_apply_speaking_frame_locked(
                sequence,
                (flags & ROTK_VOICE_HUD_FLAG_ACTIVE) != 0U,
                frame + ROTK_VOICE_HUD_HEADER_BYTES,
                profile_bytes,
                frame + ROTK_VOICE_HUD_HEADER_BYTES +
                    profile_bytes,
                name_bytes);
        } else {
            return FALSE;
        }
        consumed += frame_bytes;
    }
    if (consumed != 0U) {
        memmove(g_hud_receive_buffer,
                g_hud_receive_buffer + consumed,
                g_hud_receive_bytes - consumed);
        g_hud_receive_bytes -= consumed;
    }
    return TRUE;
}

static void hud_close_pipe_locked(BOOL reset_speakers) {
    if (g_hud_pipe != INVALID_HANDLE_VALUE) {
        CloseHandle(g_hud_pipe);
        g_hud_pipe = INVALID_HANDLE_VALUE;
    }
    g_hud_receive_bytes = 0U;
    g_hud_next_connect_ms =
        GetTickCount64() + HUD_PIPE_RECONNECT_MS;
    if (reset_speakers) {
        hud_reset_speakers_locked();
    }
}

static void hud_try_connect_pipe_locked(void) {
    WCHAR pipe_name[128];
    ULONGLONG now = GetTickCount64();
    int written;

    if (g_hud_pipe != INVALID_HANDLE_VALUE ||
        now < g_hud_next_connect_ms) {
        return;
    }
    written = swprintf(
        pipe_name,
        sizeof(pipe_name) / sizeof(pipe_name[0]),
        L"\\\\.\\pipe\\rotk-voice-hud-%lu",
        (unsigned long)GetCurrentProcessId());
    if (written <= 0 ||
        (size_t)written >=
            sizeof(pipe_name) / sizeof(pipe_name[0])) {
        g_hud_next_connect_ms = now + HUD_PIPE_RECONNECT_MS;
        return;
    }
    g_hud_pipe = CreateFileW(pipe_name,
                             GENERIC_READ,
                             0U,
                             NULL,
                             OPEN_EXISTING,
                             FILE_ATTRIBUTE_NORMAL,
                             NULL);
    if (g_hud_pipe == INVALID_HANDLE_VALUE) {
        g_hud_next_connect_ms = now + HUD_PIPE_RECONNECT_MS;
        return;
    }
    g_hud_receive_bytes = 0U;
    proxy_trace_once(
        TRACE_HUD_PIPE_CONNECTED,
        "[rotk-vivoxproxy] native HUD pipe: connected");
}

static void hud_pump_pipe_locked(void) {
    unsigned int iteration;

    hud_try_connect_pipe_locked();
    if (g_hud_pipe == INVALID_HANDLE_VALUE) {
        return;
    }
    for (iteration = 0U; iteration < 4U; ++iteration) {
        DWORD available = 0U;
        DWORD to_read;
        DWORD bytes_read = 0U;
        size_t capacity =
            sizeof(g_hud_receive_buffer) -
            g_hud_receive_bytes;

        if (!PeekNamedPipe(g_hud_pipe,
                           NULL,
                           0U,
                           NULL,
                           &available,
                           NULL)) {
            hud_close_pipe_locked(TRUE);
            return;
        }
        if (available == 0U) {
            return;
        }
        if (capacity == 0U) {
            hud_close_pipe_locked(TRUE);
            return;
        }
        to_read = available;
        if ((size_t)to_read > capacity) {
            to_read = (DWORD)capacity;
        }
        if (!ReadFile(g_hud_pipe,
                      g_hud_receive_buffer +
                          g_hud_receive_bytes,
                      to_read,
                      &bytes_read,
                      NULL) ||
            bytes_read == 0U) {
            hud_close_pipe_locked(TRUE);
            return;
        }
        g_hud_receive_bytes += bytes_read;
        if (!hud_consume_frames_locked()) {
            hud_close_pipe_locked(TRUE);
            return;
        }
    }
}

static void hud_cache_session_from_message_locked(void *message) {
    rotk_vx_evt_base *base;
    char *sessiongroup_handle;
    char *session_handle;
    size_t sessiongroup_bytes;
    size_t session_bytes;
    BOOL changed;
    size_t index;

    if (!request_is_accessible(
            message,
            offsetof(rotk_vx_evt_participant_updated,
                     participant_uri),
            FALSE)) {
        return;
    }
    base = (rotk_vx_evt_base *)message;
    if (base->message.type != VIVOX_MESSAGE_EVENT ||
        (base->type != VIVOX_EVENT_PARTICIPANT_ADDED &&
         base->type != VIVOX_EVENT_PARTICIPANT_UPDATED)) {
        return;
    }
    sessiongroup_handle =
        *(char **)((uint8_t *)message + 0x28U);
    session_handle =
        *(char **)((uint8_t *)message + 0x30U);
    if (!bounded_string(sessiongroup_handle,
                        HUD_HANDLE_BYTES - 1U,
                        &sessiongroup_bytes) ||
        !bounded_string(session_handle,
                        HUD_HANDLE_BYTES - 1U,
                        &session_bytes)) {
        return;
    }
    changed =
        !g_hud_session_ready ||
        strcmp(g_hud_sessiongroup_handle,
               sessiongroup_handle) != 0 ||
        strcmp(g_hud_session_handle,
               session_handle) != 0;
    if (!changed) {
        return;
    }
    hud_clear_pending_locked();
    memcpy(g_hud_sessiongroup_handle,
           sessiongroup_handle,
           sessiongroup_bytes + 1U);
    memcpy(g_hud_session_handle,
           session_handle,
           session_bytes + 1U);
    g_hud_session_ready = TRUE;
    for (index = 0U; index < HUD_SPEAKER_LIMIT; ++index) {
        g_hud_speakers[index].added = FALSE;
    }
    hud_emit_waiting_speakers_locked();
    proxy_trace_once(
        TRACE_HUD_SESSION_CAPTURED,
        "[rotk-vivoxproxy] native HUD session: captured");
}

static hud_synthetic_event *hud_pop_event_locked(void) {
    hud_synthetic_event *event = g_hud_pending_head;

    if (event == NULL) {
        return NULL;
    }
    g_hud_pending_head = event->next;
    if (g_hud_pending_head == NULL) {
        g_hud_pending_tail = NULL;
    }
    --g_hud_pending_count;
    event->next = g_hud_inflight;
    g_hud_inflight = event;
    return event;
}

int __cdecl vx_get_message(void **message) {
    voice_rank_ensure_initialized();
    hud_synthetic_event *synthetic;
    int result;

    proxy_trace_once(
        TRACE_GET_MESSAGE,
        "[rotk-vivoxproxy] vx_get_message: entered");
    if (message == NULL ||
        !InitOnceExecuteOnce(&g_original_once,
                             initialize_original,
                             NULL,
                             NULL) ||
        g_original_module == NULL ||
        g_get_message == NULL) {
        return VOICE_ERROR;
    }
    *message = NULL;
    AcquireSRWLockExclusive(&g_hud_lock);
    hud_pump_pipe_locked();
    hud_emit_waiting_speakers_locked();
    synthetic = hud_pop_event_locked();
    if (synthetic != NULL) {
        *message = (void *)&synthetic->event;
        ReleaseSRWLockExclusive(&g_hud_lock);
        return 0;
    }
    ReleaseSRWLockExclusive(&g_hud_lock);

    for (;;) {
        result = g_get_message(message);
        if (result != 0 || *message == NULL) {
            return result;
        }
        trace_vivox_message(*message);
#if defined(ROTK_VIVOX_V5_COMPAT)
        if (request_is_accessible(*message, ROTK_VOLUME_RESPONSE_BYTES, TRUE)) {
            AcquireSRWLockExclusive(&g_volume_lock);
            if (g_volume_destroy != NULL)
                rotk_volume_restore_response(&g_volume_pending, *message, g_volume_destroy);
            ReleaseSRWLockExclusive(&g_volume_lock);
        }
#endif
        if (compat_suppress_real_sessiongroup_added(*message)) {
            (void)g_destroy_evt(*message);
            *message = NULL;
            continue;
        }
        compat_restore_session_added_uri(*message);
        compat_restore_participant_display_name(*message);
        compat_observe_remote_speaking(*message);
        (void)compat_session_notification_response(*message);
        if (compat_sessiongroup_create_response(*message)) {
            compat_queue_sessiongroup_added(*message);
        }
        AcquireSRWLockExclusive(&g_hud_lock);
        hud_cache_session_from_message_locked(*message);
        ReleaseSRWLockExclusive(&g_hud_lock);
        return result;
    }
}

int __cdecl destroy_evt(void *event) {
    hud_synthetic_event *previous = NULL;
    hud_synthetic_event *current;

    if (event == NULL) {
        return VOICE_ERROR;
    }
    AcquireSRWLockExclusive(&g_hud_lock);
    current = g_hud_inflight;
    while (current != NULL) {
        if (event == (void *)&current->event) {
            if (previous == NULL) {
                g_hud_inflight = current->next;
            } else {
                previous->next = current->next;
            }
            ReleaseSRWLockExclusive(&g_hud_lock);
            hud_free_event(current);
            return 0;
        }
        previous = current;
        current = current->next;
    }
    ReleaseSRWLockExclusive(&g_hud_lock);

    if (!InitOnceExecuteOnce(&g_original_once,
                             initialize_original,
                             NULL,
                             NULL) ||
        g_original_module == NULL ||
        g_destroy_evt == NULL) {
        return VOICE_ERROR;
    }
    return g_destroy_evt(event);
}

static int issue_original_with_trace(void *request,
                                     int *request_count,
                                     BOOL fallback) {
    int result = g_issue_request(request, request_count);

    if (fallback) {
        proxy_trace_once(
            result == 0
                ? TRACE_FALLBACK_ACCEPTED
                : TRACE_FALLBACK_REJECTED,
            result == 0
                ? "[rotk-vivoxproxy] fail-open: original accepted"
                : "[rotk-vivoxproxy] fail-open: original rejected");
    } else {
        proxy_trace_once(
            result == 0
                ? TRACE_MUTATED_ACCEPTED
                : TRACE_MUTATED_REJECTED,
            result == 0
                ? "[rotk-vivoxproxy] mutated request: original accepted"
                : "[rotk-vivoxproxy] mutated request: original rejected");
    }
    return result;
}

int __cdecl vx_issue_request3(void *request, int *request_count) {
    uint32_t request_type;
    voice_action action;
    voice_grant grant;
    BOOL mutated;
    int result;

    if (!InitOnceExecuteOnce(
            &g_original_once,
            initialize_original,
            NULL,
            NULL) ||
        g_original_module == NULL ||
        g_issue_request == NULL ||
        g_strdup == NULL ||
        g_free == NULL ||
        request == NULL ||
        request_count == NULL ||
        !request_is_accessible(
            request,
            REQUEST_TYPE_OFFSET + sizeof(request_type),
            FALSE)) {
        return VOICE_ERROR;
    }
    memcpy(&request_type,
           (uint8_t *)request + REQUEST_TYPE_OFFSET,
           sizeof(request_type));
#if defined(ROTK_VIVOX_V5_COMPAT)
    if (request_type == REQUEST_SESSION_SET_3D_POSITION &&
        request_is_accessible(request, POSITION_REQUEST_BYTES, TRUE)) {
        /* Vivox's no-reply disposition skips success replies but retains errors. */
        uint32_t disposition = POSITION_NO_REPLY_REQUIRED;
        memcpy((uint8_t *)request + POSITION_DISPOSITION_OFFSET,
               &disposition, sizeof(disposition));
    }
    if (rotk_volume_is_legacy(request_type) &&
        request_is_accessible(request, ROTK_VOLUME_REQUEST_BYTES, TRUE)) {
        rotk_volume_create_fn create = (rotk_volume_create_fn)(uintptr_t)GetProcAddress(
            g_original_module, request_type == ROTK_VOLUME_SPEAKER_LEGACY
                ? "vx_req_aux_set_speaker_level_create" : "vx_req_aux_set_mic_level_create");
        void *replacement = NULL;
        AcquireSRWLockExclusive(&g_volume_lock);
        g_volume_destroy = (rotk_volume_destroy_fn)(uintptr_t)GetProcAddress(g_original_module, "destroy_req");
        if (create != NULL && g_volume_destroy != NULL)
            replacement = rotk_volume_prepare(&g_volume_pending, request, create, g_volume_destroy, g_strdup);
        if (replacement != NULL) {
            result = g_issue_request(replacement, request_count);
            if (result != 0) rotk_volume_cancel(&g_volume_pending, replacement, g_volume_destroy);
            ReleaseSRWLockExclusive(&g_volume_lock);
            return result;
        }
        ReleaseSRWLockExclusive(&g_volume_lock);
    }
#endif
    if (request_type ==
        REQUEST_SESSION_SEND_NOTIFICATION) {
        return g_issue_request(request, request_count);
    }
    action = action_for_type(request_type);
    if (action == VOICE_ACTION_NONE) {
        return g_issue_request(request, request_count);
    }
    if (request_type == REQUEST_LOGIN) {
        proxy_trace_once(
            TRACE_ISSUE_LOGIN,
            "[rotk-vivoxproxy] issue: type=0x83 action=login");
    } else if (request_type == REQUEST_SESSION) {
        proxy_trace_once(
            TRACE_ISSUE_SESSION,
            "[rotk-vivoxproxy] issue: type=0x10 action=join");
    } else {
        proxy_trace_once(
            TRACE_ISSUE_SESSIONGROUP,
            "[rotk-vivoxproxy] issue: type=0x08 action=join");
    }

    AcquireSRWLockExclusive(&g_grant_lock);
    SecureZeroMemory(&grant, sizeof(grant));
    if (!InitOnceExecuteOnce(
            &g_config_once,
            initialize_config,
            NULL,
            NULL) ||
        !g_config.valid) {
        SecureZeroMemory(&grant, sizeof(grant));
        ReleaseSRWLockExclusive(&g_grant_lock);
        proxy_trace_once(
            TRACE_CONFIG_INVALID,
            "[rotk-vivoxproxy] intercept: local config invalid");
        return issue_original_with_trace(
            request, request_count, TRUE);
    }
    WCHAR requested_channel[64];
    if (!copy_requested_channel(request, request_type, requested_channel) ||
        !fetch_grant(action, requested_channel, &grant)) {
        SecureZeroMemory(&grant, sizeof(grant));
        ReleaseSRWLockExclusive(&g_grant_lock);
        proxy_trace_once(
            TRACE_GRANT_FAILED,
            "[rotk-vivoxproxy] intercept: grant fetch failed");
        return issue_original_with_trace(
            request, request_count, TRUE);
    }
    AcquireSRWLockExclusive(&g_voice_lock);
    if (request_type == REQUEST_LOGIN) {
        mutated = mutate_login(request, &grant);
    } else if (request_type == REQUEST_SESSION) {
        mutated = mutate_join(request,
                              SESSION_REQUEST_BYTES,
                              SESSION_URI_OFFSET,
                              SESSION_TOKEN_OFFSET,
                              &grant);
    } else {
        mutated =
            mutate_sessiongroup_context(request, &grant) &&
            mutate_join(request,
                        SESSIONGROUP_REQUEST_BYTES,
                        SESSIONGROUP_URI_OFFSET,
                        SESSIONGROUP_TOKEN_OFFSET,
                        &grant);
    }
    SecureZeroMemory(&grant, sizeof(grant));
    ReleaseSRWLockExclusive(&g_voice_lock);
    ReleaseSRWLockExclusive(&g_grant_lock);
    proxy_trace_once(
        TRACE_GRANT_READY,
        "[rotk-vivoxproxy] intercept: grant ready");
    if (!mutated) {
        proxy_trace_once(
            TRACE_MUTATION_FAILED,
            "[rotk-vivoxproxy] intercept: mutation failed");
        return issue_original_with_trace(
            request, request_count, TRUE);
    }
    proxy_trace_once(
        TRACE_MUTATION_READY,
        "[rotk-vivoxproxy] intercept: mutation ready");
    result = issue_original_with_trace(
        request, request_count, FALSE);
    if (request_type == REQUEST_LOGIN && result != 0) {
        AcquireSRWLockExclusive(&g_voice_lock);
        SecureZeroMemory(g_account, sizeof(g_account));
        SecureZeroMemory(
            g_account_handle,
            sizeof(g_account_handle));
        ReleaseSRWLockExclusive(&g_voice_lock);
    }
    return result;
}

#if defined(ROTK_VIVOX_IAT_HOOK)
#include "vivox_iat_hook.h"
#endif

#if defined(ROTK_VIVOX_V5_COMPAT)
int __cdecl vx_uninitialize(void) {
    typedef int (__cdecl *uninitialize_fn)(void);
    uninitialize_fn uninitialize;
    if (!InitOnceExecuteOnce(&g_original_once, initialize_original, NULL, NULL) ||
        g_original_module == NULL || g_free == NULL) return VOICE_ERROR;
    uninitialize = (uninitialize_fn)(uintptr_t)GetProcAddress(g_original_module, "vx_uninitialize");
    if (uninitialize == NULL) return VOICE_ERROR;
    AcquireSRWLockExclusive(&g_volume_lock);
    if (g_volume_destroy != NULL) rotk_volume_clear(&g_volume_pending, g_volume_destroy);
    ReleaseSRWLockExclusive(&g_volume_lock);
    return uninitialize();
}
#endif

BOOL WINAPI DllMain(HINSTANCE instance,
                    DWORD reason,
                    LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_proxy_module = instance;
        DisableThreadLibraryCalls(instance);
        crouch_delete_stale_log();
        LoadLibraryA("rotkc.dll");
    }
    return TRUE;
}
