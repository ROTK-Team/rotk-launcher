#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include "../voice_volume_compat.h"
#include "proxy_test_isolation.h"

typedef int (__cdecl *create_fn)(void **);
typedef int (__cdecl *config_fn)(void *, size_t);
typedef int (__cdecl *issue_fn)(void *, int *);
typedef int (__cdecl *destroy_fn)(void *);
typedef char *(__cdecl *duplicate_fn)(const char *);
typedef int (__cdecl *uninitialize_fn)(void);
static LONG CALLBACK trace_exception(EXCEPTION_POINTERS *exception) {
    if (exception->ExceptionRecord->ExceptionCode == EXCEPTION_ACCESS_VIOLATION) {
        HMODULE module = NULL; char path[MAX_PATH] = {0};
        GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            (const char *)exception->ExceptionRecord->ExceptionAddress, &module);
        GetModuleFileNameA(module, path, sizeof(path));
        fprintf(stderr, "Access violation in %s + %llx, address %llx\n", path,
            (unsigned long long)((uintptr_t)exception->ExceptionRecord->ExceptionAddress - (uintptr_t)module),
            (unsigned long long)exception->ExceptionRecord->ExceptionInformation[1]);
        void *frames[24]; USHORT count = CaptureStackBackTrace(0, 24, frames, NULL);
        for (USHORT i = 0; i < count; ++i) {
            module = NULL;
            GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (const char *)frames[i], &module);
            GetModuleFileNameA(module, path, sizeof(path));
            fprintf(stderr, "%s + %llx\n", path, (unsigned long long)((uintptr_t)frames[i] - (uintptr_t)module));
        }
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

static uint32_t read32(const void *data, size_t offset) {
    uint32_t value; memcpy(&value, (const unsigned char *)data + offset, 4); return value;
}
static void write32(void *data, size_t offset, uint32_t value) {
    memcpy((unsigned char *)data + offset, &value, 4);
}
static unsigned released;
static int create_fixture(void **request) {
    *request = calloc(1, 0x40);
    write32(*request, 0x18, ROTK_VOLUME_SPEAKER_AUX);
    return 0;
}
static int destroy_fixture(void *request) { ++released; free(request); return 0; }
static char *duplicate_fixture(const char *cookie) { (void)cookie; return NULL; }
static void unit_tests(void) {
    rotk_volume_table table = {0};
    void *originals[ROTK_VOLUME_PENDING_LIMIT + 1];
    void *replacements[ROTK_VOLUME_PENDING_LIMIT];
    unsigned char response[0x40] = {0};
    for (unsigned i = 0; i <= ROTK_VOLUME_PENDING_LIMIT; ++i) {
        originals[i] = calloc(1, 0x40);
        write32(originals[i], 0x18, ROTK_VOLUME_SPEAKER_LEGACY);
        write32(originals[i], 0x38, 65);
    }
    for (unsigned i = 0; i < ROTK_VOLUME_PENDING_LIMIT; ++i) {
        replacements[i] = rotk_volume_prepare(&table, originals[i], create_fixture, destroy_fixture, duplicate_fixture);
        assert(replacements[i]);
        assert(read32(replacements[i], 0x30) == 65);
        assert(read32(originals[i], 0x18) == ROTK_VOLUME_SPEAKER_LEGACY);
    }
    assert(!rotk_volume_prepare(&table, originals[ROTK_VOLUME_PENDING_LIMIT], create_fixture, destroy_fixture, duplicate_fixture));
    assert(!rotk_volume_prepare(&table, originals[0], create_fixture, destroy_fixture, duplicate_fixture));
    write32(response, 0, 2);
    write32(response, 0x18, ROTK_VOLUME_SPEAKER_AUX);
    write32(response, 0x1c, 1);
    write32(response, 0x20, 1001);
    memcpy(response + 0x30, &replacements[0], sizeof(void *));
    rotk_volume_restore_response(&table, response, destroy_fixture);
    void *response_request; memcpy(&response_request, response + 0x30, sizeof(void *));
    assert(response_request == originals[0]);
    assert(read32(response, 0x18) == ROTK_VOLUME_SPEAKER_LEGACY);
    assert(read32(response, 0x1c) == 1 && read32(response, 0x20) == 1001);
    rotk_volume_cancel(&table, replacements[1], destroy_fixture);
    assert(read32(originals[1], 0x38) == 65);
    rotk_volume_clear(&table, destroy_fixture);
    assert(released == ROTK_VOLUME_PENDING_LIMIT);
    for (unsigned i = 0; i < ROTK_VOLUME_PENDING_LIMIT; ++i) assert(!table.entries[i].original);
    free(originals[0]); free(originals[1]); free(originals[ROTK_VOLUME_PENDING_LIMIT]);
    for (unsigned i = 2; i < ROTK_VOLUME_PENDING_LIMIT; ++i) free(replacements[i]);
    puts("PASS: bounded request tracking, original ownership, error preservation and cleanup.");
}

static void *wait_response(create_fn get, destroy_fn event_destroy, void *request) {
    ULONGLONG deadline = GetTickCount64() + 5000;
    while (GetTickCount64() < deadline) {
        void *message = NULL;
        (void)get(&message);
        if (!message) { Sleep(1); continue; }
        if (read32(message, 0) == 3) { event_destroy(message); continue; }
        assert(read32(message, 0) == 2);
        void *actual; memcpy(&actual, (unsigned char *)message + 0x30, sizeof(actual));
        assert(actual == request);
        return message;
    }
    assert(!"Vivox response timed out"); return NULL;
}

