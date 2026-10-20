#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static void WINAPI test_sleep(DWORD milliseconds);
#define Sleep test_sleep
#define DirectInput8Create RotkTestDirectInput8Create
#define DllCanUnloadNow RotkTestDllCanUnloadNow
#define DllGetClassObject RotkTestDllGetClassObject
#define DllRegisterServer RotkTestDllRegisterServer
#define DllUnregisterServer RotkTestDllUnregisterServer
#define GetdfDIJoystick RotkTestGetdfDIJoystick
#define DllMain RotkTestDllMain
#include "../dinput8_proxy.c"
#undef Sleep

#include <stdio.h>

static const char good[] =
    "mode=anti-slow-v3\n"
    "patch=1046F98:8f>82,1046FE5:74>eb\n"
    "h1z1Sha256=5F5A4922B0671E4ED8FD415E753BE096EF7A17E360AE80E025F11544C8DB9261\n";
static WCHAR marker_path[MAX_PATH];
static HANDLE marker_hold = INVALID_HANDLE_VALUE;
static const char *sleep_script = "";
static unsigned int sleeps;
static int failures;

static void expect(BOOL condition, const char *message) {
    if (!condition) {
        fputs(message, stderr);
        fputc('\n', stderr);
        failures += 1;
    }
}

static int write_marker(const WCHAR *path, const char *contents) {
    FILE *stream = _wfopen(path, L"wb");
    size_t length = strlen(contents);
    if (stream == NULL) {
        return 1;
    }
    if (fwrite(contents, 1U, length, stream) != length) {
        fclose(stream);
        return 1;
    }
    fclose(stream);
    return 0;
}

/* Opens the marker without sharing, as a scanner or backup tool can. */
static BOOL hold_marker(void) {
    marker_hold = CreateFileW(
        marker_path, GENERIC_READ, 0U, NULL, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, NULL);
    return marker_hold != INVALID_HANDLE_VALUE;
}

static void release_marker(void) {
    if (marker_hold != INVALID_HANDLE_VALUE) {
        CloseHandle(marker_hold);
        marker_hold = INVALID_HANDLE_VALUE;
    }
}

/* Each watchdog sleep applies the next step of the script: H holds the
 * marker, G leaves a readable good marker, R removes it. A watchdog that
 * keeps running past the script fails the test instead of hanging. */
static void WINAPI test_sleep(DWORD milliseconds) {
    char step = sleep_script[sleeps];
    if (milliseconds != ROTK_WATCH_INTERVAL_MS || step == '\0') {
        fputs("watchdog did not stop when expected\n", stderr);
        ExitProcess(1);
    }
    ++sleeps;
    release_marker();
    if (step == 'H') {
        if (!hold_marker()) {
            fputs("could not hold the marker\n", stderr);
            ExitProcess(2);
        }
    } else if (step == 'G') {
        if (write_marker(marker_path, good) != 0) {
            fputs("could not rewrite the marker\n", stderr);
            ExitProcess(2);
        }
    } else if (step == 'R') {
        (void)_wremove(marker_path);
    }
}

static BOOL all_features_disabled(void) {
    return !stance_enabled && !reboot_enabled && !fps_enabled &&
        !vehicle_exit_enabled && !ads_enabled;
}

/* Runs the real watchdog loop with the script above. Every feature starts
 * enabled and the sprint byte pair starts patched on a private image. */
static void run_watchdog(BYTE *image, const char *script) {
    InterlockedExchange(&stance_enabled, 1);
    InterlockedExchange(&reboot_enabled, 1);
    InterlockedExchange(&fps_enabled, 1);
    InterlockedExchange(&vehicle_exit_enabled, 1);
    InterlockedExchange(&ads_enabled, 1);
    image[ROTK_PATCH_A_SIGNATURE_RVA + ROTK_PATCH_A_OFFSET] = ROTK_PATCH_A_VALUE;
    image[ROTK_PATCH_B_SIGNATURE_RVA + ROTK_PATCH_B_OFFSET] = ROTK_PATCH_B_VALUE;
    g_image_base = image;
    sleep_script = script;
    sleeps = 0U;
    (void)watchdog_worker(NULL);
    release_marker();
}

static BOOL log_contains(const WCHAR *path, const char *text, unsigned int expected) {
    static char contents[8192];
    FILE *stream = _wfopen(path, L"rb");
    size_t length;
    unsigned int found = 0U;
    const char *cursor = contents;
    if (stream == NULL) {
        return expected == 0U;
    }
    length = fread(contents, 1U, sizeof(contents) - 1U, stream);
    fclose(stream);
    contents[length] = '\0';
    while ((cursor = strstr(cursor, text)) != NULL) {
        ++found;
        cursor += strlen(text);
    }
    return found == expected;
}

