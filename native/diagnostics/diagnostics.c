/* ROTK external crash collector. GPL-3.0-or-later.
 * No injected code, privilege elevation, registry changes or network operations.
 * Only the explicit, validated target PID is opened. All DbgHelp calls are made
 * serially on the debug loop thread. See README.md for privacy and limitations.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dbghelp.h>
#include <psapi.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <wchar.h>

#define PATH_CAP 32768
#define LOG_LIMIT (4ULL * 1024 * 1024)
#define SAMPLE_INTERVAL 5000
#define EXCEPTION_BINS 64
#define MIB (1024ULL * 1024)

static DWORD target_pid;
static HANDLE target_process;
static FILE *journal;
static wchar_t output_directory[PATH_CAP], log_path[PATH_CAP];
static uint64_t journal_bytes, dropped_first_chance;
static ULONGLONG started, last_cpu_tick, last_cpu_time;
static unsigned dump_sequence, snapshot_count, full_count, fatal_count;
static volatile LONG stop_requested;
static struct { DWORD code; uint64_t count; } exceptions[EXCEPTION_BINS];
static unsigned exception_types;
static uintptr_t remote_breakpoint;
static BOOL waiting_attach_breakpoint = TRUE;
static unsigned module_events, thread_events;
static BOOL debug_enabled;
static BOOL counters_only;

static const wchar_t *basename_w(const wchar_t *path) {
    const wchar_t *name = path;
    for (const wchar_t *p = path; *p; ++p) if (*p == L'\\' || *p == L'/') name = p + 1;
    return name;
}

static void json_string(const wchar_t *input, char *output, size_t capacity) {
    char utf8[8192];
    int count = WideCharToMultiByte(CP_UTF8, 0, input, -1, utf8, sizeof(utf8), NULL, NULL);
    if (!count) strcpy(utf8, "[name-too-long]");
    size_t out = 0;
    for (size_t i = 0; utf8[i] && out + 7 < capacity; ++i) {
        unsigned char c = (unsigned char)utf8[i];
        if (c == '"' || c == '\\') { output[out++] = '\\'; output[out++] = (char)c; }
        else if (c < 32) { out += (size_t)snprintf(output + out, capacity - out, "\\u%04x", c); }
        else output[out++] = (char)c;
    }
    output[out] = 0;
}

static void rotate_journal(void) {
    if (!journal || journal_bytes < LOG_LIMIT) return;
    fclose(journal);
    journal = NULL;
    wchar_t previous[PATH_CAP];
    if (swprintf(previous, PATH_CAP, L"%ls.1", log_path) <= 0) return;
    if (!MoveFileExW(log_path, previous, MOVEFILE_REPLACE_EXISTING)) return;
    journal = _wfopen(log_path, L"wb");
    journal_bytes = 0;
}

static void emit(const char *event, const char *format, ...) {
    char payload[12000], line[13000], debug_time[128] = {0};
    va_list args;
    va_start(args, format);
    vsnprintf(payload, sizeof(payload), format, args);
    va_end(args);
    SYSTEMTIME time;
    GetSystemTime(&time);
    if (debug_enabled) {
        LARGE_INTEGER qpc; QueryPerformanceCounter(&qpc);
        snprintf(debug_time, sizeof(debug_time), ",\"monotonicMs\":%llu,\"qpc\":\"%lld\"", GetTickCount64() - started, qpc.QuadPart);
    }
    int len = snprintf(line, sizeof(line),
        "{\"event\":\"%s\",\"at\":\"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ\",\"pid\":%lu%s%s}\n",
        event, time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
        time.wSecond, time.wMilliseconds, (unsigned long)target_pid, debug_time, payload);
    if (len <= 0 || (size_t)len >= sizeof(line)) return;
    /* The parent owns the pipe and drains it. EOF is also detected in read_commands. */
    fwrite(line, 1, (size_t)len, stdout);
    fflush(stdout);
    if (journal) {
        fwrite(line, 1, (size_t)len, journal);
        fflush(journal);
        journal_bytes += (uint64_t)len;
        rotate_journal();
    }
}

static uint64_t filetime_value(FILETIME time) { return ((uint64_t)time.dwHighDateTime << 32) | time.dwLowDateTime; }

#include "performance.h"

