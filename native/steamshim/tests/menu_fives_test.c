/* Execute the real shim transport with four teammates (Fives: TRIO slots 2-4). */
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include "../steam_api64.c"
#define MATE(n) (76561198000005002ULL + (n))
static unsigned joined[4], left[4], updated[4];
typedef struct TestCallback { void **vtable; int id; } TestCallback;
static void callback_run(void *self, void *payload) {
    TestCallback *callback = self;
    const unsigned char *bytes = payload;
    uint64_t member; memcpy(&member, bytes + 8, 8);
    assert(member >= MATE(0) && member <= MATE(3));
    unsigned slot = (unsigned)(member - MATE(0));
    if (callback->id == 505) updated[slot]++;
    else {
        uint32_t change; memcpy(&change, bytes + 24, 4);
        if (change == 1) joined[slot]++;
        else { assert(change == 2); left[slot]++; }
    }
}
static int callback_size(void *self) { return ((TestCallback *)self)->id == 505 ? 24 : 32; }
static int receive(const char *message, ULONGLONG now) { return receive_menu_duo_native(message, strlen(message) + 1, now); }
static DummyObject mm = {NULL, "SteamMatchMaking009"};
static void expect_roster(unsigned count) {
    assert(generic_interface_method(&mm,17,0,0,0,0) == count);
    assert(generic_interface_method(&mm,18,0,0,0,0) == g_fake_steam_id);
    for (unsigned i = 1; i <= 5; ++i)
        assert(generic_interface_method(&mm,18,0,i,0,0) == (i < count ? MATE(i - 1) : (count == 1 ? g_fake_steam_id : 0)));
}
static void expect_counts(unsigned j0, unsigned j1, unsigned j2, unsigned j3, unsigned l0, unsigned l1, unsigned l2, unsigned l3) {
    assert(joined[0] == j0 && joined[1] == j1 && joined[2] == j2 && joined[3] == j3);
    assert(left[0] == l0 && left[1] == l1 && left[2] == l2 && left[3] == l3);
}
int main(void) {
    void *vtable[] = {(void *)callback_run, NULL, (void *)callback_size};
    TestCallback data = {vtable, 505}, chat = {vtable, 506};
    SteamAPI_RegisterCallback(&data, 505); SteamAPI_RegisterCallback(&chat, 506);
    g_fake_steam_id = 76561198000005001ULL;
    const char *key = "daybreakCharId";
    const char *duo = "@CHAT:ROTK_MENU_DUO_V1|5000000000|76561198000005002|6917529027641156017|Alpha";
    const char *s2 = "@CHAT:ROTK_MENU_TRIO_V1|5000000001|2|76561198000005003|6917529027641156018|Bravo";
    const char *s3 = "@CHAT:ROTK_MENU_TRIO_V1|5000000002|3|76561198000005004|6917529027641156019|Ch%C3%A2rlie";
    const char *s4 = "@CHAT:ROTK_MENU_TRIO_V1|5000000003|4|76561198000005005|6917529027641156020|Delta";
    // DUO + TRIO|2|3|4: five lobby members with exact ids, callbacks deferred to the pump.
    assert(receive(duo,1000) && receive(s2,1000) && receive(s3,1000) && receive(s4,1000));
    expect_roster(1); expect_counts(0,0,0,0, 0,0,0,0);
    poll_menu_duo_native(1001);
    expect_roster(5); expect_counts(1,1,1,1, 0,0,0,0);
    assert(updated[0] == 1 && updated[1] == 1 && updated[2] == 1 && updated[3] == 1);
    for (unsigned i = 0; i < 4; ++i) {
        char actor[32]; snprintf(actor, sizeof(actor), "%llu", 6917529027641156017ULL + i);
        assert(!strcmp((char *)generic_interface_method(&mm,24,1,MATE(i),(uintptr_t)key,0), actor));
    }
    assert(!strcmp(menu_team_find(MATE(2))->name,"Ch\xc3\xa2rlie") && !strcmp(menu_team_find(MATE(3))->name,"Delta"));
    assert(!receive(s4,2000) && !receive(s3,2000)); /* per-slot stale sequence */
    const char *invalid[] = {
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|1|76561198000005009|6917529027641156029|SlotOne",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|5|76561198000005009|6917529027641156029|SlotFive",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|0|76561198000005009|6917529027641156029|SlotZero",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|02|76561198000005009|6917529027641156029|Padded",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|03|76561198000005009|6917529027641156029|Padded",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010||76561198000005009|6917529027641156029|Empty",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|4|76561198000005003|6917529027641156029|DupIdentity24",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|3|76561198000005005|6917529027641156029|DupIdentity43",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|2|76561198000005002|6917529027641156029|DupIdentity12",
        "@CHAT:ROTK_MENU_DUO_V1|5000000010|76561198000005005|6917529027641156029|DupIdentityDuo4",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|4|76561198000005005|6917529027641156019|DupActor34",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|2|76561198000005003|6917529027641156020|DupActor42",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|3|76561198000005004|6917529027641156017|DupActor13",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|3|76561198000005001|6917529027641156029|Self",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|4|76561198000005005|6917529027641156020|%00Hidden",
        "@CHAT:ROTK_MENU_TRIO_V1|5000000010|4|0|0|StillNamed"
    };
    for (unsigned i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++) assert(!receive(invalid[i],2000));
    for (unsigned i = 0; i < 4; ++i) assert(g_menu_team[i].sequence == 5000000000ULL + i && !g_menu_team[i].pending);
    // Clearing slot 2 hides 3 and 4, keeps their proposals, and restores them without a new frame.
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000011|2|0|0|",3000));
    poll_menu_duo_native(3001);
    expect_roster(2); expect_counts(1,1,1,1, 0,1,1,1);
    assert(g_menu_team[2].pending_member == MATE(2) && g_menu_team[3].pending_member == MATE(3));
    assert(!menu_team_find(MATE(3)) && !strcmp((char *)generic_interface_method(&mm,24,1,MATE(3),(uintptr_t)key,0),""));
    assert(!receive("@CHAT:ROTK_MENU_TRIO_V1|5000000012|2|76561198000005004|6917529027641156029|RetainedDup",3500));
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000012|2|76561198000005003|6917529027641156018|Bravo",4000));
    poll_menu_duo_native(4001);
    expect_roster(5); expect_counts(1,2,2,2, 0,1,1,1);
    // Clearing the last slot never hides the earlier mates.
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000013|4|0|0|",5000));
    poll_menu_duo_native(5001);
    expect_roster(4); expect_counts(1,2,2,2, 0,1,1,2);
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000014|4|76561198000005005|6917529027641156020|Delta",6000));
    poll_menu_duo_native(6001);
    expect_roster(5); expect_counts(1,2,2,3, 0,1,1,2);
    // Independent 20 s leases: A 1000->10000, B 4000, C 1000, D 6000->10000. An identical renewal dispatches nothing.
    assert(receive("@CHAT:ROTK_MENU_DUO_V1|5000000015|76561198000005002|6917529027641156017|Alpha",10000));
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000016|4|76561198000005005|6917529027641156020|Delta",10000));
    poll_menu_duo_native(10001);
    expect_roster(5); expect_counts(1,2,2,3, 0,1,1,2);
    poll_menu_duo_native(20999);
    expect_roster(5);
    poll_menu_duo_native(21000); /* C expires; D hides but keeps its own lease */
    expect_roster(3); expect_counts(1,2,2,3, 0,1,2,3);
    assert(g_menu_team[3].pending_member == MATE(3) && g_menu_team[3].expires == 30000);
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000017|3|76561198000005004|6917529027641156019|Charlie",21001));
    poll_menu_duo_native(21002);
    expect_roster(5); expect_counts(1,2,3,4, 0,1,2,3);
    poll_menu_duo_native(24000); /* B expires; C and D hide */
    expect_roster(2); expect_counts(1,2,3,4, 0,2,3,4);
    poll_menu_duo_native(30000); /* A expires; hidden D expires too, hidden C (41001) is kept */
    expect_roster(1); expect_counts(1,2,3,4, 1,2,3,4);
    assert(!g_menu_team[3].pending_member && g_menu_team[2].pending_member == MATE(2));
    assert(receive("@CHAT:ROTK_MENU_DUO_V1|5000000018|76561198000005002|6917529027641156017|Alpha",30001));
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000019|2|76561198000005003|6917529027641156018|Bravo",30001));
    poll_menu_duo_native(30002);
    expect_roster(4); expect_counts(2,3,4,4, 1,2,3,4);
    // CLEAR empties all four slots and keeps the sequences.
    assert(receive("@CHAT:ROTK_MENU_DUO_CLEAR_V1",31000));
    poll_menu_duo_native(31001);
    expect_roster(1); expect_counts(2,3,4,4, 2,3,4,4);
    for (unsigned i = 0; i < 4; ++i) assert(!g_menu_team[i].member && !g_menu_team[i].pending_member && !g_menu_team[i].expires);
    assert(!receive(s4,31002) && !receive(duo,31002));
    // Reversed arrival: nothing shows until slot one, then every actor keeps its scene slot.
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000020|4|76561198000005005|6917529027641156020|Delta",32000));
    poll_menu_duo_native(32001); expect_roster(1);
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000021|3|76561198000005004|6917529027641156019|Charlie",32002));
    poll_menu_duo_native(32003); expect_roster(1);
    assert(receive("@CHAT:ROTK_MENU_TRIO_V1|5000000022|2|76561198000005003|6917529027641156018|Bravo",32004));
    poll_menu_duo_native(32005); expect_roster(1);
    expect_counts(2,3,4,4, 2,3,4,4);
    assert(receive("@CHAT:ROTK_MENU_DUO_V1|5000000023|76561198000005002|6917529027641156017|Alpha",32006));
    poll_menu_duo_native(32007);
    expect_roster(5); expect_counts(3,4,5,5, 2,3,4,4);
    assert(receive("@CHAT:ROTK_MENU_DUO_CLEAR_V1",33000));
    poll_menu_duo_native(33001);
    expect_roster(1); expect_counts(3,4,5,5, 3,4,5,5);
    puts("PASS Fives native menu: four actors at stable scene slots 1-4, exact ids/data, deferred callbacks, slot grammar 2-4, cross-slot duplicate rejection, gap hide-and-retain, independent leases, reversed arrival and global clear.");
    return 0;
}
