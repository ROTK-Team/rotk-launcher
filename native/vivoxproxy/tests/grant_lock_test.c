/* Real synchronous WinHTTP + the production issue hook, no SDK/game required.
 * EXPECT_NETWORK_LOCK=1 also runs against the unmodified source as a baseline. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#define ROTK_VIVOX_V5_COMPAT 1
#include "../vivoxsdk_x64_proxy.c"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <stdlib.h>

static SOCKET listener;
static HANDLE received, release_response, issue_done, message_done;
static BYTE request_bytes[LOGIN_REQUEST_BYTES];
static DWORD caller_thread;
static ULONGLONG issue_ms;
static int sdk_calls, scenario;
static BOOL message_suppressed;

static char *duplicate(const char *s) {
    size_t n = strlen(s) + 1U;
    char *p = malloc(n); assert(p); memcpy(p, s, n); return p;
}
static int free_string(char *s) { free(s); return 0; }
static int __cdecl issue_stub(void *request, int *count) {
    char *token = NULL;
    assert(request == request_bytes && GetCurrentThreadId() == caller_thread);
    assert(TryAcquireSRWLockExclusive(&g_voice_lock));
    ReleaseSRWLockExclusive(&g_voice_lock);
#if !defined(EXPECT_NETWORK_LOCK)
    assert(TryAcquireSRWLockExclusive(&g_grant_lock));
    ReleaseSRWLockExclusive(&g_grant_lock);
#endif
    read_pointer(request, LOGIN_TOKEN_OFFSET, &token);
    assert(strcmp(token, scenario == 0 || scenario == 4 ? "new-token" : "old-token") == 0);
    ++sdk_calls; *count = 1; return 0;
}
static BOOL CALLBACK initialized(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    (void)once; (void)parameter; (void)context; return TRUE;
}
static void send_all(SOCKET client, const void *data, size_t size) {
    const char *p = data;
    while (size) { int n = send(client, p, (int)size, 0); assert(n > 0); p += n; size -= (size_t)n; }
}
static DWORD WINAPI server_thread(void *unused) {
    (void)unused;
    SOCKET client = accept(listener, NULL, NULL); assert(client != INVALID_SOCKET);
    char input[2048]; assert(recv(client, input, sizeof(input), 0) > 0);
    SetEvent(received);
    assert(WaitForSingleObject(release_response, 4000) == WAIT_OBJECT_0);
    if (scenario == 3) {
        const char response[] = "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        send_all(client, response, sizeof(response)-1U);
    } else {
        BYTE wire[128] = {0};
        const char *account = ".a.";
        const char *channel = scenario == 1 ? "sip:wrong" : scenario == 4 ? "sip:confctl-g-test.group@domain" : "";
        const char *token = "new-token";
        uint32_t expires = unix_time_seconds() + (scenario == 2 ? 0U : 60U);
        uint16_t a = (uint16_t)strlen(account), c = (uint16_t)strlen(channel), t = (uint16_t)strlen(token);
        memcpy(wire,"RVG1",4); memcpy(wire+4,&expires,4);
        memcpy(wire+8,&a,2); memcpy(wire+10,&c,2); memcpy(wire+12,&t,2);
        memcpy(wire+16,account,a); memcpy(wire+16+a,channel,c); memcpy(wire+16+a+c,token,t);
        size_t size = 16U+a+c+t;
        char headers[200];
        int n = snprintf(headers,sizeof(headers),"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",(unsigned)size);
        assert(n > 0 && (size_t)n < sizeof(headers));
        send_all(client,headers,(size_t)n); send_all(client,wire,size);
    }
    closesocket(client); return 0;
}
static DWORD WINAPI request_thread(void *unused) {
    (void)unused;
    int count = 0;
    caller_thread = GetCurrentThreadId();
    ULONGLONG start = GetTickCount64();
    assert(vx_issue_request3(request_bytes,&count) == 0 && count == 1);
    issue_ms = GetTickCount64()-start;
    SetEvent(issue_done); return 0;
}
static DWORD WINAPI messages_thread(void *unused) {
    (void)unused;
    rotk_vx_evt_sessiongroup_added event = {0};
    event.base.message.type = VIVOX_MESSAGE_EVENT;
    event.base.type = VIVOX_EVENT_SESSIONGROUP_ADDED;
    event.sessiongroup_handle = "test-group";
    message_suppressed = compat_suppress_real_sessiongroup_added(&event);
    SetEvent(message_done); return 0;
}
int main(void) {
    WSADATA data; assert(WSAStartup(MAKEWORD(2,2),&data) == 0);
    g_original_module = GetModuleHandleW(NULL);
    g_issue_request = issue_stub; g_strdup = duplicate; g_free = free_string;
    assert(InitOnceExecuteOnce(&g_original_once,initialized,NULL,NULL));
    assert(InitOnceExecuteOnce(&g_config_once,initialized,NULL,NULL));
    g_config.valid = TRUE; g_config.secure = FALSE;
    wcscpy(g_config.host,L"127.0.0.1"); wcscpy(g_config.session_id,L"test-only");
    for (scenario=0; scenario<5; ++scenario) {
        struct sockaddr_in address = {0}; address.sin_family=AF_INET; address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
        listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP); assert(listener!=INVALID_SOCKET);
        assert(bind(listener,(struct sockaddr *)&address,sizeof(address))==0 && listen(listener,1)==0);
        int length=sizeof(address); assert(getsockname(listener,(struct sockaddr *)&address,&length)==0);
        g_config.port=ntohs(address.sin_port);
        received=CreateEventW(NULL,TRUE,FALSE,NULL); release_response=CreateEventW(NULL,TRUE,FALSE,NULL);
        issue_done=CreateEventW(NULL,TRUE,FALSE,NULL); message_done=CreateEventW(NULL,TRUE,FALSE,NULL);
        assert(received && release_response && issue_done && message_done);
        strcpy(g_account,".a."); strcpy(g_compat_sessiongroup_handle,"test-group");
        InterlockedExchange(&g_suppress_sessiongroup_added,1);
        memset(request_bytes,0,sizeof(request_bytes));
        uint32_t type=scenario==1 || scenario==4 ? REQUEST_SESSION : REQUEST_LOGIN;
        memcpy(request_bytes+REQUEST_TYPE_OFFSET,&type,sizeof(type));
        write_pointer(request_bytes,LOGIN_TOKEN_OFFSET,duplicate("old-token"));
        if(type==REQUEST_SESSION) write_pointer(request_bytes,SESSION_URI_OFFSET,duplicate("sip:confctl-g-test.group@domain"));
        HANDLE server=CreateThread(NULL,0,server_thread,NULL,0,NULL);
        HANDLE issuer=CreateThread(NULL,0,request_thread,NULL,0,NULL);
        assert(server && issuer && WaitForSingleObject(received,3000)==WAIT_OBJECT_0);
#if !defined(EXPECT_NETWORK_LOCK)
        /* Login now invalidates the previous group's suppression state. */
        AcquireSRWLockExclusive(&g_voice_lock);
        strcpy(g_compat_sessiongroup_handle,"test-group");
        InterlockedExchange(&g_suppress_sessiongroup_added,1);
        ReleaseSRWLockExclusive(&g_voice_lock);