int main(void) {
    WCHAR log_path[MAX_PATH];
    HANDLE locked;
    DWORD error;
    unsigned int unreadable = 0U;
    BYTE *image;
    static const char wrong_mode[] =
        "mode=anti-slow-v2\n"
        "patch=1046F98:8f>82,1046FE5:74>eb\n";
    static const char wrong_patch[] =
        "mode=anti-slow-v3\n"
        "patch=1046F98:8f>82\n";

    g_self_module = GetModuleHandleW(NULL);
    if (!module_sibling_path(marker_path, (DWORD)ARRAYSIZE(marker_path), k_marker_name) ||
        !module_sibling_path(log_path, (DWORD)ARRAYSIZE(log_path), k_log_name)) {
        fputs("could not resolve marker path\n", stderr);
        return 2;
    }
    (void)_wremove(log_path);
    (void)_wremove(marker_path);
    expect(!marker_enabled(), "absent marker must not enable the patch");
    expect(marker_check(&error) == MARKER_REMOVED && error == ERROR_FILE_NOT_FOUND,
        "absent marker must read as removed");
    if (write_marker(marker_path, good) != 0) {
        fputs("could not write good marker\n", stderr);
        return 2;
    }
    expect(marker_enabled(), "good marker must enable the patch");
    expect(write_marker(marker_path, wrong_mode) == 0 && !marker_enabled() &&
            marker_check(&error) == MARKER_REMOVED,
        "wrong mode marker must not enable the patch");
    expect(write_marker(marker_path, wrong_patch) == 0 && !marker_enabled() &&
            marker_check(&error) == MARKER_REMOVED,
        "wrong patch marker must not enable the patch");
    expect(write_marker(marker_path, "") == 0 && marker_check(&error) == MARKER_REMOVED,
        "empty marker must read as removed");
    (void)_wremove(marker_path);
    expect(!marker_enabled(), "removed marker must disable the patch");

    /* A marker another program holds open, or has locked, is unreadable,
     * not removed. The install path still refuses it. */
    if (write_marker(marker_path, good) != 0 || !hold_marker()) {
        fputs("could not hold good marker\n", stderr);
        return 2;
    }
    expect(marker_check(&error) == MARKER_UNREADABLE && error == ERROR_SHARING_VIOLATION,
        "a marker held without sharing must read as unreadable");
    expect(!marker_enabled(), "an unreadable marker must not enable the install");
    expect(watchdog_check(&unreadable, &error) == MARKER_ENABLED && unreadable == 1U,
        "one unreadable check must not disable the patch");
    expect(watchdog_check(&unreadable, &error) == MARKER_ENABLED && unreadable == 2U,
        "two unreadable checks must not disable the patch");
    release_marker();
    expect(watchdog_check(&unreadable, &error) == MARKER_ENABLED && unreadable == 0U,
        "a readable marker must reset the unreadable count");
    locked = CreateFileW(
        marker_path, GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (locked == INVALID_HANDLE_VALUE || !LockFile(locked, 0U, 0U, 4096U, 0U)) {
        fputs("could not lock good marker\n", stderr);
        return 2;
    }
    expect(marker_check(&error) == MARKER_UNREADABLE && error == ERROR_LOCK_VIOLATION,
        "a locked marker must read as unreadable");
    expect(watchdog_check(&unreadable, &error) == MARKER_ENABLED &&
            watchdog_check(&unreadable, &error) == MARKER_ENABLED &&
            watchdog_check(&unreadable, &error) == MARKER_UNREADABLE &&
            unreadable == 3U && error == ERROR_LOCK_VIOLATION,
        "three unreadable checks in a row must disable the patch");
    (void)UnlockFile(locked, 0U, 0U, 4096U, 0U);
    CloseHandle(locked);
    unreadable = 2U;
    (void)_wremove(marker_path);
    expect(watchdog_check(&unreadable, &error) == MARKER_REMOVED && unreadable == 0U,
        "a removed marker must disable the patch at once");

    /* The watchdog loop itself, on a private image with the sprint bytes
     * patched. Two unreadable checks, a good one, then three unreadable:
     * the sixth check disables everything and logs the error once. */
    image = VirtualAlloc(NULL, 0x1047000U, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (image == NULL || write_marker(marker_path, good) != 0) {
        fputs("could not prepare the watchdog run\n", stderr);
        return 2;
    }
    run_watchdog(image, "HHGHHH");
    expect(sleeps == 6U && all_features_disabled(),
        "the watchdog must disable on the third unreadable check in a row");
    expect(image[ROTK_PATCH_A_SIGNATURE_RVA + ROTK_PATCH_A_OFFSET] == ROTK_PATCH_A_STOCK &&
            image[ROTK_PATCH_B_SIGNATURE_RVA + ROTK_PATCH_B_OFFSET] == ROTK_PATCH_B_STOCK,
        "the watchdog must restore the sprint bytes");
    expect(log_contains(log_path,
            "ROTK shotgun sprint: marker unreadable 3 times in a row (error 32); "
            "stock bytes restored.", 1U),
        "the watchdog must log the sharing violation once");
    /* One unreadable check, then the launcher removes the marker. */
    run_watchdog(image, "HR");
    expect(sleeps == 2U && all_features_disabled(),
        "the watchdog must disable as soon as the marker is removed");
    expect(log_contains(log_path,
            "ROTK shotgun sprint: marker removed; stock bytes restored.", 1U),
        "a removed marker must keep its log line");
    expect(log_contains(log_path, "marker unreadable", 1U),
        "a removed marker must not log an unreadable marker");
    VirtualFree(image, 0U, MEM_RELEASE);
    (void)_wremove(marker_path);
    if (failures != 0) {
        return 1;
    }
    puts("marker opt-in matrix and watchdog debounce passed");
    return 0;
}
