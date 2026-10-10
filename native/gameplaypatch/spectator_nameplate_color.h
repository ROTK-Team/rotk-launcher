#ifndef ROTK_SPECTATOR_NAMEPLATE_COLOR_H
#define ROTK_SPECTATOR_NAMEPLATE_COLOR_H

/* BR1315's rich nameplate passes transparent black to its text formatter.
 * A selected player receives a later color override; other names disappear.
 * Retarget only that formatter CALL through a leaf relay supplying opaque
 * white. The original CALL address, return address, EH states, name visibility,
 * selected color, team icon and health bar all remain unchanged.
 */
#define NAMEPLATE_GUARD_RVA UINT32_C(0x1b6aa66)
#define NAMEPLATE_WORD_RVA UINT32_C(0x1b6aa80)
#define NAMEPLATE_FORMAT_RVA UINT32_C(0x002fe0)
#define NAMEPLATE_RELAY_SIZE 9U
#define NAMEPLATE_COLOR_WORD_RVA UINT32_C(0x1b6c4f0)
#define NAMEPLATE_SOLID_RELAY_OFFSET 32U
#define NAMEPLATE_SOLID_RELAY_SIZE 29U

static const BYTE nameplate_prologue[] = {
    0x48,0x8b,0xc4,0x55,0x41,0x55,0x41,0x57,0x48,0x8d,0xa8,0x68,0xfe,0xff,0xff,
    0x48,0x81,0xec,0x80,0x02,0x00,0x00,0x48,0xc7,0x45,0x30,0xfe,0xff,0xff,0xff
};
static const BYTE nameplate_guard[] = {
    0x4d,0x8b,0xf9,0x4d,0x8b,0xe8,0x48,0x8b,0x3d,0x55,0x3d,0xc0,0x02,0x48,0x85,0xff,
    0x0f,0x84,0x5f,0x08,0x00,0x00,0x45,0x33,0xc0,0x48,0x8d,0x55,0x40,0xe8,0x58,0x85,
    0x49,0xfe,0x90,0x80,0xbd,0xf8,0x01,0x00,0x00,0x00,0x74,0x0e,0x8b,0x85,0xf0,0x01,
    0x00,0x00,0x0d,0x00,0x00,0x00,0xff,0x89,0x45,0x40
};
static const BYTE nameplate_format_guard[] = {
    0x48,0x89,0x54,0x24,0x10,0x57,0x48,0x83,0xec,0x30,0x48,0xc7,0x44,0x24,0x28,0xfe,
    0xff,0xff,0xff,0x48,0x89,0x5c,0x24,0x40,0x41,0x8b,0xd8,0x48,0x8b,0xfa,0x45,0x33,
    0xc0,0x44,0x89,0x44,0x24,0x20,0x48,0x8d,0x81,0x50,0x03,0x00,0x00,0x48,0x8d,0x91,
    0x70,0x03,0x00,0x00,0x48,0x85,0xc0,0x49,0x0f,0x44,0xd0,0x48,0x8b,0xcf,0xe8,0x5b
};
static const BYTE nameplate_format_tail[] = {
    0x7a,0x54,0xfe,0xc7,0x44,0x24,0x20,0x01,0x00,0x00,0x00,0x8b,0xd3,0x48,0x8b,0xcf,0xe8,0x2c,0x28,
    0x4b,0xfe,0x48,0x8b,0xc7,0x48,0x8b,0x5c,0x24,0x40,0x48,0x83,0xc4,0x30,0x5f,0xc3
};
static const BYTE nameplate_format_thunk[] = {0xe9,0xbb,0x94,0xb6,0x01};

static BYTE *nameplate_image, *nameplate_relay;
static uint64_t nameplate_stock_word, nameplate_relay_word;
static uint64_t nameplate_color_stock_word, nameplate_color_relay_word;

static BOOL nameplate_relative(uintptr_t target, uintptr_t after, int32_t *relative) {
    if (target >= after) {
        if (target - after > INT32_MAX) return FALSE;
        *relative = (int32_t)(target - after);
    } else {
        if (after - target > (uint64_t)INT32_MAX + 1U) return FALSE;
        *relative = -(int32_t)(after - target - 1U) - 1;
    }
    return TRUE;
}

