#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

/*
 * ROTK shotgun sprint client patch v3.
 *
 * Two guarded one-byte opcode edits in the final v26 client's CanSprint
 * predicate (H1Z1.exe+0x1046F10). Neither edit adds code, a trampoline,
 * executable allocation or an input hook:
 *
 *   H1Z1.exe+0x1046F98: JG (0x8F) -> JB (0x82)
 *     The preceding TEST clears CF, so the positive action-timer branch is
 *     never taken. This is the byte shipped by launcher 1.4.7.
 *
 *   H1Z1.exe+0x1046FE5: JE (0x74) -> JMP (0xEB)
 *     Takes the same allowed-path target unconditionally, bypassing the
 *     independent pending "enter fire state" block that kept slowing the
 *     shotgun after the first byte alone (reproduced offline 2026-09-12).
 *
 * The patch is opt-in through a marker file next to the executable,
 * ``rotk-shotgun-sprint.ini``. Removing that marker is a complete, local
 * live switch: the worker restores both stock bytes within two seconds and
 * the launcher deletes the DLL on the next launch. The marker is written by
 * the launcher before every patched launch and removed before attestation
 * whenever the server directs a clean client.
 */

#define ROTK_H1Z1_FILE_SIZE UINT64_C(82158616)
#define ROTK_H1Z1_TIMESTAMP UINT32_C(0x5D56E9AB)
#define ROTK_H1Z1_IMAGE_SIZE UINT32_C(0x072B4000)

#define ROTK_PATCH_A_SIGNATURE_RVA UINT32_C(0x1046F8D)
#define ROTK_PATCH_A_OFFSET 11U
#define ROTK_PATCH_A_STOCK 0x8FU
#define ROTK_PATCH_A_VALUE 0x82U

#define ROTK_PATCH_B_SIGNATURE_RVA UINT32_C(0x1046FD6)
#define ROTK_PATCH_B_OFFSET 15U
#define ROTK_PATCH_B_STOCK 0x74U
#define ROTK_PATCH_B_VALUE 0xEBU

#define ROTK_INITIAL_GRACE_MS 5000U
#define ROTK_STABLE_READS_REQUIRED 20U
#define ROTK_STABLE_READ_INTERVAL_MS 100U
#define ROTK_STABLE_READ_LIMIT 300U
#define ROTK_WATCH_INTERVAL_MS 2000U

static const WCHAR k_marker_name[] = L"rotk-shotgun-sprint.ini";
static const char k_marker_mode[] = "mode=anti-slow-v3";
static const char k_marker_patch[] = "patch=1046F98:8f>82,1046FE5:74>eb";
static const WCHAR k_log_name[] = L"rotk-shotgun-sprint.log";

typedef HRESULT(WINAPI *direct_input8_create_fn)(
    HINSTANCE,
    DWORD,
    REFIID,
    LPVOID *,
    void *);
typedef HRESULT(WINAPI *hresult_no_args_fn)(void);
typedef HRESULT(WINAPI *dll_get_class_object_fn)(
    const void *,
    const void *,
    LPVOID *);
typedef const void *(WINAPI *get_joystick_format_fn)(void);

static INIT_ONCE g_system_dinput_once = INIT_ONCE_STATIC_INIT;
static HMODULE g_system_dinput = NULL;
static HMODULE g_self_module = NULL;
static direct_input8_create_fn g_direct_input8_create = NULL;
static hresult_no_args_fn g_dll_can_unload_now = NULL;
static dll_get_class_object_fn g_dll_get_class_object = NULL;
static hresult_no_args_fn g_dll_register_server = NULL;
static hresult_no_args_fn g_dll_unregister_server = NULL;
static get_joystick_format_fn g_get_joystick_format = NULL;
static volatile LONG g_patch_worker_started = 0;
static volatile LONG g_watchdog_started = 0;
static BYTE *g_image_base = NULL;

static const BYTE k_patch_a_signature[] = {
    0x44, 0x8B, 0x87, 0x64, 0x3B, 0x00, 0x00, 0x45,
    0x85, 0xC0, 0x0F, 0x8F, 0x9E, 0x00, 0x00, 0x00,
    0x83, 0xBF, 0xA0, 0x09, 0x00, 0x00, 0x02,
};

