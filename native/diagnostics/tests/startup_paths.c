#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#undef NDEBUG
#include <assert.h>
#define PATH_CAP 32768
#include "../startup_elevation.h"

int main(void) {
    wchar_t directory[1024], launcher[1024];
    (void)administrator_status;
    (void)elevate_installed_launcher;
    assert(installed_launcher_paths(L"C:\\Program Files\\ROTK Launcher\\resources\\diagnostics\\ROTK.Diagnostics.exe", directory, launcher, 1024));
    assert(wcscmp(directory, L"C:\\Program Files\\ROTK Launcher") == 0);
    assert(wcscmp(launcher, L"C:\\Program Files\\ROTK Launcher\\ROTK Launcher.exe") == 0);
    assert(installed_launcher_paths(L"D:\\Jeux d'\u00c9t\u00e9 $($x);\\RESOURCES\\DIAGNOSTICS\\rotk.diagnostics.EXE", directory, launcher, 1024));
    assert(wcscmp(launcher, L"D:\\Jeux d'\u00c9t\u00e9 $($x);\\ROTK Launcher.exe") == 0);
    assert(!installed_launcher_paths(L"resources\\diagnostics\\ROTK.Diagnostics.exe", directory, launcher, 1024));
    assert(!installed_launcher_paths(L"\\\\server\\share\\resources\\diagnostics\\ROTK.Diagnostics.exe", directory, launcher, 1024));
    assert(!installed_launcher_paths(L"C:\\App\\resources\\diagnostics\\another.exe", directory, launcher, 1024));
    assert(!installed_launcher_paths(L"C:\\App\\diagnostics\\ROTK.Diagnostics.exe", directory, launcher, 1024));
    assert(!installed_launcher_paths(L"C:\\App\\resources\\diagnostics\\ROTK.Diagnostics.exe", directory, launcher, 10));
    puts("PASS: fixed installed target, Unicode, shell characters and invalid layouts");
    return 0;
}
