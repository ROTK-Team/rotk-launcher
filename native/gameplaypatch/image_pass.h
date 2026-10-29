#ifndef ROTK_IMAGE_PASS_H
#define ROTK_IMAGE_PASS_H
#include "image_lut.h"
#include "image_pass_shaders.h"

/*
 * Player image settings (colour LUT + sharpening) drawn on the main swap chain
 * just before the stock Present. Settings come from [UI] in UserOptions.ini,
 * written by the Graphics menu; a worker rereads them when the file changes.
 * Neutral settings skip the pass entirely. Any Direct3D failure disables the
 * pass for that device, so the game always keeps its stock image.
 */
#define IMAGE_POLL_MS 1000U
static const GUID image_iid_device = {0xdb6f6ddb, 0xac77, 0x4e88, {0x82, 0x53, 0x81, 0x9d, 0xf9, 0xbb, 0xf1, 0x40}};
static const GUID image_iid_texture = {0x6f15aaf2, 0xd208, 0x4e89, {0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}};
static volatile LONG image_enabled;
static SRWLOCK image_lock = SRWLOCK_INIT;
static uint32_t image_pending[IMAGE_LUT_TEXELS];
static float image_pending_sharpness;
static volatile LONG image_generation, image_pending_active;

static struct {
    ID3D11Device *device;
    ID3D11VertexShader *vs;
    ID3D11PixelShader *ps;
    ID3D11Buffer *constants;
    ID3D11SamplerState *sampler;
    ID3D11RasterizerState *raster;
    ID3D11Texture3D *lut;
    ID3D11ShaderResourceView *lut_view;
    ID3D11Texture2D *copy;
    ID3D11ShaderResourceView *copy_view;
    UINT width, height;
    DXGI_FORMAT format;
    LONG generation;
    BOOL failed;
} image_gpu;

#define IMAGE_RELEASE(type, object) do { if (object) { type##_Release(object); (object) = NULL; } } while (0)

static void image_release_copy(void) {
    IMAGE_RELEASE(ID3D11ShaderResourceView, image_gpu.copy_view);
    IMAGE_RELEASE(ID3D11Texture2D, image_gpu.copy);
    image_gpu.width = image_gpu.height = 0;
    image_gpu.format = DXGI_FORMAT_UNKNOWN;
}

static void image_release_device(void) {
    image_release_copy();
    IMAGE_RELEASE(ID3D11ShaderResourceView, image_gpu.lut_view);
    IMAGE_RELEASE(ID3D11Texture3D, image_gpu.lut);
    IMAGE_RELEASE(ID3D11RasterizerState, image_gpu.raster);
    IMAGE_RELEASE(ID3D11SamplerState, image_gpu.sampler);
    IMAGE_RELEASE(ID3D11Buffer, image_gpu.constants);
    IMAGE_RELEASE(ID3D11PixelShader, image_gpu.ps);
    IMAGE_RELEASE(ID3D11VertexShader, image_gpu.vs);
    IMAGE_RELEASE(ID3D11Device, image_gpu.device);
    image_gpu.generation = 0;
    image_gpu.failed = FALSE;
}

/* Copy and view formats for the back buffers the pass supports; anything else keeps the stock image. */
static BOOL image_formats(DXGI_FORMAT format, DXGI_FORMAT *typeless, DXGI_FORMAT *view, BOOL *srgb) {
    *srgb = format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB || format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
    switch (format) {
    case DXGI_FORMAT_R8G8B8A8_UNORM: case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
        *typeless = DXGI_FORMAT_R8G8B8A8_TYPELESS; *view = DXGI_FORMAT_R8G8B8A8_UNORM; return TRUE;
    case DXGI_FORMAT_B8G8R8A8_UNORM: case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
        *typeless = DXGI_FORMAT_B8G8R8A8_TYPELESS; *view = DXGI_FORMAT_B8G8R8A8_UNORM; return TRUE;
    case DXGI_FORMAT_R10G10B10A2_UNORM:
        *typeless = DXGI_FORMAT_R10G10B10A2_TYPELESS; *view = DXGI_FORMAT_R10G10B10A2_UNORM; return TRUE;
    default:
        return FALSE;
    }
}

