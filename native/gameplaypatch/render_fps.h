#ifndef ROTK_RENDER_FPS_H
#define ROTK_RENDER_FPS_H
#define COBJMACROS
#include <d3d11.h>
#include <dxgi.h>

/* Count successful presentations, independently of Scaleform's frame rate. */
typedef HRESULT (STDMETHODCALLTYPE *fps_present_fn)(IDXGISwapChain *, UINT, UINT);
typedef void (*fps_option_fn)(BYTE *, BYTE *, unsigned int, BYTE *);
static fps_present_fn fps_original_present;
static fps_option_fn fps_original_option;
static BYTE *fps_base;
static SRWLOCK fps_lock = SRWLOCK_INIT;
static IDXGISwapChain *fps_chain;
static LARGE_INTEGER fps_frequency, fps_last_present;
static uint64_t fps_frames, fps_generation;
static RUNTIME_FUNCTION fps_unwind;
static volatile LONG fps_enabled;
#ifdef ROTK_FPS_DIAGNOSTIC
static UINT fps_reference;
#endif

static HRESULT STDMETHODCALLTYPE fps_present(IDXGISwapChain *chain, UINT interval, UINT flags) {
    HRESULT result = fps_original_present(chain, interval, flags);
    DXGI_SWAP_CHAIN_DESC desc;
    RECT size;
    DWORD pid = 0;
    LARGE_INTEGER now;
    if (!InterlockedCompareExchange(&fps_enabled, 0, 0) || result != S_OK || (flags & DXGI_PRESENT_TEST)) return result;
    QueryPerformanceCounter(&now);
    AcquireSRWLockExclusive(&fps_lock);
    if (chain != fps_chain) {
        ReleaseSRWLockExclusive(&fps_lock);
        if (FAILED(IDXGISwapChain_GetDesc(chain, &desc)) ||
            !GetClientRect(desc.OutputWindow, &size) ||
            size.right - size.left < 320 || size.bottom - size.top < 200 ||
            GetAncestor(desc.OutputWindow, GA_ROOT) != desc.OutputWindow) return result;
        GetWindowThreadProcessId(desc.OutputWindow, &pid);
        if (pid != GetCurrentProcessId()) return result;
        AcquireSRWLockExclusive(&fps_lock);
    }
    /* A recreated swap chain starts a new sample instead of mixing counters. */
    if (!fps_chain || (chain != fps_chain &&
        now.QuadPart - fps_last_present.QuadPart > fps_frequency.QuadPart)) {
        fps_chain = chain;
        fps_frames = 0;
        ++fps_generation;
    }
    if (chain == fps_chain) {
        ++fps_frames;
        fps_last_present = now;
#ifdef ROTK_FPS_DIAGNOSTIC
        IDXGISwapChain_GetLastPresentCount(chain, &fps_reference);
#endif
    }
    ReleaseSRWLockExclusive(&fps_lock);
    return result;
}

static BOOL fps_string_is(const BYTE *value, const char *expected) {
    uint32_t type;
    uintptr_t text;
    char bytes[32];
    SIZE_T length = strlen(expected) + 1;
    if (length > sizeof(bytes) || !stance_read(value + 0x18, &type, sizeof(type)) ||
        (type & 0x3f) != 6 || !stance_read(value + 0x20, &text, sizeof(text))) return FALSE;
    if (type & 0x40) text = stance_ptr((void *)text);
    return stance_read((void *)text, bytes, length) && !memcmp(bytes, expected, length);
}

static void fps_option(BYTE *movie, BYTE *args, unsigned int count, BYTE *result) {
    typedef BYTE *(*movie_impl_fn)(BYTE *);
    typedef void (*create_string_fn)(BYTE *, BYTE *, const char *);
    if (InterlockedCompareExchange(&fps_enabled, 0, 0) && count == 3 && fps_string_is(args, "ROTKRuntime") &&
        fps_string_is(args + 48, "RenderedFramesV1")) {
        BYTE *impl;
        uintptr_t vtable = stance_ptr(movie), method = stance_ptr((void *)(vtable + 0x150));
        char sample[128];
        LARGE_INTEGER now;
        uint64_t frames, generation;
        QueryPerformanceCounter(&now);
        AcquireSRWLockShared(&fps_lock);
        frames = fps_frames;
        generation = fps_generation;
        if (!fps_chain || now.QuadPart - fps_last_present.QuadPart > fps_frequency.QuadPart)
            generation = 0;
        ReleaseSRWLockShared(&fps_lock);
        snprintf(sample, sizeof(sample), "1,%llu,%llu,%lld,%lld", (unsigned long long)generation,
            (unsigned long long)frames, (long long)now.QuadPart, (long long)fps_frequency.QuadPart);
#ifdef ROTK_FPS_DIAGNOSTIC
        {
            static unsigned int captures;
            if (captures++ < 40) {
                char line[200];
                snprintf(line, sizeof(line), "ROTK FPS sample %s reference=%u\n", sample, fps_reference);
                patch_log(line);
            }
        }
#endif
        /* Use the same native string constructor as the stock binding. */
        if (method && readable_range(result, 48) &&
            (impl = ((movie_impl_fn)method)(movie)) != NULL) {
            ((create_string_fn)(uintptr_t)(fps_base + 0xba36b))(impl, result, sample);
            return;
        }
    }
    fps_original_option(movie, args, count, result);
}

