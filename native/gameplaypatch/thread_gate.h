/* Freezes every other thread of the process around a multi-byte code write.
 * The handle list only grows before the first SuspendThread: a suspended
 * thread may own the heap lock. Nothing sleeps, allocates or logs while a
 * thread is suspended. Startup threads can exit or sit inside a patch window,
 * so those states are retried from a fresh snapshot with everything resumed.
 */
#include <tlhelp32.h>

#define THREAD_GATE_ATTEMPTS 20U
/* Sanity cap only: H1Z1 with an NVIDIA driver was seen at 316 threads. */
#define THREAD_GATE_LIMIT 4096U

typedef enum {
    THREAD_GATE_FROZEN, THREAD_GATE_CHANGED, THREAD_GATE_INSIDE, THREAD_GATE_TOO_MANY
} thread_gate_state;
typedef struct { const BYTE *start; SIZE_T length; } thread_gate_window;
typedef struct { HANDLE *handles; unsigned int count, stopped; const char *name; } thread_gate;

static void thread_gate_thaw(thread_gate *gate) {
    unsigned int held = gate->count;
    char line[160];
    while (gate->stopped) ResumeThread(gate->handles[--gate->stopped]);
    while (gate->count) CloseHandle(gate->handles[--gate->count]);
    if (gate->handles) HeapFree(GetProcessHeap(), 0, gate->handles);
    gate->handles = NULL;
    if (gate->name) {
        snprintf(line, sizeof(line), "ROTK %s: %u threads held for the guarded write.\n", gate->name, held);
        patch_log(line);
        gate->name = NULL;
    }
}

static thread_gate_state thread_gate_try(thread_gate *gate, const thread_gate_window *windows, unsigned int window_count) {
    DWORD self = GetCurrentThreadId(), process = GetCurrentProcessId(), error;
    unsigned int capacity = 0, i, j;
    THREADENTRY32 row;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return THREAD_GATE_CHANGED;
    row.dwSize = sizeof(row);
    if (!Thread32First(snapshot, &row)) { CloseHandle(snapshot); return THREAD_GATE_CHANGED; }
    do {
        if (row.th32OwnerProcessID != process || row.th32ThreadID == self) continue;
        if (gate->count == capacity) {
            HANDLE *grown;
            if (capacity == THREAD_GATE_LIMIT) { CloseHandle(snapshot); return THREAD_GATE_TOO_MANY; }
            capacity = capacity ? capacity * 2 : 256;
            grown = gate->handles ?
                (HANDLE *)HeapReAlloc(GetProcessHeap(), 0, gate->handles, capacity * sizeof(HANDLE)) :
                (HANDLE *)HeapAlloc(GetProcessHeap(), 0, capacity * sizeof(HANDLE));
            if (!grown) { CloseHandle(snapshot); return THREAD_GATE_TOO_MANY; }
            gate->handles = grown;
        }
        gate->handles[gate->count] = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT, FALSE, row.th32ThreadID);
        if (!gate->handles[gate->count]) { CloseHandle(snapshot); return THREAD_GATE_CHANGED; }
        ++gate->count;
    } while (Thread32Next(snapshot, &row));
    error = GetLastError();
    CloseHandle(snapshot);
    if (error != ERROR_NO_MORE_FILES) return THREAD_GATE_CHANGED;
    for (i = 0; i < gate->count; ++i) {
        CONTEXT context; memset(&context, 0, sizeof(context)); context.ContextFlags = CONTEXT_CONTROL;
        if (SuspendThread(gate->handles[i]) == (DWORD)-1) return THREAD_GATE_CHANGED;
        ++gate->stopped;
        if (!GetThreadContext(gate->handles[i], &context)) return THREAD_GATE_CHANGED;
        for (j = 0; j < window_count; ++j)
            if (context.Rip >= (uintptr_t)windows[j].start &&
                context.Rip < (uintptr_t)windows[j].start + windows[j].length) return THREAD_GATE_INSIDE;
    }
    return THREAD_GATE_FROZEN;
}

/* TRUE: every other thread is suspended outside the windows; call
 * thread_gate_thaw after the write. FALSE: nothing is suspended or held. */
static BOOL thread_gate_freeze(thread_gate *gate, const char *name,
                               const thread_gate_window *windows, unsigned int window_count) {
    static const char *const reasons[] = {
        "", "thread list kept changing", "a thread stayed inside the patch window", "too many threads"
    };
    thread_gate_state state = THREAD_GATE_CHANGED;
    unsigned int attempts = 0, seen = 0;
    char line[192];
    while (attempts < THREAD_GATE_ATTEMPTS) {
        if (attempts++) Sleep(10);
        gate->handles = NULL; gate->count = gate->stopped = 0; gate->name = NULL;
        state = thread_gate_try(gate, windows, window_count);
        if (state == THREAD_GATE_FROZEN) { gate->name = name; return TRUE; }
        seen = gate->count;
        thread_gate_thaw(gate);
        if (state == THREAD_GATE_TOO_MANY) break;
    }
    snprintf(line, sizeof(line), "ROTK %s: thread gate refused after %u attempt(s) at %u threads: %s.\n",
             name, attempts, seen, reasons[state]);
    patch_log(line);
    return FALSE;
}