static BOOL image_create_device_objects(ID3D11Device *device) {
    D3D11_BUFFER_DESC constants = {16, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0};
    D3D11_SAMPLER_DESC sampler;
    D3D11_RASTERIZER_DESC raster;
    D3D11_TEXTURE3D_DESC lut = {IMAGE_LUT_SIZE, IMAGE_LUT_SIZE, IMAGE_LUT_SIZE, 1,
        DXGI_FORMAT_R8G8B8A8_UNORM, D3D11_USAGE_DEFAULT, D3D11_BIND_SHADER_RESOURCE, 0, 0};
    memset(&sampler, 0, sizeof(sampler));
    sampler.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler.MaxLOD = D3D11_FLOAT32_MAX;
    sampler.ComparisonFunc = D3D11_COMPARISON_NEVER;
    memset(&raster, 0, sizeof(raster));
    raster.FillMode = D3D11_FILL_SOLID;
    raster.CullMode = D3D11_CULL_NONE;
    raster.DepthClipEnable = TRUE;
    ID3D11Device_AddRef(device);
    image_gpu.device = device;
    return SUCCEEDED(ID3D11Device_CreateVertexShader(device, image_vs, sizeof(image_vs), NULL, &image_gpu.vs)) &&
        SUCCEEDED(ID3D11Device_CreatePixelShader(device, image_ps, sizeof(image_ps), NULL, &image_gpu.ps)) &&
        SUCCEEDED(ID3D11Device_CreateBuffer(device, &constants, NULL, &image_gpu.constants)) &&
        SUCCEEDED(ID3D11Device_CreateSamplerState(device, &sampler, &image_gpu.sampler)) &&
        SUCCEEDED(ID3D11Device_CreateRasterizerState(device, &raster, &image_gpu.raster)) &&
        SUCCEEDED(ID3D11Device_CreateTexture3D(device, &lut, NULL, &image_gpu.lut)) &&
        SUCCEEDED(ID3D11Device_CreateShaderResourceView(device, (ID3D11Resource *)image_gpu.lut, NULL, &image_gpu.lut_view));
}

static BOOL image_create_copy(const D3D11_TEXTURE2D_DESC *source, DXGI_FORMAT typeless, DXGI_FORMAT view) {
    D3D11_TEXTURE2D_DESC desc;
    D3D11_SHADER_RESOURCE_VIEW_DESC srv;
    image_release_copy();
    memset(&desc, 0, sizeof(desc));
    desc.Width = source->Width;
    desc.Height = source->Height;
    desc.MipLevels = desc.ArraySize = 1;
    desc.Format = typeless;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    memset(&srv, 0, sizeof(srv));
    srv.Format = view;
    srv.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
    srv.Texture2D.MipLevels = 1;
    if (FAILED(ID3D11Device_CreateTexture2D(image_gpu.device, &desc, NULL, &image_gpu.copy)) ||
        FAILED(ID3D11Device_CreateShaderResourceView(image_gpu.device, (ID3D11Resource *)image_gpu.copy, &srv, &image_gpu.copy_view))) {
        image_release_copy();
        return FALSE;
    }
    image_gpu.width = source->Width;
    image_gpu.height = source->Height;
    image_gpu.format = source->Format;
    return TRUE;
}

