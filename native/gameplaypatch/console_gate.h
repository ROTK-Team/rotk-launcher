/* Stock debug console for every player. The native ToggleDebugConsole handler
 * only forwards EVENT_TOGGLE_DEBUG_CONSOLE to the UI on internal builds or for
 * the SendSelf admin flag, so ~ did nothing in retail. Turn that one je into
 * jmp; the key, the UI and every server permission check stay stock.
 * Restored by the marker watchdog; a restart restores the disk image.
 */
#define CONSOLE_GATE_SIGNATURE_RVA UINT32_C(0x00f823e9)
#define CONSOLE_GATE_OFFSET 8U
#define CONSOLE_GATE_STOCK 0x74U
#define CONSOLE_GATE_VALUE 0xEBU
/* call build_type; cmp eax,1; je ui; mov rax,[rbx+37680h]; mov rcx,[rax+1710h];
 * test rcx,rcx; jz skip; cmp byte [rcx+108F9h],0; je skip */
static const BYTE console_gate_signature[] = {
    0xe8,0x84,0x11,0x0c,0xff,0x83,0xf8,0x01,0x74,0x20,
    0x48,0x8b,0x83,0x80,0x76,0x03,0x00,0x48,0x8b,0x88,0x10,0x17,0x00,0x00,
    0x48,0x85,0xc9,0x0f,0x84,0x81,0x00,0x00,0x00,
    0x80,0xb9,0xf9,0x08,0x01,0x00,0x00,0x74,0x78
};

static BOOL console_gate_install(BYTE *base) {
    return exact_bytes(base + CONSOLE_GATE_SIGNATURE_RVA, console_gate_signature, sizeof(console_gate_signature)) &&
        write_guarded_byte(base + CONSOLE_GATE_SIGNATURE_RVA + CONSOLE_GATE_OFFSET,
                           CONSOLE_GATE_STOCK, CONSOLE_GATE_VALUE);
}

static BOOL console_gate_restore(BYTE *base) {
    BYTE *gate = base + CONSOLE_GATE_SIGNATURE_RVA + CONSOLE_GATE_OFFSET, value = 0;
    if (!read_byte(gate, &value) || value != CONSOLE_GATE_VALUE) return TRUE;
    return write_guarded_byte(gate, CONSOLE_GATE_VALUE, CONSOLE_GATE_STOCK);
}
