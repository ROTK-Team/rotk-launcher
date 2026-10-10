#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static BYTE *failure_word;
static LONG flush_failures, restore_failures, writable_failures;
static BOOL WINAPI test_protect(LPVOID address, SIZE_T size, DWORD protection,
                               PDWORD previous) {
    if (address == failure_word && protection == PAGE_EXECUTE_READ && restore_failures > 0) {
        --restore_failures; return FALSE;
    }
    if (address == failure_word && protection == PAGE_EXECUTE_READWRITE && writable_failures > 0) {
        --writable_failures; return FALSE;
    }
    return VirtualProtect(address, size, protection, previous);
}
static BOOL WINAPI test_flush(HANDLE process, LPCVOID address, SIZE_T size) {
    if (address == failure_word && flush_failures > 0) {
        --flush_failures; return FALSE;
    }
    return FlushInstructionCache(process, address, size);
}
#define VirtualProtect test_protect
#define FlushInstructionCache test_flush
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

typedef uint32_t (*fixture_fn)(void);
static fixture_fn fixture;
static volatile LONG fixture_stop, fixture_failed;
static volatile LONG64 fixture_calls;

static DWORD WINAPI exercise_call(LPVOID parameter) {
    (void)parameter;
    while (!InterlockedCompareExchange(&fixture_stop, 0, 0)) {
        uint32_t value = fixture();
        if (value != 0U && value != UINT32_MAX) InterlockedExchange(&fixture_failed, 1);
        InterlockedIncrement64(&fixture_calls);
    }
    return 0U;
}

static void protect_rx(BYTE *memory, SIZE_T size) {
    DWORD previous;
    assert(VirtualProtect(memory, size, PAGE_EXECUTE_READ, &previous));
    assert(FlushInstructionCache(GetCurrentProcess(), memory, size));
}

static void write_caller(BYTE *entry, BYTE *formatter) {
    const BYTE begin[] = {0x48,0x83,0xec,0x28,0x45,0x33,0xc0};
    const BYTE finish[] = {0x90,0x48,0x83,0xc4,0x28,0xc3};
    int32_t relative;
    memcpy(entry, begin, sizeof(begin));
    entry[15] = 0x48;
    memcpy(entry + 16, nameplate_guard + NAMEPLATE_WORD_RVA - NAMEPLATE_GUARD_RVA, 8);
    assert(nameplate_relative((uintptr_t)formatter, (uintptr_t)entry + 24, &relative));
    memcpy(entry + 20, &relative, sizeof(relative));
    memcpy(entry + 24, finish, sizeof(finish));
}