/* Everything the draw touches, captured from the game and put back afterwards. */
typedef struct {
    ID3D11InputLayout *layout;
    D3D11_PRIMITIVE_TOPOLOGY topology;
    ID3D11VertexShader *vs;
    ID3D11ClassInstance *vs_instances[256];
    UINT vs_count;
    ID3D11GeometryShader *gs;
    ID3D11ClassInstance *gs_instances[256];
    UINT gs_count;
    ID3D11HullShader *hs;
    ID3D11ClassInstance *hs_instances[256];
    UINT hs_count;
    ID3D11DomainShader *ds;
    ID3D11ClassInstance *ds_instances[256];
    UINT ds_count;
    ID3D11PixelShader *ps;
    ID3D11ClassInstance *ps_instances[256];
    UINT ps_count;
    ID3D11ShaderResourceView *ps_views[2];
    ID3D11SamplerState *ps_sampler;
    ID3D11Buffer *ps_constants;
    ID3D11RasterizerState *raster;
    D3D11_VIEWPORT viewports[D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE];
    UINT viewport_count;
    ID3D11RenderTargetView *targets[D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT];
    ID3D11DepthStencilView *depth;
    ID3D11BlendState *blend;
    FLOAT blend_factor[4];
    UINT sample_mask;
    ID3D11DepthStencilState *depth_state;
    UINT stencil_ref;
} image_state;

static void image_save(ID3D11DeviceContext *c, image_state *s) {
    memset(s, 0, sizeof(*s));
    ID3D11DeviceContext_IAGetInputLayout(c, &s->layout);
    ID3D11DeviceContext_IAGetPrimitiveTopology(c, &s->topology);
    s->vs_count = s->gs_count = s->hs_count = s->ds_count = s->ps_count = 256;
    ID3D11DeviceContext_VSGetShader(c, &s->vs, s->vs_instances, &s->vs_count);
    ID3D11DeviceContext_GSGetShader(c, &s->gs, s->gs_instances, &s->gs_count);
    ID3D11DeviceContext_HSGetShader(c, &s->hs, s->hs_instances, &s->hs_count);
    ID3D11DeviceContext_DSGetShader(c, &s->ds, s->ds_instances, &s->ds_count);
    ID3D11DeviceContext_PSGetShader(c, &s->ps, s->ps_instances, &s->ps_count);
    ID3D11DeviceContext_PSGetShaderResources(c, 0, 2, s->ps_views);
    ID3D11DeviceContext_PSGetSamplers(c, 0, 1, &s->ps_sampler);
    ID3D11DeviceContext_PSGetConstantBuffers(c, 0, 1, &s->ps_constants);
    ID3D11DeviceContext_RSGetState(c, &s->raster);
    s->viewport_count = D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE;
    ID3D11DeviceContext_RSGetViewports(c, &s->viewport_count, s->viewports);
    ID3D11DeviceContext_OMGetRenderTargets(c, D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT, s->targets, &s->depth);
    ID3D11DeviceContext_OMGetBlendState(c, &s->blend, s->blend_factor, &s->sample_mask);
    ID3D11DeviceContext_OMGetDepthStencilState(c, &s->depth_state, &s->stencil_ref);
}

#define IMAGE_RELEASE_ALL(type, list, count) do { for (UINT i_ = 0; i_ < (count); ++i_) IMAGE_RELEASE(type, (list)[i_]); } while (0)