static BOOL nameplate_build_relay(BYTE *relay, uintptr_t relay_address,
                                uintptr_t format, BYTE *word,
                                uintptr_t word_address) {
    int32_t branch, call;
    if (!nameplate_relative(format, relay_address + NAMEPLATE_RELAY_SIZE, &branch) ||
        !nameplate_relative(relay_address, word_address + 8U, &call)) return FALSE;
    /* OR R8D,-1; JMP formatter. No stack or nonvolatile register changes. */
    const BYTE prefix[] = {0x41,0x83,0xc8,0xff,0xe9};
    memcpy(relay, prefix, sizeof(prefix));
    memcpy(relay + sizeof(prefix), &branch, sizeof(branch));
    memcpy(word, nameplate_guard + NAMEPLATE_WORD_RVA - NAMEPLATE_GUARD_RVA, 8U);
    memcpy(word + 4U, &call, sizeof(call));
    return TRUE;
}

/* The rich nameplate's copied DrawText format has a colorized outline filter.
 * Remove it only from this temporary format, before color multiplication.
 * Other formatter callers and the shared font definition keep their filters.
 * Both relays are leaves; the original CALL and EH return addresses stay intact.
 */
static BOOL nameplate_build_solid_relay(BYTE *relay, uintptr_t relay_address,
                                      BYTE *base, BYTE *word) {
    int32_t branch, call;
    uintptr_t expected_caller = (uintptr_t)(base + NAMEPLATE_WORD_RVA + 8U);
    if (!nameplate_relative((uintptr_t)(base + 0x1ed21),
            relay_address + NAMEPLATE_SOLID_RELAY_SIZE, &branch) ||
        !nameplate_relative(relay_address,
            (uintptr_t)(base + NAMEPLATE_COLOR_WORD_RVA + 5U), &call)) return FALSE;
    const BYTE prefix[] = {0x48,0xb8}; /* MOV RAX, rich CALL return address */
    const BYTE body[] = {
        0x48,0x39,0x44,0x24,0x40, /* CMP [RSP+40h],RAX: formatter caller */
        0x75,0x07,               /* JNE: leave other callers unchanged */
        0xc7,0x41,0x40,0,0,0,0, /* copied filter count = 0, retain allocation */
        0xe9
    };
    memcpy(relay, prefix, sizeof(prefix));
    memcpy(relay + 2U, &expected_caller, sizeof(expected_caller));
    memcpy(relay + 10U, body, sizeof(body));
    memcpy(relay + 25U, &branch, sizeof(branch));
    memcpy(word, base + NAMEPLATE_COLOR_WORD_RVA, 8U);
    memcpy(word + 1U, &call, sizeof(call));
    return TRUE;
}

/* The complete CALL instruction is inside this aligned QWORD and cache line.
 * Both old and new destinations are executable before publishing the branch.
 */
