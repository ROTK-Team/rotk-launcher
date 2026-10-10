/* Production async hook + real WinHTTP and bundled SDK allocation/destruction. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#define ROTK_VIVOX_V5_COMPAT 1
#include "../vivoxsdk_x64_proxy.c"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
typedef int (__cdecl *create_fn)(void **);
typedef int (__cdecl *config_fn)(void *, size_t);
typedef int (__cdecl *stop_fn)(void);
static SOCKET listener;
static HANDLE received, release_response, notified;
static DWORD application_thread;
static int scenario, attempts, sdk_calls, callback_cookie;
static void *sdk_response;
static create_fn login_create, session_create, group_create;
static voice_parse_response_fn parse_event;
static voice_destroy_fn destroy_event;
static vx_issue_request3_fn real_issue;
static create_fn real_get;
static unsigned control_calls;
static voice_destroy_fn sdk_destroy_response;
static unsigned destroyed_responses;
static void *passthrough_request;
static BYTE passthrough_base[0x30U];
static int __cdecl tracked_destroy_response(void *response) {
    int result = sdk_destroy_response(response); assert(result == 0); ++destroyed_responses; return result;
}
static BOOL CALLBACK initialized(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    (void)once; (void)parameter; (void)context; return TRUE;
}
static void __cdecl notification(void *cookie) {
    assert(cookie == &callback_cookie); SetEvent(notified);
}
static int __cdecl issue_stub(void *request, int *count) {
    assert(GetCurrentThreadId() == application_thread);
    assert(TryAcquireSRWLockExclusive(&g_voice_lock)); ReleaseSRWLockExclusive(&g_voice_lock);
    assert(TryAcquireSRWLockExclusive(&g_async_lock)); ReleaseSRWLockExclusive(&g_async_lock);
    if (passthrough_request != NULL) {
        assert(request == passthrough_request && memcmp(request, passthrough_base, sizeof(passthrough_base)) == 0);
        *count = 0; return 0;
    }
    uint32_t type; memcpy(&type, (char *)request + REQUEST_TYPE_OFFSET, 4U);
    if (type == 22U || type == 23U) {
        char *handle = NULL; int value; read_pointer(request, 0x30U, &handle); memcpy(&value, (char *)request + 0x38U, 4U);
        assert(!strcmp(handle, "sip:confctl-g-test.group@domain"));
        assert(value == (type == 22U ? 1 : 35)); ++control_calls; return real_issue(request, count);
    }
    char *token = NULL; read_pointer(request, type == REQUEST_SESSIONGROUP_ADD ? SESSIONGROUP_TOKEN_OFFSET : LOGIN_TOKEN_OFFSET, &token);
    assert(!strcmp(token, "new-token"));
    assert(sdk_response == NULL); sdk_response = voice_error_response(request, type); assert(sdk_response);
    int32_t success = 0; memcpy((char *)sdk_response + RESPONSE_RETURN_CODE_OFFSET, &success, 4U);
    if (scenario == 11 && type == REQUEST_SESSION) {
        write_pointer(sdk_response, 0x40U, g_strdup("test-group")); write_pointer(sdk_response, 0x48U, g_strdup("sdk-room-42"));
    }
    if (scenario == 11 && type == REQUEST_SESSIONGROUP_ADD) {
        char *handle = NULL; read_pointer(request, SESSIONGROUP_SESSION_HANDLE_OFFSET, &handle); assert(!strcmp(handle, "sdk-room-42"));
    }
    ++sdk_calls; *count = 1; return 0;
}
static int __cdecl get_stub(void **message) {
    if (sdk_response) { *message = sdk_response; sdk_response = NULL; return 0; }
    (void)real_get(message); return 0;
}
static void send_all(SOCKET client, const void *data, size_t size) {
    const char *p = data;
    while (size) { int n = send(client, p, (int)size, 0); assert(n > 0); p += n; size -= (size_t)n; }
}
static DWORD WINAPI serve(void *unused) {
    (void)unused;
    unsigned expected = scenario == 1 ? 3U : scenario == 6 || scenario == 11 ? 2U : scenario == 9 ? 4U : 1U;
    for (unsigned attempt = 0; attempt < expected; ++attempt) {
        SOCKET client = accept(listener, NULL, NULL); assert(client != INVALID_SOCKET);
        char input[2048]; assert(recv(client, input, sizeof(input), 0) > 0);
        ++attempts; SetEvent(received);
        assert(WaitForSingleObject(release_response, 5000U) == WAIT_OBJECT_0);
        if (scenario == 9) { closesocket(client); continue; }
        if (scenario == 10) {
            const char response[] = "HTTP/1.1 503 Busy\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            send_all(client, response, sizeof(response) - 1U);
        } else if (scenario == 1 && attempt < 2U) {
            const char response[] = "HTTP/1.1 429 Busy\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            send_all(client, response, sizeof(response) - 1U);
        } else if (scenario == 2) {
            const char response[] = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            send_all(client, response, sizeof(response) - 1U);
        } else {
            BYTE wire[256] = {0}; const char *account = scenario == 8 ? ".wrong." : ".a.", *token = "new-token";
            const char *channel = scenario == 7 ? "sip:confctl-g-wrong.group@domain" : scenario >= 4 ? "sip:confctl-g-test.group@domain" : "";
            uint32_t expires = unix_time_seconds() + (scenario == 3 ? 0U : 60U);
            uint16_t a = (uint16_t)strlen(account), c = (uint16_t)strlen(channel), t = (uint16_t)strlen(token);
            memcpy(wire, "RVG1", 4U); memcpy(wire + 4U, &expires, 4U);
            memcpy(wire + 8U, &a, 2U); memcpy(wire + 10U, &c, 2U); memcpy(wire + 12U, &t, 2U);
            memcpy(wire + 16U, account, a); memcpy(wire + 16U + a, channel, c); memcpy(wire + 16U + a + c, token, t);
            size_t size = 16U + a + c + t; char headers[200];
            int n = snprintf(headers, sizeof(headers), "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %u\r\nConnection: close\r\n\r\n", (unsigned)size);
            assert(n > 0); send_all(client, headers, (size_t)n); send_all(client, wire, size);
        }
        closesocket(client);
    }
    return 0;
}
static void *request_new(BOOL join) {
    void *request = NULL; assert((scenario == 6 ? group_create : join ? session_create : login_create)(&request) == 0 && request);
    write_pointer(request, scenario == 6 ? SESSIONGROUP_TOKEN_OFFSET : LOGIN_TOKEN_OFFSET, g_strdup("old-token"));
    write_pointer(request, 0x20U, g_strdup("original-cookie")); write_pointer(request, 0x28U, (char *)&callback_cookie);
    if (join) write_pointer(request, scenario == 6 ? SESSIONGROUP_URI_OFFSET : SESSION_URI_OFFSET, g_strdup("sip:confctl-g-test.group@domain"));
    if (scenario == 6) { write_pointer(request, 0x30U, g_strdup("test-group")); int audio = 1; memcpy((char *)request + 0x50U, &audio, 4U); }
    return request;
}
static void observe_xml_event(const char *xml, uint32_t type) {
    void *event = NULL; char *error = NULL;
    int parsed = parse_event(xml, &event, &error); if (error) g_free(error);
    assert((uint32_t)parsed == type && event); voice_async_observe_event(event); assert(destroy_event(event) == 0);
}
static void destroy_completion(void *message, void *original, BOOL success) {
    assert(message); void *attached = NULL; char *cookie = NULL, *context = NULL;
    memcpy(&attached, (char *)message + RESPONSE_REQUEST_OFFSET, sizeof(attached));
    assert(attached == original); read_pointer(attached, 0x20U, &cookie); read_pointer(attached, 0x28U, &context);
    assert(!strcmp(cookie, "original-cookie") && context == (char *)&callback_cookie);
    int32_t result; memcpy(&result, (char *)message + RESPONSE_RETURN_CODE_OFFSET, 4U);
    assert((result == 0) == success); assert(g_async_destroy_response(message) == 0);
}
int main(int argc, char **argv) {
    assert(argc == 2); setvbuf(stdout, NULL, _IONBF, 0);
    WSADATA data; assert(WSAStartup(MAKEWORD(2, 2), &data) == 0);
    g_original_module = LoadLibraryA(argv[1]); assert(g_original_module);
#define LOAD(type, name) ((type)(uintptr_t)GetProcAddress(g_original_module, name))
    g_strdup = LOAD(vx_strdup_fn, "vx_strdup"); g_free = LOAD(vx_free_fn, "vx_free");
    g_issue_request = issue_stub; g_get_message = get_stub;
    login_create = LOAD(create_fn, "vx_req_account_anonymous_login_create");
    session_create = LOAD(create_fn, "vx_req_session_create_create");
    group_create = LOAD(create_fn, "vx_req_sessiongroup_add_session_create");
    parse_event = LOAD(voice_parse_response_fn, "vx_xml_to_event"); destroy_event = LOAD(voice_destroy_fn, "destroy_evt");
    assert(g_strdup && g_free && login_create && session_create);
    assert(InitOnceExecuteOnce(&g_original_once, initialized, NULL, NULL));
    assert(InitOnceExecuteOnce(&g_config_once, initialized, NULL, NULL));
    uint64_t config[512] = {0}; config_fn defaults = LOAD(config_fn, "vx_get_default_config3");
    assert(defaults(config, sizeof(config)) == 0);
    voice_notify_fn callback = notification; void *cookie = &callback_cookie;
    memcpy((char *)config + 384U, &cookie, sizeof(cookie)); memcpy((char *)config + 400U, &callback, sizeof(callback));
    notified = CreateEventW(NULL, FALSE, FALSE, NULL); assert(notified);
    assert(vx_initialize3(config, sizeof(config)) == 0);
    real_get = LOAD(create_fn, "vx_get_message");
    real_issue = LOAD(vx_issue_request3_fn, "vx_issue_request3");
    void *sample = NULL; int count = 0; assert(login_create(&sample) == 0 && real_issue(sample, &count) == 0);
    assert(WaitForSingleObject(notified, 3000U) == WAIT_OBJECT_0);
    void *message = NULL; assert(real_get(&message) == 0 && message);
    assert(LOAD(voice_destroy_fn, "destroy_resp")(message) == 0);
    g_config.valid = TRUE; g_config.secure = FALSE; wcscpy(g_config.host, L"127.0.0.1"); wcscpy(g_config.session_id, L"test-only");
    application_thread = GetCurrentThreadId();
    for (scenario = 0; scenario < 12; ++scenario) {
        compat_begin_login_epoch(); voice_async_reset_login_signature(); strcpy(g_account, ".a.");
        strcpy(g_account_handle, ".a.");
        struct sockaddr_in address = {0}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); assert(listener != INVALID_SOCKET);
        assert(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0 && listen(listener, 8) == 0);
        int length = sizeof(address); assert(getsockname(listener, (struct sockaddr *)&address, &length) == 0);
        g_config.port = ntohs(address.sin_port); attempts = 0;
        received = CreateEventW(NULL, TRUE, FALSE, NULL); release_response = CreateEventW(NULL, TRUE, FALSE, NULL);
        ResetEvent(notified); HANDLE server = CreateThread(NULL, 0U, serve, NULL, 0U, NULL); assert(server);
        void *request = request_new(scenario >= 4); ULONGLONG start = GetTickCount64(); int calls = sdk_calls;
        assert(vx_issue_request3(request, &count) == 0 && count == 1);
        assert(GetTickCount64() - start < 100U);
        assert(WaitForSingleObject(received, 3000U) == WAIT_OBJECT_0);
        assert(sdk_calls == calls && TryAcquireSRWLockExclusive(&g_voice_lock)); ReleaseSRWLockExclusive(&g_voice_lock);
        assert(vx_get_message(&message) == 0 && message == NULL);
        if (scenario == 0) Sleep(2200U);
        if (scenario == 5) {
            BYTE leave[0x38U] = {0}; write_pointer(leave, 0x30U, "sip:confctl-g-test.group@domain"); voice_async_retire(leave, 0x15U);
        }
        SetEvent(release_response);
        assert(WaitForSingleObject(notified, 6000U) == WAIT_OBJECT_0);
        assert(vx_get_message(&message) == 0 && message);
        BOOL success = scenario == 0 || scenario == 1 || scenario == 4 || scenario == 6 || scenario == 11;
        destroy_completion(message, request, success); assert(sdk_calls == calls + (success ? 1 : 0));
        if (scenario == 6) {
            observe_xml_event("<Event type=\"MediaStreamUpdatedEvent\"><SessionGroupHandle>test-group</SessionGroupHandle><SessionHandle>sip:confctl-g-test.group@domain</SessionHandle><StatusCode>503</StatusCode><State>1</State></Event>", 20U);
            observe_xml_event("<Event type=\"SessionRemovedEvent\"><SessionGroupHandle>test-group</SessionGroupHandle><SessionHandle>sip:confctl-g-test.group@domain</SessionHandle></Event>", 25U);
            assert(g_voice_rooms[0].media_failed && g_voice_rooms[0].removed);
            assert(WaitForSingleObject(notified, 12000U) == WAIT_OBJECT_0);
            assert(vx_get_message(&message) == 0 && message == NULL);
            assert(WaitForSingleObject(notified, 6000U) == WAIT_OBJECT_0);
            assert(vx_get_message(&message) == 0 && message == NULL);
            assert(sdk_calls == calls + 2 && g_voice_rooms[0].rejoins == 1U);
            g_voice_rooms[0].has_mute = g_voice_rooms[0].has_volume = TRUE;
            g_voice_rooms[0].speaker_mute = 1; g_voice_rooms[0].speaker_volume = 35;
            observe_xml_event("<Event type=\"SessionAddedEvent\"><SessionGroupHandle>test-group</SessionGroupHandle><SessionHandle>sip:confctl-g-test.group@domain</SessionHandle></Event>", 24U);
            assert(control_calls == 2U && !g_voice_rooms[0].restore_audio);
            ULONGLONG deadline = GetTickCount64() + 2000U;
            while (GetTickCount64() < deadline) {
                assert(vx_get_message(&message) == 0 && message == NULL);
                if (!g_voice_controls[0] && !g_voice_controls[1]) break; Sleep(1U);
            }
            assert(!g_voice_controls[0] && !g_voice_controls[1]);
            observe_xml_event("<Event type=\"MediaStreamUpdatedEvent\"><SessionGroupHandle>test-group</SessionGroupHandle><SessionHandle>sip:confctl-g-test.group@domain</SessionHandle><StatusCode>403</StatusCode><State>1</State></Event>", 20U);
            assert(g_voice_rooms[0].exhausted && !g_voice_rooms[0].media_failed);
            BYTE leave[0x40U] = {0}; write_pointer(leave, 0x30U, "sip:confctl-g-test.group@domain");
            write_pointer(leave, 0x38U, "test-group"); voice_async_retire(leave, 9U);
            assert(!g_voice_rooms[0].desired);
            observe_xml_event("<Event type=\"MediaStreamUpdatedEvent\"><SessionGroupHandle>test-group</SessionGroupHandle><SessionHandle>sip:confctl-g-test.group@domain</SessionHandle><StatusCode>503</StatusCode><State>1</State></Event>", 20U);
            voice_async_rejoin(); assert(sdk_calls == calls + 2);
        }
        if (scenario == 11) {
            assert(!strcmp(g_voice_rooms[0].handle, "sdk-room-42"));
            void *event = NULL; char *error = NULL;
            assert(parse_event("<Event type=\"SessionAddedEvent\"><SessionGroupHandle>test-group</SessionGroupHandle><SessionHandle>sdk-room-42</SessionHandle></Event>", &event, &error) == 24);
            voice_async_observe_event(event); char *uri = NULL; read_pointer(event, 0x38U, &uri);
            assert(uri && !strcmp(uri, "sip:confctl-g-test.group@domain")); assert(destroy_event(event) == 0);
            observe_xml_event("<Event type=\"MediaStreamUpdatedEvent\"><SessionGroupHandle>test-group</SessionGroupHandle><SessionHandle>sdk-room-42</SessionHandle><StatusCode>503</StatusCode><State>1</State></Event>", 20U);
            observe_xml_event("<Event type=\"SessionRemovedEvent\"><SessionGroupHandle>test-group</SessionGroupHandle><SessionHandle>sdk-room-42</SessionHandle></Event>", 25U);
            assert(WaitForSingleObject(notified, 12000U) == WAIT_OBJECT_0);
            assert(vx_get_message(&message) == 0 && message == NULL);
            assert(WaitForSingleObject(notified, 6000U) == WAIT_OBJECT_0);
            assert(vx_get_message(&message) == 0 && message == NULL);
            assert(sdk_calls == calls + 2);
        }
        assert(WaitForSingleObject(server, 1000U) == WAIT_OBJECT_0); assert(attempts == (scenario == 1 ? 3 : scenario == 6 || scenario == 11 ? 2 : scenario == 9 ? 4 : 1));
        if (scenario == 4) {
            void *duplicate = request_new(TRUE); assert(vx_issue_request3(duplicate, &count) == VOICE_ERROR); assert(g_async_destroy_request(duplicate) == 0);
        }
        assert(vx_get_message(&message) == 0 && message == NULL);
        printf("scenario=%d attempts=%d success=%u ownership/cookies/wakeup/cancellation=pass\n", scenario, attempts, success);
        CloseHandle(server); CloseHandle(received); CloseHandle(release_response); closesocket(listener);
    }
    strcpy(g_account_handle, ".a."); g_login_signature_set = TRUE;
    observe_xml_event("<Event type=\"AccountLoginStateChangeEvent\"><State>0</State><AccountHandle>.a.</AccountHandle></Event>", 2U);
    assert(g_account_handle[0] == '\0' && !g_login_signature_set);
    strcpy(g_account_handle, "next-account");
    observe_xml_event("<Event type=\"AccountLoginStateChangeEvent\"><State>0</State><AccountHandle>.a.</AccountHandle></Event>", 2U);
    assert(!strcmp(g_account_handle, "next-account"));
    const char *controls[] = {
        "vx_req_connector_mute_local_mic_create", "vx_req_connector_mute_local_speaker_create",
        "vx_req_aux_set_capture_device_create", "vx_req_aux_set_render_device_create",
        "vx_req_sessiongroup_set_tx_all_sessions_create", "vx_req_sessiongroup_set_tx_session_create",
        "vx_req_sessiongroup_set_tx_no_session_create", "vx_req_session_mute_local_speaker_create",
        "vx_req_session_set_local_speaker_volume_create"
    };
    for (unsigned pass = 0; pass < 50U; ++pass) for (unsigned i = 0; i < sizeof(controls) / sizeof(controls[0]); ++i) {
        create_fn create = LOAD(create_fn, controls[i]); assert(create && create(&passthrough_request) == 0);
        memcpy(passthrough_base, passthrough_request, sizeof(passthrough_base));
        assert(vx_issue_request3(passthrough_request, &count) == 0);
        assert(g_async_destroy_request(passthrough_request) == 0); passthrough_request = NULL;
    }
    /* Eight accepted originals, then immediate refusal; cancel and release all
     * without SDK submission. Reuse the room slots across fifty game changes. */
    for (unsigned cycle = 0; cycle < 50U; ++cycle) {
        compat_begin_login_epoch(); strcpy(g_account, ".a.");
        void *requests[VOICE_ASYNC_LIMIT];
        for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) {
            assert(session_create(&requests[i]) == 0); char channel[64];
            snprintf(channel, sizeof(channel), "sip:confctl-g-cycle%u-slot%u@domain", cycle, i);
            write_pointer(requests[i], SESSION_URI_OFFSET, g_strdup(channel));
            write_pointer(requests[i], 0x20U, g_strdup("original-cookie")); write_pointer(requests[i], 0x28U, (char *)&callback_cookie);
            assert(voice_async_enqueue(requests[i], REQUEST_SESSION, &count, 0U) == 0);
        }
        void *overflow = NULL; assert(session_create(&overflow) == 0);
        write_pointer(overflow, SESSION_URI_OFFSET, g_strdup("sip:confctl-g-overflow@domain"));
        assert(voice_async_enqueue(overflow, REQUEST_SESSION, &count, 0U) == VOICE_ERROR);
        assert(g_async_destroy_request(overflow) == 0);
        voice_async_new_login();
        for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) destroy_completion(voice_async_poll(), requests[i], FALSE);
    }
    compat_begin_login_epoch(); voice_async_reset_login_signature();
    void *pending = request_new(FALSE); assert(voice_async_enqueue(pending, REQUEST_LOGIN, &count, 0U) == 0);
    sdk_destroy_response = g_async_destroy_response; g_async_destroy_response = tracked_destroy_response;
    assert(vx_uninitialize() == 0 && destroyed_responses == 1U);
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) assert(g_async_jobs[i].phase == VOICE_EMPTY);
    CloseHandle(notified); WSACleanup(); puts("PASS async HTTP never stalls SDK entry points; retries bounded; original ownership preserved"); return 0;
}
