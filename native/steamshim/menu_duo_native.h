/* Server -> owner-only broadcast -> GFX -> SteamSendChatToLobby -> shim.
 * Presentation only: never changes the authoritative ROTK party or inventory.
 * Steam callbacks run on the existing callback pump, outside the UI call. */
typedef struct MenuTeamMember {
    uint64_t member, sequence, pending_member;
    char actor[32], name[129], pending_actor[32], pending_name[129];
    ULONGLONG expires;
    int pending;
} MenuTeamMember;
static MenuTeamMember g_menu_team[2];
/* Keep the original first-mate names for the Duo transport and its callers. */
#define g_menu_duo_member (g_menu_team[0].member)
#define g_menu_duo_sequence (g_menu_team[0].sequence)
#define g_menu_duo_actor (g_menu_team[0].actor)
#define g_menu_duo_name (g_menu_team[0].name)
static uint64_t g_menu_duo_callback_member = 0;
static uint32_t g_menu_duo_callback_change = 0;

static void clear_menu_team_member(MenuTeamMember *slot) {
    slot->pending_member = 0;
    slot->pending_actor[0] = slot->pending_name[0] = 0;
    slot->expires = 0; slot->pending = 1;
}
static unsigned menu_team_count(void) {
    /* Native scene actor slots must never be renumbered by packet arrival order. */
    return g_menu_team[0].member ? 2 + !!g_menu_team[1].member : 1;
}
static uint64_t menu_team_member_at(uintptr_t index) {
    if (!index) return g_fake_steam_id;
    if (!g_menu_team[0].member) return 0;
    if (index <= 2) return g_menu_team[index - 1].member;
    return 0;
}
static MenuTeamMember *menu_team_find(uint64_t member) {
    if (!member) return NULL;
    for (unsigned i = 0; i < 2; ++i) if (g_menu_team[i].member == member && (!i || g_menu_team[0].member)) return &g_menu_team[i];
    return NULL;
}

