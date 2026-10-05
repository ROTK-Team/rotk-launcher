#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#undef NDEBUG
#include <assert.h>
static int log_count;
static void proxy_trace_line(const char *message) {
    assert(strstr(message, "unsupported HUD code") != NULL);
    log_count++;
}
#include "../voice_rank_patch.h"

/* BR1315 getter at VOICE_RANK_RVA. */
static const unsigned char voice_rank_original[] = {
    0x48,0x8b,0x47,0x10,0x48,0x89,0x44,0x24,0x20,0x48,0x8d,0x54,0x24,0x20,0x48,0x8b,
    0x0d,0x2d,0x35,0xc8,0x02,0xe8,0x1b,0x7c,0x51,0xfe,0x48,0x85,0xc0,0x74,0x0d,0x33,
    0xd2,0x48,0x8b,0xc8,0xe8,0x68,0x60,0x52,0xfe,0x89,0x47,0x78,0x44,0x8b,0x47,0x78,
    0xe9,0xd0,0xfe,0xff,0xff,0x48,0x8b,0x47,0x10,0x48,0x89,0x44,0x24,0x28,0x48,0x8d,
    0x54,0x24,0x28,0x48,0x8b,0x0d,0xf8,0x34,0xc8,0x02,0xe8,0xe6,0x7b,0x51,0xfe,0x48,
    0x85,0xc0,0x74,0x0d,0x33,0xd2,0x48,0x8b,0xc8,0xe8,0x33,0xcb,0x5a,0xfe,0x89,0x47,
    0x7c,0x44,0x8b,0x47,0x7c,0xe9,0x9b,0xfe,0xff,0xff
};

/* Only the two branch opcodes may differ from the bytes found before patching. */
static void assert_branches_only(const unsigned char *code, const unsigned char *before) {
    for (size_t i = 0; i < sizeof(voice_rank_original); i++) {
        assert(code[i] == ((i == VOICE_RANK_TIER_BRANCH || i == VOICE_RANK_SUBTIER_BRANCH)
            ? 0xeb : before[i]));
    }
}

int main(int argc, char **argv) {
    unsigned char *memory = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    assert(memory != NULL);
    const size_t length = sizeof(voice_rank_original);
    assert(length == 106);
    for (size_t index = 0; index < length; index++) {
        if (index == VOICE_RANK_TIER_BRANCH || index == VOICE_RANK_SUBTIER_BRANCH) continue;
        memcpy(memory, voice_rank_original, length);
        memory[index] ^= 1;
        unsigned char before[sizeof(voice_rank_original)];
        memcpy(before, memory, length);
        assert(voice_rank_patch_code(memory) == 1);
        assert_branches_only(memory, before);
    }
    memcpy(memory, voice_rank_original, length);
    memory[VOICE_RANK_TIER_BRANCH] = 0xeb;
    assert(voice_rank_patch_code(memory) == 1);
    assert_branches_only(memory, voice_rank_original);
    memcpy(memory, voice_rank_original, length);
    DWORD ignored;
    assert(VirtualProtect(memory, 4096, PAGE_EXECUTE_READ, &ignored));
    assert(voice_rank_patch_code(memory) == 1);
    assert(voice_rank_patch_code(memory) == 1);
    MEMORY_BASIC_INFORMATION info;
    assert(VirtualQuery(memory, &info, sizeof(info)) == sizeof(info));
    assert(info.Protect == PAGE_EXECUTE_READ);
    assert_branches_only(memory, voice_rank_original);
    if (argc == 2) {
        FILE *output = fopen(argv[1], "wb");
        assert(output != NULL);
        assert(fwrite(memory, 1, length, output) == length);
        assert(fclose(output) == 0);
    }
    voice_rank_ensure_initialized();
    voice_rank_ensure_initialized();
    assert(log_count == 1); /* Unsupported host stays untouched; init is once. */
    assert(VirtualFree(memory, 0, MEM_RELEASE));
    puts("PASS voice HUD patch: installs whatever the other 104 bytes hold, partial patch completed, exactly two code bytes changed, idempotence, protection restored, unsupported host skipped once.");
    return 0;
}
