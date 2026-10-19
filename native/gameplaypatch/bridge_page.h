#ifndef ROTK_BRIDGE_PAGE_H
#define ROTK_BRIDGE_PAGE_H

/* H1Z1.exe has no relocations and no DYNAMIC_BASE: it always maps at
 * 0x140000000, and Windows places the other bottom-up allocations of the
 * process at the same addresses on every launch. Each hook needs a bridge
 * page within rel32 reach of its sites, and the patch worker asks for it
 * about seven seconds after launch. On some PCs the whole window above the
 * image is in use by then, so the same hooks were refused at every launch.
 *
 * DINPUT8.dll is a static import of the game, so DllMain runs before the
 * game's own code. It reserves one 64 KiB block where the first bridge always
 * landed, and bridge_page() commits its pages one by one. Without the block,
 * the original upward search runs, then a search below the image. The stance
 * hook keeps its own search, which simply skips the block.
 */
#define BRIDGE_H1Z1_BASE UINT64_C(0x140000000)
#define BRIDGE_FIRST_DELTA UINT64_C(0x08000000)
#define BRIDGE_LAST_DELTA UINT64_C(0x70000000)
/* Every hooked site is below base + 0x02000000, so a page at or above
 * base + 0x02000000 - 0x7fff0000 stays within int32 reach of all of them. */
#define BRIDGE_SITE_LIMIT UINT64_C(0x02000000)
#define BRIDGE_DOWN_REACH UINT64_C(0x7fff0000)
#define BRIDGE_PAGE_SIZE 4096U
#define BRIDGE_BLOCK_PAGES 16
#define BRIDGE_BLOCK_SIZE (BRIDGE_PAGE_SIZE * BRIDGE_BLOCK_PAGES)

static BYTE *bridge_block_base, *bridge_block;
static volatile LONG bridge_block_next;

/* In-memory headers only: DllMain must not open the executable. */
static BOOL bridge_is_h1z1(const BYTE *base) {
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS64 nt;
    memcpy(&dos, base, sizeof(dos));
    if (dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew <= 0 ||
        dos.e_lfanew > (LONG)(BRIDGE_PAGE_SIZE - sizeof(nt))) return FALSE;
    memcpy(&nt, base + dos.e_lfanew, sizeof(nt));
    return nt.Signature == IMAGE_NT_SIGNATURE &&
        nt.FileHeader.Machine == IMAGE_FILE_MACHINE_AMD64 &&
        nt.FileHeader.TimeDateStamp == ROTK_H1Z1_TIMESTAMP &&
        nt.OptionalHeader.Magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC &&
        nt.OptionalHeader.SizeOfImage == ROTK_H1Z1_IMAGE_SIZE;
}

/* Same search as the bridges always used, so the block takes the address the
 * first bridge had on PCs where they worked. The loader lock is held: store
 * the block and nothing else. */
static void bridge_block_reserve_at(BYTE *base) {
    SYSTEM_INFO info;
    BYTE *block = NULL;
    GetSystemInfo(&info);
    for (uintptr_t delta = BRIDGE_FIRST_DELTA; delta < BRIDGE_LAST_DELTA && block == NULL;
         delta += info.dwAllocationGranularity)
        block = VirtualAlloc(base + delta, BRIDGE_BLOCK_SIZE, MEM_RESERVE, PAGE_NOACCESS);
    if (block != NULL) {
        bridge_block_base = base;
        bridge_block = block;
    }
}

/* Called from DllMain: kernel32 only, no file I/O, no logging. */
static void bridge_block_reserve(void) {
    BYTE *base = (BYTE *)GetModuleHandleW(NULL);
    if ((uintptr_t)base == BRIDGE_H1Z1_BASE && bridge_is_h1z1(base))
        bridge_block_reserve_at(base);
}

/* Highest free granule between the reach floor and the image. VirtualQuery
 * gives each allocation's base, so the walk skips whole allocations. */