static const BYTE k_patch_b_signature[] = {
    0xBA, 0x0A, 0x00, 0x00, 0x00, 0x48, 0x8B, 0xCF,
    0xE8, 0xE0, 0x79, 0xFF, 0xFE, 0x84, 0xC0, 0x74,
    0x19, 0x85, 0xF6, 0x74, 0x15, 0x48, 0x85, 0xDB,
};

static void debug_status(const char *message) {
    OutputDebugStringA(message);
}

static BOOL module_sibling_path(
    WCHAR *output,
    DWORD capacity,
    const WCHAR *leaf) {
    WCHAR module_path[MAX_PATH];
    DWORD length;
    DWORD directory_length;
    SIZE_T leaf_length;

    if (output == NULL || leaf == NULL || capacity == 0U) {
        return FALSE;
    }
    length = GetModuleFileNameW(
        g_self_module,
        module_path,
        (DWORD)ARRAYSIZE(module_path));
    if (length == 0U || length >= (DWORD)ARRAYSIZE(module_path)) {
        return FALSE;
    }
    directory_length = length;
    while (directory_length > 0U &&
           module_path[directory_length - 1U] != L'\\' &&
           module_path[directory_length - 1U] != L'/') {
        --directory_length;
    }
    if (directory_length == 0U) {
        return FALSE;
    }
    leaf_length = wcslen(leaf);
    if ((SIZE_T)directory_length + leaf_length + 1U > (SIZE_T)capacity) {
        return FALSE;
    }
    memcpy(
        output,
        module_path,
        (SIZE_T)directory_length * sizeof(WCHAR));
    memcpy(
        output + directory_length,
        leaf,
        (leaf_length + 1U) * sizeof(WCHAR));
    return TRUE;
}

static void patch_log(const char *message) {
    WCHAR log_path[MAX_PATH];
    SYSTEMTIME now;
    char line[512];
    int length;
    HANDLE file;
    DWORD written = 0U;

    debug_status(message);
    if (!module_sibling_path(
            log_path,
            (DWORD)ARRAYSIZE(log_path),
            k_log_name)) {
        return;
    }
    GetSystemTime(&now);
    length = snprintf(
        line,
        sizeof(line),
        "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ pid=%lu %s\r\n",
        (unsigned)now.wYear,
        (unsigned)now.wMonth,
        (unsigned)now.wDay,
        (unsigned)now.wHour,
        (unsigned)now.wMinute,
        (unsigned)now.wSecond,
        (unsigned)now.wMilliseconds,
        (unsigned long)GetCurrentProcessId(),
        message);
    if (length <= 0) {
        return;
    }
    if ((SIZE_T)length >= sizeof(line)) {
        length = (int)(sizeof(line) - 1U);
    }
    file = CreateFileW(
        log_path,
        FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return;
    }
    (void)WriteFile(
        file,
        line,
        (DWORD)length,
        &written,
        NULL);
    CloseHandle(file);
}

static BOOL marker_enabled(void) {
    WCHAR marker_path[MAX_PATH];
    HANDLE file;
    char contents[512];
    DWORD read = 0U;
    BOOL enabled = FALSE;

    if (!module_sibling_path(
            marker_path,
            (DWORD)ARRAYSIZE(marker_path),
            k_marker_name)) {
        return FALSE;
    }
    file = CreateFileW(
        marker_path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return FALSE;
    }
    if (ReadFile(
            file,
            contents,
            (DWORD)(sizeof(contents) - 1U),
            &read,
            NULL) &&
        read > 0U) {
        contents[read] = '\0';
        enabled =
            strstr(contents, k_marker_mode) != NULL &&
            strstr(contents, k_marker_patch) != NULL;
    }
    CloseHandle(file);
    return enabled;
}

static FARPROC system_dinput_export(const char *name) {
    return g_system_dinput == NULL
        ? NULL
        : GetProcAddress(g_system_dinput, name);
}

