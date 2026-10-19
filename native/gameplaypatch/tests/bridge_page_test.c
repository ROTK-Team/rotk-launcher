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

static BOOL page_is(const BYTE *page, DWORD state) {
    MEMORY_BASIC_INFORMATION region;
    return VirtualQuery(page, &region, sizeof(region)) == sizeof(region) && region.State == state &&
        (state != MEM_COMMIT || region.Protect == PAGE_READWRITE);
}

static void write_headers(BYTE *header, LONG offset, DWORD image_size) {
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS64 nt;
    memset(header, 0, BRIDGE_PAGE_SIZE);
    memset(&dos, 0, sizeof(dos));
    memset(&nt, 0, sizeof(nt));
    dos.e_magic = IMAGE_DOS_SIGNATURE;
    dos.e_lfanew = offset;
    nt.Signature = IMAGE_NT_SIGNATURE;
    nt.FileHeader.Machine = IMAGE_FILE_MACHINE_AMD64;
    nt.FileHeader.TimeDateStamp = ROTK_H1Z1_TIMESTAMP;
    nt.OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC;
    nt.OptionalHeader.SizeOfImage = image_size;
    memcpy(header, &dos, sizeof(dos));
    if (offset > 0 && offset <= (LONG)(BRIDGE_PAGE_SIZE - sizeof(nt))) memcpy(header + offset, &nt, sizeof(nt));
}

