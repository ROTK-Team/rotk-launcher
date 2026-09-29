/* BR1315 CZ loading continuation. The native reader adds ImageBase to this
 * aligned qword, but the unpacked retail qword already contains a VA.
 * 0x140000000 + 0x140f6f676 == the observed fault 0x280f6f676.
 * Normalize only this operand; leave the reader, continuation and base intact.
 * Called only after executable validation and unpacking signature stabilization.
 * This repair lasts for the process lifetime (restart restores the disk image).
 */
#define RESPAWN_OPERAND_RVA 0x00f545e8U
#define RESPAWN_BASE_RVA 0x011627b8U
#define RESPAWN_READER_RVA 0x00dfb775U
#define RESPAWN_CONTINUATION_RVA 0x00f6f676U
static const BYTE respawn_reader_guard[] = {
    0x48,0x8b,0x05,0x3c,0x70,0x36,0x00,
    0x48,0x03,0x05,0x65,0x8e,0x15,0x00,
    0x48,0x89,0x45,0x00,0x48,0x8b,0x45,0x00,
    0x48,0x8d,0x4d,0x70,0x48,0x83,0xe9,0x08,
    0x48,0x89,0x01,0x48,0x8b,0x5d,0x40,
    0x48,0x8d,0x65,0x60,0x48,0x8b,0x2c,0x24,
    0x48,0x8d,0x64,0x24,0x08,0x48,0x8d,0x64,0x24,0x08,
    0xff,0x64,0x24,0xf8
};
static const BYTE respawn_continuation_guard[] = {0xe9,0x04,0x6d,0xf9,0xff};

/* 1: repaired/already repaired, 0: unsupported, -1: OS operation failed. */
static int respawn_address_install(BYTE *base) {
    uint64_t image_base = 0, operand = 0;
    SIZE_T done = 0;
    DWORD old;
    volatile LONG64 *slot = (volatile LONG64 *)(base + RESPAWN_OPERAND_RVA);
    if (((uintptr_t)slot & 7U) ||
        !exact_bytes(base + RESPAWN_READER_RVA, respawn_reader_guard, sizeof(respawn_reader_guard)) ||
        !exact_bytes(base + RESPAWN_CONTINUATION_RVA, respawn_continuation_guard, sizeof(respawn_continuation_guard)) ||
        !ReadProcessMemory(GetCurrentProcess(), base + RESPAWN_BASE_RVA,
                           &image_base, sizeof(image_base), &done) || done != sizeof(image_base) ||
        image_base != (uintptr_t)base ||
        !ReadProcessMemory(GetCurrentProcess(), (const void *)slot,
                           &operand, sizeof(operand), &done) || done != sizeof(operand)) return 0;
    if (operand == RESPAWN_CONTINUATION_RVA) return 1;
    if (operand != image_base + RESPAWN_CONTINUATION_RVA) return 0;
    if (!VirtualProtect((void *)slot, sizeof(*slot), PAGE_EXECUTE_READWRITE, &old)) return -1;
    /* An aligned atomic exchange prevents readers from seeing a torn pointer.
     * Refuse a changed operand instead of overwriting an unknown patch. */
    LONG64 previous = InterlockedCompareExchange64(slot, RESPAWN_CONTINUATION_RVA, (LONG64)operand);
    BOOL restored = restore_page_protection((void *)slot, sizeof(*slot), old);
    if (!restored) return -1;
    return (uint64_t)previous == operand || previous == RESPAWN_CONTINUATION_RVA ? 1 : 0;
}
