#ifndef ROTK_VOICE_RANK_PATCH_H
#define ROTK_VOICE_RANK_PATCH_H

/* BR1315 VoiceRecentParticipants Tier/Subtier must retain Voice.Identity.
 * The retail getters overwrite the row with the actor's rank, including the
 * local/lightweight actor's zero. Only the two conditional branches change;
 * names, audio, actor state and the kill-feed data source are untouched.
 * Executed at the first Vivox poll, after the client has unpacked its code.
 * The launcher pins the client build, so the getter is not compared with its
 * original bytes: only the two branch opcodes are read and written.
 */
#define VOICE_RANK_RVA 0x01ae9d4eU
#define VOICE_RANK_TIER_BRANCH 29U
#define VOICE_RANK_SUBTIER_BRANCH 82U
#define VOICE_RANK_SPAN (VOICE_RANK_SUBTIER_BRANCH + 1U)

/* 1: installed (now or already), -2: protection/cache failure. */
static int voice_rank_patch_code(unsigned char *code) {
    DWORD old_protection, ignored;
    if (code[VOICE_RANK_TIER_BRANCH] == 0xeb &&
        code[VOICE_RANK_SUBTIER_BRANCH] == 0xeb) return 1;
    if (!VirtualProtect(code, VOICE_RANK_SPAN, PAGE_EXECUTE_READWRITE,
                        &old_protection)) return -2;
    code[VOICE_RANK_TIER_BRANCH] = 0xeb;
    code[VOICE_RANK_SUBTIER_BRANCH] = 0xeb;
    BOOL flushed = FlushInstructionCache(GetCurrentProcess(), code,
                                         VOICE_RANK_SPAN);
    BOOL restored = VirtualProtect(code, VOICE_RANK_SPAN,
                                    old_protection, &ignored);
    return flushed && restored ? 1 : -2;
}

static BOOL CALLBACK voice_rank_initialize(PINIT_ONCE once, PVOID parameter,
                                           PVOID *context) {
    (void)once; (void)parameter; (void)context;
    unsigned char *base = (unsigned char *)GetModuleHandleW(NULL);
    MEMORY_BASIC_INFORMATION memory;
    int result = -1;
    if (base != NULL) {
        IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
        if (dos->e_magic == IMAGE_DOS_SIGNATURE && dos->e_lfanew > 0 &&
            dos->e_lfanew < 0x100000) {
            IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(base + dos->e_lfanew);
            if (nt->Signature == IMAGE_NT_SIGNATURE &&
                nt->FileHeader.Machine == IMAGE_FILE_MACHINE_AMD64 &&
                nt->OptionalHeader.Magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC &&
                nt->OptionalHeader.SizeOfImage >= VOICE_RANK_RVA + VOICE_RANK_SPAN) {
                unsigned char *code = base + VOICE_RANK_RVA;
                if (VirtualQuery(code, &memory, sizeof(memory)) == sizeof(memory) &&
                    memory.State == MEM_COMMIT && memory.Type == MEM_IMAGE &&
                    !(memory.Protect & (PAGE_GUARD | PAGE_NOACCESS)) &&
                    (memory.Protect & (PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                       PAGE_EXECUTE_WRITECOPY)) &&
                    (uintptr_t)memory.BaseAddress + memory.RegionSize >=
                        (uintptr_t)code + VOICE_RANK_SPAN) {
                    result = voice_rank_patch_code(code);
                }
            }
        }
    }
    proxy_trace_line(result == 1
        ? "[voice-rank] Voice.Identity HUD source installed"
        : result == -2 ? "[voice-rank] HUD patch protection/cache failure"
        : "[voice-rank] unsupported HUD code; voice audio remains available");
    return TRUE;
}

static INIT_ONCE voice_rank_once = INIT_ONCE_STATIC_INIT;
static void voice_rank_ensure_initialized(void) {
    (void)InitOnceExecuteOnce(&voice_rank_once, voice_rank_initialize, NULL, NULL);
}
#endif
