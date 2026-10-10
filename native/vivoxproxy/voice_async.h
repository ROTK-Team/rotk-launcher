#ifndef ROTK_VOICE_ASYNC_H
#define ROTK_VOICE_ASYNC_H
/* Network work owns only copied inputs. SDK requests/completions stay on the
 * application's SDK entry points; accepted originals are never copied/freed twice. */
#define VOICE_ASYNC_LIMIT 8U
#define VOICE_ROOM_LIMIT 16U
#define VOICE_RECOVERY_MS 20000U
#define VOICE_ATTEMPT_MS 4000U
static void compat_begin_login_epoch(void);
typedef int (__cdecl *voice_parse_response_fn)(const char *, void **, char **);
typedef int (__cdecl *voice_destroy_fn)(void *);
typedef struct voice_room {
    BOOL occupied, desired, exhausted, accepted, media_failed, removed, wake_announced;
    uint64_t generation, epoch;
    ULONGLONG rejoin_after;
    unsigned rejoins;
    int connect_audio, connect_text;
    BOOL restore_audio, has_mute, has_volume;
    int speaker_mute, speaker_volume;
    WCHAR channel[64];
    char handle[HUD_HANDLE_BYTES], group[HUD_HANDLE_BYTES];
} voice_room;
typedef enum voice_job_phase { VOICE_EMPTY, VOICE_WAITING, VOICE_FETCHING, VOICE_READY, VOICE_ISSUED } voice_job_phase;
typedef struct voice_job {
    voice_job_phase phase;
    BOOL cancelled, valid, internal, notified;
    uint32_t type;
    uint64_t serial, epoch, generation;
    unsigned room, attempts;
    ULONGLONG until, next;
    void *request, *failure;
    WCHAR channel[64];
    char retained_handle[HUD_HANDLE_BYTES];
    voice_grant grant;
} voice_job;
static SRWLOCK g_async_lock = SRWLOCK_INIT;
static voice_job g_async_jobs[VOICE_ASYNC_LIMIT];
static voice_room g_voice_rooms[VOICE_ROOM_LIMIT];
static HANDLE g_async_wake, g_async_worker;
static DWORD g_async_worker_id;
static BOOL g_async_stop;
static LONG g_voice_uninitializing;
static uint64_t g_async_serial, g_room_generation;
static LONG g_sdk_outstanding;
static LONG g_media_trace_count;
static BOOL g_login_signature_set;
static char g_login_signature[GRANT_TOKEN_MAX + 1U];
static voice_parse_response_fn g_async_parse;
static voice_destroy_fn g_async_destroy_request, g_async_destroy_response;
static void *g_voice_controls[VOICE_ASYNC_LIMIT];
typedef void (__cdecl *voice_notify_fn)(void *);
static voice_notify_fn g_voice_notify;
static void *g_voice_notify_cookie;

/* V5's published, pack(8) configuration prefix: callback_handle at 384,
 * pf_sdk_message_callback at 400. Pass the entire configuration unchanged. */
int __cdecl vx_initialize3(void *config, size_t size) {
    typedef int (__cdecl *initialize_fn)(void *, size_t);
    if (!InitOnceExecuteOnce(&g_original_once, initialize_original, NULL, NULL)) return VOICE_ERROR;
    initialize_fn initialize = (initialize_fn)(uintptr_t)GetProcAddress(g_original_module, "vx_initialize3");
    if (initialize == NULL) return VOICE_ERROR;
    voice_notify_fn callback = NULL; void *cookie = NULL;
    if (size >= 408U && request_is_accessible(config, 408U, FALSE)) {
        memcpy(&cookie, (char *)config + 384U, sizeof(cookie));
        memcpy(&callback, (char *)config + 400U, sizeof(callback));
    }
    int result = initialize(config, size);
    if (result == 0) {
        g_voice_notify = callback; g_voice_notify_cookie = cookie;
        InterlockedExchange(&g_voice_uninitializing, 0L);
    }
    return result;
}

/* The actual bundled SDK requires InputXml and creates a temporary request.
 * Dispose that request before attaching the application's accepted original. */
