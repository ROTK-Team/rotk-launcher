/* Real proxy polling and queue ownership, with a controllable SDK producer. */
#define ROTK_VIVOX_V5_COMPAT 1
#include "../vivoxsdk_x64_proxy.c"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>

static unsigned polls, real_deliveries;
static BOOL real_ready;
static rotk_vx_evt_base real_event;
static BOOL CALLBACK initialized(PINIT_ONCE once, PVOID p, PVOID *ctx) {
    (void)once; (void)p; (void)ctx; return TRUE;
}
static int __cdecl sdk_poll(void **message) {
    ++polls;
    *message = real_ready ? &real_event : NULL;
    if (real_ready) ++real_deliveries;
    return 0;
}
static int __cdecl sdk_destroy(void *event) { assert(event == &real_event); return 0; }
static void update(BOOL speaking) {
    hud_speaker speaker = {0};
    strcpy(speaker.participant_uri, "sip:test@example.invalid");
    hud_synthetic_event *node = hud_build_participant_updated_locked(&speaker, speaking);
    assert(node != NULL && hud_queue_event_locked(node));
}
int main(void) {
    g_original_module = GetModuleHandleW(NULL);
    g_get_message = sdk_poll;
    g_destroy_evt = sdk_destroy;
    assert(InitOnceExecuteOnce(&g_original_once, initialized, NULL, NULL));
    g_hud_next_connect_ms = ~(ULONGLONG)0;
    strcpy(g_hud_session_handle, "current");
    strcpy(g_hud_sessiongroup_handle, "group");
    real_event.message.type = VIVOX_MESSAGE_EVENT;
    real_event.type = 0x7fff;

    for (unsigned i = 0; i < 1000; ++i) update((i & 1U) == 0);
    assert(g_hud_pending_count == 1);
    assert(g_hud_pending_head->event.participant_updated.is_speaking == 0);
    hud_clear_pending_locked();

    for (unsigned phase = 0; phase < 2; ++phase) {
        real_ready = phase != 0;
        polls = real_deliveries = 0;
        g_hud_prefer_sdk = FALSE;
        for (unsigned i = 0; i < 1000; ++i) {
            void *message = NULL;
            update(TRUE);
            assert(vx_get_message(&message) == 0 && message != NULL);
            assert(destroy_evt(message) == 0);
            assert(g_hud_pending_count <= 1 && g_hud_inflight == NULL);
        }
        assert(polls >= 500);
        if (real_ready) assert(real_deliveries == 500);
        hud_clear_pending_locked();
    }
    puts("PASS: continuous HUD traffic cannot starve SDK replies; updates coalesce and ownership survives 2000 polls");
    return 0;
}