static void sample(void) {
    PROCESS_MEMORY_COUNTERS_EX memory = {0};
    memory.cb = sizeof(memory);
    MEMORYSTATUSEX system = {0};
    system.dwLength = sizeof(system);
    FILETIME created, exited, kernel, user;
    BOOL memory_ok = GetProcessMemoryInfo(target_process, (PROCESS_MEMORY_COUNTERS *)&memory, sizeof(memory));
    BOOL system_ok = GlobalMemoryStatusEx(&system);
    BOOL times_ok = GetProcessTimes(target_process, &created, &exited, &kernel, &user);
    ULONGLONG tick = GetTickCount64(), cpu = 0;
    double cpu_percent = 0;
    SYSTEM_INFO info;
    GetSystemInfo(&info);
    if (times_ok) {
        cpu = filetime_value(kernel) + filetime_value(user);
        if (last_cpu_tick && tick > last_cpu_tick && cpu >= last_cpu_time) {
            cpu_percent = (double)(cpu - last_cpu_time) / (double)(tick - last_cpu_tick) / 100.0 / info.dwNumberOfProcessors;
        }
        last_cpu_tick = tick;
        last_cpu_time = cpu;
    }
    DWORD handles = 0;
    GetProcessHandleCount(target_process, &handles);
    emit("sample", ",\"elapsedMs\":%llu,\"memoryAvailable\":%s,\"workingSetBytes\":%llu,\"privateBytes\":%llu,\"peakWorkingSetBytes\":%llu,\"systemAvailable\":%s,\"systemTotalPhysicalBytes\":%llu,\"systemAvailablePhysicalBytes\":%llu,\"systemCommitLimitBytes\":%llu,\"systemCommitAvailableBytes\":%llu,\"cpuAvailable\":%s,\"cpuPercent\":%.2f,\"cpuTime100ns\":%llu,\"handleCount\":%lu,\"droppedFirstChanceEvents\":%llu",
        tick - started, memory_ok ? "true" : "false", (uint64_t)memory.WorkingSetSize,
        (uint64_t)memory.PrivateUsage, (uint64_t)memory.PeakWorkingSetSize,
        system_ok ? "true" : "false", system.ullTotalPhys, system.ullAvailPhys,
        system.ullTotalPageFile, system.ullAvailPageFile, times_ok ? "true" : "false",
        cpu_percent, cpu, (unsigned long)handles, dropped_first_chance);
}

static void exception_summary(void) {
    for (unsigned i = 0; i < exception_types; ++i)
        emit("exception-count", ",\"code\":\"0x%08lX\",\"count\":%llu", (unsigned long)exceptions[i].code, exceptions[i].count);
}

static void log_module(HANDLE file, LPVOID base) {
    if (!file || file == INVALID_HANDLE_VALUE) return;
    wchar_t raw[PATH_CAP], safe[4096], windows_path[MAX_PATH];
    DWORD length = GetFinalPathNameByHandleW(file, raw, PATH_CAP, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (!length || length >= PATH_CAP) return;
    const wchar_t *path = wcsncmp(raw, L"\\\\?\\", 4) == 0 ? raw + 4 : raw;
    if (_wcsicmp(basename_w(path), L"ntdll.dll") == 0) {
        HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        FARPROC breakpoint = GetProcAddress(ntdll, "DbgBreakPoint");
        if (breakpoint) remote_breakpoint = (uintptr_t)base + (uintptr_t)breakpoint - (uintptr_t)ntdll;
    }
    if (++module_events > 2048) return;
    DWORD windows_length = GetWindowsDirectoryW(windows_path, MAX_PATH);
    if (windows_length && windows_length < MAX_PATH && _wcsnicmp(path, windows_path, windows_length) == 0 && path[windows_length] == L'\\')
        swprintf(safe, 4096, L"%%WINDIR%%%ls", path + windows_length);
    else swprintf(safe, 4096, L"%ls", basename_w(path));
    char name[8192];
    json_string(safe, name, sizeof(name));
    unsigned major = 0, minor = 0, build = 0, revision = 0;
    /* Do not follow UNC paths or network drives when obtaining version metadata. */
    if (path[0] && path[1] == L':' && path[2] == L'\\') {
        wchar_t drive[] = {path[0], L':', L'\\', 0};
        if (GetDriveTypeW(drive) == DRIVE_FIXED) {
            DWORD size = GetFileVersionInfoSizeW(path, NULL);
            if (size && size < 2 * MIB) {
                void *data = malloc(size);
                VS_FIXEDFILEINFO *version = NULL;
                UINT version_size = 0;
                if (data && GetFileVersionInfoW(path, 0, size, data) && VerQueryValueW(data, L"\\", (LPVOID *)&version, &version_size) && version_size >= sizeof(*version)) {
                    major = HIWORD(version->dwFileVersionMS); minor = LOWORD(version->dwFileVersionMS);
                    build = HIWORD(version->dwFileVersionLS); revision = LOWORD(version->dwFileVersionLS);
                }
                free(data);
            }
        }
    }
    emit("module", ",\"name\":\"%s\",\"base\":\"0x%016llX\",\"version\":\"%u.%u.%u.%u\"", name, (uint64_t)(uintptr_t)base, major, minor, build, revision);
}

static BOOL read_context(DWORD thread_id, CONTEXT *context) {
    memset(context, 0, sizeof(*context));
    context->ContextFlags = CONTEXT_ALL;
    HANDLE thread = OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, thread_id);
    if (!thread) return FALSE;
    BOOL ok = GetThreadContext(thread, context);
    CloseHandle(thread);
    return ok;
}