static BOOL CALLBACK load_system_dinput(
    PINIT_ONCE once,
    PVOID parameter,
    PVOID *context) {
    WCHAR path[MAX_PATH];
    static const WCHAR suffix[] = L"\\dinput8.dll";
    UINT length;
    FARPROC address;

    (void)once;
    (void)parameter;
    (void)context;

    length = GetSystemDirectoryW(path, (UINT)ARRAYSIZE(path));
    if (length == 0U ||
        length >= (UINT)ARRAYSIZE(path) ||
        length + (UINT)ARRAYSIZE(suffix) > (UINT)ARRAYSIZE(path)) {
        return TRUE;
    }
    CopyMemory(path + length, suffix, sizeof(suffix));
    g_system_dinput = LoadLibraryW(path);
    if (g_system_dinput == NULL) {
        return TRUE;
    }

    address = system_dinput_export("DirectInput8Create");
    if (address != NULL) {
        union {
            FARPROC source;
            direct_input8_create_fn destination;
        } converted;
        converted.source = address;
        g_direct_input8_create = converted.destination;
    }
    {
        union {
            FARPROC source;
            hresult_no_args_fn destination;
        } converted;
        converted.source = system_dinput_export("DllCanUnloadNow");
        g_dll_can_unload_now = converted.destination;
        converted.source = system_dinput_export("DllRegisterServer");
        g_dll_register_server = converted.destination;
        converted.source = system_dinput_export("DllUnregisterServer");
        g_dll_unregister_server = converted.destination;
    }
    {
        union {
            FARPROC source;
            dll_get_class_object_fn destination;
        } converted;
        converted.source = system_dinput_export("DllGetClassObject");
        g_dll_get_class_object = converted.destination;
    }
    {
        union {
            FARPROC source;
            get_joystick_format_fn destination;
        } converted;
        converted.source = system_dinput_export("GetdfDIJoystick");
        g_get_joystick_format = converted.destination;
    }
    return TRUE;
}

