/* Execute the real shim transport and native matchmaking callbacks. */
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include "../steam_api64.c"
static unsigned joined[2], left[2], updated[2];
typedef struct TestCallback { void **vtable; int id; } TestCallback;
static void callback_run(void *self, void *payload) {
    TestCallback *callback = self;
    const unsigned char *bytes = payload;
    uint64_t member; memcpy(&member, bytes + 8, 8);
    assert(member == 76561198000005002ULL || member == 76561198000005003ULL);
    unsigned slot = (unsigned)(member - 76561198000005002ULL);
    if (callback->id == 505) updated[slot]++;
    else {
        uint32_t change; memcpy(&change, bytes + 24, 4);
        if (change == 1) joined[slot]++;
        else { assert(change == 2); left[slot]++; }
    }
}
static int callback_size(void *self) { return ((TestCallback *)self)->id == 505 ? 24 : 32; }
static int receive(const char *message, ULONGLONG now) { return receive_menu_duo_native(message, strlen(message) + 1, now); }
int main(void) {
    void *vtable[] = {(void *)callback_run, NULL, (void *)callback_size};
    TestCallback data = {vtable, 505}, chat = {vtable, 506};
    SteamAPI_RegisterCallback(&data, 505); SteamAPI_RegisterCallback(&chat, 506);
    g_fake_steam_id = 76561198000005001ULL;
    DummyObject mm = {NULL, "SteamMatchMaking009"};
    const char *first = "@CHAT:ROTK_MENU_DUO_V1|5000000000|76561198000005002|6917529027641156017|Bravo";
    const char *second = "@CHAT:ROTK_MENU_TRIO_V1|5000000001|2|76561198000005003|6917529027641156018|Ch%C3%A2rlie";
    assert(receive(first,1000) && receive(second,1100));
    assert(menu_team_count() == 1 && joined[0] == 0 && joined[1] == 0);
    poll_menu_duo_native(1200);
    assert(generic_interface_method(&mm,17,0,0,0,0) == 3);
    assert(generic_interface_method(&mm,18,0,0,0,0) == g_fake_steam_id);
    assert(generic_interface_method(&mm,18,0,1,0,0) == 76561198000005002ULL);
    assert(generic_interface_method(&mm,18,0,2,0,0) == 76561198000005003ULL);
    assert(generic_interface_method(&mm,18,0,3,0,0) == 0);
    assert(joined[0] == 1 && joined[1] == 1 && updated[0] == 1 && updated[1] == 1);
    assert(!strcmp(menu_team_find(76561198000005003ULL)->name,"Ch\xc3\xa2rlie"));
    const char *key = "daybreakCharId";
    assert(!strcmp((char *)generic_interface_method(&mm,24,1,76561198000005002ULL,(uintptr_t)key,0),"6917529027641156017"));
    assert(!strcmp((char *)generic_interface_method(&mm,24,1,76561198000005003ULL,(uintptr_t)key,0),"6917529027641156018"));
    assert(!receive(second,2000));
    const char *invalid[] = {
        "@CHAT:ROTK_MENU_TRIO_V1|5000000002|1|76561198000005003|6917529027641156018|BadSlot",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000002|02|76561198000005003|6917529027641156018|BadSlot",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000002|2|76561198000005002|6917529027641156018|DuplicateIdentity",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000002|2|76561198000005003|6917529027641156017|DuplicateActor",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000002|2|76561198000005001|6917529027641156018|Self",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000002|2|76561198000005003|6917529027641156018|%00Hidden",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000002|2|0|0|StillNamed",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000002|2|0|0||"
    };
    for (unsigned i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++) assert(!receive(invalid[i],2000));
    assert(g_menu_team[1].sequence == 5000000001ULL);
    // Refresh the second independently. It must never take native scene slot one.
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000003|2|76561198000005003|6917529027641221554|Charlie2",2000));
    poll_menu_duo_native(2001);
    assert(updated[1] == 2 && joined[1] == 1);
    poll_menu_duo_native(21000);
    assert(menu_team_count() == 1 && left[0] == 1 && left[1] == 1);
    assert(menu_team_member_at(1) == 0 && menu_team_member_at(2) == 0);
    assert(g_menu_team[1].pending_member == 76561198000005003ULL);
    assert(receive("@CHAT:ROTK_MENU_DUO_V1|5000000004|76561198000005002|6917529027641156017|Bravo",21001));
    poll_menu_duo_native(21002);
    assert(menu_team_count() == 3 && joined[0] == 2 && joined[1] == 2);
    assert(menu_team_member_at(2) == 76561198000005003ULL);
    assert(receive("@CHAT:ROTK_MENU_DUO_CLEAR_V1",21003));
    poll_menu_duo_native(21004);
    assert(menu_team_count() == 1 && left[0] == 2 && left[1] == 2);
    assert(!receive(first,21005) && !receive(second,21005));
    // Explicit slot clear never clears the other mate.
    assert(receive("@CHAT:ROTK_MENU_DUO_V1|5000000005|76561198000005002|6917529027641156017|Bravo",22000));
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000006|2|76561198000005003|6917529027641156018|Charlie",22000));
    poll_menu_duo_native(22001);
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000007|2|0|0|",22002));
    poll_menu_duo_native(22003);
    assert(menu_team_count() == 2 && g_menu_duo_member && !g_menu_team[1].member);
    // The second actor's full-data response can arrive before the first actor.
    assert(receive("@CHAT:ROTK_MENU_DUO_CLEAR_V1",23000));
    poll_menu_duo_native(23001);
    unsigned second_joins = joined[1];
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000008|2|76561198000005003|6917529027641156018|Charlie",23002));
    poll_menu_duo_native(23003);
    assert(menu_team_count() == 1 && joined[1] == second_joins && !g_menu_team[1].member);
    assert(receive("@CHAT:ROTK_MENU_DUO_V1|5000000009|76561198000005002|6917529027641156017|Bravo",23004));
    poll_menu_duo_native(23005);
    assert(menu_team_count() == 3 && joined[1] == second_joins + 1);
    assert(menu_team_member_at(1) == 76561198000005002ULL && menu_team_member_at(2) == 76561198000005003ULL);
    puts("PASS Trio native menu: two actors, exact identity/data, deferred callbacks, independent leases, stable scene slots across reversed arrival/expiry, malformed/duplicate rejection and global/slot clear.");
    return 0;
}
