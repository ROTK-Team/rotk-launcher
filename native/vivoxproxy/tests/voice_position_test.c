#define ROTK_VIVOX_V5_COMPAT 1
#include "../vivoxsdk_x64_proxy.c"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <stdlib.h>
#include "proxy_test_isolation.h"

static int original_result;
static unsigned original_calls;
static void *last_request;
static int issue_fixture(void *request, int *count) {
    ++original_calls;
    last_request = request;
    *count = 1;
    return original_result;
}
static char *duplicate_fixture(const char *value) { (void)value; return NULL; }
static int free_fixture(char *value) { (void)value; return 0; }
static BOOL CALLBACK initialize_fixture(PINIT_ONCE once, PVOID param, PVOID *context) {
    (void)once; (void)param; (void)context;
    g_original_module = (HMODULE)(uintptr_t)1;
    g_issue_request = issue_fixture;
    g_strdup = duplicate_fixture;
    g_free = free_fixture;
    return TRUE;
}
static uint32_t read32(const void *request, size_t offset) {
    uint32_t value;
    memcpy(&value, (const uint8_t *)request + offset, sizeof(value));
    return value;
}
static void write32(void *request, size_t offset, uint32_t value) {
    memcpy((uint8_t *)request + offset, &value, sizeof(value));
}
static void unit_tests(void) {
    uint8_t request[POSITION_REQUEST_BYTES], expected[POSITION_REQUEST_BYTES];
    int count = 0;
    assert(InitOnceExecuteOnce(&g_original_once, initialize_fixture, NULL, NULL));
    memset(request, 0x5a, sizeof(request));
    write32(request, REQUEST_TYPE_OFFSET, REQUEST_SESSION_SET_3D_POSITION);
    memcpy(expected, request, sizeof(request));
    write32(expected, POSITION_DISPOSITION_OFFSET, POSITION_NO_REPLY_REQUIRED);
    assert(vx_issue_request3(request, &count) == 0);
    assert(original_calls == 1 && last_request == request && count == 1);
    assert(!memcmp(request, expected, sizeof(request)));
    original_result = 7;
    assert(vx_issue_request3(request, &count) == 7);
    assert(!memcmp(request, expected, sizeof(request)));
    original_result = 0;
    write32(request, REQUEST_TYPE_OFFSET, 0x1fU);
    write32(request, POSITION_DISPOSITION_OFFSET, 0U);
    memcpy(expected, request, sizeof(request));
    assert(vx_issue_request3(request, &count) == 0);
    assert(!memcmp(request, expected, sizeof(request)));
    SYSTEM_INFO system; GetSystemInfo(&system);
    uint8_t *pages = VirtualAlloc(NULL, system.dwPageSize * 2U,
                                 MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(pages);
    DWORD previous;
    assert(VirtualProtect(pages + system.dwPageSize, system.dwPageSize,
                          PAGE_NOACCESS, &previous));
    uint8_t *short_request = pages + system.dwPageSize - 0x30U;
    write32(short_request, REQUEST_TYPE_OFFSET, REQUEST_SESSION_SET_3D_POSITION);
    assert(vx_issue_request3(short_request, &count) == 0);
    assert(last_request == short_request);
    write32(pages, REQUEST_TYPE_OFFSET, REQUEST_SESSION_SET_3D_POSITION);
    assert(VirtualProtect(pages, system.dwPageSize, PAGE_READONLY, &previous));
    assert(vx_issue_request3(pages, &count) == 0);
    assert(read32(pages, POSITION_DISPOSITION_OFFSET) == 0U);
    assert(VirtualFree(pages, 0, MEM_RELEASE));
    unsigned calls = original_calls;
    assert(vx_issue_request3(NULL, &count) == VOICE_ERROR);
    assert(vx_issue_request3(request, NULL) == VOICE_ERROR);
    assert(original_calls == calls);
    puts("PASS: only disposition changes; positions/cookies preserved; bounded writable memory; original errors and other request types preserved.");
}

typedef int (__cdecl *config_fn)(void *, size_t);
typedef int (__cdecl *create_fn)(void **);
typedef int (__cdecl *xml_fn)(void *, char **);
#define LOAD(module, type, name) ((type)(uintptr_t)GetProcAddress(module, name))
static void sdk_test(const char *path, const char *proxy_path) {
    HMODULE sdk = LoadLibraryA(path);
    assert(sdk);
    config_fn defaults = LOAD(sdk, config_fn, "vx_get_default_config3");
    config_fn initialize = LOAD(sdk, config_fn, "vx_initialize3");
    create_fn create = LOAD(sdk, create_fn, "vx_req_session_set_3d_position_create");
    create_fn get = LOAD(sdk, create_fn, "vx_get_message");
    xml_fn xml = LOAD(sdk, xml_fn, "vx_request_to_xml");
    typedef int (__cdecl *destroy_fn)(void *);
    destroy_fn destroy = LOAD(sdk, destroy_fn, "destroy_resp");
    destroy_fn destroy_event = LOAD(sdk, destroy_fn, "destroy_evt");
    typedef int (__cdecl *shutdown_fn)(void);
    shutdown_fn shutdown = LOAD(sdk, shutdown_fn, "vx_uninitialize");
    g_original_module = sdk;
    g_issue_request = LOAD(sdk, vx_issue_request3_fn, "vx_issue_request3");
    g_free = LOAD(sdk, vx_free_fn, "vx_free");
    vx_issue_request3_fn issue = vx_issue_request3;
    if (proxy_path) {
        HMODULE proxy = LoadLibraryA(proxy_path);
        assert(proxy);
        issue = LOAD(proxy, vx_issue_request3_fn, "vx_issue_request3");
        assert(issue);
    }
    assert(defaults && initialize && create && get && xml && destroy && destroy_event && shutdown && g_issue_request && g_free);
    uint64_t config[512] = {0};
    assert(defaults(config, sizeof(config)) == 0);
    assert(initialize(config, sizeof(config)) == 0);
    for (unsigned pass = 0; pass < 2; ++pass) {
        void *request = NULL; int count = 0;
        assert(create(&request) == 0);
        assert(read32(request, REQUEST_TYPE_OFFSET) == REQUEST_SESSION_SET_3D_POSITION);
        assert(read32(request, POSITION_DISPOSITION_OFFSET) == 0U);
        char *before = NULL, *after = NULL;
        assert(xml(request, &before) == 0 && before);
        write32(request, POSITION_DISPOSITION_OFFSET, 1U);
        assert(xml(request, &after) == 0 && after);
        /* This SDK flag is local; the position payload stays identical. */
        assert(!strcmp(before, after));
        assert(g_free(before) == 0 && g_free(after) == 0);
        write32(request, POSITION_DISPOSITION_OFFSET, 0U);
        /* No login/channel: a real SDK error must survive the no-reply flag. */
        assert(issue(request, &count) == 0);
        ULONGLONG deadline = GetTickCount64() + 5000U;
        BOOL received = FALSE;
        while (GetTickCount64() < deadline) {
            void *message = NULL; (void)get(&message);
            if (!message) { Sleep(1); continue; }
            if (read32(message, 0) == VIVOX_MESSAGE_EVENT) {
                assert(destroy_event(message) == 0); continue;
            }
            assert(read32(message, 0) == VIVOX_MESSAGE_RESPONSE);
            assert(read32(message, REQUEST_TYPE_OFFSET) == REQUEST_SESSION_SET_3D_POSITION);
            assert(read32(message, RESPONSE_RETURN_CODE_OFFSET) != 0U);
            assert(read32(message, RESPONSE_STATUS_CODE_OFFSET) != 0U);
            void *actual = NULL; memcpy(&actual, (uint8_t *)message + RESPONSE_REQUEST_OFFSET, sizeof(actual));
            assert(actual == request && read32(actual, POSITION_DISPOSITION_OFFSET) == 1U);
            assert(destroy(message) == 0);
            received = TRUE; break;
        }
        assert(received);
    }
    assert(shutdown() == 0);
    puts("PASS: real bundled SDK confirms disposition ABI and still returns position errors; response/request disposal succeeds.");
}
int main(int argc, char **argv) {
    if (!isolate_proxy_test()) return 1;
    setvbuf(stdout, NULL, _IONBF, 0);
    assert(argc == 2 || argc == 3);
    unit_tests();
    sdk_test(argv[1], argc == 3 ? argv[2] : NULL);
    return 0;
}
