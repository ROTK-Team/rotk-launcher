/*
 * Loads the proxy from a thread whose stack is far smaller than a normal main
 * thread's, the way BR1315 can load vivoxsdk_x64.dll during startup. DllMain
 * must not put large buffers on the stack: launcher 2.0.19 reserved a 64 KiB
 * path there and every game process died in PreInitialize with 0xC00000FD.
 *
 * usage: dllmain_small_stack_test.exe <path to vivoxsdk_x64.dll>
 * The DLL's directory gets a stale rotk-crouch-parity.log, which must be gone
 * once the load returns.
 */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#include "proxy_test_isolation.h"

static const wchar_t *g_dll;
static HMODULE g_module;

static DWORD WINAPI load_proxy(LPVOID parameter) {
    (void)parameter;
    g_module = LoadLibraryW(g_dll);
    return g_module != NULL ? 0U : GetLastError();
}

int wmain(int argc, wchar_t **argv) {
    wchar_t log_path[MAX_PATH];
    wchar_t *separator;
    HANDLE file;
    HANDLE thread;
    DWORD exit_code = 1U;

    if (!isolate_proxy_test()) return 1;

    if (argc != 2 || wcslen(argv[1]) >= MAX_PATH) {
        fwprintf(stderr, L"usage: %ls <vivoxsdk_x64.dll>\n", argv[0]);
        return 2;
    }
    g_dll = argv[1];
    wcscpy(log_path, g_dll);
    separator = wcsrchr(log_path, L'\\');
    if (separator == NULL || (size_t)(separator - log_path) + 24U >= MAX_PATH) {
        fwprintf(stderr, L"FAIL: pass an absolute Windows path\n");
        return 2;
    }
    wcscpy(separator + 1, L"rotk-crouch-parity.log");
    file = CreateFileW(log_path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        fwprintf(stderr, L"FAIL: cannot create %ls\n", log_path);
        return 1;
    }
    CloseHandle(file);

    /* 32 KiB reserved stack, committed on demand: a 64 KiB local overflows. */
    thread = CreateThread(NULL, 32U * 1024U, load_proxy, NULL,
                          STACK_SIZE_PARAM_IS_A_RESERVATION, NULL);
    if (thread == NULL) {
        fwprintf(stderr, L"FAIL: CreateThread error=%lu\n", GetLastError());
        return 1;
    }
    WaitForSingleObject(thread, INFINITE);
    GetExitCodeThread(thread, &exit_code);
    CloseHandle(thread);
    if (exit_code != 0U || g_module == NULL) {
        fwprintf(stderr, L"FAIL: LoadLibrary on a small stack failed code=0x%08lx\n", exit_code);
        return 1;
    }
    if (GetFileAttributesW(log_path) != INVALID_FILE_ATTRIBUTES) {
        fwprintf(stderr, L"FAIL: stale crouch log survived DllMain\n");
        return 1;
    }
    wprintf(L"PASS: proxy loads on a 32 KiB thread stack and removes the stale crouch log.\n");
    return 0;
}