int main(int argc, char **argv) {
    if (!isolate_proxy_test()) return 1;
    setvbuf(stdout, NULL, _IONBF, 0);
    AddVectoredExceptionHandler(1, trace_exception);
    puts("Testing volume request tracking");
    unit_tests();
    assert(argc == 3);
    HMODULE sdk = LoadLibraryA(argv[1]);
    HMODULE proxy = LoadLibraryA(argv[2]);
    assert(sdk && proxy);
    puts("Loaded SDK and proxy");
#define LOAD(module, type, name) ((type)(uintptr_t)GetProcAddress(module, name))
    config_fn defaults = LOAD(sdk, config_fn, "vx_get_default_config3");
    config_fn initialize = LOAD(proxy, config_fn, "vx_initialize3");
    issue_fn issue = LOAD(proxy, issue_fn, "vx_issue_request3");
    create_fn get = LOAD(proxy, create_fn, "vx_get_message");
    destroy_fn destroy = LOAD(proxy, destroy_fn, "destroy_resp");
    destroy_fn destroy_event = LOAD(proxy, destroy_fn, "destroy_evt");
    duplicate_fn duplicate = LOAD(sdk, duplicate_fn, "vx_strdup");
    uninitialize_fn uninitialize = LOAD(proxy, uninitialize_fn, "vx_uninitialize");
    assert(defaults && initialize && issue && get && destroy && destroy_event && duplicate && uninitialize);
    /* The versioned configuration API accepts a larger zero-initialized buffer. */
    uint64_t config[512] = {0};
    assert(defaults(config, sizeof(config)) == 0);
    assert(initialize(config, sizeof(config)) == 0);
    puts("Initialized SDK");
    const char *setters[] = {"vx_req_connector_set_local_speaker_volume_create", "vx_req_connector_set_local_mic_volume_create"};
    const char *getters[] = {"vx_req_aux_get_speaker_level_create", "vx_req_aux_get_mic_level_create"};
    const uint32_t legacy_types[] = {ROTK_VOLUME_SPEAKER_LEGACY, ROTK_VOLUME_MIC_LEGACY};
    const uint32_t levels[] = {0, 25, 50, 65, 100};
    for (unsigned pass = 0; pass < 50; ++pass) {
        for (unsigned channel = 0; channel < 2; ++channel) {
            create_fn create = LOAD(proxy, create_fn, setters[channel]);
            create_fn query = LOAD(sdk, create_fn, getters[channel]);
            assert(create && query);
            void *request = NULL; assert(create(&request) == 0);
            assert(read32(request, 0x18) == legacy_types[channel]);
            char *handle = duplicate("fixture-connector");
            char *cookie = duplicate("volume-cookie");
            void *vcookie = &config;
            memcpy((unsigned char *)request + 0x20, &cookie, sizeof(cookie));
            memcpy((unsigned char *)request + 0x28, &vcookie, sizeof(vcookie));
            memcpy((unsigned char *)request + 0x30, &handle, sizeof(handle));
            uint32_t level = levels[pass % 5];
            write32(request, 0x38, level);
            unsigned char original[0x40]; memcpy(original, request, sizeof(original));
            int count = 0; assert(issue(request, &count) == 0);
            if (pass == 0) printf("Issued volume channel %u\n", channel);
            void *response = wait_response(get, destroy_event, request);
            if (pass == 0) printf("Received volume channel %u\n", channel);
            assert(read32(response, 0x18) == legacy_types[channel]);
            assert(read32(response, 0x1c) == 0 && read32(response, 0x20) == 0);
            assert(!memcmp(original, request, sizeof(original)));
            assert(destroy(response) == 0);
            if (pass == 0) printf("Disposed volume channel %u\n", channel);
            assert(query(&request) == 0);
            uint32_t query_type = read32(request, 0x18);
            assert(issue(request, &count) == 0);
            response = wait_response(get, destroy_event, request);
            assert(read32(response, 0x18) == query_type);
            assert(read32(response, 0x1c) == 0 && read32(response, 0x20) == 0);
            assert(read32(response, 0x40) == level);
            assert(destroy(response) == 0);
        }
    }
    /* Close with a response still pending, then start again: neither side may
     * free the other's request, or retain a stale mapping after shutdown. */
    for (unsigned cycle = 0; cycle < 3; ++cycle) {
        create_fn create = LOAD(proxy, create_fn, setters[0]);
        void *request = NULL; int count = 0;
        assert(create(&request) == 0);
        char *handle = duplicate("pending-connector");
        memcpy((unsigned char *)request + 0x30, &handle, sizeof(handle));
        write32(request, 0x38, 50);
        assert(issue(request, &count) == 0);
        assert(uninitialize() == 0);
        if (cycle < 2) assert(initialize(config, sizeof(config)) == 0);
    }
    puts("PASS: real Vivox DLL applies 0/25/50/65/100 to voice output and microphone across 50 cycles; legacy responses and request ownership survive SDK disposal.");
    return 0;
}
