#include "../dinput8_proxy.c"
#undef NDEBUG
#include <assert.h>

/*
 * Runs the real pass on WARP (the software Direct3D 11 device every Windows has)
 * and checks pixels, state restore, resize, formats and the off paths.
 */
#define W 64
#define H 48
static uint32_t pixels[W * H];
static HWND window;
static unsigned int presents;
static IDXGISwapChain *expected_chain;
static BOOL graded_before_present;

static HRESULT STDMETHODCALLTYPE stub_present(IDXGISwapChain *chain, UINT interval, UINT flags) {
    (void)interval; (void)flags;
    ++presents;
    graded_before_present = chain == expected_chain && image_gpu.generation == image_generation;
    return S_OK;
}

static void settings(const char *text) {
    WCHAR path[MAX_PATH];
    FILE *file;
    GetTempPathW(MAX_PATH, path);
    wcscat(path, L"rotk-image-test.ini");
    file = _wfopen(path, L"wb");
    assert(file);
    fputs(text, file);
    fclose(file);
    image_load_settings(path);
    DeleteFileW(path);
}

static IDXGISwapChain *create(DXGI_FORMAT format, DXGI_SWAP_EFFECT effect, UINT samples, ID3D11Device **device, ID3D11DeviceContext **context) {
    DXGI_SWAP_CHAIN_DESC desc;
    IDXGISwapChain *chain = NULL;
    memset(&desc, 0, sizeof(desc));
    desc.BufferDesc.Width = W;
    desc.BufferDesc.Height = H;
    desc.BufferDesc.Format = format;
    desc.SampleDesc.Count = samples;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = effect == DXGI_SWAP_EFFECT_FLIP_DISCARD ? 2 : 1;
    /* One window per chain: DXGI refuses a second swap chain on the same window. */
    desc.OutputWindow = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, W, H, NULL, NULL, GetModuleHandleW(NULL), NULL);
    assert(desc.OutputWindow);
    desc.Windowed = TRUE;
    desc.SwapEffect = effect;
    if (FAILED(D3D11CreateDeviceAndSwapChain(NULL, D3D_DRIVER_TYPE_WARP, NULL, 0, NULL, 0, D3D11_SDK_VERSION,
            &desc, &chain, device, NULL, context))) return NULL;
    return chain;
}

/* Fills the back buffer with a gradient plus a dark corner and a hard edge. */
static void fill(IDXGISwapChain *chain, ID3D11DeviceContext *context, BOOL bgr) {
    ID3D11Texture2D *back;
    for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) {
            uint32_t r = (uint32_t)(x * 255 / (W - 1)), g = (uint32_t)(y * 255 / (H - 1)), b = (uint32_t)((x + y) * 2 % 256);
            if (x < 8 && y < 8) r = g = b = (uint32_t)(x + y) * 4;
            pixels[y * W + x] = (bgr ? b | r << 16 : r | b << 16) | g << 8 | 0xff000000u;
        }
    assert(SUCCEEDED(IDXGISwapChain_GetBuffer(chain, 0, &image_iid_texture, (void **)&back)));
    ID3D11DeviceContext_UpdateSubresource(context, (ID3D11Resource *)back, 0, NULL, pixels, W * 4, 0);
    ID3D11Texture2D_Release(back);
}

static void read_back(IDXGISwapChain *chain, ID3D11Device *device, ID3D11DeviceContext *context, uint32_t *out) {
    ID3D11Texture2D *back, *staging;
    D3D11_TEXTURE2D_DESC desc;
    D3D11_MAPPED_SUBRESOURCE map;
    assert(SUCCEEDED(IDXGISwapChain_GetBuffer(chain, 0, &image_iid_texture, (void **)&back)));
    ID3D11Texture2D_GetDesc(back, &desc);
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    assert(SUCCEEDED(ID3D11Device_CreateTexture2D(device, &desc, NULL, &staging)));
    ID3D11DeviceContext_CopyResource(context, (ID3D11Resource *)staging, (ID3D11Resource *)back);
    assert(SUCCEEDED(ID3D11DeviceContext_Map(context, (ID3D11Resource *)staging, 0, D3D11_MAP_READ, 0, &map)));
    for (int y = 0; y < H; ++y) memcpy(out + y * W, (BYTE *)map.pData + y * map.RowPitch, W * 4);
    ID3D11DeviceContext_Unmap(context, (ID3D11Resource *)staging, 0);
    ID3D11Texture2D_Release(staging);
    ID3D11Texture2D_Release(back);
}