static void log_exception(const DEBUG_EVENT *event, const CONTEXT *context, BOOL context_ok) {
    const EXCEPTION_RECORD *record = &event->u.Exception.ExceptionRecord;
    char parameters[512] = {0};
    size_t used = 0;
    for (DWORD i = 0; i < record->NumberParameters && i < EXCEPTION_MAXIMUM_PARAMETERS; ++i)
        used += (size_t)snprintf(parameters + used, sizeof(parameters) - used, "%s\"0x%016llX\"", i ? "," : "", (uint64_t)record->ExceptionInformation[i]);
    emit("exception", ",\"firstChance\":%s,\"code\":\"0x%08lX\",\"flags\":%lu,\"address\":\"0x%016llX\",\"threadId\":%lu,\"parameters\":[%s],\"contextAvailable\":%s,\"registers\":{\"rip\":\"0x%016llX\",\"rsp\":\"0x%016llX\",\"rbp\":\"0x%016llX\",\"rax\":\"0x%016llX\",\"rbx\":\"0x%016llX\",\"rcx\":\"0x%016llX\",\"rdx\":\"0x%016llX\",\"rsi\":\"0x%016llX\",\"rdi\":\"0x%016llX\",\"r8\":\"0x%016llX\",\"r9\":\"0x%016llX\",\"r10\":\"0x%016llX\",\"r11\":\"0x%016llX\",\"r12\":\"0x%016llX\",\"r13\":\"0x%016llX\",\"r14\":\"0x%016llX\",\"r15\":\"0x%016llX\",\"eflags\":\"0x%08lX\"}",
        event->u.Exception.dwFirstChance ? "true" : "false", (unsigned long)record->ExceptionCode,
        (unsigned long)record->ExceptionFlags, (uint64_t)(uintptr_t)record->ExceptionAddress,
        (unsigned long)event->dwThreadId, parameters, context_ok ? "true" : "false",
        context->Rip, context->Rsp, context->Rbp, context->Rax, context->Rbx, context->Rcx,
        context->Rdx, context->Rsi, context->Rdi, context->R8, context->R9, context->R10,
        context->R11, context->R12, context->R13, context->R14, context->R15, (unsigned long)context->EFlags);
}

static uint64_t committed_memory(void) {
    MEMORY_BASIC_INFORMATION region;
    uintptr_t address = 0;
    uint64_t total = 0;
    while (VirtualQueryEx(target_process, (void *)address, &region, sizeof(region)) == sizeof(region)) {
        if (region.State == MEM_COMMIT) total += region.RegionSize;
        uintptr_t next = (uintptr_t)region.BaseAddress + region.RegionSize;
        if (next <= address) break;
        address = next;
    }
    return total;
}

