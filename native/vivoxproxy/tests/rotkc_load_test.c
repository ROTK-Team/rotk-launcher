/*
 * rotkc.dll load contract of the Vivox proxy, checked with a test double
 * (rotkc_stub.c); the real closed module is never involved.
 *
 * usage: rotkc_load_test.exe <absolute path to vivoxsdk_x64.dll> loaded|legacy|absent
 *   loaded  the proxy's directory holds the stub: it must be loaded from
 *           exactly there, and the trace must say so.
 *   legacy  same, but the stub imports a DLL that only PATH provides: the
 *           strict load fails and the legacy import-search retry must load it.
 *   absent  the proxy's directory has no rotkc.dll while this executable's
 *           directory, the current directory and PATH all hold the stub:
 *           none of them may be used, and the failure must be traced.
 *
 * The proxy is loaded from a 32 KiB thread, like dllmain_small_stack_test,
 * because its DllMain performs and traces the load.
 */
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include "proxy_test_isolation.h"

typedef DWORD (*attach_thread_fn)(void);

static const wchar_t *g_proxy;
static HMODULE g_proxy_module;

static DWORD WINAPI load_proxy(LPVOID parameter) {
    (void)parameter;
    g_proxy_module = LoadLibraryW(g_proxy);
    return g_proxy_module != NULL ? 0U : GetLastError();
}

static int sibling(const wchar_t *file, const wchar_t *name, wchar_t *out) {
    wchar_t *separator;

    if (wcslen(file) >= MAX_PATH) return 0;
    wcscpy(out, file);
    separator = wcsrchr(out, L'\\');
    if (separator == NULL ||
        (size_t)(separator - out) + 1U + wcslen(name) >= MAX_PATH) {
        return 0;
    }
    wcscpy(separator + 1, name);
    return 1;
}

static int trace_contains(const wchar_t *trace_path, const char *needle) {
    char contents[8192];
    DWORD read_bytes = 0U;
    HANDLE file = CreateFileW(trace_path, GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);

    if (file == INVALID_HANDLE_VALUE) return 0;
    if (!ReadFile(file, contents, (DWORD)(sizeof(contents) - 1U), &read_bytes, NULL)) {
        read_bytes = 0U;
    }
    CloseHandle(file);
    contents[read_bytes] = '\0';
    return strstr(contents, needle) != NULL;
}

int wmain(int argc, wchar_t **argv) {
    wchar_t expected[MAX_PATH];
    wchar_t trace[MAX_PATH];
    wchar_t actual[MAX_PATH];
    HANDLE thread;
    DWORD proxy_thread = 0U;
    DWORD exit_code = 1U;
    HMODULE rotkc;
    attach_thread_fn attach_thread;
    const char *expected_trace;

    if (!isolate_proxy_test()) return 1;
    if (argc != 3) {
        fwprintf(stderr, L"usage: %ls <vivoxsdk_x64.dll> loaded|legacy|absent\n", argv[0]);
        return 2;
    }
    if (wcscmp(argv[2], L"loaded") == 0) {
        expected_trace = "] rotkc: loaded\r\n";
    } else if (wcscmp(argv[2], L"legacy") == 0) {
        expected_trace = "] rotkc: loaded with legacy import search\r\n";
    } else if (wcscmp(argv[2], L"absent") == 0) {
        expected_trace = NULL;
    } else {
        fwprintf(stderr, L"usage: %ls <vivoxsdk_x64.dll> loaded|legacy|absent\n", argv[0]);
        return 2;
    }
    g_proxy = argv[1];
    if (!sibling(g_proxy, L"rotkc.dll", expected) ||
        !sibling(g_proxy, L"rotk-vivox-v5-compat.log", trace)) {
        fwprintf(stderr, L"FAIL: pass an absolute Windows path\n");
        return 2;
    }
    if (GetModuleHandleW(L"rotkc.dll") != NULL) {
        fwprintf(stderr, L"FAIL: rotkc.dll was loaded before the proxy\n");
        return 1;
    }

    thread = CreateThread(NULL, 32U * 1024U, load_proxy, NULL,
                          STACK_SIZE_PARAM_IS_A_RESERVATION, &proxy_thread);
    if (thread == NULL) {
        fwprintf(stderr, L"FAIL: CreateThread error=%lu\n", GetLastError());
        return 1;
    }
    WaitForSingleObject(thread, INFINITE);
    GetExitCodeThread(thread, &exit_code);
    CloseHandle(thread);
    if (exit_code != 0U || g_proxy_module == NULL) {
        fwprintf(stderr, L"FAIL: proxy load failed code=0x%08lx\n", exit_code);
        return 1;
    }

    rotkc = GetModuleHandleW(L"rotkc.dll");
    if (expected_trace == NULL) {
        if (rotkc != NULL) {
            GetModuleFileNameW(rotkc, actual, MAX_PATH);
            fwprintf(stderr, L"FAIL: rotkc.dll came from the search order: %ls\n", actual);
            return 1;
        }
        if (!trace_contains(trace, "] rotkc: load failed error=126\r\n")) {
            fwprintf(stderr, L"FAIL: the missing module was not traced in %ls\n", trace);
            return 1;
        }
        wprintf(L"PASS (absent): app dir, current dir and PATH copies ignored, failure traced.\n");
        return 0;
    }

    if (rotkc == NULL) {
        fwprintf(stderr, L"FAIL: the proxy did not load rotkc.dll from its directory\n");
        return 1;
    }
    if (GetModuleFileNameW(rotkc, actual, MAX_PATH) == 0U ||
        _wcsicmp(actual, expected) != 0) {
        fwprintf(stderr, L"FAIL: rotkc.dll loaded from %ls, expected %ls\n", actual, expected);
        return 1;
    }
    attach_thread = (attach_thread_fn)(uintptr_t)GetProcAddress(rotkc, "rotkc_stub_attach_thread");
    if (attach_thread == NULL) {
        fwprintf(stderr, L"FAIL: the loaded rotkc.dll is not the test double\n");
        return 1;
    }
    /* Still loaded from the proxy's DllMain, on the thread that loaded it. */
    if (attach_thread() != proxy_thread) {
        fwprintf(stderr, L"FAIL: rotkc.dll attached on thread %lu, expected %lu\n",
                 attach_thread(), proxy_thread);
        return 1;
    }
    if (!trace_contains(trace, expected_trace)) {
        fwprintf(stderr, L"FAIL: the load was not traced as expected in %ls\n", trace);
        return 1;
    }
    wprintf(L"PASS (%ls): rotkc.dll loaded by absolute path from the proxy directory and traced.\n",
            argv[2]);
    return 0;
}