#endif
        HANDLE messages=CreateThread(NULL,0,messages_thread,NULL,0,NULL); assert(messages);
        DWORD progress=WaitForSingleObject(message_done,300);
        assert(WaitForSingleObject(issue_done,0)==WAIT_TIMEOUT); /* issue remains synchronous */
#if defined(EXPECT_NETWORK_LOCK)
        assert(progress==WAIT_TIMEOUT);
#else
        assert(progress==WAIT_OBJECT_0 && message_suppressed);
        assert(!TryAcquireSRWLockExclusive(&g_grant_lock)); /* grants still serialized */
        Sleep(300); /* hold the same artificial network stall for the timing probe */
#endif
        SetEvent(release_response);
        HANDLE threads[]={server,issuer,messages};
        assert(WaitForMultipleObjects(3,threads,TRUE,4000)==WAIT_OBJECT_0);
        assert(message_suppressed && sdk_calls==scenario+1);
        printf("scenario=%d issue_thread=%lu issue_ms=%llu message_during_HTTP=%s SDK_same_thread=yes\n",
               scenario,(unsigned long)caller_thread,(unsigned long long)issue_ms,progress==WAIT_OBJECT_0?"yes":"no");
        char *p=NULL; read_pointer(request_bytes,LOGIN_TOKEN_OFFSET,&p); free(p);
        read_pointer(request_bytes,type==REQUEST_SESSION?SESSION_URI_OFFSET:LOGIN_ACCOUNT_OFFSET,&p); free(p);
        for(unsigned i=0;i<3;++i) CloseHandle(threads[i]);
        CloseHandle(received); CloseHandle(release_response); CloseHandle(issue_done); CloseHandle(message_done);
        closesocket(listener);
    }
    WSACleanup(); puts("PASS production hook: delayed grants, failure, expiry, channel isolation and message progress"); return 0;
}