typedef struct { ULONGLONG deadline; uint64_t max_bytes; HANDLE file; } DUMP_BUDGET;
static BOOL CALLBACK dump_callback(PVOID parameter, const PMINIDUMP_CALLBACK_INPUT input, PMINIDUMP_CALLBACK_OUTPUT output) {
    DUMP_BUDGET *budget = (DUMP_BUDGET *)parameter;
    if (input->CallbackType == CancelCallback) {
        LARGE_INTEGER size = {0};
        GetFileSizeEx(budget->file, &size);
        output->CheckCancel = TRUE;
        output->Cancel = GetTickCount64() > budget->deadline || (uint64_t)size.QuadPart > budget->max_bytes;
    }
    return TRUE;
}

static BOOL write_dump(BOOL full, const DEBUG_EVENT *fatal_event, CONTEXT *context, BOOL context_ok) {
    const char *kind = fatal_event ? "fatal" : "snapshot";
    if ((fatal_event && fatal_count >= 2) || (!fatal_event && (snapshot_count >= 10 || (full && full_count >= 2)))) {
        emit("dump-failed", ",\"kind\":\"%s\",\"full\":%s,\"reason\":\"session-dump-limit\"", kind, full ? "true" : "false");
        return FALSE;
    }
    ULARGE_INTEGER free_bytes;
    uint64_t required = full ? committed_memory() + 512 * MIB : 512 * MIB;
    if (!GetDiskFreeSpaceExW(output_directory, &free_bytes, NULL, NULL) || free_bytes.QuadPart < required) {
        emit("dump-failed", ",\"kind\":\"%s\",\"full\":%s,\"reason\":\"insufficient-disk-space\",\"requiredBytes\":%llu", kind, full ? "true" : "false", required);
        return FALSE;
    }
    SYSTEMTIME time;
    GetSystemTime(&time);
    wchar_t filename[200], final_path[PATH_CAP], partial_path[PATH_CAP];
    swprintf(filename, 200, L"%ls-%04u%02u%02uT%02u%02u%02u-%03u-%lu-%u%ls.dmp",
        fatal_event ? L"crash" : L"snapshot", time.wYear, time.wMonth, time.wDay,
        time.wHour, time.wMinute, time.wSecond, time.wMilliseconds, (unsigned long)target_pid,
        ++dump_sequence, full ? L"-full" : L"");
    if (swprintf(final_path, PATH_CAP, L"%ls\\%ls", output_directory, filename) <= 0 ||
        swprintf(partial_path, PATH_CAP, L"%ls.partial", final_path) <= 0) return FALSE;
    HANDLE file = CreateFileW(partial_path, GENERIC_WRITE | GENERIC_READ, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        emit("dump-failed", ",\"kind\":\"%s\",\"full\":%s,\"reason\":\"create-file\",\"win32Error\":%lu", kind, full ? "true" : "false", (unsigned long)GetLastError());
        return FALSE;
    }
    MINIDUMP_TYPE flags = (MINIDUMP_TYPE)(MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules |
        MiniDumpWithIndirectlyReferencedMemory | MiniDumpWithFullMemoryInfo |
        MiniDumpScanMemory | MiniDumpFilterModulePaths | MiniDumpIgnoreInaccessibleMemory);
    if (full) flags = (MINIDUMP_TYPE)(flags | MiniDumpWithFullMemory);
    EXCEPTION_RECORD record;
    EXCEPTION_POINTERS pointers;
    MINIDUMP_EXCEPTION_INFORMATION exception_info;
    MINIDUMP_EXCEPTION_INFORMATION *exception_ptr = NULL;
    if (fatal_event && context_ok) {
        record = fatal_event->u.Exception.ExceptionRecord;
        /* The chained record address belongs to the target; never dereference it locally. */
        record.ExceptionRecord = NULL;
        pointers.ExceptionRecord = &record;
        pointers.ContextRecord = context;
        exception_info.ThreadId = fatal_event->dwThreadId;
        exception_info.ExceptionPointers = &pointers;
        exception_info.ClientPointers = FALSE;
        exception_ptr = &exception_info;
    }
    DUMP_BUDGET budget = {GetTickCount64() + (full ? 180000 : 45000), full ? free_bytes.QuadPart - 256 * MIB : 256 * MIB, file};
    MINIDUMP_CALLBACK_INFORMATION callback = {dump_callback, &budget};
    emit("dump-started", ",\"kind\":\"%s\",\"full\":%s", kind, full ? "true" : "false");
    BOOL ok = MiniDumpWriteDump(target_process, target_pid, file, flags, exception_ptr, NULL, &callback);
    DWORD error = ok ? 0 : GetLastError();
    if (!ok && !full) {
        /* A huge indirect-memory graph or an older DbgHelp must not cost the
         * core crash evidence. Retry once with stacks, modules and exception. */
        MINIDUMP_TYPE fallback_flags = (MINIDUMP_TYPE)(MiniDumpWithThreadInfo |
            MiniDumpWithUnloadedModules | MiniDumpWithFullMemoryInfo |
            MiniDumpFilterModulePaths | MiniDumpIgnoreInaccessibleMemory);
        emit("dump-retry", ",\"kind\":\"%s\",\"reason\":\"retry-without-indirect-memory\",\"win32Error\":%lu", kind, (unsigned long)error);
        LARGE_INTEGER zero = {0};
        if (SetFilePointerEx(file, zero, NULL, FILE_BEGIN) && SetEndOfFile(file)) {
            budget.deadline = GetTickCount64() + 15000;
            flags = fallback_flags;
            ok = MiniDumpWriteDump(target_process, target_pid, file, flags, exception_ptr, NULL, &callback);
            error = ok ? 0 : GetLastError();
        }
    }
    LARGE_INTEGER size = {0};
    GetFileSizeEx(file, &size);
    FlushFileBuffers(file);
    CloseHandle(file);
    if (ok && !MoveFileW(partial_path, final_path)) { ok = FALSE; error = GetLastError(); }
    if (!ok) {
        DeleteFileW(partial_path);
        emit("dump-failed", ",\"kind\":\"%s\",\"full\":%s,\"reason\":\"minidump-write\",\"win32Error\":%lu", kind, full ? "true" : "false", (unsigned long)error);
        return FALSE;
    }
    char name[512];
    json_string(filename, name, sizeof(name));
    if (fatal_event) ++fatal_count; else ++snapshot_count;
    if (full) ++full_count;
    emit("dump-written", ",\"kind\":\"%s\",\"full\":%s,\"path\":\"%s\",\"bytes\":%llu,\"exceptionStream\":%s,\"flags\":%lu",
        kind, full ? "true" : "false", name, (uint64_t)size.QuadPart, exception_ptr ? "true" : "false", (unsigned long)flags);
    return TRUE;
}