/* Trilinear LUT lookup on the CPU, as the shader does it. */
static float reference(const float c[3], int channel_index) {
    float f[3], result = 0.0f;
    int i0[3];
    for (int k = 0; k < 3; ++k) {
        float position = c[k] * (IMAGE_LUT_SIZE - 1);
        i0[k] = position >= IMAGE_LUT_SIZE - 1 ? IMAGE_LUT_SIZE - 2 : (int)position;
        f[k] = position - (float)i0[k];
    }
    for (int corner = 0; corner < 8; ++corner) {
        int r = i0[0] + (corner & 1), g = i0[1] + (corner >> 1 & 1), b = i0[2] + (corner >> 2 & 1);
        float weight = (corner & 1 ? f[0] : 1 - f[0]) * (corner & 2 ? f[1] : 1 - f[1]) * (corner & 4 ? f[2] : 1 - f[2]);
        result += weight * (float)(image_pending[(b * IMAGE_LUT_SIZE + g) * IMAGE_LUT_SIZE + r] >> (8 * channel_index) & 0xff);
    }
    return result;
}

static void check_graded(const uint32_t *out, BOOL bgr) {
    int worst = 0;
    for (int i = 0; i < W * H; ++i) {
        uint32_t in = pixels[i], got = out[i];
        float c[3];
        int rs = bgr ? 16 : 0, bs = bgr ? 0 : 16;
        c[0] = (float)(in >> rs & 0xff) / 255.0f;
        c[1] = (float)(in >> 8 & 0xff) / 255.0f;
        c[2] = (float)(in >> bs & 0xff) / 255.0f;
        for (int k = 0; k < 3; ++k) {
            int shift = k == 0 ? rs : k == 1 ? 8 : bs;
            int delta = abs((int)(got >> shift & 0xff) - (int)lrintf(reference(c, k)));
            if (delta > worst) worst = delta;
        }
    }
    if (worst > 3) { fprintf(stderr, "graded pixel off by %d/255\n", worst); abort(); }
}

static void check_format(DXGI_FORMAT format, DXGI_SWAP_EFFECT effect, BOOL bgr) {
    ID3D11Device *device;
    ID3D11DeviceContext *context;
    IDXGISwapChain *chain = create(format, effect, 1, &device, &context);
    uint32_t out[W * H];
    D3D11_VIEWPORT viewport = {3, 4, 20, 10, 0.25f, 0.75f}, got_viewport[2];
    UINT count = 2;
    ID3D11RasterizerState *raster, *got_raster;
    ID3D11RenderTargetView *rtv, *got_rtv[2] = {NULL, NULL};
    ID3D11Texture2D *other;
    D3D11_RASTERIZER_DESC raster_desc = {D3D11_FILL_WIREFRAME, D3D11_CULL_FRONT, FALSE, 0, 0, 0, TRUE, TRUE, FALSE, FALSE};
    D3D11_TEXTURE2D_DESC other_desc = {8, 8, 1, 1, DXGI_FORMAT_R8G8B8A8_UNORM, {1, 0}, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET, 0, 0};
    assert(chain);
    fill(chain, context, bgr);
    /* Game state that the pass must give back untouched. */
    assert(SUCCEEDED(ID3D11Device_CreateRasterizerState(device, &raster_desc, &raster)));
    assert(SUCCEEDED(ID3D11Device_CreateTexture2D(device, &other_desc, NULL, &other)));
    assert(SUCCEEDED(ID3D11Device_CreateRenderTargetView(device, (ID3D11Resource *)other, NULL, &rtv)));
    ID3D11DeviceContext_RSSetState(context, raster);
    ID3D11DeviceContext_RSSetViewports(context, 1, &viewport);
    ID3D11DeviceContext_OMSetRenderTargets(context, 1, &rtv, NULL);
    assert(image_apply(chain));
    ID3D11DeviceContext_RSGetState(context, &got_raster);
    ID3D11DeviceContext_RSGetViewports(context, &count, got_viewport);
    ID3D11DeviceContext_OMGetRenderTargets(context, 2, got_rtv, NULL);
    assert(got_raster == raster && count == 1 && !memcmp(&got_viewport[0], &viewport, sizeof(viewport)));
    assert(got_rtv[0] == rtv && got_rtv[1] == NULL);
    ID3D11RasterizerState_Release(got_raster);
    ID3D11RenderTargetView_Release(got_rtv[0]);
    read_back(chain, device, context, out);
    check_graded(out, bgr);
    /* No back buffer reference is left behind: the game can still resize. */
    ID3D11DeviceContext_OMSetRenderTargets(context, 0, NULL, NULL);
    assert(SUCCEEDED(IDXGISwapChain_ResizeBuffers(chain, 0, W, H, DXGI_FORMAT_UNKNOWN, 0)));
    fill(chain, context, bgr);
    assert(image_apply(chain));
    ID3D11RenderTargetView_Release(rtv);
    ID3D11Texture2D_Release(other);
    ID3D11RasterizerState_Release(raster);
    ID3D11DeviceContext_Release(context);
    ID3D11Device_Release(device);
    IDXGISwapChain_Release(chain);
}