static int menu_duo_u64(const char *text, uint64_t *out) {
    uint64_t value = 0;
    if (!*text || (*text == '0' && text[1])) return 0;
    for (; *text; ++text) {
        if (*text < '0' || *text > '9' || value > (UINT64_MAX - (*text - '0')) / 10) return 0;
        value = value * 10 + (*text - '0');
    }
    *out = value; return 1;
}
static int menu_duo_hex(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}
static int menu_duo_name(const char *text, char *out, size_t capacity) {
    size_t used = 0;
    while (*text) {
        unsigned char value = (unsigned char)*text++;
        if (value == '%') {
            if (!text[0] || !text[1]) return 0;
            int high = menu_duo_hex(text[0]), low = menu_duo_hex(text[1]);
            if (high < 0 || low < 0) return 0;
            value = (unsigned char)(high * 16 + low); text += 2;
        }
        if (value < 32 || value == 127 || used + 1 >= capacity) return 0;
        out[used++] = (char)value;
    }
    out[used] = 0; return used > 0;
}
static int receive_menu_duo_native(const char *message, size_t size, ULONGLONG now) {
    char buffer[1024], name[129] = "", *fields[5], *cursor;
    uint64_t sequence, member, actor;
    const char prefix[] = "@CHAT:ROTK_MENU_DUO_V1|";
    const char trio_prefix[] = "@CHAT:ROTK_MENU_TRIO_V1|";
    unsigned slot_index = 0, field_count = 4, offset = 0;
    if (!size || size >= sizeof(buffer) || !can_access_process_memory((uintptr_t)message, size, 0)) return 0;
    memcpy(buffer, message, size);
    if (buffer[size - 1] == 0) --size;
    if (memchr(buffer, 0, size)) return 0;
    buffer[size] = 0;
    if (!strcmp(buffer, "@CHAT:ROTK_MENU_DUO_CLEAR_V1")) {
        for (unsigned i = 0; i < 2; ++i) clear_menu_team_member(&g_menu_team[i]);
        return 1;
    }
    if (!strncmp(buffer, prefix, sizeof(prefix) - 1)) cursor = buffer + sizeof(prefix) - 1;
    else if (!strncmp(buffer, trio_prefix, sizeof(trio_prefix) - 1)) {
        cursor = buffer + sizeof(trio_prefix) - 1;
        slot_index = 1; field_count = 5; offset = 1;
    } else return 0;
    for (unsigned i = 0; i < field_count; ++i) {
        fields[i] = cursor;
        char *separator = strchr(cursor, '|');
        if (i == field_count - 1) { if (separator) return 0; }
        else { if (!separator) return 0; *separator = 0; cursor = separator + 1; }
    }
    MenuTeamMember *slot = &g_menu_team[slot_index], *other = &g_menu_team[1 - slot_index];
    if (offset && strcmp(fields[1], "2")) return 0;
    if (!menu_duo_u64(fields[0], &sequence) || !sequence || sequence > 9007199254740991ULL || sequence <= slot->sequence ||
        !menu_duo_u64(fields[1 + offset], &member) || !menu_duo_u64(fields[2 + offset], &actor)) return 0;
    if (member == 0) { if (actor || fields[3 + offset][0]) return 0; }
    else if (member < 76561197960265728ULL || member == g_fake_steam_id || (actor >> 48) != 0x6000 ||
        !menu_duo_name(fields[3 + offset], name, sizeof(name))) return 0;
    /* A coalesced clear takes precedence over the old displayed identity. */
    uint64_t other_member = other->pending ? other->pending_member : other->member;
    const char *other_actor = other->pending ? other->pending_actor : other->actor;
    char actor_text[32] = "";
    if (member) snprintf(actor_text, sizeof(actor_text), "%llu", (unsigned long long)actor);
    if (member && other_member && (member == other_member || !strcmp(actor_text, other_actor))) return 0;
    slot->sequence = sequence;
    slot->pending_member = member;
    lstrcpynA(slot->pending_actor, actor_text, sizeof(slot->pending_actor));
    lstrcpynA(slot->pending_name, name, sizeof(slot->pending_name));
    slot->expires = member ? now + 20000 : 0;
    slot->pending = 1;
    return 1;
}
static const char *menu_team_member_value(MenuTeamMember *slot, const char *key) {
    if (!_stricmp(key, "daybreakCharId") || !_stricmp(key, "h1z1_character")) return slot->actor;
    if (!_stricmp(key, "daybreakUserId")) return "0";
    if (!_stricmp(key, "datacenter")) return g_fake_lobby_datacenter;
    if (!_stricmp(key, "SelectedMatchCanEnter")) return "-1";
    if (!_stricmp(key, "status")) return "Z1BR  - Main Menu";
    if (!_stricmp(key, "ready") || !_stricmp(key, "inGame") ||
        !_stricmp(key, "ViewingHostedGames") || !_stricmp(key, "SelectedMatchRole") ||
        !_stricmp(key, "SelectedMatchId") || !_stricmp(key, "matchId")) return "0";
    return "";
}
static void poll_menu_team_member(MenuTeamMember *slot, ULONGLONG now) {
    if (slot->expires && now >= slot->expires) {
        clear_menu_team_member(slot);
    }
    if (!slot->pending) return;
    slot->pending = 0;
    uint64_t previous = slot->member;
    uint64_t member = slot->pending_member;
    if (previous == member && !strcmp(slot->actor, slot->pending_actor) && !strcmp(slot->name, slot->pending_name)) return;
    slot->member = member;
    lstrcpynA(slot->actor, slot->pending_actor, sizeof(slot->actor));
    lstrcpynA(slot->name, slot->pending_name, sizeof(slot->name));
    if (previous && previous != member) {
        g_menu_duo_callback_member = previous; g_menu_duo_callback_change = 2;
        dispatch_callbacks_by_id(506, "MenuDuo leave", 1);
    }
    if (member) {
        g_menu_duo_callback_member = member;
        if (previous != member) {
            g_menu_duo_callback_change = 1;
            dispatch_callbacks_by_id(506, "MenuDuo join", 1);
        }
        dispatch_callbacks_by_id(505, "MenuDuo member data", 1);
    }
    g_menu_duo_callback_member = 0; g_menu_duo_callback_change = 0;
    log_line("MenuTeam native roster member=%llu actor=%s", (unsigned long long)member, slot->actor);
}
static void poll_menu_duo_native(ULONGLONG now) {
    poll_menu_team_member(&g_menu_team[0], now);
    MenuTeamMember *second = &g_menu_team[1];
    if (!g_menu_team[0].member) {
        if (second->expires && now >= second->expires) clear_menu_team_member(second);
        if (second->member) {
            /* Hide the second presentation while slot one is absent, but retain
             * a fresh authoritative proposal until the first actor is ready. */
            uint64_t wanted = second->pending ? second->pending_member : second->member;
            char actor[32], name[129];
            ULONGLONG expires = second->expires;
            lstrcpynA(actor, second->pending ? second->pending_actor : second->actor, sizeof(actor));
            lstrcpynA(name, second->pending ? second->pending_name : second->name, sizeof(name));
            clear_menu_team_member(second);
            poll_menu_team_member(second, now);
            if (wanted && expires > now) {
                second->pending_member = wanted;
                lstrcpynA(second->pending_actor, actor, sizeof(second->pending_actor));
                lstrcpynA(second->pending_name, name, sizeof(second->pending_name));
                second->expires = expires; second->pending = 1;
            }
        }
        return;
    }
    poll_menu_team_member(second, now);
}