static void command(char *line) {
    size_t length = strlen(line);
    while (length && (line[length - 1] == '\r' || line[length - 1] == ' ')) line[--length] = 0;
    if (strcmp(line, "stop") == 0) InterlockedExchange(&stop_requested, 1);
    else if (strcmp(line, "snapshot") == 0) write_dump(FALSE, NULL, NULL, FALSE);
    else if (strcmp(line, "full") == 0) write_dump(TRUE, NULL, NULL, FALSE);
    else if (*line) emit("command-rejected", ",\"reason\":\"unknown-command\"");
}

static void read_commands(void) {
    static char pending[256];
    static size_t length;
    static BOOL overflow;
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD available = 0;
    if (!input || input == INVALID_HANDLE_VALUE) { InterlockedExchange(&stop_requested, 1); return; }
    if (GetFileType(input) != FILE_TYPE_PIPE) return;
    if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
        InterlockedExchange(&stop_requested, 1);
        return;
    }
    while (available--) {
        char value;
        DWORD count;
        if (!ReadFile(input, &value, 1, &count, NULL) || !count) { InterlockedExchange(&stop_requested, 1); break; }
        if (value == '\n') {
            pending[length] = 0;
            if (overflow) emit("command-rejected", ",\"reason\":\"command-too-long\"");
            else command(pending);
            length = 0; overflow = FALSE;
        } else if (length + 1 < sizeof(pending)) pending[length++] = value;
        else overflow = TRUE;
    }
}

static BOOL WINAPI console_control(DWORD signal) {
    (void)signal;
    InterlockedExchange(&stop_requested, 1);
    return TRUE;
}

