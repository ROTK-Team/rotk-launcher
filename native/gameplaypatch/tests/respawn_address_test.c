#define DirectInput8Create RotkTestDirectInput8Create
#define DllCanUnloadNow RotkTestDllCanUnloadNow
#define DllGetClassObject RotkTestDllGetClassObject
#define DllRegisterServer RotkTestDllRegisterServer
#define DllUnregisterServer RotkTestDllUnregisterServer
#define GetdfDIJoystick RotkTestGetdfDIJoystick
#define DllMain RotkTestDllMain
#include "../dinput8_proxy.c"
#undef NDEBUG
#include <assert.h>

static LONG WINAPI report_fault(EXCEPTION_POINTERS *fault) {
    fprintf(stderr, "Native reader fault: code=%08lx address=%p\n",
            fault->ExceptionRecord->ExceptionCode, fault->ExceptionRecord->ExceptionAddress);
    fflush(stderr);
    return EXCEPTION_EXECUTE_HANDLER;
}

int main(int argc, char **argv) {
    DWORD old;
    /* Reserve the real image base so the uncorrected native reader produces
     * the exact address recorded by Windows in the user's crash dumps. */
    BYTE *image = VirtualAlloc((void *)UINT64_C(0x140000000), 0x1200000,
                              MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(image == (void *)UINT64_C(0x140000000));
    uint64_t *operand = (uint64_t *)(image + RESPAWN_OPERAND_RVA);
    memcpy(image + RESPAWN_READER_RVA, respawn_reader_guard, sizeof(respawn_reader_guard));
    memcpy(image + RESPAWN_CONTINUATION_RVA, respawn_continuation_guard, sizeof(respawn_continuation_guard));
    *(uint64_t *)(image + RESPAWN_BASE_RVA) = (uintptr_t)image;
    *operand = (uintptr_t)image + RESPAWN_CONTINUATION_RVA;
    /* Native epilogue restores RBP/RBX and tail-jumps with the caller's RSP.
     * Arrange its frame, then execute the exact retail reader. */
    const BYTE enter[] = {0x48,0x83,0xec,0x70, 0x48,0x89,0x5c,0x24,0x40,
        0x48,0x89,0x6c,0x24,0x60, 0x48,0x89,0xe5};
    memcpy(image + 0x1000, enter, sizeof(enter));
    stance_jump(image + 0x1000 + sizeof(enter), image + RESPAWN_READER_RVA);
    memcpy(image + 0xf0637f, "\xb8\x2a\x00\x00\x00\xc3", 6);
    assert(VirtualProtect(image, 0x1200000, PAGE_EXECUTE_READ, &old));
    assert(FlushInstructionCache(GetCurrentProcess(), image, 0x1200000));
    if (argc > 1 && !strcmp(argv[1], "--unpatched")) {
        SetErrorMode(SEM_NOGPFAULTERRORBOX | SEM_FAILCRITICALERRORS);
        SetUnhandledExceptionFilter(report_fault);
        return ((int (*)(void))(uintptr_t)(image + 0x1000))();
    }
    assert(respawn_address_install(image) == 1);
    assert(*operand == RESPAWN_CONTINUATION_RVA);
    assert(respawn_address_install(image) == 1);
    for (int i = 0; i < 10000; ++i)
        assert(((int (*)(void))(uintptr_t)(image + 0x1000))() == 42);
    MEMORY_BASIC_INFORMATION info;
    assert(VirtualQuery(operand, &info, sizeof(info)) == sizeof(info));
    assert(info.Protect == PAGE_EXECUTE_READ);
    assert(*(uint64_t *)(image + RESPAWN_BASE_RVA) == (uintptr_t)image);
    assert(!memcmp(image + RESPAWN_READER_RVA, respawn_reader_guard, sizeof(respawn_reader_guard)));
    assert(VirtualProtect(image, 0x1200000, PAGE_READWRITE, &old));
    *operand = 0x1234;
    assert(respawn_address_install(image) == 0 && *operand == 0x1234);
    *operand = (uintptr_t)image + RESPAWN_CONTINUATION_RVA;
    image[RESPAWN_READER_RVA] ^= 1;
    assert(respawn_address_install(image) == 0);
    image[RESPAWN_READER_RVA] ^= 1;
    image[RESPAWN_CONTINUATION_RVA] ^= 1;
    assert(respawn_address_install(image) == 0);
    image[RESPAWN_CONTINUATION_RVA] ^= 1;
    *(uint64_t *)(image + RESPAWN_BASE_RVA) = 0;
    assert(respawn_address_install(image) == 0);
    assert(*operand == (uintptr_t)image + RESPAWN_CONTINUATION_RVA);
    VirtualFree(image, 0, MEM_RELEASE);
    puts("CZ respawn: 10000 native continuations; guards, idempotence and RX restoration passed.");
    return 0;
}
