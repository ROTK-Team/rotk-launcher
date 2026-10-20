/* InstantADS.Enabled=0 restores the native fire countdown while entering
 * ADS, but two sprint-cooldown readers of that rule (weapon usable and can
 * fire) would then latch a shot and lower the weapon while moving. Each reads
 * the rule through a pure lookup and consumes only AL, so its five-byte CALL
 * becomes the five-byte MOV EAX,1 it observed under InstantADS=1. The fire
 * gate, the third reader, stays native. Each site lies inside one aligned
 * qword: a locked compare-exchange swaps whole instructions, without thread
 * suspension, trampoline, allocation or per-frame work.
 */
static volatile LONG ads_rule_installed;
static const uint32_t ads_rule_sites[2] = {0x10474d8, 0x166682a};
static const BYTE ads_rule_calls[2][5] = {
    {0xe8,0x09,0x00,0x0b,0xff}, {0xe8,0xb7,0x0c,0xa9,0xfe}
};
static const BYTE ads_rule_kept[5] = {0xb8,0x01,0x00,0x00,0x00};
/* XOR EDX,EDX and MOV ECX,0x63EE6001 (InstantADS.Enabled) frame each call. */
static const BYTE ads_rule_weapon_guard[] = {
    0x33,0xd2,0xb9,0x01,0x60,0xee,0x63,0xe8,0x09,0x00,0x0b,0xff,
    0xf6,0x46,0x20,0x40,0x0f,0xb6,0xe8
};
static const BYTE ads_rule_fire_guard[] = {
    0x33,0xd2,0x4c,0x89,0x6c,0x24,0x58,0xb9,0x01,0x60,0xee,0x63,
    0x4c,0x89,0x74,0x24,0x60,0x4c,0x89,0x7c,0x24,0x20,0xe8,0xb7,
    0x0c,0xa9,0xfe,0x44,0x8b,0xa5,0x00,0x01,0x00,0x00
};

/* Swaps one instruction only while it still holds ``from``. A false return
 * leaves the stock or previous instruction and its page protection in place.
 */
static BOOL ads_rule_swap(BYTE *site, const BYTE *from, const BYTE *to) {
    volatile LONG64 *word = (volatile LONG64 *)((uintptr_t)site & ~(uintptr_t)7);
    SIZE_T shift = (SIZE_T)((uintptr_t)site & 7U);
    LONG64 expected, replacement;
    DWORD old_protection = 0U;
    BOOL swapped, restored;

    if (shift > 3U || !executable_committed_range((const BYTE *)word, 8U, FALSE)) {
        return FALSE;
    }
    expected = *word;
    if (memcmp((const BYTE *)&expected + shift, from, 5U) != 0) {
        return FALSE;
    }
    replacement = expected;
    memcpy((BYTE *)&replacement + shift, to, 5U);
    if (!VirtualProtect((LPVOID)word, 8U, PAGE_EXECUTE_READWRITE, &old_protection)) {
        return FALSE;
    }
    swapped = InterlockedCompareExchange64(word, replacement, expected) == expected;
    if (swapped) {
        FlushInstructionCache(GetCurrentProcess(), (LPCVOID)word, 8U);
    }
    restored = restore_page_protection((LPVOID)word, 8U, old_protection);
    if (swapped && !restored) {
        DWORD ignored;
        if (VirtualProtect((LPVOID)word, 8U, PAGE_EXECUTE_READWRITE, &ignored)) {
            if (InterlockedCompareExchange64(word, expected, replacement) == replacement) {
                FlushInstructionCache(GetCurrentProcess(), (LPCVOID)word, 8U);
            }
            (void)restore_page_protection((LPVOID)word, 8U, old_protection);
        }
        return FALSE;
    }
    return swapped;
}

static void ads_rule_install(BYTE *base) {
    if (!exact_bytes(base + 0x10474d1, ads_rule_weapon_guard, sizeof(ads_rule_weapon_guard)) ||
        !exact_bytes(base + 0x1666814, ads_rule_fire_guard, sizeof(ads_rule_fire_guard))) {
        patch_log("ROTK ADS sprint rule: native signature mismatch; skipped.\n"); return;
    }
    if (!ads_rule_swap(base + ads_rule_sites[0], ads_rule_calls[0], ads_rule_kept)) {
        patch_log("ROTK ADS sprint rule: guarded installation refused.\n"); return;
    }
    if (!ads_rule_swap(base + ads_rule_sites[1], ads_rule_calls[1], ads_rule_kept)) {
        (void)ads_rule_swap(base + ads_rule_sites[0], ads_rule_kept, ads_rule_calls[0]);
        patch_log("ROTK ADS sprint rule: guarded installation refused.\n"); return;
    }
    InterlockedExchange(&ads_rule_installed, 1);
    patch_log("ROTK ADS sprint rule: sprint readers keep InstantADS.\n");
}

static BOOL ads_rule_restore(BYTE *base) {
    BOOL restored = TRUE;
    if (!InterlockedExchange(&ads_rule_installed, 0)) {
        return TRUE;
    }
    for (unsigned int i = 0; i < 2U; ++i) {
        if (!ads_rule_swap(base + ads_rule_sites[i], ads_rule_kept, ads_rule_calls[i])) {
            restored = FALSE;
        }
    }
    return restored;
}