static BYTE *bridge_below(BYTE *base, DWORD granularity, DWORD *error) {
    MEMORY_BASIC_INFORMATION region;
    uintptr_t mask = ~(uintptr_t)(granularity - 1U);
    uintptr_t reach = BRIDGE_DOWN_REACH - BRIDGE_SITE_LIMIT;
    uintptr_t lowest = (uintptr_t)base > reach + granularity
        ? ((uintptr_t)base - reach + granularity - 1U) & mask
        : granularity;
    for (uintptr_t address = (uintptr_t)base & mask; address >= lowest + granularity;) {
        address -= granularity;
        if (VirtualQuery((void *)address, &region, sizeof(region)) != sizeof(region)) break;
        if (region.State == MEM_FREE) {
            BYTE *page = VirtualAlloc((void *)address, BRIDGE_PAGE_SIZE,
                MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
            if (page != NULL) return page;
            *error = GetLastError();
        } else {
            address = (uintptr_t)region.AllocationBase & mask;
        }
    }
    return NULL;
}

/* A committed read-write page within rel32 reach of every hooked site, or
 * NULL with the error of the last allocation attempt. */
static BYTE *bridge_page(BYTE *base) {
    SYSTEM_INFO info;
    BYTE *page = NULL;
    DWORD error;
    if (bridge_block != NULL && base == bridge_block_base) {
        LONG index = InterlockedIncrement(&bridge_block_next) - 1;
        if (index < BRIDGE_BLOCK_PAGES) {
            page = VirtualAlloc(bridge_block + (SIZE_T)index * BRIDGE_PAGE_SIZE,
                BRIDGE_PAGE_SIZE, MEM_COMMIT, PAGE_READWRITE);
            if (page != NULL) return page;
        }
    }
    GetSystemInfo(&info);
    for (uintptr_t delta = BRIDGE_FIRST_DELTA; delta < BRIDGE_LAST_DELTA && page == NULL;
         delta += info.dwAllocationGranularity)
        page = VirtualAlloc(base + delta, BRIDGE_PAGE_SIZE, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (page != NULL) return page;
    error = GetLastError();
    page = bridge_below(base, info.dwAllocationGranularity, &error);
    if (page == NULL) SetLastError(error);
    return page;
}

/* A block page is only decommitted: the block stays reserved and its index
 * never moves back, so the page is not handed out again. */
static void bridge_release(BYTE *page) {
    if (bridge_block != NULL && page >= bridge_block && page < bridge_block + BRIDGE_BLOCK_SIZE)
        VirtualFree(page, BRIDGE_PAGE_SIZE, MEM_DECOMMIT);
    else
        VirtualFree(page, 0, MEM_RELEASE);
}

static const char *bridge_state_name(DWORD state) {
    return state == MEM_COMMIT ? "committed" : state == MEM_RESERVE ? "reserved" :
        state == MEM_FREE ? "free" : "unknown";
}

static const char *bridge_type_name(DWORD type) {
    return type == MEM_PRIVATE ? "private" : type == MEM_MAPPED ? "mapped" :
        type == MEM_IMAGE ? "image" : "none";
}

/* One line after bridge_page() returns NULL: its error and what holds the
 * first address of the search. The old prefix keeps log searches working. */
static void bridge_refused(const char *feature, BYTE *base) {
    DWORD error = GetLastError();
    MEMORY_BASIC_INFORMATION region;
    char line[256];
    if (VirtualQuery(base + BRIDGE_FIRST_DELTA, &region, sizeof(region)) == sizeof(region)) {
        snprintf(line, sizeof(line),
            "%s: bridge allocation refused (error %lu; base+0x08000000 %s %s, "
            "allocation 0x%llx, size 0x%llx).\n",
            feature, (unsigned long)error, bridge_state_name(region.State),
            bridge_type_name(region.Type),
            (unsigned long long)(uintptr_t)region.AllocationBase,
            (unsigned long long)region.RegionSize);
    } else {
        snprintf(line, sizeof(line),
            "%s: bridge allocation refused (error %lu; base+0x08000000 not queried).\n",
            feature, (unsigned long)error);
    }
    patch_log(line);
}
#endif