static BOOL fps_hook_option(BYTE *base) {
    static const BYTE prologue[] = {0x48,0x8b,0xc4,0x55,0x41,0x54,0x41,0x55};
    static const BYTE remaining_prologue[] = {0x41,0x56,0x41,0x57,0x48,0x8d,0xa8,0x58,0xfe,0xff,0xff,0x48,0x81,0xec,0x80,0x02,0x00,0x00};
    static const BYTE string_thunk[] = {0xe9,0x20,0x4a,0xd0,0x01};
    static const BYTE getter_thunk[] = {0xe9,0xfc,0xce,0xb8,0x01};
    BYTE *bridge = NULL, original[15], replacement[15];
    DWORD protection;
    int32_t relative;
    if (!exact_bytes(base + 0x1c18b10, prologue, sizeof(prologue)) ||
        !exact_bytes(base + 0x1c18b18, remaining_prologue, sizeof(remaining_prologue)) ||
        !exact_bytes(base + 0x8bc0f, getter_thunk, sizeof(getter_thunk)) ||
        !exact_bytes(base + 0xba36b, string_thunk, sizeof(string_thunk))) return FALSE;
    bridge = bridge_page(base);
    if (!bridge) { bridge_refused("ROTK FPS", base); return FALSE; }
    memcpy(bridge, prologue, 8);
    stance_jump(bridge + 8, base + 0x1c18b18);
    stance_jump(bridge + 32, (void *)(uintptr_t)fps_option);
    /* Unwind metadata for the copied PUSH RBP, R12 and R13 prologue. */
    const BYTE unwind[] = {1,8,3,0,8,0xd0,6,0xc0,4,0x50,0,0};
    memcpy(bridge + 128, unwind, sizeof(unwind));
    fps_unwind.BeginAddress = 0;
    fps_unwind.EndAddress = 22;
    fps_unwind.UnwindData = 128;
    if (!VirtualProtect(bridge, 4096, PAGE_EXECUTE_READ, &protection) ||
        !FlushInstructionCache(GetCurrentProcess(), bridge, 4096) ||
        !RtlAddFunctionTable(&fps_unwind, 1, (DWORD64)(uintptr_t)bridge)) {
        bridge_release(bridge);
        return FALSE;
    }
    relative = (int32_t)((bridge + 32) - (base + 0x1c18b15));
    memcpy(original, base + 0x1c18b10, sizeof(original));
    memcpy(replacement, original, sizeof(replacement));
    replacement[0] = 0xe9;
    memcpy(replacement + 1, &relative, 4);
    memset(replacement + 5, 0x90, 3);
    fps_base = base;
    fps_original_option = (fps_option_fn)(uintptr_t)bridge;
    /* Reuse the existing thread gate: reject a thread inside the old prologue. */
    return stance_commit(base + 0x1c18b10, original, replacement,
        base + 0x8bc0f, getter_thunk, getter_thunk);
}

static void fps_install(BYTE *base) {
    HWND window;
    IDXGISwapChain *chain = NULL;
    ID3D11Device *device = NULL;
    ID3D11DeviceContext *context = NULL;
    DXGI_SWAP_CHAIN_DESC desc;
    void **vtable;
    DWORD protection;
    HRESULT created;
    QueryPerformanceFrequency(&fps_frequency);
    if (fps_frequency.QuadPart <= 0) return;
    window = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, 1, 1, NULL, NULL, GetModuleHandleW(NULL), NULL);
    if (!window) return;
    memset(&desc, 0, sizeof(desc));
    desc.BufferCount = 1;
    desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.OutputWindow = window;
    desc.SampleDesc.Count = 1;
    desc.Windowed = TRUE;
    created = D3D11CreateDeviceAndSwapChain(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0, NULL, 0,
        D3D11_SDK_VERSION, &desc, &chain, &device, NULL, &context);
    if (SUCCEEDED(created)) {
        vtable = *(void ***)chain;
        fps_original_present = (fps_present_fn)(uintptr_t)vtable[8];
        if (fps_hook_option(base) && VirtualProtect(vtable + 8, sizeof(void *), PAGE_READWRITE, &protection)) {
            InterlockedExchangePointer((void *volatile *)(vtable + 8), (void *)(uintptr_t)fps_present);
            InterlockedExchange(&fps_enabled, 1);
            if (!restore_page_protection(vtable + 8, sizeof(void *), protection))
                patch_log("ROTK FPS: presentation hook page protection restore failed.\n");
            patch_log("ROTK FPS: native presentation counter installed.\n");
        } else patch_log("ROTK FPS: native counter installation refused.\n");
    } else patch_log("ROTK FPS: DXGI initialization refused.\n");
    if (context) ID3D11DeviceContext_Release(context);
    if (device) ID3D11Device_Release(device);
    if (chain) IDXGISwapChain_Release(chain);
    DestroyWindow(window);
}
#endif