static BOOL nameplate_exchange(BYTE *word, uint64_t expected, uint64_t replacement) {
    DWORD protection;
    uint64_t original = expected;
    BOOL changed, flushed = FALSE, restored;
    if (((uintptr_t)word & 7U) != 0U ||
        !executable_committed_range(word, 8U, FALSE) ||
        !VirtualProtect(word, 8U, PAGE_EXECUTE_READWRITE, &protection)) return FALSE;
    changed = __atomic_compare_exchange_n((volatile uint64_t *)word, &expected,
        replacement, FALSE, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
    if (changed) flushed = FlushInstructionCache(GetCurrentProcess(), word, 8U);
    restored = restore_page_protection(word, 8U, protection);
    if (changed && flushed && restored) return TRUE;
    if (changed) {
        DWORD ignored;
        uint64_t rollback = replacement;
        if (VirtualProtect(word, 8U, PAGE_EXECUTE_READWRITE, &ignored)) {
            if (__atomic_compare_exchange_n((volatile uint64_t *)word, &rollback,
                    original, FALSE, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
                (void)FlushInstructionCache(GetCurrentProcess(), word, 8U);
            }
            (void)restore_page_protection(word, 8U, protection);
        }
    } else if (!restored) {
        (void)restore_page_protection(word, 8U, protection);
    }
    return FALSE;
}

static BOOL nameplate_signatures_ready(const BYTE *base) {
    return exact_bytes(base + 0x1b6aa00, nameplate_prologue, sizeof(nameplate_prologue)) &&
        exact_bytes(base + NAMEPLATE_GUARD_RVA, nameplate_guard, sizeof(nameplate_guard)) &&
        exact_bytes(base + 0x1b6c4a0, nameplate_format_guard, sizeof(nameplate_format_guard)) &&
        exact_bytes(base + 0x1b6c4e0, nameplate_format_tail, sizeof(nameplate_format_tail)) &&
        exact_bytes(base + NAMEPLATE_FORMAT_RVA, nameplate_format_thunk, sizeof(nameplate_format_thunk)) &&
        executable_committed_range(base + NAMEPLATE_GUARD_RVA, sizeof(nameplate_guard), FALSE);
}

static BOOL nameplate_restore_word(uint32_t rva, uint64_t stock, uint64_t patched) {
    BYTE *word = nameplate_image + rva;
    uint64_t observed;
    if (!readable_range(word, sizeof(observed))) return FALSE;
    memcpy(&observed, word, sizeof(observed));
    if (observed == stock) return TRUE;
    return observed == patched && nameplate_exchange(word, patched, stock);
}

static BOOL nameplate_restore(void) {
    BOOL names, filters;
    if (nameplate_image == NULL) return TRUE;
    names = nameplate_restore_word(NAMEPLATE_WORD_RVA,
        nameplate_stock_word, nameplate_relay_word);
    filters = nameplate_restore_word(NAMEPLATE_COLOR_WORD_RVA,
        nameplate_color_stock_word, nameplate_color_relay_word);
    /* Keep both RX leaves alive for threads that already took either branch. */
    return names && filters;
}

static void nameplate_install(BYTE *base) {
    BYTE *relay = NULL, replacement[8], color_replacement[8];
    DWORD protection;
    SYSTEM_INFO info;
    if (nameplate_image != NULL || !nameplate_signatures_ready(base)) {
        patch_log("ROTK spectator names: unsupported or already installed formatter; skipped.\n");
        return;
    }
    GetSystemInfo(&info);
    for (uintptr_t delta = 0x08000000; delta < 0x70000000 && relay == NULL;
         delta += info.dwAllocationGranularity) {
        relay = VirtualAlloc(base + delta, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    }
    if (relay == NULL) return;
    if (!nameplate_build_relay(relay, (uintptr_t)relay,
            (uintptr_t)(base + NAMEPLATE_FORMAT_RVA), replacement,
            (uintptr_t)(base + NAMEPLATE_WORD_RVA)) ||
        !nameplate_build_solid_relay(relay + NAMEPLATE_SOLID_RELAY_OFFSET,
            (uintptr_t)(relay + NAMEPLATE_SOLID_RELAY_OFFSET), base, color_replacement) ||
        !VirtualProtect(relay, 4096, PAGE_EXECUTE_READ, &protection) ||
        !FlushInstructionCache(GetCurrentProcess(), relay, NAMEPLATE_SOLID_RELAY_OFFSET + NAMEPLATE_SOLID_RELAY_SIZE) ||
        !marker_enabled() || !nameplate_signatures_ready(base)) {
        VirtualFree(relay, 0U, MEM_RELEASE);
        return;
    }
    nameplate_image = base;
    nameplate_relay = relay;
    memcpy(&nameplate_stock_word, base + NAMEPLATE_WORD_RVA, sizeof(nameplate_stock_word));
    memcpy(&nameplate_relay_word, replacement, sizeof(nameplate_relay_word));
    memcpy(&nameplate_color_stock_word, base + NAMEPLATE_COLOR_WORD_RVA, sizeof(nameplate_color_stock_word));
    memcpy(&nameplate_color_relay_word, color_replacement, sizeof(nameplate_color_relay_word));
    if (nameplate_exchange(base + NAMEPLATE_COLOR_WORD_RVA,
            nameplate_color_stock_word, nameplate_color_relay_word) &&
        nameplate_exchange(base + NAMEPLATE_WORD_RVA, nameplate_stock_word, nameplate_relay_word)) {
        patch_log("ROTK spectator names: solid nameplate text installed; selected color preserved.\n");
    } else {
        (void)nameplate_restore();
        patch_log("ROTK spectator names: guarded formatter installation refused.\n");
    }
}
#endif
