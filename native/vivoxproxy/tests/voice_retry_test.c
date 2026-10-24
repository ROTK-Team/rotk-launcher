/* Regression: real SDK allocation + WinHTTP; no external network or game installation. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#define ROTK_VIVOX_V5_COMPAT 1
#include "../vivoxsdk_x64_proxy.c"
#include "proxy_test_isolation.h"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
typedef int (__cdecl *create_fn)(void **);
typedef int (__cdecl *config_fn)(void *, size_t);
static SOCKET listener;
static unsigned failures, failure_status, http_requests, sdk_requests;
static BOOL joining;
static unsigned test_case;
static BOOL CALLBACK ready(PINIT_ONCE a, PVOID b, PVOID *c) { (void)a; (void)b; (void)c; return TRUE; }
static int __cdecl issue(void *request, int *count) {
    char *token = NULL; read_pointer(request, joining ? SESSION_TOKEN_OFFSET : LOGIN_TOKEN_OFFSET, &token);
    assert(token && !strcmp(token, "fresh-token")); ++sdk_requests;
    if (test_case == 11U && sdk_requests == 1U) return 5024;
    *count = 1; return 0;
}
static void send_all(SOCKET client, const void *data, size_t bytes) {
    const char *p = data;
    while (bytes) { int n = send(client, p, (int)bytes, 0); assert(n > 0); p += n; bytes -= (size_t)n; }
}
static DWORD WINAPI serve(void *unused) {
    (void)unused;
    unsigned expected = test_case == 14U ? 1U : test_case == 8U || test_case == 10U || test_case == 11U || test_case == 12U || test_case == 13U ? 2U : failure_status == 403U || test_case == 7U || test_case == 9U || test_case == 16U ? 1U : failures + 1U;
    for (unsigned i = 0; i < expected; ++i) {
        SOCKET client = accept(listener, NULL, NULL); assert(client != INVALID_SOCKET);
        char input[2048]; assert(recv(client, input, sizeof(input), 0) > 0); ++http_requests;
        if (i < failures && (test_case == 6U || test_case == 7U || test_case == 16U)) {
            const char *response = test_case == 6U ?
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 256\r\nConnection: close\r\n\r\nRVG1" :
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\nConnection: close\r\n\r\nFAIL";
            send_all(client, response, strlen(response));
        } else if (i < failures) {
            char response[256]; int n = snprintf(response, sizeof(response),
                "HTTP/1.1 %u Test\r\n%sContent-Length: 0\r\nConnection: close\r\n\r\n",
                failure_status, failure_status == 503U ? "Retry-After: 60\r\n" : "");
            assert(n > 0); send_all(client, response, (size_t)n);
        } else {
            const char *account = ".audit.", *channel = joining ? "sip:confctl-g-audit@domain" : "", *token = "fresh-token";
            BYTE wire[256] = {0}; uint32_t expires = unix_time_seconds() + 60U;
            uint16_t a = (uint16_t)strlen(account), c = (uint16_t)strlen(channel), t = (uint16_t)strlen(token);
            memcpy(wire, "RVG1", 4U); memcpy(wire + 4U, &expires, 4U);
            memcpy(wire + 8U, &a, 2U); memcpy(wire + 10U, &c, 2U); memcpy(wire + 12U, &t, 2U);
            memcpy(wire + 16U, account, a); memcpy(wire + 16U + a, channel, c); memcpy(wire + 16U + a + c, token, t);
            size_t bytes = 16U + a + c + t; char response[256]; int n = snprintf(response, sizeof(response),
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %u\r\nConnection: close\r\n\r\n", (unsigned)bytes);
            assert(n > 0); send_all(client, response, (size_t)n); send_all(client, wire, bytes);
        }
        closesocket(client);
    }
    return 0;
}
static void *request(create_fn create) {
    void *r = NULL; assert(create(&r) == 0 && r);
    write_pointer(r, joining ? SESSION_TOKEN_OFFSET : LOGIN_TOKEN_OFFSET, g_strdup("original-token"));
    if (joining) write_pointer(r, SESSION_URI_OFFSET, g_strdup("sip:confctl-g-audit@domain"));
    return r;
}
static BOOL completion_ready(void) {
    AcquireSRWLockShared(&g_async_lock); BOOL result = FALSE;
    for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) result |= g_async_jobs[i].phase == VOICE_READY;
    ReleaseSRWLockShared(&g_async_lock); return result;
}
static void wait_ready(void) {
    ULONGLONG until = GetTickCount64() + 25000U;
    while (!completion_ready() && GetTickCount64() < until) Sleep(10U);
    assert(completion_ready());
}
static void sdk_complete(void *original, int32_t status) {
    void *response = voice_error_response(original, joining ? REQUEST_SESSION : REQUEST_LOGIN); assert(response);
    int32_t code = status != 0; memcpy((char *)response + RESPONSE_RETURN_CODE_OFFSET, &code, 4U);
    memcpy((char *)response + RESPONSE_STATUS_CODE_OFFSET, &status, 4U);
    assert(!voice_async_observe_response(response)); assert(g_async_destroy_response(response) == 0);
}
static void success(void *original) {
    assert(voice_async_poll() == NULL && sdk_requests == 1U); sdk_complete(original, 0);
}
int main(int argc, char **argv) {
    assert((argc == 2 || argc == 3) && isolate_proxy_test()); setvbuf(stdout, NULL, _IONBF, 0);
    WSADATA ws; assert(WSAStartup(MAKEWORD(2, 2), &ws) == 0);
    g_original_module = LoadLibraryA(argv[1]); assert(g_original_module);
#define LOAD(t,n) ((t)(uintptr_t)GetProcAddress(g_original_module,n))
    g_strdup = LOAD(vx_strdup_fn, "vx_strdup"); g_free = LOAD(vx_free_fn, "vx_free"); g_issue_request = issue;
    assert(InitOnceExecuteOnce(&g_original_once, ready, NULL, NULL));
    assert(InitOnceExecuteOnce(&g_config_once, ready, NULL, NULL));
    uint64_t config[512] = {0}; assert(LOAD(config_fn, "vx_get_default_config3")(config, sizeof(config)) == 0);
    assert(vx_initialize3(config, sizeof(config)) == 0);
    g_config.valid = TRUE; wcscpy(g_config.host, L"127.0.0.1"); wcscpy(g_config.session_id, L"audit-only");
    for (unsigned mode = 0; mode < 2U; ++mode) for (unsigned test = 0; test < 18U; ++test) {
        if (argc == 3 && test != (unsigned)atoi(argv[2])) continue;
        static const unsigned statuses[] = {409U, 503U, 403U, 500U, 502U, 504U, 200U, 200U, 200U, 200U, 200U, 200U, 200U, 200U, 200U,403U,200U,200U};
        test_case = test; joining = mode != 0; failures = test == 17U ? 0U : test >= 15U ? 1U : test >= 8U ? 0U : test == 0 ? 4U : 1U; failure_status = statuses[test];
        http_requests = sdk_requests = 0; compat_begin_login_epoch(); voice_async_reset_login_signature(); strcpy(g_account, ".audit.");
        struct sockaddr_in address = {0}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); assert(listener != INVALID_SOCKET);
        assert(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0 && listen(listener, 8) == 0);
        int bytes = sizeof(address); assert(getsockname(listener, (struct sockaddr *)&address, &bytes) == 0); g_config.port = ntohs(address.sin_port);
        HANDLE server = CreateThread(NULL, 0U, serve, NULL, 0U, NULL); assert(server);
        create_fn create = LOAD(create_fn, joining ? "vx_req_session_create_create" : "vx_req_account_anonymous_login_create");
        if (test == 14U) {
            voice_async_stop();
            g_async_parse = LOAD(voice_parse_response_fn,"vx_xml_to_response");
            g_async_destroy_request = LOAD(voice_destroy_fn,"destroy_req"); g_async_destroy_response = LOAD(voice_destroy_fn,"destroy_resp");
            g_async_wake = CreateEventW(NULL,FALSE,FALSE,NULL); assert(g_async_wake); g_async_stop = FALSE;
            g_async_worker = CreateThread(NULL,0U,voice_network_worker,NULL,CREATE_SUSPENDED,&g_async_worker_id); assert(g_async_worker);
        }
        void *original = request(create); int count = 0; assert(vx_issue_request3(original, &count) == 0);
        if (test == 14U) {
            AcquireSRWLockExclusive(&g_async_lock);
            for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) if (g_async_jobs[i].request == original) g_async_jobs[i].until = 1U;
            ReleaseSRWLockExclusive(&g_async_lock); assert(ResumeThread(g_async_worker) == 1U);
        }
        void *duplicate = request(create); assert(vx_issue_request3(duplicate, &count) == VOICE_ERROR); assert(LOAD(voice_destroy_fn, "destroy_req")(duplicate) == 0);
        if (joining && test == 0U) {
            void *other = NULL; assert(LOAD(create_fn,"vx_req_sessiongroup_add_session_create")(&other) == 0 && other);
            write_pointer(other,SESSIONGROUP_TOKEN_OFFSET,g_strdup("original-token")); write_pointer(other,SESSIONGROUP_URI_OFFSET,g_strdup("sip:confctl-g-audit@domain"));
            assert(vx_issue_request3(other,&count) == VOICE_ERROR); assert(LOAD(voice_destroy_fn,"destroy_req")(other) == 0);
        }
        wait_ready();
        if (test == 12U || test == 13U || test >= 15U) {
            AcquireSRWLockExclusive(&g_async_lock);
            for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) if (g_async_jobs[i].request == original) {
                /* 13: the grant's time ran out while its expiry still lies ahead on the
                 * wall clock (PC clock stepped back). 17: the wall clock stepped past
                 * the expiry while the grant still has time (stepped forward). */
                if (test == 13U) g_async_jobs[i].grant.deadline = GetTickCount64() - 1U;
                else if (test == 17U) g_async_jobs[i].grant.expires = unix_time_seconds() - 1U;
                else g_async_jobs[i].until = 1U;
            }
            ReleaseSRWLockExclusive(&g_async_lock);
        }
        if (test >= 8U && test != 17U) {
            if (test >= 11U) {
                void *failure = voice_async_poll(); assert(failure && sdk_requests == (test == 11U ? 1U : 0U)); assert(g_async_destroy_response(failure) == 0);
            } else { assert(voice_async_poll() == NULL && sdk_requests == 1U); sdk_complete(original,test == 8U ? 5024 : test == 10U ? 20127 : 20122); }
            void *retry = request(create); assert(vx_issue_request3(retry,&count) == VOICE_ERROR);
            if (test != 9U && test < 15U) {
                AcquireSRWLockExclusive(&g_async_lock);
                if (joining) { assert(!g_voice_rooms[0].accepted && !g_voice_rooms[0].exhausted); assert(g_voice_rooms[0].retry_after > GetTickCount64()); g_voice_rooms[0].retry_after = 1U; }
                else { assert(g_login_retry_after > GetTickCount64()); g_login_retry_after = 1U; }
                ReleaseSRWLockExclusive(&g_async_lock);
                assert(vx_issue_request3(retry,&count) == 0); wait_ready(); assert(voice_async_poll() == NULL && sdk_requests == (test >= 12U ? 1U : 2U)); sdk_complete(retry,0);
                assert(http_requests == (test == 14U ? 1U : 2U));
            } else {
                assert(joining ? g_voice_rooms[0].exhausted : g_login_retry_after == 0U);
                assert(g_async_destroy_request(retry) == 0 && http_requests == 1U);
            }
        }
        else if (test == 0 || (test >= 3U && test <= 6U) || test == 17U) { assert(http_requests == failures + 1U); success(original); }
        else {
            void *failure = voice_async_poll(); assert(failure && sdk_requests == 0U); assert(g_async_destroy_response(failure) == 0);
            void *retry = request(create); assert(vx_issue_request3(retry, &count) == VOICE_ERROR);
            if (test == 1) {
                AcquireSRWLockExclusive(&g_async_lock);
                if (joining) { assert(!g_voice_rooms[0].exhausted && g_voice_rooms[0].retry_after > GetTickCount64() + 59000U); g_voice_rooms[0].retry_after = 1U; }
                else { assert(g_login_retry_after > GetTickCount64() + 59000U); g_login_retry_after = 1U; }
                ReleaseSRWLockExclusive(&g_async_lock);
                assert(vx_issue_request3(retry, &count) == 0); wait_ready(); success(retry); assert(http_requests == 2U);
            } else {
                assert(joining ? g_voice_rooms[0].exhausted : g_login_retry_after == 0U);
                assert(g_async_destroy_request(retry) == 0 && http_requests == 1U);
            }
        }
        assert(WaitForSingleObject(server, 1000U) == WAIT_OBJECT_0); CloseHandle(server); closesocket(listener);
        printf("PASS %s: %s; requests=%u SDK=%u ownership preserved\n", joining ? "join" : "login",
            test == 0 ? "four quick 409s then recovery" : test == 1 ? "transient failure, cooldown, same-context retry" :
            test == 2 ? "403 stays blocked" : test == 6 ? "truncated HTTP 200 recovers" : test == 7 ? "malformed HTTP 200 stays blocked" :
            test == 8 ? "SDK network failure permits cooldown retry" : test == 9 ? "SDK invalid signature stays blocked" :
            test == 10 ? "SDK VAT unavailable permits fresh-grant cooldown retry" : test == 11 ? "immediate SDK network refusal permits cooldown retry" :
            test == 12 ? "ready completion deadline permits fresh retry" : test == 13 ? "grant time runs out before SDK poll while the wall clock says valid; fresh retry" : test == 14 ? "queued deadline expires before first fetch; fresh retry" :
            test == 15 ? "expired ready 403 remains blocked" : test == 16 ? "expired malformed grant remains blocked" :
            test == 17U ? "wall clock steps past expiry before SDK poll; grant still used" : "transient 5xx recovers", http_requests, sdk_requests);
    }
    assert(vx_uninitialize() == 0); WSACleanup(); return 0;
}