static BOOL validate_target(void) {
    if (target_pid == 0 || target_pid == GetCurrentProcessId()) {
        emit("attach-failed", ",\"reason\":\"invalid-pid\""); return FALSE;
    }
    target_process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, target_pid);
    if (!target_process) {
        emit("attach-failed", ",\"reason\":\"open-process\",\"win32Error\":%lu", (unsigned long)GetLastError()); return FALSE;
    }
    wchar_t path[PATH_CAP];
    DWORD length = PATH_CAP;
    if (!QueryFullProcessImageNameW(target_process, 0, path, &length)) {
        emit("attach-failed", ",\"reason\":\"query-image-name\",\"win32Error\":%lu", (unsigned long)GetLastError()); return FALSE;
    }
    BOOL allowed = _wcsicmp(basename_w(path), L"H1Z1.exe") == 0;
#ifdef ROTK_DIAGNOSTICS_TEST
    allowed = allowed || _wcsicmp(basename_w(path), L"ROTK.Diagnostics.Fixture.exe") == 0;
#endif
    if (!allowed) { emit("attach-failed", ",\"reason\":\"unexpected-process-name\""); return FALSE; }
    BOOL wow64 = FALSE;
    if (!IsWow64Process(target_process, &wow64) || wow64) {
        emit("attach-failed", ",\"reason\":\"unsupported-process-architecture\""); return FALSE;
    }
    return TRUE;
}

static int watch_counters_only(void) {
    perf_emit(FALSE, "performance-status", ",\"status\":\"recording\",\"source\":\"windows-process-counters\",\"debuggerAttached\":false,\"threadCountAvailable\":false,\"reason\":\"debugger-attach-unavailable\",\"frameTimesCollected\":false,\"frameTimesStatus\":\"separate-presentmon-required\"");
    BOOL exited = FALSE;
    while (!stop_requested) {
        DWORD wait = WaitForSingleObject(target_process, 100);
        if (wait == WAIT_OBJECT_0) { exited = TRUE; break; }
        if (wait == WAIT_FAILED) break;
        read_commands();
        perf_tick(FALSE);
    }
    if (exited) {
        DWORD code = 0; BOOL known = GetExitCodeProcess(target_process, &code);
        emit("exited", ",\"exitCode\":%lu,\"exitCodeHex\":\"0x%08lX\",\"exitCodeAvailable\":%s,\"elapsedMs\":%llu,\"fatalDumpCount\":0,\"debuggerAttached\":false",
            (unsigned long)code, (unsigned long)code, known ? "true" : "false", GetTickCount64() - started);
    }
    perf_end(exited ? "process-exited" : "stopped");
    return 0;
}