static void *voice_error_response(void *request, uint32_t type) {
    static const char *const xml[] = {
        "<Response requestId=\"\" action=\"Account.AnonymousLogin.1\"><ReturnCode>1</ReturnCode><Results><StatusCode>1008</StatusCode><StatusString /><Uri /><EncodedUriWithTag /></Results><InputXml><Request requestId=\"\" action=\"Account.AnonymousLogin.1\"><ConnectorHandle /><ParticipantPropertyFrequency>100</ParticipantPropertyFrequency><EnableBuddiesAndPresence>false</EnableBuddiesAndPresence><BuddyManagementMode>Accept</BuddyManagementMode><AccountHandle /><AcctName /><DisplayName /><AccessToken /><Languages /></Request></InputXml></Response>",
        "<Response requestId=\"\" action=\"Session.Create.1\"><ReturnCode>1</ReturnCode><Results><StatusCode>1008</StatusCode><StatusString /><SessionGroupHandle /><SessionHandle /></Results><InputXml><Request requestId=\"\" action=\"Session.Create.1\"><AccountHandle /><URI /><Name /><Password /><ConnectAudio>true</ConnectAudio><ConnectText>true</ConnectText><VoiceFontID>0</VoiceFontID><JoinAudio>true</JoinAudio><JoinText>false</JoinText><PasswordHashAlgorithm>ClearText</PasswordHashAlgorithm><AliasUserName /><SessionGroupHandle /><SessionHandle /><AccessToken /></Request></InputXml></Response>",
        "<Response requestId=\"\" action=\"SessionGroup.AddSession.1\"><ReturnCode>1</ReturnCode><Results><StatusCode>1008</StatusCode><StatusString /></Results><InputXml><Request requestId=\"\" action=\"SessionGroup.AddSession.1\"><SessionGroupHandle /><URI /><ConnectAudio>false</ConnectAudio><ConnectText>false</ConnectText><SessionHandle /><AccessToken /><AccountHandle /></Request></InputXml></Response>"
    };
    unsigned index = type == REQUEST_LOGIN ? 0U : type == REQUEST_SESSION ? 1U : 2U;
    void *response = NULL, *temporary = NULL; char *error = NULL;
    if (g_async_parse == NULL || g_async_destroy_request == NULL || g_async_destroy_response == NULL) return NULL;
    int parsed = g_async_parse(xml[index], &response, &error);
    if (error != NULL) g_free(error);
    if ((uint32_t)parsed != type || response == NULL) {
        if (response != NULL) g_async_destroy_response(response);
        return NULL;
    }
    memcpy(&temporary, (char *)response + RESPONSE_REQUEST_OFFSET, sizeof(temporary));
    if (temporary != NULL) g_async_destroy_request(temporary);
    memcpy((char *)response + RESPONSE_REQUEST_OFFSET, &request, sizeof(request));
    memcpy((char *)response + 8U, (char *)request + 8U, 8U);
    return response;
}
static BOOL voice_async_duplicate_login(void *request) {
    char *token = NULL; size_t bytes;
    if (!request_is_accessible(request, LOGIN_REQUEST_BYTES, FALSE)) return FALSE;
    read_pointer(request, LOGIN_TOKEN_OFFSET, &token);
    if (!bounded_string(token, GRANT_TOKEN_MAX, &bytes)) return FALSE;
    AcquireSRWLockShared(&g_async_lock);
    BOOL duplicate = g_login_signature_set && strcmp(token, g_login_signature) == 0;
    ReleaseSRWLockShared(&g_async_lock); return duplicate;
}
static void voice_async_reset_login_signature(void) {
    AcquireSRWLockExclusive(&g_async_lock);
    g_login_signature_set = FALSE; SecureZeroMemory(g_login_signature, sizeof(g_login_signature));
    ReleaseSRWLockExclusive(&g_async_lock);
}
static unsigned voice_pending_locked(void) {
    unsigned count = 0U;
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i)
        count += g_async_jobs[i].phase != VOICE_EMPTY && g_async_jobs[i].phase != VOICE_ISSUED;
    return count;
}
static int voice_sdk_issue(void *request, int *count) {
    uint32_t type = 0U; int value = 0; char retained_handle[HUD_HANDLE_BYTES] = {0};
    if (request_is_accessible(request, 0x40U, FALSE)) {
        memcpy(&type, (char *)request + REQUEST_TYPE_OFFSET, 4U);
        if (type == 22U || type == 23U) {
            char *handle = NULL; size_t bytes;
            read_pointer(request, 0x30U, &handle); memcpy(&value, (char *)request + 0x38U, 4U);
            if (bounded_string(handle, HUD_HANDLE_BYTES - 1U, &bytes) &&
                (type == 22U ? value == 0 || value == 1 : value >= 0 && value <= 100))
                memcpy(retained_handle, handle, bytes + 1U);
        }
    }
    int result = g_issue_request(request, count);
    if (result == 0 && retained_handle[0] != '\0') {
                AcquireSRWLockExclusive(&g_async_lock);
                for (unsigned i = 0; i < VOICE_ROOM_LIMIT; ++i) {
                    voice_room *room = &g_voice_rooms[i]; char channel[64];
                    for (unsigned c = 0; c < 64U; ++c) channel[c] = (char)room->channel[c];
                    if (!room->desired || (strcmp(retained_handle, room->handle) != 0 && strcmp(retained_handle, channel) != 0)) continue;
                    if (type == 22U) { room->speaker_mute = value; room->has_mute = TRUE; }
                    else { room->speaker_volume = value; room->has_volume = TRUE; }
                    break;
                }
                ReleaseSRWLockExclusive(&g_async_lock);
    }
    if (result == 0 && count != NULL) {
        InterlockedExchange(&g_sdk_outstanding, *count);
        AcquireSRWLockShared(&g_async_lock);
        *count += (int)voice_pending_locked();
        ReleaseSRWLockShared(&g_async_lock);
    }
    return result;
}
static BOOL voice_current_locked(const voice_job *job) {
    if (job->cancelled) return FALSE;
    if (job->type == REQUEST_LOGIN) return TRUE; /* Epoch cancellation covers Login. */
    const voice_room *room = &g_voice_rooms[job->room];
    return room->desired && room->generation == job->generation && room->epoch == job->epoch;
}
static BOOL voice_retryable(DWORD status) {
    return status == 0U || status == 401U || status == 409U || status == 429U || status == 503U;
}
static DWORD WINAPI voice_network_worker(void *unused) {
    (void)unused;
    for (;;) {
        unsigned selected = VOICE_ASYNC_LIMIT; DWORD wait = INFINITE; BOOL room_ready = FALSE;
        voice_job work = {0}; ULONGLONG now = GetTickCount64();
        AcquireSRWLockExclusive(&g_async_lock);
        if (g_async_stop) { ReleaseSRWLockExclusive(&g_async_lock); break; }
        for (unsigned r = 0; r < VOICE_ROOM_LIMIT; ++r) {
            voice_room *room = &g_voice_rooms[r];
            if (!room->desired || !room->media_failed || !room->removed || room->exhausted ||
                room->rejoins >= 2U || room->wake_announced) continue;
            if (now >= room->rejoin_after) { room->wake_announced = TRUE; room_ready = TRUE; }
            else if (room->rejoin_after - now < wait) wait = (DWORD)(room->rejoin_after - now);
        }
        for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) {
            voice_job *job = &g_async_jobs[i];
            if (job->phase != VOICE_WAITING) continue;
            if (!voice_current_locked(job) || now >= job->until) {
                job->cancelled = TRUE; job->phase = VOICE_READY; continue;
            }
            if (job->next <= now) {
                if (selected == VOICE_ASYNC_LIMIT || job->next < g_async_jobs[selected].next) selected = i;
            } else if (job->next - now < wait) wait = (DWORD)(job->next - now);
        }
        for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) {
            voice_job *job = &g_async_jobs[i];
            if (job->phase == VOICE_READY && !job->notified) { job->notified = TRUE; room_ready = TRUE; }
        }
        if (selected != VOICE_ASYNC_LIMIT) {
            g_async_jobs[selected].phase = VOICE_FETCHING;
            work = g_async_jobs[selected];
        }
        ReleaseSRWLockExclusive(&g_async_lock);
        if (room_ready && g_voice_notify != NULL) g_voice_notify(g_voice_notify_cookie);
        if (selected == VOICE_ASYNC_LIMIT) { WaitForSingleObject(g_async_wake, wait); continue; }
        DWORD status = 0U, retry = 0U;
        DWORD budget = work.until - now < VOICE_ATTEMPT_MS ? (DWORD)(work.until - now) : VOICE_ATTEMPT_MS;
        BOOL valid = fetch_grant_result(action_for_type(work.type), work.channel, &work.grant, budget, &status, &retry);
        now = GetTickCount64();
        AcquireSRWLockExclusive(&g_async_lock);
        voice_job *job = &g_async_jobs[selected];
        if (job->serial == work.serial && job->phase == VOICE_FETCHING) {
            ++job->attempts;
            DWORD delay = (500U + (DWORD)(job->serial % 251U)) << (job->attempts - 1U);
            if (retry > delay) delay = retry;
            if (voice_current_locked(job) && valid && now < job->until) {
                job->grant = work.grant; job->valid = TRUE; job->phase = VOICE_READY;
            } else if (voice_current_locked(job) && voice_retryable(status) && !valid &&
                       job->attempts < 4U && now + delay < job->until) {
                job->next = now + delay; job->phase = VOICE_WAITING;
            } else {
                job->phase = VOICE_READY;
                if (job->type != REQUEST_LOGIN && voice_current_locked(job)) g_voice_rooms[job->room].exhausted = TRUE;
            }
        }
        BOOL ready = job->phase == VOICE_READY;
        if (ready) job->notified = TRUE;
        ReleaseSRWLockExclusive(&g_async_lock);
        SecureZeroMemory(&work, sizeof(work));
        /* Like Vivox, this callback only announces available work. The game
         * chooses where to call vx_get_message; never invoke it under a lock. */
        if (ready && g_voice_notify != NULL) g_voice_notify(g_voice_notify_cookie);
    }
    return 0;
}
static BOOL voice_async_start_locked(void) {
    if (g_async_worker != NULL) {
        if (!g_async_stop) return TRUE;
        if (WaitForSingleObject(g_async_worker, 0U) != WAIT_OBJECT_0) return FALSE;
        CloseHandle(g_async_worker); CloseHandle(g_async_wake);
        g_async_worker = NULL; g_async_wake = NULL;
    }
    if (g_async_parse == NULL) {
        g_async_parse = (voice_parse_response_fn)(uintptr_t)GetProcAddress(g_original_module, "vx_xml_to_response");
        g_async_destroy_request = (voice_destroy_fn)(uintptr_t)GetProcAddress(g_original_module, "destroy_req");
        g_async_destroy_response = (voice_destroy_fn)(uintptr_t)GetProcAddress(g_original_module, "destroy_resp");
    }
    if (g_async_parse == NULL || g_async_destroy_request == NULL || g_async_destroy_response == NULL) return FALSE;
    g_async_wake = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (g_async_wake == NULL) return FALSE;
    g_async_stop = FALSE;
    g_async_worker = CreateThread(NULL, 0U, voice_network_worker, NULL, 0U, &g_async_worker_id);
    if (g_async_worker == NULL) { CloseHandle(g_async_wake); g_async_wake = NULL; return FALSE; }
    return TRUE;
}
static int voice_async_enqueue(void *request, uint32_t type, int *count, uint64_t recovery_generation) {
    WCHAR channel[64]; unsigned room_index = VOICE_ROOM_LIMIT, slot = VOICE_ASYNC_LIMIT;
    if (!copy_requested_channel(request, type, channel) ||
        !request_is_accessible(request, type == REQUEST_LOGIN ? LOGIN_REQUEST_BYTES :
            type == REQUEST_SESSION ? SESSION_REQUEST_BYTES : SESSIONGROUP_REQUEST_BYTES, TRUE)) return VOICE_ERROR;
    typedef int (__cdecl *initialized_fn)(void);
    initialized_fn initialized = (initialized_fn)(uintptr_t)GetProcAddress(g_original_module, "vx_is_initialized");
    if (initialized == NULL || initialized() == 0) return VOICE_ERROR;
    AcquireSRWLockExclusive(&g_async_lock);
    if (InterlockedCompareExchange(&g_voice_uninitializing, 0L, 0L) != 0L) {
        ReleaseSRWLockExclusive(&g_async_lock); return VOICE_ERROR;
    }
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) {
        const voice_job *job = &g_async_jobs[i];
        if (job->phase == VOICE_EMPTY && slot == VOICE_ASYNC_LIMIT) slot = i;
        if (job->phase != VOICE_EMPTY && !job->cancelled &&
            (job->request == request || (job->type == type && wcscmp(job->channel, channel) == 0))) {
            ReleaseSRWLockExclusive(&g_async_lock); return VOICE_ERROR;
        }
    }
    if (type != REQUEST_LOGIN) {
        for (unsigned i = 0; i < VOICE_ROOM_LIMIT; ++i) {
            if (g_voice_rooms[i].occupied && wcscmp(g_voice_rooms[i].channel, channel) == 0) { room_index = i; break; }
            if (!g_voice_rooms[i].desired && room_index == VOICE_ROOM_LIMIT) room_index = i;
        }
        if (room_index == VOICE_ROOM_LIMIT ||
            (recovery_generation != 0U && (!g_voice_rooms[room_index].desired || g_voice_rooms[room_index].generation != recovery_generation)) ||
            (g_voice_rooms[room_index].desired && (g_voice_rooms[room_index].exhausted ||
                (recovery_generation == 0U && g_voice_rooms[room_index].accepted)))) {
            ReleaseSRWLockExclusive(&g_async_lock); return VOICE_ERROR;
        }
    }
    if (slot == VOICE_ASYNC_LIMIT || !voice_async_start_locked()) {
        ReleaseSRWLockExclusive(&g_async_lock); return VOICE_ERROR;
    }
    void *failure = voice_error_response(request, type);
    if (failure == NULL) { ReleaseSRWLockExclusive(&g_async_lock); return VOICE_ERROR; }
    AcquireSRWLockShared(&g_voice_lock); uint64_t epoch = g_login_epoch; ReleaseSRWLockShared(&g_voice_lock);
    voice_job *job = &g_async_jobs[slot];
    job->type = type; job->request = request; job->failure = failure; job->epoch = epoch;
    job->internal = recovery_generation != 0U;
    job->room = room_index; job->serial = ++g_async_serial;
    wcscpy(job->channel, channel);
    job->next = GetTickCount64(); job->until = job->next + VOICE_RECOVERY_MS;
    if (type == REQUEST_LOGIN) {
        char *token = NULL; size_t bytes;
        read_pointer(request, LOGIN_TOKEN_OFFSET, &token);
        if (bounded_string(token, GRANT_TOKEN_MAX, &bytes)) {
            SecureZeroMemory(g_login_signature, sizeof(g_login_signature));
            memcpy(g_login_signature, token, bytes + 1U); g_login_signature_set = TRUE;
        }
    }
    if (type != REQUEST_LOGIN) {
        voice_room *room = &g_voice_rooms[room_index];
        if (!room->desired) {
            SecureZeroMemory(room, sizeof(*room)); room->occupied = room->desired = TRUE;
            room->epoch = epoch; room->generation = ++g_room_generation; wcscpy(room->channel, channel);
        }
        job->generation = room->generation;
        if (job->internal) memcpy(job->retained_handle, room->handle, sizeof(job->retained_handle));
        char *group = NULL; size_t length;
        read_pointer(request, type == REQUEST_SESSIONGROUP_ADD ? 0x30U : 0x78U, &group);
        if (bounded_string(group, HUD_HANDLE_BYTES - 1U, &length)) memcpy(room->group, group, length + 1U);
        if (type == REQUEST_SESSIONGROUP_ADD) {
            memcpy(&room->connect_audio, (char *)request + 0x50U, 4U);
            memcpy(&room->connect_text, (char *)request + 0x5cU, 4U);
        }
        else {
            memcpy(&room->connect_audio, (char *)request + 0x50U, 4U);
            memcpy(&room->connect_text, (char *)request + 0x60U, 4U);
        }
    }
    job->phase = VOICE_WAITING;
    LONG sdk = InterlockedCompareExchange(&g_sdk_outstanding, 0L, 0L);
    *count = (sdk > 0L ? (int)sdk : 0) + (int)voice_pending_locked();
    SetEvent(g_async_wake);
    ReleaseSRWLockExclusive(&g_async_lock);
    return 0;
}
static void voice_async_new_login(void) {
    AcquireSRWLockExclusive(&g_async_lock);
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) {
        if (g_async_jobs[i].phase == VOICE_EMPTY) continue;
        g_async_jobs[i].cancelled = TRUE; g_async_jobs[i].valid = FALSE;
        g_async_jobs[i].notified = FALSE;
        if (g_async_jobs[i].phase != VOICE_ISSUED) g_async_jobs[i].phase = VOICE_READY;
    }
    SecureZeroMemory(g_voice_rooms, sizeof(g_voice_rooms));
    InterlockedExchange(&g_media_trace_count, 0L);
    if (g_async_wake != NULL) SetEvent(g_async_wake);
    ReleaseSRWLockExclusive(&g_async_lock);
}
static void voice_async_retire(void *request, uint32_t type) {
    char *handle = NULL; BOOL all = type == 2U || type == REQUEST_ACCOUNT_LOGOUT;
    if (!all && !request_is_accessible(request, 0x38U, FALSE)) return;
    if (type == 9U) read_pointer(request, 0x30U, &handle);
    else if (type == 7U || type == 0x13U || type == 0x15U) read_pointer(request, 0x30U, &handle);
    else if (!all) return;
    size_t length; if (!all && !bounded_string(handle, HUD_HANDLE_BYTES - 1U, &length)) return;
    AcquireSRWLockExclusive(&g_async_lock);
    for (unsigned r = 0; r < VOICE_ROOM_LIMIT; ++r) {
        voice_room *room = &g_voice_rooms[r];
        char channel[64]; for (unsigned i = 0; i < 64U; ++i) channel[i] = (char)room->channel[i];
        if (room->desired && (all || strcmp(handle, type == 7U ? room->group : room->handle) == 0 ||
                             (type != 7U && strcmp(handle, channel) == 0))) {
            room->desired = FALSE;
            for (unsigned j = 0; j < VOICE_ASYNC_LIMIT; ++j) {
                voice_job *job = &g_async_jobs[j];
                if (job->phase != VOICE_EMPTY && job->phase != VOICE_ISSUED && job->room == r && job->type != REQUEST_LOGIN) {
                    job->cancelled = TRUE; job->valid = FALSE; job->phase = VOICE_READY;
                    job->notified = FALSE;
                }
            }
        }
    }
    ReleaseSRWLockExclusive(&g_async_lock);
}
/* Return at most one completion per poll; SDK calls never run on the worker. */
static void *voice_async_poll(void) {
    voice_job work = {0}; unsigned slot = VOICE_ASYNC_LIMIT;
    AcquireSRWLockExclusive(&g_async_lock);
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) if (g_async_jobs[i].phase == VOICE_READY) {
        slot = i; work = g_async_jobs[i];
        work.valid = work.valid && voice_current_locked(&work) && GetTickCount64() < work.until;
        g_async_jobs[i].phase = VOICE_ISSUED; g_async_jobs[i].failure = NULL; break;
    }
    ReleaseSRWLockExclusive(&g_async_lock);
    if (slot == VOICE_ASYNC_LIMIT) return NULL;
    BOOL mutated = FALSE;
    AcquireSRWLockExclusive(&g_voice_lock);
    if (work.valid && work.epoch == g_login_epoch && work.grant.expires > unix_time_seconds()) {
        if (work.type == REQUEST_LOGIN) mutated = mutate_login(work.request, &work.grant);
        else if (work.type == REQUEST_SESSION) mutated = mutate_join(work.request, SESSION_REQUEST_BYTES, SESSION_URI_OFFSET, SESSION_TOKEN_OFFSET, &work.grant);
        else mutated = mutate_sessiongroup_context(work.request, &work.grant) &&
            mutate_join(work.request, SESSIONGROUP_REQUEST_BYTES, SESSIONGROUP_URI_OFFSET, SESSIONGROUP_TOKEN_OFFSET, &work.grant);
        if (mutated && work.internal && work.retained_handle[0] != '\0') {
            char *handle = g_strdup(work.retained_handle), *canonical = NULL;
            if (handle == NULL) mutated = FALSE;
            else {
                read_pointer(work.request, SESSIONGROUP_SESSION_HANDLE_OFFSET, &canonical);
                write_pointer(work.request, SESSIONGROUP_SESSION_HANDLE_OFFSET, handle);
                if (canonical != NULL) g_free(canonical);
            }
        }
    }
    ReleaseSRWLockExclusive(&g_voice_lock);
    void *none = NULL;
    memcpy((char *)work.failure + RESPONSE_REQUEST_OFFSET, &none, sizeof(none));
    int count = 0, issued = mutated ? g_issue_request(work.request, &count) : VOICE_ERROR;
    if (issued == 0) {
        InterlockedExchange(&g_sdk_outstanding, count);
        g_async_destroy_response(work.failure);
        AcquireSRWLockExclusive(&g_async_lock);
        if (work.type != REQUEST_LOGIN && voice_current_locked(&work)) g_voice_rooms[work.room].accepted = TRUE;
        if (g_async_jobs[slot].serial == work.serial) SecureZeroMemory(&g_async_jobs[slot].grant, sizeof(voice_grant));
        ReleaseSRWLockExclusive(&g_async_lock);
        work.failure = NULL;
    } else {
        memcpy((char *)work.failure + RESPONSE_REQUEST_OFFSET, &work.request, sizeof(work.request));
        AcquireSRWLockExclusive(&g_async_lock);
        if (work.type != REQUEST_LOGIN && voice_current_locked(&work)) g_voice_rooms[work.room].exhausted = TRUE;
        if (g_async_jobs[slot].serial == work.serial) SecureZeroMemory(&g_async_jobs[slot], sizeof(voice_job));
        ReleaseSRWLockExclusive(&g_async_lock);
    }
    void *failure = work.failure;
    if (work.internal && failure != NULL) { g_async_destroy_response(failure); failure = NULL; }
    SecureZeroMemory(&work, sizeof(work)); return failure;
}
static BOOL voice_async_observe_response(void *message) {
    uint32_t kind; if (!request_is_accessible(message, 0x40U, FALSE)) return FALSE;
    memcpy(&kind, message, 4U); if (kind != VIVOX_MESSAGE_RESPONSE) return FALSE;
    void *request = NULL; memcpy(&request, (char *)message + RESPONSE_REQUEST_OFFSET, sizeof(request));
    BOOL internal = FALSE;
    AcquireSRWLockExclusive(&g_async_lock);
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i)
        if (g_voice_controls[i] == request) { g_voice_controls[i] = NULL; internal = TRUE; break; }
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) {
        voice_job *job = &g_async_jobs[i];
        if (job->phase == VOICE_ISSUED && job->request == request) {
            internal = job->internal;
            int32_t code; memcpy(&code, (char *)message + RESPONSE_RETURN_CODE_OFFSET, 4U);
            if (code == 0 && job->type == REQUEST_SESSION && voice_current_locked(job) &&
                request_is_accessible(message, 0x50U, FALSE)) {
                char *group = NULL, *handle = NULL; size_t bytes;
                read_pointer(message, 0x40U, &group); read_pointer(message, 0x48U, &handle);
                voice_room *room = &g_voice_rooms[job->room];
                if (bounded_string(group, HUD_HANDLE_BYTES - 1U, &bytes)) memcpy(room->group, group, bytes + 1U);
                if (bounded_string(handle, HUD_HANDLE_BYTES - 1U, &bytes)) memcpy(room->handle, handle, bytes + 1U);
            }
            if (code != 0 && job->type != REQUEST_LOGIN && voice_current_locked(job)) g_voice_rooms[job->room].exhausted = TRUE;
            SecureZeroMemory(job, sizeof(*job)); break;
        }
    }
    LONG outstanding = InterlockedCompareExchange(&g_sdk_outstanding, 0L, 0L);
    if (outstanding > 0L) InterlockedDecrement(&g_sdk_outstanding);
    ReleaseSRWLockExclusive(&g_async_lock);
    return internal;
}
/* V5 events, pack(8): media type=20, removed=25. A successful join response
 * does not establish media. Retry documented transient failures only, after
 * removal and a ten-second delay; explicit leaves retire desire first. */