int main(void) {
    static BYTE header[BRIDGE_PAGE_SIZE];
    SYSTEM_INFO info;
    BYTE *span, *base, *page, *window, *below, *image, *bridge, *lowest, *rest;
    DWORD old, granularity;
    int32_t relative;
    unsigned int i;

    GetSystemInfo(&info);
    granularity = info.dwAllocationGranularity;

    /* The test executable is not H1Z1: the DllMain step reserves nothing. */
    bridge_block_reserve();
    assert(bridge_block == NULL && bridge_block_base == NULL);
    write_headers(header, 0x100, ROTK_H1Z1_IMAGE_SIZE);
    assert(bridge_is_h1z1(header));
    write_headers(header, 0x100, ROTK_H1Z1_IMAGE_SIZE + 0x1000U);
    assert(!bridge_is_h1z1(header));
    write_headers(header, (LONG)BRIDGE_PAGE_SIZE, ROTK_H1Z1_IMAGE_SIZE);
    assert(!bridge_is_h1z1(header));

    /* A private 4 GiB span: 2 GiB below the fake image base, then its whole
     * upward window. Nothing here is the executable module or a client. */
    span = VirtualAlloc(NULL, UINT64_C(0x100000000), MEM_RESERVE, PAGE_NOACCESS);
    assert(span != NULL && VirtualFree(span, 0, MEM_RELEASE));
    base = span + UINT64_C(0x80000000);

    /* The early block takes the first bridge address and hands out its pages. */
    bridge_block_reserve_at(base);
    assert(bridge_block == base + BRIDGE_FIRST_DELTA && bridge_block_base == base);
    assert(page_is(bridge_block, MEM_RESERVE));
    for (i = 0; i < BRIDGE_BLOCK_PAGES; ++i) {
        page = bridge_page(base);
        assert(page == bridge_block + i * BRIDGE_PAGE_SIZE && page_is(page, MEM_COMMIT));
    }
    bridge_release(bridge_block + 3U * BRIDGE_PAGE_SIZE);
    assert(page_is(bridge_block + 3U * BRIDGE_PAGE_SIZE, MEM_RESERVE));
    assert(page_is(bridge_block + 4U * BRIDGE_PAGE_SIZE, MEM_COMMIT));
    /* A used-up block falls back to the original upward search. */
    page = bridge_page(base);
    assert(page == bridge_block + granularity && page_is(page, MEM_COMMIT));
    bridge_release(page);
    assert(page_is(page, MEM_FREE));
    /* Another image base never takes pages from this block. */
    page = bridge_page(base + 0x01000000);
    assert(page == base + 0x01000000 + BRIDGE_FIRST_DELTA && page_is(page, MEM_COMMIT));
    bridge_release(page);
    assert(page_is(page, MEM_FREE));
    assert(VirtualFree(bridge_block, 0, MEM_RELEASE));
    bridge_block = bridge_block_base = NULL;
    bridge_block_next = 0;

    /* No block and the whole upward window in use: search below the image,
     * skipping a whole allocation directly under it. */
    window = VirtualAlloc(base + BRIDGE_FIRST_DELTA, BRIDGE_LAST_DELTA - BRIDGE_FIRST_DELTA,
        MEM_RESERVE, PAGE_NOACCESS);
    below = VirtualAlloc(base - 0x01000000, 0x01000000, MEM_RESERVE, PAGE_NOACCESS);
    assert(window == base + BRIDGE_FIRST_DELTA && below == base - 0x01000000);
    page = bridge_page(base);
    assert(page == below - granularity && page_is(page, MEM_COMMIT));
    bridge_release(page);
    assert(page_is(page, MEM_FREE));

    /* The Trio reboot hook still installs there, and its rel32 gate JMP
     * lands on the bridge entry. */
    image = VirtualAlloc(base, 0x1700000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    assert(image == base);
    memcpy(image + REBOOT_ACTOR_RVA, reboot_actor_guard, sizeof(reboot_actor_guard));
    memcpy(image + REBOOT_RESPONSE_RVA, reboot_response_guard, sizeof(reboot_response_guard));
    memcpy(image + 0xee0f20, reboot_selector_guard, sizeof(reboot_selector_guard));
    memcpy(image + 0xf71710, reboot_setter_guard, sizeof(reboot_setter_guard));
    memcpy(image + 0x10876b0, reboot_hidden_guard, sizeof(reboot_hidden_guard));
    memcpy(image + 0x16d5131, reboot_match_guard, sizeof(reboot_match_guard));
    assert(VirtualProtect(image, 0x1700000, PAGE_EXECUTE_READ, &old));
    assert(FlushInstructionCache(GetCurrentProcess(), image, 0x1700000));
    reboot_install(image);
    bridge = (BYTE *)(uintptr_t)reboot_original_actor;
    assert(reboot_enabled && bridge == below - granularity);
    assert(image[REBOOT_RESPONSE_RVA] == 0xe9);
    memcpy(&relative, image + REBOOT_RESPONSE_RVA + 1, sizeof(relative));
    assert(image + REBOOT_RESPONSE_RVA + 5 + relative == bridge + 64);

    /* Nothing free within reach of the farthest hooked site: refuse, even
     * with free space one granule lower, and keep the allocation error. */
    lowest = base - (BRIDGE_DOWN_REACH - BRIDGE_SITE_LIMIT);
    rest = VirtualAlloc(lowest, (SIZE_T)(bridge - lowest), MEM_RESERVE, PAGE_NOACCESS);
    assert(rest == lowest && page_is(lowest - granularity, MEM_FREE));
    SetLastError(ERROR_SUCCESS);
    assert(bridge_page(base) == NULL && GetLastError() != ERROR_SUCCESS);
    bridge_refused("ROTK bridge test", base);

    /* The lowest granule in reach is accepted, and rel32 from the farthest
     * hooked site still reaches it. */
    assert(VirtualFree(rest, 0, MEM_RELEASE));
    rest = VirtualAlloc(lowest + granularity, (SIZE_T)(bridge - lowest - granularity),
        MEM_RESERVE, PAGE_NOACCESS);
    assert(rest == lowest + granularity);
    page = bridge_page(base);
    assert(page == lowest && page_is(page, MEM_COMMIT));
    assert((int64_t)(uintptr_t)page - (int64_t)(uintptr_t)(base + BRIDGE_SITE_LIMIT) >= INT32_MIN);
    bridge_release(page);
    assert(VirtualFree(rest, 0, MEM_RELEASE));
    puts("Bridge page: DllMain guard and headers, early block pages and decommit, original upward search, search below the image with full window, Trio reboot install and rel32 reach, reach floor and refusal passed.");
    return 0;
}