static int watch(void) {
    if (counters_only) {
        emit("observer-ready", ",\"mode\":\"passive\",\"debuggerAttached\":false");
        emit("attach-failed", ",\"reason\":\"passive-capture-no-exception-debugger\"");
        return watch_counters_only();
    }
    BOOL present = FALSE;
    if (!CheckRemoteDebuggerPresent(target_process, &present) || present) {
        emit("attach-failed", ",\"reason\":\"debugger-present-or-unavailable\",\"win32Error\":%lu", (unsigned long)GetLastError());
        return debug_enabled ? watch_counters_only() : 3;
    }
    if (!DebugActiveProcess(target_pid)) {
        emit("attach-failed", ",\"reason\":\"debug-active-process\",\"win32Error\":%lu", (unsigned long)GetLastError());
        return debug_enabled ? watch_counters_only() : 3;
    }
    /* Must run on the attaching thread, immediately after attaching. */
    if (!DebugSetProcessKillOnExit(FALSE)) {
        DWORD error = GetLastError();
        DebugActiveProcessStop(target_pid);
        emit("attach-failed", ",\"reason\":\"cannot-disable-kill-on-exit\",\"win32Error\":%lu", (unsigned long)error);
        return 3;
    }
    emit("attached", ",\"helperVersion\":1,\"killOnExit\":false,\"architecture\":\"x64\",\"firstChancePolicy\":\"pass-through\"");
    ULONGLONG next_sample = 0, next_summary = GetTickCount64() + 30000;
    BOOL exited = FALSE;
    while (!stop_requested && !exited) {
        DEBUG_EVENT event;
        if (WaitForDebugEvent(&event, 100)) {
            DWORD continuation = DBG_CONTINUE;
            switch (event.dwDebugEventCode) {
            case CREATE_PROCESS_DEBUG_EVENT:
                perf_thread(1);
                log_module(event.u.CreateProcessInfo.hFile, event.u.CreateProcessInfo.lpBaseOfImage);
                if (event.u.CreateProcessInfo.hFile) CloseHandle(event.u.CreateProcessInfo.hFile);
                /* Windows closes the process/thread debug-event handles on exit. */
                break;
            case LOAD_DLL_DEBUG_EVENT:
                log_module(event.u.LoadDll.hFile, event.u.LoadDll.lpBaseOfDll);
                if (event.u.LoadDll.hFile) CloseHandle(event.u.LoadDll.hFile);
                break;
            case UNLOAD_DLL_DEBUG_EVENT:
                if (++module_events <= 2048) emit("module-unloaded", ",\"base\":\"0x%016llX\"", (uint64_t)(uintptr_t)event.u.UnloadDll.lpBaseOfDll);
                break;
            case CREATE_THREAD_DEBUG_EVENT:
                perf_thread(1);
                if (++thread_events <= 512) emit("thread-created", ",\"threadId\":%lu,\"startAddress\":\"0x%016llX\"", (unsigned long)event.dwThreadId, (uint64_t)(uintptr_t)event.u.CreateThread.lpStartAddress);
                break;
            case EXIT_THREAD_DEBUG_EVENT:
                perf_thread(-1);
                if (++thread_events <= 512) emit("thread-exited", ",\"threadId\":%lu,\"exitCode\":%lu", (unsigned long)event.dwThreadId, (unsigned long)event.u.ExitThread.dwExitCode);
                break;
            case EXCEPTION_DEBUG_EVENT: {
                DWORD code = event.u.Exception.ExceptionRecord.ExceptionCode;
                if (waiting_attach_breakpoint && event.u.Exception.dwFirstChance && code == EXCEPTION_BREAKPOINT && remote_breakpoint &&
                    (uintptr_t)event.u.Exception.ExceptionRecord.ExceptionAddress == remote_breakpoint) {
                    waiting_attach_breakpoint = FALSE;
                    if (perf.running) perf.threads_known = TRUE;
                    emit("attach-breakpoint", ",\"threadId\":%lu", (unsigned long)event.dwThreadId);
                    break;
                }
                continuation = DBG_EXCEPTION_NOT_HANDLED;
                unsigned index = 0;
                for (; index < exception_types && exceptions[index].code != code; ++index) {}
                if (index == exception_types && exception_types < EXCEPTION_BINS) {
                    exceptions[index].code = code; ++exception_types;
                }
                uint64_t occurrence = index < EXCEPTION_BINS ? ++exceptions[index].count : UINT64_MAX;
                BOOL fatal = !event.u.Exception.dwFirstChance;
                if (fatal || occurrence <= 3) {
                    CONTEXT context;
                    BOOL context_ok = read_context(event.dwThreadId, &context);
                    log_exception(&event, &context, context_ok);
                    if (fatal) { sample(); perf_tick(TRUE); write_dump(FALSE, &event, &context, context_ok); }
                } else ++dropped_first_chance;
                break;
            }
            case EXIT_PROCESS_DEBUG_EVENT:
                emit("exited", ",\"exitCode\":%lu,\"exitCodeHex\":\"0x%08lX\",\"elapsedMs\":%llu,\"fatalDumpCount\":%u",
                    (unsigned long)event.u.ExitProcess.dwExitCode, (unsigned long)event.u.ExitProcess.dwExitCode, GetTickCount64() - started, fatal_count);
                exited = TRUE;
                break;
            case OUTPUT_DEBUG_STRING_EVENT:
                /* Never copy arbitrary debug strings: they can contain credentials. */
                break;
            default: break;
            }
            if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, continuation)) {
                emit("debug-error", ",\"reason\":\"continue-event\",\"win32Error\":%lu", (unsigned long)GetLastError());
                break;
            }
        } else {
            DWORD error = GetLastError();
            if (error != ERROR_SEM_TIMEOUT) {
                emit("debug-error", ",\"reason\":\"wait-event\",\"win32Error\":%lu", (unsigned long)error);
                break;
            }
        }
        if (!exited && !waiting_attach_breakpoint) read_commands();
        ULONGLONG now = GetTickCount64();
        if (!exited && !waiting_attach_breakpoint) perf_tick(FALSE);
        if (!exited && now >= next_sample) { sample(); next_sample = now + SAMPLE_INTERVAL; }
        if (now >= next_summary) { exception_summary(); next_summary = now + 30000; }
    }
    exception_summary();
    perf_end(exited ? "process-exited" : "stopped");
    if (!exited) {
        BOOL detached = DebugActiveProcessStop(target_pid);
        emit("detached", ",\"success\":%s,\"win32Error\":%lu", detached ? "true" : "false", detached ? 0UL : (unsigned long)GetLastError());
    }
    return 0;
}

