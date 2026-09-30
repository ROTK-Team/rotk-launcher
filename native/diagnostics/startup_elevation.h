/* Explicit launcher startup operations; never used by diagnostic capture. */
#include <shellapi.h>

static int administrator_status(void) {
    HANDLE token = NULL;
    TOKEN_ELEVATION elevation = {0};
    DWORD size = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 3;
    BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size);
    CloseHandle(token);
    if (!ok || size != sizeof(elevation)) return 3;
    puts(elevation.TokenIsElevated ? "elevated" : "standard");
    return 0;
}

/* The only elevation target is the launcher beside our own resources folder.
 * No caller-supplied executable, arguments, working directory or environment
 * variable selects the target. Windows still requires normal UAC consent. */
static BOOL installed_launcher_paths(const wchar_t *module, wchar_t *directory, wchar_t *launcher, size_t capacity) {
    const wchar_t suffix[] = L"\\resources\\diagnostics\\ROTK.Diagnostics.exe";
    const wchar_t executable[] = L"\\ROTK Launcher.exe";
    size_t length = wcslen(module), suffix_length = wcslen(suffix);
    if (length <= suffix_length || _wcsicmp(module + length - suffix_length, suffix) != 0) return FALSE;
    size_t root_length = length - suffix_length;
    /* Require a local absolute drive path, not a network share or relative path. */
    if (root_length < 3 || module[1] != L':' || module[2] != L'\\' ||
        !((module[0] >= L'A' && module[0] <= L'Z') || (module[0] >= L'a' && module[0] <= L'z')) ||
        root_length + wcslen(executable) + 1 > capacity) return FALSE;
    wmemcpy(directory, module, root_length);
    directory[root_length] = 0;
    wmemcpy(launcher, module, root_length);
    wcscpy(launcher + root_length, executable);
    return TRUE;
}

static int elevate_installed_launcher(void) {
    wchar_t module[PATH_CAP], directory[PATH_CAP], launcher[PATH_CAP];
    DWORD length = GetModuleFileNameW(NULL, module, PATH_CAP);
    if (!length || length >= PATH_CAP || !installed_launcher_paths(module, directory, launcher, PATH_CAP)) return 2;
    DWORD attributes = GetFileAttributesW(launcher);
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY)) return 3;
    SHELLEXECUTEINFOW request = {0};
    request.cbSize = sizeof(request);
    request.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    request.lpVerb = L"runas";
    request.lpFile = launcher;
    request.lpParameters = L"--rotk-elevation-relaunch";
    request.lpDirectory = directory;
    request.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&request)) {
        if (GetLastError() == ERROR_CANCELLED) { puts("cancelled"); return 0; }
        return 3;
    }
    if (!request.hProcess) return 3;
    CloseHandle(request.hProcess);
    puts("started");
    return 0;
}