static void voice_restore_audio(const voice_room *room) {
    typedef int (__cdecl *create_fn)(void **);
    const char *factories[] = {"vx_req_session_mute_local_speaker_create", "vx_req_session_set_local_speaker_volume_create"};
    for (unsigned control = 0; control < 2U; ++control) {
        if (control == 0U ? !room->has_mute : !room->has_volume) continue;
        create_fn create = (create_fn)(uintptr_t)GetProcAddress(g_original_module, factories[control]);
        void *request = NULL; if (create == NULL || create(&request) != 0 || request == NULL) continue;
        char *handle = g_strdup(room->handle); write_pointer(request, 0x30U, handle);
        int value = control == 0U ? room->speaker_mute : room->speaker_volume;
        memcpy((char *)request + 0x38U, &value, 4U);
        unsigned slot = VOICE_ASYNC_LIMIT;
        AcquireSRWLockExclusive(&g_async_lock);
        for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) if (g_voice_controls[i] == NULL) {
            slot = i; g_voice_controls[i] = request; break;
        }
        ReleaseSRWLockExclusive(&g_async_lock);
        int count = 0, result = handle != NULL && slot != VOICE_ASYNC_LIMIT ? g_issue_request(request, &count) : VOICE_ERROR;
        if (result == 0) InterlockedExchange(&g_sdk_outstanding, count);
        else {
            AcquireSRWLockExclusive(&g_async_lock);
            if (slot != VOICE_ASYNC_LIMIT && g_voice_controls[slot] == request) g_voice_controls[slot] = NULL;
            ReleaseSRWLockExclusive(&g_async_lock); g_async_destroy_request(request);
        }
    }
}
static void voice_async_observe_event(void *message) {
    uint32_t kind, type;
    if (!request_is_accessible(message, 0x30U, FALSE)) return;
    memcpy(&kind, message, 4U); memcpy(&type, (char *)message + 0x18U, 4U);
    if (kind == VIVOX_MESSAGE_EVENT && type == 2U && request_is_accessible(message, 0x38U, FALSE)) {
        int state; char *account = NULL; size_t bytes; BOOL current = FALSE;
        memcpy(&state, (char *)message + 0x28U, 4U); read_pointer(message, 0x30U, &account);
        if (state == 0 && bounded_string(account, HUD_HANDLE_BYTES - 1U, &bytes)) {
            AcquireSRWLockShared(&g_voice_lock);
            current = g_account_handle[0] != '\0' && strcmp(account, g_account_handle) == 0;
            ReleaseSRWLockShared(&g_voice_lock);
        }
        if (current) { voice_async_reset_login_signature(); compat_begin_login_epoch(); }
        return;
    }
    if (kind != VIVOX_MESSAGE_EVENT || (type != 20U && type != 23U && type != 24U && type != 25U)) return;
    char *handle = NULL, *group = NULL;
    if (type != 23U) {
        if (!request_is_accessible(message, 0x40U, FALSE)) return;
        read_pointer(message, 0x30U, &handle);
    }
    read_pointer(message, 0x28U, &group);
    size_t handle_bytes, group_bytes;
    if ((type != 23U && !bounded_string(handle, HUD_HANDLE_BYTES - 1U, &handle_bytes)) ||
        !bounded_string(group, HUD_HANDLE_BYTES - 1U, &group_bytes)) return;
    int state = 0, status = 0;
    if (type == 20U) {
        if (!request_is_accessible(message, 0x50U, FALSE)) return;
        memcpy(&status, (char *)message + 0x38U, 4U); memcpy(&state, (char *)message + 0x48U, 4U);
    }
    voice_room restore = {0}; BOOL restore_pending = FALSE; char restored_channel[64] = {0};
    AcquireSRWLockExclusive(&g_async_lock);
    for (unsigned i = 0; i < VOICE_ROOM_LIMIT; ++i) {
        voice_room *room = &g_voice_rooms[i]; char channel[64];
        for (unsigned c = 0; c < 64U; ++c) channel[c] = (char)room->channel[c];
        if (type == 23U && room->desired && strcmp(group, room->group) == 0) {
            /* A removed group loses its TX selection; let the game recreate it
             * rather than reopening transmission with SDK defaults. */
            room->exhausted = TRUE; continue;
        }
        if (!room->desired || !room->accepted || strcmp(group, room->group) != 0 ||
            (strcmp(handle, room->handle) != 0 && strcmp(handle, channel) != 0)) continue;
        if (type == 24U) {
            memcpy(room->handle, handle, handle_bytes + 1U);
            memcpy(restored_channel, channel, sizeof(restored_channel));
            if (room->restore_audio) { restore = *room; restore_pending = TRUE; room->restore_audio = FALSE; }
        }
        if (type == 20U && state == 2) { room->media_failed = FALSE; room->removed = FALSE; }
        if (type == 20U && state == 1) {
            room->media_failed = status == 408 || status == 480 || status == 486 || status == 503;
            room->rejoin_after = GetTickCount64() + 10000U;
            room->wake_announced = FALSE;
            if (status >= 400 && !room->media_failed) room->exhausted = TRUE;
        }
        if (type == 25U) room->removed = TRUE;
        if (g_async_wake != NULL) SetEvent(g_async_wake);
        if (InterlockedIncrement(&g_media_trace_count) <= 32L) {
            char line[160]; snprintf(line, sizeof(line), "[rotk-vivoxproxy] media: event=%u state=%d status=%d transient=%u rejoins=%u",
                (unsigned)type, state, status, (unsigned)room->media_failed, room->rejoins);
            proxy_trace_line(line);
        }
        break;
    }
    ReleaseSRWLockExclusive(&g_async_lock);
    if (restored_channel[0] != '\0') {
        char *uri = NULL; size_t bytes; read_pointer(message, 0x38U, &uri);
        if (uri == NULL || (bounded_string(uri, GRANT_CHANNEL_MAX, &bytes) && bytes == 0U)) {
            char *replacement = g_strdup(restored_channel);
            if (replacement != NULL) {
                write_pointer(message, 0x38U, replacement); if (uri != NULL) g_free(uri);
            }
        }
    }
    if (restore_pending) voice_restore_audio(&restore);
}
static void voice_async_rejoin(void) {
    voice_room snapshot = {0}; unsigned selected = VOICE_ROOM_LIMIT;
    AcquireSRWLockExclusive(&g_async_lock);
    for (unsigned i = 0; i < VOICE_ROOM_LIMIT; ++i) {
        voice_room *room = &g_voice_rooms[i];
        if (room->desired && room->accepted && room->media_failed && room->removed && !room->exhausted &&
            room->rejoins < 2U && room->group[0] != '\0' && GetTickCount64() >= room->rejoin_after) {
            snapshot = *room; room->media_failed = FALSE; room->removed = FALSE; room->restore_audio = TRUE;
            ++room->rejoins; selected = i; break;
        }
    }
    ReleaseSRWLockExclusive(&g_async_lock);
    if (selected == VOICE_ROOM_LIMIT) return;
    typedef int (__cdecl *create_fn)(void **);
    create_fn create = (create_fn)(uintptr_t)GetProcAddress(g_original_module, "vx_req_sessiongroup_add_session_create");
    void *request = NULL; int count = 0;
    if (create == NULL || create(&request) != 0 || request == NULL) return;
    char channel[64]; for (unsigned i = 0; i < 64U; ++i) channel[i] = (char)snapshot.channel[i];
    char *group = g_strdup(snapshot.group), *uri = g_strdup(channel);
    write_pointer(request, 0x30U, group); write_pointer(request, SESSIONGROUP_URI_OFFSET, uri);
    memcpy((char *)request + 0x50U, &snapshot.connect_audio, 4U);
    memcpy((char *)request + 0x5cU, &snapshot.connect_text, 4U);
    if (group == NULL || uri == NULL || voice_async_enqueue(request, REQUEST_SESSIONGROUP_ADD, &count, snapshot.generation) != 0)
        g_async_destroy_request(request);
}
static void voice_async_stop(void) {
    AcquireSRWLockExclusive(&g_async_lock); g_async_stop = TRUE;
    HANDLE worker = g_async_worker;
    if (g_async_wake != NULL) SetEvent(g_async_wake);
    ReleaseSRWLockExclusive(&g_async_lock);
    if (worker != NULL && GetCurrentThreadId() != g_async_worker_id) {
        WaitForSingleObject(worker, INFINITE); CloseHandle(worker); CloseHandle(g_async_wake);
        g_async_worker = NULL; g_async_wake = NULL;
    }
    voice_async_new_login();
}
/* The V5 allocator must still be initialized when destroying accepted requests
 * that have not reached the SDK. Issued originals belong to the SDK instead. */
static void voice_async_discard_pending(void) {
    AcquireSRWLockExclusive(&g_async_lock);
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) {
        if (g_async_jobs[i].phase == VOICE_ISSUED) continue;
        if (g_async_jobs[i].failure != NULL) g_async_destroy_response(g_async_jobs[i].failure);
        SecureZeroMemory(&g_async_jobs[i], sizeof(voice_job));
    }
    ReleaseSRWLockExclusive(&g_async_lock);
}
static void voice_async_clear(void) {
    AcquireSRWLockExclusive(&g_async_lock);
    memset(g_async_jobs, 0, sizeof(g_async_jobs));
    InterlockedExchange(&g_sdk_outstanding, 0L);
    memset(g_voice_controls, 0, sizeof(g_voice_controls));
    g_voice_notify = NULL; g_voice_notify_cookie = NULL;
    g_login_signature_set = FALSE; SecureZeroMemory(g_login_signature, sizeof(g_login_signature));
    ReleaseSRWLockExclusive(&g_async_lock);
}
#endif