int main(void) {
    ID3D11Device *device;
    ID3D11DeviceContext *context;
    IDXGISwapChain *chain;
    uint32_t out[W * H];
    window = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, W, H, NULL, NULL, GetModuleHandleW(NULL), NULL);
    assert(window);

    /* Locale-independent decimals from the menu. */
    assert(image_parse_float(L"1.15", 0) == 1.15f && image_parse_float(L" -0.5", 0) == -0.5f);
    assert(image_parse_float(L"1,25", 0) == 1.25f && image_parse_float(L"abc", 7) == 7.0f);
    assert(image_parse_float(L"", 3) == 3.0f && image_parse_float(L"1e999", 0) == 1.0f);

    /* Missing keys, the switch OFF and the Off preset leave the pass off. */
    settings("[UI]\r\n");
    assert(!image_pending_active);
    settings("[UI]\r\nrotk_img_preset=1\r\nrotk_img_daltonism=2\r\nrotk_img_sharpness=1\r\n");
    assert(!image_pending_active);
    settings("[UI]\r\nrotk_img_mode=0\r\nrotk_img_preset=1\r\nrotk_img_daltonism=2\r\n");
    assert(!image_pending_active);
    settings("[UI]\r\nrotk_img_mode=1\r\nrotk_img_preset=0\r\nrotk_img_saturation=1.4\r\n");
    assert(!image_pending_active);
    chain = create(DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SWAP_EFFECT_DISCARD, 1, &device, &context);
    assert(chain);
    assert(!image_apply(chain));

    /* Colour only (no sharpening) is checked pixel by pixel on every supported format. */
    settings("[UI]\r\nrotk_img_mode=1\r\nrotk_img_preset=4\r\nrotk_img_saturation=1.3\r\nrotk_img_vibrance=0.4\r\n"
        "rotk_img_contrast=1.15\r\nrotk_img_temperature=0.5\r\nrotk_img_sharpness=0\r\n");
    assert(image_pending_active && image_pending_sharpness == 0.0f);
    check_format(DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SWAP_EFFECT_DISCARD, FALSE);
    check_format(DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SWAP_EFFECT_DISCARD, TRUE);
    check_format(DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, DXGI_SWAP_EFFECT_DISCARD, FALSE);
    check_format(DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_SWAP_EFFECT_DISCARD, TRUE);
    check_format(DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SWAP_EFFECT_FLIP_DISCARD, FALSE);
    check_format(DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SWAP_EFFECT_FLIP_DISCARD, TRUE);
    settings("[UI]\r\nrotk_img_mode=1\r\nrotk_img_preset=1\r\nrotk_img_daltonism=2\r\n");
    image_pending_sharpness = 0.0f; /* pixel-exact check below needs the LUT alone */
    check_format(DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SWAP_EFFECT_DISCARD, FALSE);

    /* Unsupported back buffers keep the stock image: half floats and multisampling. */
    {
        ID3D11Device *other_device;
        ID3D11DeviceContext *other_context;
        IDXGISwapChain *other = create(DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_SWAP_EFFECT_DISCARD, 1, &other_device, &other_context);
        assert(other && !image_apply(other));
        IDXGISwapChain_Release(other); ID3D11DeviceContext_Release(other_context); ID3D11Device_Release(other_device);
        other = create(DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SWAP_EFFECT_DISCARD, 4, &other_device, &other_context);
        assert(other && !image_apply(other));
        IDXGISwapChain_Release(other); ID3D11DeviceContext_Release(other_context); ID3D11Device_Release(other_device);
    }

    /* Sharpening: a flat area stays flat, an edge gains contrast, nothing leaves 0..255. */
    settings("[UI]\r\nrotk_img_mode=1\r\nrotk_img_preset=4\r\nrotk_img_sharpness=1\r\n");
    assert(image_pending_active && image_pending_sharpness == 1.0f);
    for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) pixels[y * W + x] = x < W / 2 ? 0xff606060u : 0xffa0a0a0u;
    {
        ID3D11Texture2D *back;
        assert(SUCCEEDED(IDXGISwapChain_GetBuffer(chain, 0, &image_iid_texture, (void **)&back)));
        ID3D11DeviceContext_UpdateSubresource(context, (ID3D11Resource *)back, 0, NULL, pixels, W * 4, 0);
        ID3D11Texture2D_Release(back);
    }
    assert(image_apply(chain));
    read_back(chain, device, context, out);
    assert((out[10 * W + 4] & 0xff) >= 0x5e && (out[10 * W + 4] & 0xff) <= 0x62);
    assert((out[10 * W + W - 4] & 0xff) >= 0x9e && (out[10 * W + W - 4] & 0xff) <= 0xa2);
    assert((out[10 * W + W / 2 - 1] & 0xff) < 0x5e && (out[10 * W + W / 2] & 0xff) > 0xa2);
    /* A dark edge inside the shadows is left as drawn: sharpening neither lightens nor deepens it. */
    for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) pixels[y * W + x] = x < W / 2 ? 0xff101010u : 0xff303030u;
    {
        ID3D11Texture2D *back;
        assert(SUCCEEDED(IDXGISwapChain_GetBuffer(chain, 0, &image_iid_texture, (void **)&back)));
        ID3D11DeviceContext_UpdateSubresource(context, (ID3D11Resource *)back, 0, NULL, pixels, W * 4, 0);
        ID3D11Texture2D_Release(back);
    }
    assert(image_apply(chain));
    read_back(chain, device, context, out);
    for (int i = 0; i < W * H; ++i) assert(abs((int)(out[i] & 0xff) - (int)(pixels[i] & 0xff)) <= 1);

    /* Through the real Present hook: graded before the stock Present, never for other chains. */
    fps_original_present = stub_present;
    settings("[UI]\r\nrotk_img_mode=1\r\nrotk_img_preset=2\r\n");
    InterlockedExchange(&image_enabled, 1);
    fps_chain = chain;
    expected_chain = chain;
    assert(fps_present(chain, 0, 0) == S_OK && presents == 1 && graded_before_present);
    fps_chain = NULL;
    image_gpu.generation = 0;
    assert(fps_present(chain, 0, 0) == S_OK && presents == 2 && image_gpu.generation == 0);
    fps_chain = chain;
    assert(fps_present(chain, 0, DXGI_PRESENT_TEST) == S_OK && image_gpu.generation == 0);
    InterlockedExchange(&image_enabled, 0);
    assert(fps_present(chain, 0, 0) == S_OK && image_gpu.generation == 0);

    /* A new device rebuilds the objects instead of using stale ones. */
    {
        ID3D11Device *before = image_gpu.device, *other_device;
        ID3D11DeviceContext *other_context;
        IDXGISwapChain *other = create(DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SWAP_EFFECT_DISCARD, 1, &other_device, &other_context);
        assert(other && image_apply(other) && image_gpu.device == other_device && image_gpu.device != before);
        image_release_device();
        IDXGISwapChain_Release(other); ID3D11DeviceContext_Release(other_context); ID3D11Device_Release(other_device);
    }
    IDXGISwapChain_Release(chain);
    ID3D11DeviceContext_Release(context);
    ID3D11Device_Release(device);
    DestroyWindow(window);
    puts("image pass tests passed");
    return 0;
}