static void image_restore(ID3D11DeviceContext *c, image_state *s) {
    ID3D11DeviceContext_IASetInputLayout(c, s->layout);
    ID3D11DeviceContext_IASetPrimitiveTopology(c, s->topology);
    ID3D11DeviceContext_VSSetShader(c, s->vs, s->vs_instances, s->vs_count);
    ID3D11DeviceContext_GSSetShader(c, s->gs, s->gs_instances, s->gs_count);
    ID3D11DeviceContext_HSSetShader(c, s->hs, s->hs_instances, s->hs_count);
    ID3D11DeviceContext_DSSetShader(c, s->ds, s->ds_instances, s->ds_count);
    ID3D11DeviceContext_PSSetShader(c, s->ps, s->ps_instances, s->ps_count);
    ID3D11DeviceContext_PSSetShaderResources(c, 0, 2, s->ps_views);
    ID3D11DeviceContext_PSSetSamplers(c, 0, 1, &s->ps_sampler);
    ID3D11DeviceContext_PSSetConstantBuffers(c, 0, 1, &s->ps_constants);
    ID3D11DeviceContext_RSSetState(c, s->raster);
    ID3D11DeviceContext_RSSetViewports(c, s->viewport_count, s->viewports);
    ID3D11DeviceContext_OMSetRenderTargets(c, D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT, s->targets, s->depth);
    ID3D11DeviceContext_OMSetBlendState(c, s->blend, s->blend_factor, s->sample_mask);
    ID3D11DeviceContext_OMSetDepthStencilState(c, s->depth_state, s->stencil_ref);
    IMAGE_RELEASE(ID3D11InputLayout, s->layout);
    IMAGE_RELEASE(ID3D11VertexShader, s->vs);
    IMAGE_RELEASE_ALL(ID3D11ClassInstance, s->vs_instances, s->vs_count);
    IMAGE_RELEASE(ID3D11GeometryShader, s->gs);
    IMAGE_RELEASE_ALL(ID3D11ClassInstance, s->gs_instances, s->gs_count);
    IMAGE_RELEASE(ID3D11HullShader, s->hs);
    IMAGE_RELEASE_ALL(ID3D11ClassInstance, s->hs_instances, s->hs_count);
    IMAGE_RELEASE(ID3D11DomainShader, s->ds);
    IMAGE_RELEASE_ALL(ID3D11ClassInstance, s->ds_instances, s->ds_count);
    IMAGE_RELEASE(ID3D11PixelShader, s->ps);
    IMAGE_RELEASE_ALL(ID3D11ClassInstance, s->ps_instances, s->ps_count);
    IMAGE_RELEASE_ALL(ID3D11ShaderResourceView, s->ps_views, 2);
    IMAGE_RELEASE(ID3D11SamplerState, s->ps_sampler);
    IMAGE_RELEASE(ID3D11Buffer, s->ps_constants);
    IMAGE_RELEASE(ID3D11RasterizerState, s->raster);
    IMAGE_RELEASE_ALL(ID3D11RenderTargetView, s->targets, D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT);
    IMAGE_RELEASE(ID3D11DepthStencilView, s->depth);
    IMAGE_RELEASE(ID3D11BlendState, s->blend);
    IMAGE_RELEASE(ID3D11DepthStencilState, s->depth_state);
}

