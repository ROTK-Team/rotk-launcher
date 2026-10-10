#define ROTK_VIVOX_V5_COMPAT 1
#include "../vivoxsdk_x64_proxy.c"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
static void group(unsigned char *response, unsigned char *request, char *account, char *handle) {
    memset(request, 0, 0x60); memset(response, 0, 0x48);
    uint32_t type = REQUEST_SESSIONGROUP_CREATE;
    memcpy(request + REQUEST_TYPE_OFFSET, &type, sizeof(type));
    write_pointer(request, SESSIONGROUP_CREATE_ACCOUNT_OFFSET, account);
    write_pointer(response, RESPONSE_REQUEST_OFFSET, (char *)request);
    write_pointer(response, RESPONSE_SESSIONGROUP_HANDLE_OFFSET, handle);
    assert(compat_track_group(request));
}
int main(void) {
    for (unsigned cycle = 0; cycle < 50; ++cycle) {
        unsigned char old_request[0x60], current_request[0x60];
        unsigned char old_response[0x48], current_response[0x48];
        compat_begin_login_epoch();
        group(old_response, old_request, "old-or-reused", "old-group");
        compat_begin_login_epoch();
        group(current_response, current_request,
              cycle & 1U ? "current" : "old-or-reused", "current-group");
        compat_queue_sessiongroup_added(current_response);
        assert(strcmp(g_account_handle, cycle & 1U ? "current" : "old-or-reused") == 0);
        assert(g_hud_pending_count == 1);
        compat_queue_sessiongroup_added(old_response);
        assert(strcmp(g_account_handle, cycle & 1U ? "current" : "old-or-reused") == 0);
        assert(g_hud_pending_count == 1);
        assert(compat_group_epoch(old_request) == 0 && compat_group_epoch(current_request) != 0);
        compat_forget_group(old_request); compat_forget_group(current_request);
        compat_begin_login_epoch();
        assert(g_hud_pending_count == 0 && !g_hud_session_ready && !g_account_handle[0]);
    }
    unsigned char requests[129][0x60] = {{0}};
    for (unsigned i = 0; i < 128; ++i) assert(compat_track_group(requests[i]));
    assert(!compat_track_group(requests[128]));
    for (unsigned i = 0; i < 128; ++i) compat_forget_group(requests[i]);
    assert(compat_track_group(requests[128])); compat_forget_group(requests[128]);
    puts("PASS: 50 login cycles fence old responses with distinct/reused handles; tracking remains bounded");
    return 0;
}
