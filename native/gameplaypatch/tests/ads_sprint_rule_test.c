#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static BOOL WINAPI test_virtual_protect(LPVOID address, SIZE_T bytes, DWORD protection, PDWORD old);
#define VirtualProtect test_virtual_protect
#define DirectInput8Create RotkTestDirectInput8Create
#define DllCanUnloadNow RotkTestDllCanUnloadNow
#define DllGetClassObject RotkTestDllGetClassObject
#define DllRegisterServer RotkTestDllRegisterServer
#define DllUnregisterServer RotkTestDllUnregisterServer
#define GetdfDIJoystick RotkTestGetdfDIJoystick
#define DllMain RotkTestDllMain
#include "../dinput8_proxy.c"
#undef VirtualProtect
#undef NDEBUG
#include <assert.h>

static BYTE *refused_word;
static BOOL WINAPI test_virtual_protect(LPVOID address, SIZE_T bytes, DWORD protection, PDWORD old) {
    if (address == refused_word && protection == PAGE_EXECUTE_READWRITE) {
        SetLastError(ERROR_ACCESS_DENIED); return FALSE;
    }
    return VirtualProtect(address, bytes, protection, old);
}

static BYTE *image;
static volatile LONG reading;
static void place(uint32_t rva, const BYTE *bytes, SIZE_T size) {
    DWORD old;
    assert(VirtualProtect(image + (rva & ~0xfffU), 0x2000, PAGE_READWRITE, &old));
    memcpy(image + rva, bytes, size);
    assert(VirtualProtect(image + (rva & ~0xfffU), 0x2000, PAGE_EXECUTE_READ, &old));
}
static void stock(void) {
    place(0x10474d1, ads_rule_weapon_guard, sizeof(ads_rule_weapon_guard));
    place(0x1666814, ads_rule_fire_guard, sizeof(ads_rule_fire_guard));
}
static BOOL holds(unsigned int i, const BYTE *bytes) {
    return memcmp(image + ads_rule_sites[i], bytes, 5) == 0;
}
static void assert_protection(unsigned int i) {
    MEMORY_BASIC_INFORMATION info;
    assert(VirtualQuery(image + ads_rule_sites[i], &info, sizeof(info)) == sizeof(info));
    assert(info.Protect == PAGE_EXECUTE_READ);
}
/* Instruction fetch must only ever see the whole CALL or the whole MOV. */
static DWORD WINAPI observe(LPVOID unused) {
    (void)unused;
    while (InterlockedCompareExchange(&reading, 0, 0)) {
        LONG64 word = *(volatile LONG64 *)(image + 0x1666828);
        assert(!memcmp((BYTE *)&word + 2, ads_rule_calls[1], 5) || !memcmp((BYTE *)&word + 2, ads_rule_kept, 5));
    }
    return 0;
}

int main(void) {
    HANDLE observer;
    image = VirtualAlloc(NULL, 0x1670000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(image);
    stock();

    /* A different client build is left untouched. */
    {
        BYTE other[sizeof(ads_rule_fire_guard)];
        memcpy(other, ads_rule_fire_guard, sizeof(other)); other[8] = 0x02;
        place(0x1666814, other, sizeof(other));
        ads_rule_install(image);
        assert(holds(0, ads_rule_calls[0]) && !ads_rule_installed);
        stock();
    }

    ads_rule_install(image);
    assert(ads_rule_installed);
    assert(holds(0, ads_rule_kept) && holds(1, ads_rule_kept));
    assert(!memcmp(image + 0x10474d1, ads_rule_weapon_guard, 7));
    assert(!memcmp(image + 0x10474dd, ads_rule_weapon_guard + 12, sizeof(ads_rule_weapon_guard) - 12));
    assert(!memcmp(image + 0x1666814, ads_rule_fire_guard, 22));
    assert(!memcmp(image + 0x166682f, ads_rule_fire_guard + 27, sizeof(ads_rule_fire_guard) - 27));
    assert_protection(0); assert_protection(1);

    assert(ads_rule_restore(image));
    assert(!ads_rule_installed && holds(0, ads_rule_calls[0]) && holds(1, ads_rule_calls[1]));
    assert_protection(0); assert_protection(1);
    assert(ads_rule_restore(image));

    /* A refused second site rolls the first back to the stock call. */
    refused_word = image + 0x1666828;
    ads_rule_install(image);
    assert(!ads_rule_installed && holds(0, ads_rule_calls[0]) && holds(1, ads_rule_calls[1]));
    assert_protection(0); assert_protection(1);
    refused_word = NULL;

    InterlockedExchange(&reading, 1);
    observer = CreateThread(NULL, 0, observe, NULL, 0, NULL);
    assert(observer);
    for (unsigned int i = 0; i < 500; ++i) {
        ads_rule_install(image);
        assert(ads_rule_installed);
        assert(ads_rule_restore(image));
    }
    InterlockedExchange(&reading, 0);
    assert(WaitForSingleObject(observer, 5000) == WAIT_OBJECT_0);
    CloseHandle(observer);
    assert(holds(0, ads_rule_calls[0]) && holds(1, ads_rule_calls[1]));
    VirtualFree(image, 0, MEM_RELEASE);
    return 0;
}