int wmain(int argc, wchar_t **argv) {
    BOOL watch_mode = FALSE, snapshot_mode = FALSE, full = FALSE;
    const wchar_t *output = NULL;
    for (int i = 1; i < argc; ++i) {
        if (wcscmp(argv[i], L"--watch") == 0) watch_mode = TRUE;
        else if (wcscmp(argv[i], L"--snapshot") == 0) snapshot_mode = TRUE;
        else if (wcscmp(argv[i], L"--full") == 0) full = TRUE;
        else if (wcscmp(argv[i], L"--debug") == 0) debug_enabled = TRUE;
        else if (wcscmp(argv[i], L"--counters-only") == 0) counters_only = TRUE;
        else if (wcscmp(argv[i], L"--pid") == 0 && i + 1 < argc) {
            wchar_t *end = NULL;
            unsigned long long parsed = wcstoull(argv[++i], &end, 10);
            if (!end || *end || !parsed || parsed > MAXDWORD) return 2;
            target_pid = (DWORD)parsed;
        } else if (wcscmp(argv[i], L"--output") == 0 && i + 1 < argc) output = argv[++i];
        else return 2;
    }
    if (watch_mode == snapshot_mode || !output || !target_pid || (watch_mode && full) || (debug_enabled && !watch_mode) || (counters_only && !watch_mode)) {
        fprintf(stderr, "Usage: ROTK.Diagnostics.exe (--watch [--debug] | --snapshot [--full]) --pid PID --output DIRECTORY\n");
        return 2;
    }
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
#ifndef ROTK_DIAGNOSTICS_TEST
    /* Production must never attach to the game's protected process. */
    if (watch_mode) counters_only = TRUE;
#endif
    SetConsoleCtrlHandler(console_control, TRUE);
    started = GetTickCount64();
    if (!validate_target()) { if (target_process) CloseHandle(target_process); return 3; }
    DWORD output_length = GetFullPathNameW(output, PATH_CAP, output_directory, NULL);
    if (!output_length || output_length >= PATH_CAP - 256 || (wcsncmp(output_directory, L"\\\\", 2) == 0)) {
        emit("attach-failed", ",\"reason\":\"invalid-local-output-directory\""); CloseHandle(target_process); return 2;
    }
    wchar_t drive[] = {output_directory[0], L':', L'\\', 0};
    if (output_directory[1] != L':' || GetDriveTypeW(drive) != DRIVE_FIXED) {
        emit("attach-failed", ",\"reason\":\"output-must-be-local-fixed-drive\""); CloseHandle(target_process); return 2;
    }
    if (!CreateDirectoryW(output_directory, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) {
        emit("attach-failed", ",\"reason\":\"create-output-directory\",\"win32Error\":%lu", (unsigned long)GetLastError()); CloseHandle(target_process); return 2;
    }
    swprintf(log_path, PATH_CAP, L"%ls\\native-events.jsonl", output_directory);
    journal = _wfopen(log_path, L"ab");
    if (!journal) { emit("attach-failed", ",\"reason\":\"open-journal\""); CloseHandle(target_process); return 2; }
    _fseeki64(journal, 0, SEEK_END);
    __int64 existing = _ftelli64(journal);
    if (existing > 0) journal_bytes = (uint64_t)existing;
    rotate_journal();
    if (debug_enabled) perf_begin(target_process, target_pid, output_directory);
    int result;
    if (watch_mode) result = watch();
    else { sample(); result = write_dump(full, NULL, NULL, FALSE) ? 0 : 4; }
    perf_end("helper-stopped");
    if (journal) fclose(journal);
    CloseHandle(target_process);
    return result;
}