static BOOL readable_range(const BYTE *address, SIZE_T size) {
    MEMORY_BASIC_INFORMATION information;
    uintptr_t start = (uintptr_t)address;
    uintptr_t end = start + size;
    uintptr_t region_end;

    if (end < start ||
        VirtualQuery(address, &information, sizeof(information)) !=
            sizeof(information) ||
        information.State != MEM_COMMIT ||
        (information.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0U) {
        return FALSE;
    }
    region_end =
        (uintptr_t)information.BaseAddress + (uintptr_t)information.RegionSize;
    return end <= region_end && information.Protect != 0U;
}

static BOOL exact_bytes(
    const BYTE *address,
    const BYTE *expected,
    SIZE_T size) {
    BYTE observed[64];
    SIZE_T transferred = 0U;

    if (size == 0U || size > sizeof(observed) ||
        !readable_range(address, size) ||
        !ReadProcessMemory(
            GetCurrentProcess(),
            address,
            observed,
            size,
            &transferred) ||
        transferred != size) {
        return FALSE;
    }
    return memcmp(observed, expected, size) == 0;
}

static BOOL read_byte(const BYTE *address, BYTE *value) {
    SIZE_T transferred = 0U;
    if (value == NULL || !readable_range(address, 1U) ||
        !ReadProcessMemory(
            GetCurrentProcess(),
            address,
            value,
            1U,
            &transferred) ||
        transferred != 1U) {
        return FALSE;
    }
    return TRUE;
}

static BOOL executable_committed_range(
    const BYTE *address,
    SIZE_T size,
    BOOL require_nonwritable) {
    MEMORY_BASIC_INFORMATION information;
    uintptr_t start = (uintptr_t)address;
    uintptr_t end = start + size;
    uintptr_t region_end;
    DWORD protection;
    BOOL executable;
    BOOL writable;

    if (end < start ||
        VirtualQuery(address, &information, sizeof(information)) !=
            sizeof(information) ||
        information.State != MEM_COMMIT ||
        (information.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0U) {
        return FALSE;
    }
    region_end =
        (uintptr_t)information.BaseAddress + (uintptr_t)information.RegionSize;
    if (end > region_end) {
        return FALSE;
    }
    protection = information.Protect & 0xFFU;
    executable =
        protection == PAGE_EXECUTE ||
        protection == PAGE_EXECUTE_READ ||
        protection == PAGE_EXECUTE_READWRITE ||
        protection == PAGE_EXECUTE_WRITECOPY;
    writable =
        protection == PAGE_READWRITE ||
        protection == PAGE_WRITECOPY ||
        protection == PAGE_EXECUTE_READWRITE ||
        protection == PAGE_EXECUTE_WRITECOPY;
    return executable && (!require_nonwritable || !writable);
}

static BOOL validate_h1z1_image(HMODULE module, BYTE **image_base) {
    BYTE *base = (BYTE *)module;
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS64 nt;
    WCHAR executable_path[MAX_PATH];
    HANDLE file;
    LARGE_INTEGER file_size;
    DWORD path_length;
    SIZE_T transferred = 0U;
    BOOL valid_size;

    if (base == NULL ||
        !ReadProcessMemory(
            GetCurrentProcess(),
            base,
            &dos,
            sizeof(dos),
            &transferred) ||
        transferred != sizeof(dos) ||
        dos.e_magic != IMAGE_DOS_SIGNATURE ||
        dos.e_lfanew <= 0 ||
        dos.e_lfanew > 0x1000 ||
        !ReadProcessMemory(
            GetCurrentProcess(),
            base + dos.e_lfanew,
            &nt,
            sizeof(nt),
            &transferred) ||
        transferred != sizeof(nt) ||
        nt.Signature != IMAGE_NT_SIGNATURE ||
        nt.FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
        nt.FileHeader.TimeDateStamp != ROTK_H1Z1_TIMESTAMP ||
        nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
        nt.OptionalHeader.SizeOfImage != ROTK_H1Z1_IMAGE_SIZE) {
        return FALSE;
    }

    path_length = GetModuleFileNameW(
        module,
        executable_path,
        (DWORD)ARRAYSIZE(executable_path));
    if (path_length == 0U || path_length >= (DWORD)ARRAYSIZE(executable_path)) {
        return FALSE;
    }
    file = CreateFileW(
        executable_path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return FALSE;
    }
    valid_size = GetFileSizeEx(file, &file_size) &&
        file_size.QuadPart == (LONGLONG)ROTK_H1Z1_FILE_SIZE;
    CloseHandle(file);
    if (!valid_size) {
        return FALSE;
    }

    *image_base = base;
    return TRUE;
}

static BOOL patch_a_ready(const BYTE *image_base) {
    const BYTE *signature = image_base + ROTK_PATCH_A_SIGNATURE_RVA;
    return exact_bytes(
            signature,
            k_patch_a_signature,
            sizeof(k_patch_a_signature)) &&
        executable_committed_range(
            signature,
            sizeof(k_patch_a_signature),
            FALSE);
}

static BOOL patch_b_ready(const BYTE *image_base) {
    const BYTE *signature = image_base + ROTK_PATCH_B_SIGNATURE_RVA;
    return exact_bytes(
            signature,
            k_patch_b_signature,
            sizeof(k_patch_b_signature)) &&
        executable_committed_range(
            signature,
            sizeof(k_patch_b_signature),
            FALSE);
}

static BOOL signatures_ready(const BYTE *image_base) {
    return patch_a_ready(image_base) && patch_b_ready(image_base);
}

static BOOL wait_for_stable_signatures(const BYTE *image_base) {
    DWORD attempt;
    DWORD consecutive = 0U;

    for (attempt = 0U; attempt < ROTK_STABLE_READ_LIMIT; ++attempt) {
        if (signatures_ready(image_base) && marker_enabled()) {
            ++consecutive;
            if (consecutive >= ROTK_STABLE_READS_REQUIRED) {
                return TRUE;
            }
        } else {
            consecutive = 0U;
        }
        Sleep(ROTK_STABLE_READ_INTERVAL_MS);
    }
    return FALSE;
}

static BOOL restore_page_protection(
    void *address,
    SIZE_T size,
    DWORD protection) {
    DWORD ignored;
    unsigned int attempt;

    for (attempt = 0U; attempt < 3U; ++attempt) {
        if (VirtualProtect(address, size, protection, &ignored)) {
            return TRUE;
        }
    }
    return FALSE;
}

static BOOL compare_exchange_byte(
    BYTE *address,
    BYTE expected,
    BYTE replacement) {
    BYTE observed = expected;
    return __atomic_compare_exchange_n(
        (volatile BYTE *)address,
        &observed,
        replacement,
        FALSE,
        __ATOMIC_SEQ_CST,
        __ATOMIC_SEQ_CST);
}

/**
 * Writes one byte only when it still holds ``expected``. The page protection
 * is always restored and an incomplete write is rolled back before returning
 * failure, so the caller can treat a false return as "stock bytes still in
 * place".
 */
static BOOL write_guarded_byte(
    BYTE *address,
    BYTE expected,
    BYTE replacement) {
    DWORD old_protection = 0U;
    BOOL byte_written = FALSE;
    BOOL byte_valid = FALSE;
    BOOL protection_restored;

    if (!readable_range(address, 1U) ||
        !VirtualProtect(address, 1U, PAGE_EXECUTE_READWRITE, &old_protection)) {
        return FALSE;
    }
    if (compare_exchange_byte(address, expected, replacement)) {
        byte_written = TRUE;
        byte_valid =
            FlushInstructionCache(GetCurrentProcess(), address, 1U) &&
            *address == replacement;
    }
    protection_restored = restore_page_protection(
        address,
        1U,
        old_protection);
    if (byte_written && byte_valid && protection_restored) {
        return TRUE;
    }
    if (byte_written) {
        DWORD ignored_protection;
        if (VirtualProtect(
                address,
                1U,
                PAGE_EXECUTE_READWRITE,
                &ignored_protection)) {
            if (compare_exchange_byte(address, replacement, expected)) {
                FlushInstructionCache(GetCurrentProcess(), address, 1U);
            }
            (void)restore_page_protection(
                address,
                1U,
                old_protection);
        }
    }
    return FALSE;
}

static BOOL restore_patch_pair(const BYTE *image_base) {
    BYTE *patch_a =
        (BYTE *)image_base + ROTK_PATCH_A_SIGNATURE_RVA + ROTK_PATCH_A_OFFSET;
    BYTE *patch_b =
        (BYTE *)image_base + ROTK_PATCH_B_SIGNATURE_RVA + ROTK_PATCH_B_OFFSET;
    BYTE value = 0U;
    BOOL restored_a = TRUE;
    BOOL restored_b = TRUE;

    if (read_byte(patch_a, &value) && value == ROTK_PATCH_A_VALUE) {
        restored_a = write_guarded_byte(
            patch_a,
            ROTK_PATCH_A_VALUE,
            ROTK_PATCH_A_STOCK);
    }
    if (read_byte(patch_b, &value) && value == ROTK_PATCH_B_VALUE) {
        restored_b = write_guarded_byte(
            patch_b,
            ROTK_PATCH_B_VALUE,
            ROTK_PATCH_B_STOCK);
    }
    return restored_a && restored_b;
}

static BOOL install_patch_pair(BYTE *image_base) {
    BYTE *patch_a =
        image_base + ROTK_PATCH_A_SIGNATURE_RVA + ROTK_PATCH_A_OFFSET;
    BYTE *patch_b =
        image_base + ROTK_PATCH_B_SIGNATURE_RVA + ROTK_PATCH_B_OFFSET;

    if (!signatures_ready(image_base)) {
        return FALSE;
    }
    if (!write_guarded_byte(
            patch_a,
            ROTK_PATCH_A_STOCK,
            ROTK_PATCH_A_VALUE)) {
        return FALSE;
    }
    if (!patch_b_ready(image_base) ||
        !write_guarded_byte(
            patch_b,
            ROTK_PATCH_B_STOCK,
            ROTK_PATCH_B_VALUE)) {
        (void)restore_patch_pair(image_base);
        return FALSE;
    }
    return TRUE;
}

#include "weapon_stance.h"
#include "respawn_address.h"
#include "trio_reboot_camera.h"
#include "spectator_nameplate_color.h"

static DWORD WINAPI watchdog_worker(LPVOID parameter) {
    (void)parameter;
    for (;;) {
        Sleep(ROTK_WATCH_INTERVAL_MS);
        if (marker_enabled()) {
            continue;
        }
        InterlockedExchange(&stance_enabled, 0);
        InterlockedExchange(&reboot_enabled, 0);
        if (!nameplate_restore()) {
            patch_log("ROTK spectator names: original formatter restore refused.\n");
        }
        if (restore_patch_pair(g_image_base)) {
            patch_log(
                "ROTK shotgun sprint: marker removed; stock bytes restored.\n");
        } else {
            patch_log(
                "ROTK shotgun sprint: marker removed; restore refused.\n");
        }
        return 0U;
    }
}

static void start_watchdog(BYTE *image_base) {
    HANDLE worker;

    g_image_base = image_base;
    if (InterlockedCompareExchange(&g_watchdog_started, 1, 0) != 0) {
        return;
    }
    worker = CreateThread(NULL, 0U, watchdog_worker, NULL, 0U, NULL);
    if (worker == NULL) {
        InterlockedExchange(&g_watchdog_started, 0);
        return;
    }
    CloseHandle(worker);
}

static DWORD WINAPI patch_worker(LPVOID parameter) {
    HMODULE executable = GetModuleHandleW(NULL);
    BYTE *image_base = NULL;

    (void)parameter;
    if (!validate_h1z1_image(executable, &image_base)) {
        patch_log(
            "ROTK shotgun sprint: unsupported executable; skipped.\n");
        return 0U;
    }
    Sleep(ROTK_INITIAL_GRACE_MS);
    if (!marker_enabled()) {
        patch_log(
            "ROTK shotgun sprint: marker missing; skipped.\n");
        return 0U;
    }
    if (!wait_for_stable_signatures(image_base)) {
        patch_log(
            "ROTK shotgun sprint: signatures never stabilized; skipped.\n");
        return 0U;
    }
    if (!marker_enabled()) {
        patch_log(
            "ROTK shotgun sprint: marker removed before install; skipped.\n");
        return 0U;
    }
    {
        int repair = respawn_address_install(image_base);
        patch_log(repair == 1 ? "ROTK CZ respawn: continuation address repaired.\n" :
                  repair == 0 ? "ROTK CZ respawn: unsupported continuation; skipped.\n" :
                                "ROTK CZ respawn: memory protection failure.\n");
    }
    if (install_patch_pair(image_base)) {
        patch_log(
            "ROTK shotgun sprint: v3 patch installed "
            "(0x1046F98:8f>82, 0x1046FE5:74>eb).\n");
        stance_install(image_base);
        reboot_install(image_base);
        nameplate_install(image_base);
        start_watchdog(image_base);
    } else {
        patch_log(
            "ROTK shotgun sprint: guarded installation refused.\n");
    }
    return 0U;
}

static void start_patch_worker(void) {
    HMODULE self = NULL;
    HANDLE worker;

    if (InterlockedCompareExchange(&g_patch_worker_started, 1, 0) != 0) {
        return;
    }
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
            (LPCWSTR)(const void *)&g_patch_worker_started,
            &self)) {
        InterlockedExchange(&g_patch_worker_started, 0);
        return;
    }
    worker = CreateThread(NULL, 0U, patch_worker, NULL, 0U, NULL);
    if (worker == NULL) {
        FreeLibrary(self);
        InterlockedExchange(&g_patch_worker_started, 0);
        return;
    }
    CloseHandle(worker);
}

