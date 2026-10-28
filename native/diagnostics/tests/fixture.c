#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

static volatile unsigned long sink;

static DWORD WINAPI performance_worker(void *parameter) {
    (void)parameter;
    ULONGLONG until = GetTickCount64() + 4000;
    unsigned long value = 1;
    while (GetTickCount64() < until) {
        /* Span the coarse Windows clock tick so the CPU sampler observes real work. */
        ULONGLONG busy_until = GetTickCount64() + 50;
        while (GetTickCount64() < busy_until) for (unsigned i = 0; i < 1000; ++i) value = value * 1664525U + 1013904223U;
        Sleep(8);
    }
    return value;
}

static void performance_workload(void) {
    const SIZE_T bytes = 64 * 1024 * 1024;
    unsigned char *memory = VirtualAlloc(NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!memory) { puts("workload:allocation-failed"); fflush(stdout); return; }
    for (SIZE_T offset = 0; offset < bytes; offset += 4096) memory[offset] = 1;
    wchar_t path[32768]; DWORD length = GetModuleFileNameW(NULL, path, 32768);
    HANDLE file = INVALID_HANDLE_VALUE;
    if (length && length + 8 < 32768) {
        wcscat(path, L".io.tmp");
        file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
            FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, NULL);
    }
    HANDLE workers[2] = {CreateThread(NULL, 0, performance_worker, NULL, 0, NULL), CreateThread(NULL, 0, performance_worker, NULL, 0, NULL)};
    puts("workload:started"); fflush(stdout);
    for (unsigned iteration = 0; iteration < 10; ++iteration) {
        if (file != INVALID_HANDLE_VALUE) {
            SetFilePointer(file, 0, NULL, FILE_BEGIN);
            DWORD written; WriteFile(file, memory, 4 * 1024 * 1024, &written, NULL);
            SetFilePointer(file, 0, NULL, FILE_BEGIN);
            DWORD read; ReadFile(file, memory, 4 * 1024 * 1024, &read, NULL);
        }
        Sleep(400);
    }
    for (unsigned i = 0; i < 2; ++i) if (workers[i]) { WaitForSingleObject(workers[i], INFINITE); CloseHandle(workers[i]); }
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    VirtualFree(memory, 0, MEM_RELEASE);
    puts("workload:done"); fflush(stdout);
}

static LONG CALLBACK handled_exception(EXCEPTION_POINTERS *pointers) {
    if (pointers->ExceptionRecord->ExceptionCode == 0xE0424242) {
        ++sink;
        return EXCEPTION_CONTINUE_EXECUTION;
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

__declspec(noinline) static void exhaust_stack(unsigned depth) {
    volatile unsigned char page[4096];
    page[depth % sizeof(page)] = (unsigned char)depth;
    void (*volatile recurse)(unsigned) = exhaust_stack;
    recurse(depth + 1);
    sink += page[depth % sizeof(page)];
}

/* Loads a test DLL by full path, as the game loads its own modules, so the
 * passive image inventory has a known module to find and lose. */
static HMODULE loaded_module;

static void load_module(char *path) {
    size_t length = strlen(path);
    while (length && (path[length - 1] == '\n' || path[length - 1] == '\r')) path[--length] = 0;
    wchar_t wide[1024];
    if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wide, 1024)) { puts("loaded:0"); fflush(stdout); return; }
    HMODULE module = LoadLibraryW(wide);
    if (module) loaded_module = module;
    printf("loaded:%d\n", module != NULL); fflush(stdout);
}

int main(void) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    AddVectoredExceptionHandler(1, handled_exception);
    ULONG guarantee = 65536;
    SetThreadStackGuarantee(&guarantee);
    puts("ready"); fflush(stdout);
    char command[1024];
    while (fgets(command, sizeof(command), stdin)) {
        if (strncmp(command, "load ", 5) == 0) {
            load_module(command + 5);
        } else if (strncmp(command, "unload", 6) == 0) {
            BOOL freed = loaded_module && FreeLibrary(loaded_module);
            loaded_module = NULL;
            printf("unloaded:%d\n", freed); fflush(stdout);
        } else if (strncmp(command, "av", 2) == 0) {
            volatile ULONG_PTR bad_address = 1;
            *(volatile unsigned *)bad_address = 0xDEAD;
        } else if (strncmp(command, "stack", 5) == 0) {
            exhaust_stack(0);
        } else if (strncmp(command, "handled", 7) == 0) {
            for (unsigned i = 0; i < 100; ++i) RaiseException(0xE0424242, 0, 0, NULL);
            printf("handled:%lu\n", sink); fflush(stdout);
        } else if (strncmp(command, "workload", 8) == 0) {
            performance_workload();
        } else if (strncmp(command, "ping", 4) == 0) {
            printf("alive:debugger=%d\n", IsDebuggerPresent()); fflush(stdout);
        } else if (strncmp(command, "exit", 4) == 0) return 0;
    }
    return 0;
}