static void exercise_solid_filter(void) {
    const SIZE_T image_size = 0x1b6d000;
    BYTE *image = VirtualAlloc(NULL, image_size, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(image != NULL);
    memset(image, 0x90, image_size);
    BYTE *word = image + NAMEPLATE_COLOR_WORD_RVA;
    BYTE *formatter = word - 4;
    BYTE *rich = image + NAMEPLATE_WORD_RVA - 16;
    BYTE *other = image + 0x3000;
    BYTE *relay = image + 0x4000;
    const BYTE stack[] = {0x48,0x83,0xec,0x38};
    const BYTE finish[] = {0x48,0x83,0xc4,0x38,0xc3};
    const BYTE return_filters[] = {0x8b,0x41,0x40,0xc3};
    memcpy(formatter, stack, sizeof(stack));
    word[0] = 0xe8;
    int32_t relative;
    assert(nameplate_relative((uintptr_t)(image + 0x1ed21),
                             (uintptr_t)word + 5, &relative));
    memcpy(word + 1, &relative, sizeof(relative));
    memcpy(word + 5, finish, sizeof(finish));
    memcpy(image + 0x1ed21, return_filters, sizeof(return_filters));
    write_caller(rich, formatter);
    write_caller(other, formatter);
    BYTE replacement[8];
    assert(nameplate_build_solid_relay(relay, (uintptr_t)relay, image, replacement));
    protect_rx(image, image_size);
    typedef uint32_t (*filter_fn)(BYTE *);
    filter_fn rich_call = (filter_fn)(uintptr_t)rich;
    filter_fn other_call = (filter_fn)(uintptr_t)other;
    BYTE format[72] = {0};
    uint32_t filters = 3;
    memcpy(format + 0x40, &filters, sizeof(filters));
    assert(rich_call(format) == 3);
    assert(other_call(format) == 3);

    nameplate_image = image;
    memcpy(&nameplate_stock_word, image + NAMEPLATE_WORD_RVA, 8);
    nameplate_relay_word = nameplate_stock_word;
    memcpy(&nameplate_color_stock_word, word, 8);
    memcpy(&nameplate_color_relay_word, replacement, 8);
    assert(nameplate_exchange(word, nameplate_color_stock_word, nameplate_color_relay_word));
    assert(rich_call(format) == 0);
    memcpy(format + 0x40, &filters, sizeof(filters));
    assert(other_call(format) == 3);
    assert(nameplate_restore());
    assert(rich_call(format) == 3);
    nameplate_image = NULL;
    assert(VirtualFree(image, 0, MEM_RELEASE));
}

int main(void) {
    int32_t relative;
    BYTE relay_bytes[NAMEPLATE_RELAY_SIZE], replacement[8];
    assert(nameplate_relative(0x1000, 0x2000, &relative) && relative == -0x1000);
    assert(nameplate_relative(0x2000, 0x1000, &relative) && relative == 0x1000);
    assert(nameplate_relative(0x180000000ULL, 0x100000000ULL, &relative) == FALSE);
    assert(nameplate_relative(0x80000000ULL, 0x100000000ULL, &relative) && relative == INT32_MIN);
    assert(!nameplate_build_relay(relay_bytes, 0x1000, 0x2000, replacement, 0x100000000ULL));

    BYTE *memory = VirtualAlloc(NULL, 8192, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(memory != NULL);
    BYTE *word = memory + 16, *formatter = memory + 128, *relay = memory + 256;
    /* The fixture CALL has exactly the native aligned QWORD layout and return
     * address. Formatter returns the incoming R8D multiplier. No game code runs. */
    const BYTE begin[] = {0x48,0x83,0xec,0x28,0x45,0x33,0xc0};
    const BYTE finish[] = {0x90,0x48,0x83,0xc4,0x28,0xc3};
    const BYTE return_color[] = {0x44,0x89,0xc0,0xc3};
    memset(memory, 0x90, 8192);
    memcpy(memory, begin, sizeof(begin));
    memory[15] = 0x48;
    memcpy(word, nameplate_guard + NAMEPLATE_WORD_RVA - NAMEPLATE_GUARD_RVA, 8);
    assert(nameplate_relative((uintptr_t)formatter, (uintptr_t)word + 8, &relative));
    memcpy(word + 4, &relative, sizeof(relative));
    memcpy(word + 8, finish, sizeof(finish));
    memcpy(formatter, return_color, sizeof(return_color));
    assert(nameplate_build_relay(relay, (uintptr_t)relay, (uintptr_t)formatter,
                                replacement, (uintptr_t)word));
    uint64_t stock, patched;
    memcpy(&stock, word, sizeof(stock));
    memcpy(&patched, replacement, sizeof(patched));
    assert((stock & UINT64_C(0xffffffff)) == (patched & UINT64_C(0xffffffff)));
    protect_rx(memory, 8192);
    fixture = (fixture_fn)(uintptr_t)memory;
    assert(fixture() == 0U);
    assert(!nameplate_exchange(word + 1, stock, patched));
    assert(!nameplate_exchange(word, stock ^ 1U, patched));
    assert(fixture() == 0U);
    failure_word = word;
    flush_failures = 1;
    assert(!nameplate_exchange(word, stock, patched));
    assert(fixture() == 0U);
    restore_failures = 3;
    assert(!nameplate_exchange(word, stock, patched));
    assert(fixture() == 0U);
    writable_failures = 1;
    assert(!nameplate_exchange(word, stock, patched));
    assert(fixture() == 0U);
    MEMORY_BASIC_INFORMATION info;
    assert(VirtualQuery(memory, &info, sizeof(info)) == sizeof(info));
    assert(info.Protect == PAGE_EXECUTE_READ);
    failure_word = NULL;
    assert(nameplate_exchange(word, stock, patched));
    assert(fixture() == UINT32_MAX);

    nameplate_image = word - NAMEPLATE_WORD_RVA;
    nameplate_relay = relay;
    nameplate_stock_word = stock;
    nameplate_relay_word = patched;
    memcpy(&nameplate_color_stock_word,
           nameplate_image + NAMEPLATE_COLOR_WORD_RVA, 8);
    nameplate_color_relay_word = nameplate_color_stock_word;
    assert(nameplate_restore());
    assert(nameplate_restore());
    assert(fixture() == 0U);
    assert(VirtualQuery(memory, &info, sizeof(info)) == sizeof(info));
    assert(info.Protect == PAGE_EXECUTE_READ);

    /* Four threads execute the actual CALL while the marker-equivalent restore
     * and install alternate. No partial CALL or freed relay may become visible. */
    HANDLE threads[4];
    for (unsigned int i = 0; i < ARRAYSIZE(threads); ++i) {
        threads[i] = CreateThread(NULL, 0, exercise_call, NULL, 0, NULL);
        assert(threads[i] != NULL);
    }
    for (unsigned int i = 0; i < 200; ++i) {
        assert(nameplate_exchange(word, stock, patched));
        assert(nameplate_restore());
    }
    InterlockedExchange(&fixture_stop, 1);
    assert(WaitForMultipleObjects(ARRAYSIZE(threads), threads, TRUE, 10000) == WAIT_OBJECT_0);
    for (unsigned int i = 0; i < ARRAYSIZE(threads); ++i) CloseHandle(threads[i]);
    assert(!fixture_failed && fixture_calls > 0);
    assert(fixture() == 0U);
    assert(VirtualQuery(memory, &info, sizeof(info)) == sizeof(info));
    assert(info.Protect == PAGE_EXECUTE_READ);

    /* BR1315 keeps its unpacked image pages RWX. Preserve that original
     * protection as well; do not require the retail loader to convert to RX. */
    DWORD prior;
    assert(VirtualProtect(memory, 4096, PAGE_EXECUTE_READWRITE, &prior));
    assert(nameplate_exchange(word, stock, patched));
    assert(fixture() == UINT32_MAX);
    assert(nameplate_restore());
    assert(VirtualQuery(memory, &info, sizeof(info)) == sizeof(info));
    assert(info.Protect == PAGE_EXECUTE_READWRITE);
    protect_rx(memory, 4096);

    /* Full unpacked signatures must match, including the selected color path.
     * This is a private allocation, never the executable module or a client. */
    BYTE *image = VirtualAlloc(NULL, 0x1b6d000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(image != NULL);
    memcpy(image + 0x1b6aa00, nameplate_prologue, sizeof(nameplate_prologue));
    memcpy(image + NAMEPLATE_GUARD_RVA, nameplate_guard, sizeof(nameplate_guard));
    memcpy(image + 0x1b6c4a0, nameplate_format_guard, sizeof(nameplate_format_guard));
    memcpy(image + 0x1b6c4e0, nameplate_format_tail, sizeof(nameplate_format_tail));
    memcpy(image + NAMEPLATE_FORMAT_RVA, nameplate_format_thunk, sizeof(nameplate_format_thunk));
    protect_rx(image + NAMEPLATE_GUARD_RVA, sizeof(nameplate_guard));
    assert(nameplate_signatures_ready(image));
    DWORD previous;
    assert(VirtualProtect(image + NAMEPLATE_GUARD_RVA, sizeof(nameplate_guard), PAGE_EXECUTE_READWRITE, &previous));
    assert(nameplate_signatures_ready(image));
    assert(VirtualProtect(image + NAMEPLATE_GUARD_RVA, sizeof(nameplate_guard), PAGE_READWRITE, &previous));
    assert(!nameplate_signatures_ready(image));
    image[NAMEPLATE_GUARD_RVA + sizeof(nameplate_guard) - 1] ^= 1U;
    protect_rx(image + NAMEPLATE_GUARD_RVA, sizeof(nameplate_guard));
    assert(!nameplate_signatures_ready(image));
    assert(VirtualFree(image, 0, MEM_RELEASE));
    nameplate_image = NULL;
    nameplate_relay = NULL;
    assert(VirtualFree(memory, 0, MEM_RELEASE));
    exercise_solid_filter();
    printf("PASS spectator names: opaque relay, caller-scoped solid filter, original CALL/return, guards, RX and cache failure rollback, marker rollback and %lld concurrent calls.\n",
           (long long)fixture_calls);
    return 0;
}