/* Draws the pass into the chain's current back buffer. Returns FALSE when nothing was drawn. */
static BOOL image_apply(IDXGISwapChain *chain) {
    ID3D11Device *device = NULL;
    ID3D11DeviceContext *context = NULL;
    ID3D11Texture2D *back = NULL;
    ID3D11RenderTargetView *target = NULL;
    D3D11_TEXTURE2D_DESC desc;
    DXGI_FORMAT typeless, view;
    BOOL srgb, drawn = FALSE;
    LONG generation;
    float sharpness;
    if (!InterlockedCompareExchange(&image_pending_active, 0, 0)) return FALSE;
    if (FAILED(IDXGISwapChain_GetDevice(chain, &image_iid_device, (void **)&device))) return FALSE;
    if (device != image_gpu.device) {
        image_release_device();
        if (!image_create_device_objects(device)) {
            patch_log("ROTK image: device objects refused; stock image kept.\n");
            image_gpu.failed = TRUE;
        }
    }
    if (image_gpu.failed || FAILED(IDXGISwapChain_GetBuffer(chain, 0, &image_iid_texture, (void **)&back))) goto done;
    ID3D11Texture2D_GetDesc(back, &desc);
    /* Multisampled, array or non-render-target back buffers keep the stock image. */
    if (desc.SampleDesc.Count != 1 || desc.ArraySize != 1 || !(desc.BindFlags & D3D11_BIND_RENDER_TARGET) ||
        !image_formats(desc.Format, &typeless, &view, &srgb)) goto done;
    if ((desc.Width != image_gpu.width || desc.Height != image_gpu.height || desc.Format != image_gpu.format) &&
        !image_create_copy(&desc, typeless, view)) goto done;
    if (FAILED(ID3D11Device_CreateRenderTargetView(device, (ID3D11Resource *)back, NULL, &target))) goto done;
    ID3D11Device_GetImmediateContext(device, &context);
    AcquireSRWLockShared(&image_lock);
    /* Read with the LUT so a frame never draws settings that are not uploaded yet. */
    generation = image_generation;
    if (!image_pending_active) {
        ReleaseSRWLockShared(&image_lock);
        goto done;
    }
    if (generation != image_gpu.generation)
        ID3D11DeviceContext_UpdateSubresource(context, (ID3D11Resource *)image_gpu.lut, 0, NULL, image_pending,
            IMAGE_LUT_SIZE * 4, IMAGE_LUT_SIZE * IMAGE_LUT_SIZE * 4);
    sharpness = image_pending_sharpness;
    ReleaseSRWLockShared(&image_lock);
    image_gpu.generation = generation;
    {
        image_state saved;
        struct { float sharpness, srgb; int32_t max_x, max_y; } constants = {
            sharpness, srgb ? 1.0f : 0.0f, (int32_t)desc.Width - 1, (int32_t)desc.Height - 1};
        D3D11_VIEWPORT viewport = {0.0f, 0.0f, (float)desc.Width, (float)desc.Height, 0.0f, 1.0f};
        ID3D11ShaderResourceView *views[2] = {image_gpu.copy_view, image_gpu.lut_view}, *none[2] = {NULL, NULL};
        image_save(context, &saved);
        ID3D11DeviceContext_CopyResource(context, (ID3D11Resource *)image_gpu.copy, (ID3D11Resource *)back);
        ID3D11DeviceContext_UpdateSubresource(context, (ID3D11Resource *)image_gpu.constants, 0, NULL, &constants, 0, 0);
        ID3D11DeviceContext_IASetInputLayout(context, NULL);
        ID3D11DeviceContext_IASetPrimitiveTopology(context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D11DeviceContext_VSSetShader(context, image_gpu.vs, NULL, 0);
        ID3D11DeviceContext_GSSetShader(context, NULL, NULL, 0);
        ID3D11DeviceContext_HSSetShader(context, NULL, NULL, 0);
        ID3D11DeviceContext_DSSetShader(context, NULL, NULL, 0);
        ID3D11DeviceContext_PSSetShader(context, image_gpu.ps, NULL, 0);
        ID3D11DeviceContext_PSSetShaderResources(context, 0, 2, views);
        ID3D11DeviceContext_PSSetSamplers(context, 0, 1, &image_gpu.sampler);
        ID3D11DeviceContext_PSSetConstantBuffers(context, 0, 1, &image_gpu.constants);
        ID3D11DeviceContext_RSSetState(context, image_gpu.raster);
        ID3D11DeviceContext_RSSetViewports(context, 1, &viewport);
        ID3D11DeviceContext_OMSetRenderTargets(context, 1, &target, NULL);
        ID3D11DeviceContext_OMSetBlendState(context, NULL, NULL, 0xffffffffu);
        ID3D11DeviceContext_OMSetDepthStencilState(context, NULL, 0);
        ID3D11DeviceContext_Draw(context, 3, 0);
        ID3D11DeviceContext_PSSetShaderResources(context, 0, 2, none);
        image_restore(context, &saved);
        drawn = TRUE;
    }
done:
    /* No reference survives the frame, so the game can still resize its buffers. */
    IMAGE_RELEASE(ID3D11RenderTargetView, target);
    IMAGE_RELEASE(ID3D11Texture2D, back);
    IMAGE_RELEASE(ID3D11DeviceContext, context);
    IMAGE_RELEASE(ID3D11Device, device);
    return drawn;
}

/* "-0.35" style decimals, independent of the process locale (wcstof follows setlocale). */
static float image_parse_float(const WCHAR *text, float fallback) {
    float value = 0.0f, scale = 1.0f, sign = 1.0f;
    BOOL digits = FALSE, fraction = FALSE;
    while (*text == L' ' || *text == L'\t') ++text;
    if (*text == L'-' || *text == L'+') sign = *text++ == L'-' ? -1.0f : 1.0f;
    for (; *text; ++text) {
        if (*text >= L'0' && *text <= L'9') {
            digits = TRUE;
            if (fraction) value += (float)(*text - L'0') * (scale *= 0.1f);
            else if (value < 1000.0f) value = value * 10.0f + (float)(*text - L'0');
        } else if ((*text == L'.' || *text == L',') && !fraction) fraction = TRUE;
        else break;
    }
    return digits ? sign * value : fallback;
}

static float image_read_float(const WCHAR *path, const WCHAR *key, float fallback) {
    WCHAR text[32];
    if (!GetPrivateProfileStringW(L"UI", key, L"", text, ARRAYSIZE(text), path)) return fallback;
    return image_parse_float(text, fallback);
}

/* Reads the menu keys and publishes the matching LUT; called on the worker only. */
static void image_load_settings(const WCHAR *path) {
    static uint32_t built[IMAGE_LUT_TEXELS];
    image_params custom = {
        image_read_float(path, L"rotk_img_saturation", 1.0f),
        image_read_float(path, L"rotk_img_vibrance", 0.0f),
        image_read_float(path, L"rotk_img_contrast", 1.0f),
        image_read_float(path, L"rotk_img_temperature", 0.0f),
        image_read_float(path, L"rotk_img_sharpness", 0.0f),
        (int)GetPrivateProfileIntW(L"UI", L"rotk_img_daltonism", 0, path),
    };
    image_params p = image_resolve((int)GetPrivateProfileIntW(L"UI", L"rotk_img_preset", IMAGE_PRESET_OFF, path), custom);
    /* The menu's ON/OFF switch: OFF is the stock image whatever the saved choices are. */
    if (GetPrivateProfileIntW(L"UI", L"rotk_img_mode", 0, path) != 1) p = image_neutral;
    image_build_lut(&p, built);
    AcquireSRWLockExclusive(&image_lock);
    memcpy(image_pending, built, sizeof(built));
    image_pending_sharpness = p.sharpness;
    InterlockedExchange(&image_pending_active, !image_lut_neutral(p) || p.sharpness > 0.0f);
    InterlockedIncrement(&image_generation);
    ReleaseSRWLockExclusive(&image_lock);
}

static DWORD WINAPI image_settings_worker(LPVOID parameter) {
    WCHAR path[MAX_PATH];
    FILETIME seen = {0, 0};
    (void)parameter;
    if (!module_sibling_path(path, ARRAYSIZE(path), L"UserOptions.ini")) return 0U;
    while (InterlockedCompareExchange(&image_enabled, 0, 0)) {
        WIN32_FILE_ATTRIBUTE_DATA data;
        if (GetFileAttributesExW(path, GetFileExInfoStandard, &data) &&
            CompareFileTime(&data.ftLastWriteTime, &seen) != 0) {
            seen = data.ftLastWriteTime;
            image_load_settings(path);
        }
        Sleep(IMAGE_POLL_MS);
    }
    InterlockedExchange(&image_pending_active, 0);
    return 0U;
}

/* Rides on the FPS counter's Present hook; without it there is nothing to draw on. */
static void image_install(BOOL presenting) {
    HANDLE worker;
    if (!presenting) return;
    InterlockedExchange(&image_enabled, 1);
    worker = CreateThread(NULL, 0U, image_settings_worker, NULL, 0U, NULL);
    if (!worker) {
        InterlockedExchange(&image_enabled, 0);
        patch_log("ROTK image: settings worker refused.\n");
        return;
    }
    CloseHandle(worker);
    patch_log("ROTK image: player image settings installed.\n");
}
#endif