HRESULT WINAPI DirectInput8Create(
    HINSTANCE instance,
    DWORD version,
    REFIID interface_id,
    LPVOID *output,
    void *outer) {
    HRESULT result;

    InitOnceExecuteOnce(
        &g_system_dinput_once, load_system_dinput, NULL, NULL);
    if (g_direct_input8_create == NULL) {
        return E_FAIL;
    }
    result = g_direct_input8_create(
        instance, version, interface_id, output, outer);
    start_patch_worker();
    return result;
}

HRESULT WINAPI DllCanUnloadNow(void) {
    InitOnceExecuteOnce(
        &g_system_dinput_once, load_system_dinput, NULL, NULL);
    return g_dll_can_unload_now == NULL ? E_FAIL : g_dll_can_unload_now();
}

HRESULT WINAPI DllGetClassObject(
    const void *class_id,
    const void *interface_id,
    LPVOID *output) {
    InitOnceExecuteOnce(
        &g_system_dinput_once, load_system_dinput, NULL, NULL);
    return g_dll_get_class_object == NULL
        ? E_FAIL
        : g_dll_get_class_object(class_id, interface_id, output);
}

HRESULT WINAPI DllRegisterServer(void) {
    InitOnceExecuteOnce(
        &g_system_dinput_once, load_system_dinput, NULL, NULL);
    return g_dll_register_server == NULL ? E_FAIL : g_dll_register_server();
}

HRESULT WINAPI DllUnregisterServer(void) {
    InitOnceExecuteOnce(
        &g_system_dinput_once, load_system_dinput, NULL, NULL);
    return g_dll_unregister_server == NULL
        ? E_FAIL
        : g_dll_unregister_server();
}

const void *WINAPI GetdfDIJoystick(void) {
    InitOnceExecuteOnce(
        &g_system_dinput_once, load_system_dinput, NULL, NULL);
    return g_get_joystick_format == NULL ? NULL : g_get_joystick_format();
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_self_module = instance;
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}
