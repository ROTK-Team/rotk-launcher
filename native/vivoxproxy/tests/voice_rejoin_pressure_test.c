/* Real SDK allocation/destruction; deterministic queue pressure and unowned responses. */
#define WIN32_LEAN_AND_MEAN
#define ROTK_VIVOX_V5_COMPAT 1
#include "../vivoxsdk_x64_proxy.c"
#include "proxy_test_isolation.h"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
typedef int (__cdecl *create_fn)(void **);
typedef int (__cdecl *config_fn)(void *,size_t);
static BOOL CALLBACK ready(PINIT_ONCE a,PVOID b,PVOID *c) { (void)a;(void)b;(void)c;return TRUE; }
static BOOL replace_generation;
static char *__cdecl refuse_string(const char *text) {
    (void)text;
    if (replace_generation) {
        replace_generation = FALSE;
        memset(&g_voice_rooms[0],0,sizeof(voice_room)); g_voice_rooms[0].occupied = g_voice_rooms[0].desired = TRUE;
        g_voice_rooms[0].generation = 9U; g_voice_rooms[0].epoch = g_login_epoch;
    }
    return NULL;
}
int main(int argc,char **argv) {
    assert((argc == 2 || argc == 3) && isolate_proxy_test()); setvbuf(stdout,NULL,_IONBF,0);
    g_original_module = LoadLibraryA(argv[1]); assert(g_original_module);
#define LOAD(t,n) ((t)(uintptr_t)GetProcAddress(g_original_module,n))
    g_strdup = LOAD(vx_strdup_fn,"vx_strdup"); g_free = LOAD(vx_free_fn,"vx_free");
    assert(InitOnceExecuteOnce(&g_original_once,ready,NULL,NULL)); assert(InitOnceExecuteOnce(&g_config_once,ready,NULL,NULL));
    uint64_t config[512] = {0}; assert(LOAD(config_fn,"vx_get_default_config3")(config,sizeof(config)) == 0); assert(vx_initialize3(config,sizeof(config)) == 0);
    g_async_parse = LOAD(voice_parse_response_fn,"vx_xml_to_response");
    g_async_destroy_request = LOAD(voice_destroy_fn,"destroy_req"); g_async_destroy_response = LOAD(voice_destroy_fn,"destroy_resp");
    if (argc == 2 || !strcmp(argv[2],"null")) {
        void *original = NULL; assert(LOAD(create_fn,"vx_req_account_anonymous_login_create")(&original) == 0 && original);
        void *response = voice_error_response(original,REQUEST_LOGIN); assert(response);
        void *none = NULL; memcpy((char *)response + RESPONSE_REQUEST_OFFSET,&none,sizeof(none));
        assert(!voice_async_observe_response(response));
        memcpy((char *)response + RESPONSE_REQUEST_OFFSET,&original,sizeof(original)); assert(g_async_destroy_response(response) == 0);
        puts("PASS: response with no owned request remains visible to application");
    }
    if (argc == 2 || !strcmp(argv[2],"pressure")) {
        vx_strdup_fn original_strdup = g_strdup;
        for (unsigned fault = 0; fault < 3U; ++fault) {
        voice_room *room = &g_voice_rooms[0];
        memset(room,0,sizeof(*room));
        room->occupied = room->desired = room->accepted = room->media_failed = room->removed = TRUE;
        room->wake_announced = TRUE;
        room->generation = 7U; room->epoch = g_login_epoch; wcscpy(room->channel,L"sip:confctl-g-pressure@domain");
        strcpy(room->group,"pressure-group"); strcpy(room->handle,"pressure-handle"); room->connect_audio = 1;
        if (fault == 0U) for (unsigned i = 0; i < VOICE_ASYNC_LIMIT; ++i) { g_async_jobs[i].phase = VOICE_ISSUED; g_async_jobs[i].cancelled = TRUE; }
        else { g_strdup = refuse_string; replace_generation = fault == 2U; }
        voice_async_rejoin();
        if (fault == 2U) {
            assert(room->generation == 9U && room->desired && !room->accepted && !room->media_failed && !room->removed && room->rejoins == 0U);
            puts("PASS: failed old-generation recovery cannot resurrect a replacement room");
        } else {
        assert(room->desired && room->accepted && room->media_failed && room->removed && !room->exhausted);
        assert(room->rejoins == 0U && room->rejoin_after > GetTickCount64() && !room->wake_announced);
        puts(fault == 0U ? "PASS: full grant queue preserves pending media recovery and episode budget" : "PASS: allocation pressure preserves pending media recovery and episode budget");
        }
        memset(g_async_jobs,0,sizeof(g_async_jobs)); room->desired = FALSE;
        g_strdup = original_strdup;
        }
    }
    if (argc == 2 || !strcmp(argv[2],"budget")) {
        voice_room *room = &g_voice_rooms[0];
        memset(room,0,sizeof(*room));
        room->occupied = room->desired = room->accepted = TRUE; room->rejoins = VOICE_REJOIN_LIMIT;
        voice_room_media(room,1,5024,500U);
        assert(room->media_failed && room->rejoins == VOICE_REJOIN_LIMIT && room->rejoin_after == 500U + VOICE_REJOIN_SLOW_MS);
        voice_room_media(room,2,0,1000U); voice_room_media(room,1,5024,1000U + VOICE_STABLE_MS - 1U);
        assert(room->media_failed && room->rejoins == VOICE_REJOIN_LIMIT);
        voice_room_media(room,2,0,100000U); assert(!room->media_failed && !room->removed);
        voice_room_media(room,1,5024,100000U + VOICE_STABLE_MS);
        assert(room->media_failed && !room->exhausted && room->rejoins == 0U);
        assert(room->rejoin_after == 100000U + VOICE_STABLE_MS + VOICE_REJOIN_DELAY_MS);
        room->rejoins = VOICE_REJOIN_LIMIT;
        voice_room_media(room,1,5024,300000U);
        assert(room->rejoins == VOICE_REJOIN_LIMIT);
        room->desired = FALSE;
        puts("PASS: media that held a minute gives the next drop a full rejoin budget; flapping or unconnected media does not");
    }
    if (argc == 2 || !strcmp(argv[2],"slow")) {
        vx_strdup_fn original_strdup = g_strdup;
        voice_room *room = &g_voice_rooms[0];
        memset(room,0,sizeof(*room));
        room->occupied = room->desired = room->accepted = room->media_failed = room->removed = TRUE;
        room->generation = 7U; room->epoch = g_login_epoch; wcscpy(room->channel,L"sip:confctl-g-slow@domain");
        strcpy(room->group,"slow-group"); room->connect_audio = 1; room->rejoins = VOICE_REJOIN_LIMIT;
        g_strdup = refuse_string; voice_async_rejoin(); g_strdup = original_strdup;
        assert(room->media_failed && room->removed && room->rejoins == VOICE_REJOIN_LIMIT);
        assert(room->rejoin_after + 1000U >= GetTickCount64() + VOICE_REJOIN_SLOW_MS);
        room->rejoins = VOICE_REJOIN_MAX; room->rejoin_after = 0U;
        g_strdup = refuse_string; voice_async_rejoin(); g_strdup = original_strdup;
        assert(room->rejoins == VOICE_REJOIN_MAX && room->rejoin_after == 0U);
        memset(g_async_jobs,0,sizeof(g_async_jobs)); room->desired = FALSE;
        puts("PASS: a drop that used its quick rejoins keeps trying once a minute, ten minutes at most");
    }
    assert(vx_uninitialize() == 0); return 0;
}
