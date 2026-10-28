#ifndef ROTK_IMAGE_LUT_H
#define ROTK_IMAGE_LUT_H
#include <math.h>
#include <stdint.h>

/*
 * Player colour settings baked into one 32^3 LUT. Every value is clamped here,
 * so editing UserOptions.ini by hand cannot go past the menu limits, and the
 * final step forbids brightening shadows: a dark input never leaves lighter.
 */
#define IMAGE_LUT_SIZE 32
#define IMAGE_LUT_TEXELS (IMAGE_LUT_SIZE * IMAGE_LUT_SIZE * IMAGE_LUT_SIZE)

typedef struct {
    float saturation;  /* 0.6 .. 1.4, 1 = stock */
    float vibrance;    /* 0 .. 1 */
    float contrast;    /* 0.85 .. 1.25 */
    float temperature; /* -1 (cold) .. 1 (warm) */
    float sharpness;   /* 0 .. 1, applied by the shader */
    int daltonism;     /* 0 none, 1 protanopia, 2 deuteranopia, 3 tritanopia */
} image_params;

enum { IMAGE_PRESET_OFF, IMAGE_PRESET_VIVID, IMAGE_PRESET_CONTRAST, IMAGE_PRESET_SOFT, IMAGE_PRESET_CUSTOM };

static const image_params image_neutral = {1.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0};
static const image_params image_presets[IMAGE_PRESET_CUSTOM] = {
    {1.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0},
    {1.15f, 0.35f, 1.08f, 0.0f, 0.4f, 0},
    {1.05f, 0.15f, 1.18f, 0.0f, 0.5f, 0},
    {0.9f, 0.0f, 1.0f, 0.3f, 0.2f, 0},
};

static float image_clamp(float value, float low, float high) {
    /* NaN fails both tests and falls back to the low bound. */
    return value >= low ? (value <= high ? value : high) : low;
}

static image_params image_sanitize(image_params p) {
    p.saturation = image_clamp(p.saturation, 0.6f, 1.4f);
    p.vibrance = image_clamp(p.vibrance, 0.0f, 1.0f);
    p.contrast = image_clamp(p.contrast, 0.85f, 1.25f);
    p.temperature = image_clamp(p.temperature, -1.0f, 1.0f);
    p.sharpness = image_clamp(p.sharpness, 0.0f, 1.0f);
    if (p.daltonism < 0 || p.daltonism > 3) p.daltonism = 0;
    return p;
}

/* Preset values replace the sliders, except daltonism which stacks on any preset. */
static image_params image_resolve(int preset, image_params custom) {
    image_params p = preset >= IMAGE_PRESET_OFF && preset < IMAGE_PRESET_CUSTOM ? image_presets[preset] : custom;
    if (preset < IMAGE_PRESET_OFF || preset > IMAGE_PRESET_CUSTOM) p = image_neutral;
    p.daltonism = custom.daltonism;
    return image_sanitize(p);
}

static int image_lut_neutral(image_params p) {
    return p.saturation == 1.0f && p.vibrance == 0.0f && p.contrast == 1.0f &&
        p.temperature == 0.0f && p.daltonism == 0;
}

static float image_luma(const float c[3]) {
    return 0.2126f * c[0] + 0.7152f * c[1] + 0.0722f * c[2];
}

/* How much of the settings a colour receives: none in the shadows (luma below 0.2), all from 0.45.
 * Shadows stay exactly as the game draws them, so no setting helps to tell dark things apart. */
static float image_strength(float luma) {
    float t = image_clamp((luma - 0.2f) / 0.25f, 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

/* Highest luma an input may reach: none above it in the shadows, a little in the highlights. */
static float image_luma_limit(float luma) {
    float t = image_clamp((luma - 0.3f) / 0.4f, 0.0f, 1.0f);
    return luma + 0.12f * t * t * (3.0f - 2.0f * t);
}

static float image_to_linear(float v) {
    return v <= 0.04045f ? v / 12.92f : powf((v + 0.055f) / 1.055f, 2.4f);
}

static float image_to_srgb(float v) {
    v = image_clamp(v, 0.0f, 1.0f);
    return v <= 0.0031308f ? v * 12.92f : 1.055f * powf(v, 1.0f / 2.4f) - 0.055f;
}

/* Daltonization: simulate the deficiency (Machado 2009, full severity) and shift the lost contrast. */
static void image_daltonize(float c[3], int mode) {
    static const float sim[3][9] = {
        {0.152286f, 1.052583f, -0.204868f, 0.114503f, 0.786281f, 0.099216f, -0.003882f, -0.048116f, 1.051998f},
        {0.367322f, 0.860646f, -0.227968f, 0.280085f, 0.672501f, 0.047413f, -0.011820f, 0.042940f, 0.968881f},
        {1.255528f, -0.076749f, -0.178779f, -0.078411f, 0.930809f, 0.147602f, 0.004733f, 0.691367f, 0.303900f},
    };
    const float *m = sim[mode - 1];
    float l[3], s[3], e[3];
    for (int i = 0; i < 3; ++i) l[i] = image_to_linear(c[i]);
    for (int i = 0; i < 3; ++i) s[i] = m[i * 3] * l[0] + m[i * 3 + 1] * l[1] + m[i * 3 + 2] * l[2];
    for (int i = 0; i < 3; ++i) e[i] = l[i] - s[i];
    l[1] += 0.7f * e[0] + e[1];
    l[2] += 0.7f * e[0] + e[2];
    for (int i = 0; i < 3; ++i) c[i] = image_to_srgb(l[i]);
}

/* One display-encoded colour through the player's settings. */
static void image_grade(const image_params *p, const float in[3], float out[3]) {
    float c[3] = {in[0], in[1], in[2]}, luma, low, high, limit, result;
    c[0] *= 1.0f + 0.06f * p->temperature;
    c[2] *= 1.0f - 0.06f * p->temperature;
    for (int i = 0; i < 3; ++i) c[i] = (c[i] - 0.5f) * p->contrast + 0.5f;
    luma = image_luma(c);
    low = fminf(c[0], fminf(c[1], c[2]));
    high = fmaxf(c[0], fmaxf(c[1], c[2]));
    {
        float gain = p->saturation * (1.0f + p->vibrance * (1.0f - image_clamp(high - low, 0.0f, 1.0f)));
        for (int i = 0; i < 3; ++i) c[i] = image_clamp(luma + (c[i] - luma) * gain, 0.0f, 1.0f);
    }
    if (p->daltonism) image_daltonize(c, p->daltonism);
    {
        float strength = image_strength(image_luma(in));
        for (int i = 0; i < 3; ++i) c[i] = in[i] + (c[i] - in[i]) * strength;
    }
    limit = image_luma_limit(image_luma(in));
    result = image_luma(c);
    if (result > limit) for (int i = 0; i < 3; ++i) c[i] *= limit / result;
    for (int i = 0; i < 3; ++i) out[i] = image_clamp(c[i], 0.0f, 1.0f);
}

/* RGBA8 texels, red along x, green along y, blue along z, as the shader samples them. */
static void image_build_lut(const image_params *params, uint32_t *texels) {
    image_params p = image_sanitize(*params);
    for (int b = 0; b < IMAGE_LUT_SIZE; ++b)
        for (int g = 0; g < IMAGE_LUT_SIZE; ++g)
            for (int r = 0; r < IMAGE_LUT_SIZE; ++r) {
                const float scale = 1.0f / (IMAGE_LUT_SIZE - 1);
                float in[3] = {r * scale, g * scale, b * scale}, out[3];
                image_grade(&p, in, out);
                texels[(b * IMAGE_LUT_SIZE + g) * IMAGE_LUT_SIZE + r] =
                    (uint32_t)lrintf(out[0] * 255.0f) | (uint32_t)lrintf(out[1] * 255.0f) << 8 |
                    (uint32_t)lrintf(out[2] * 255.0f) << 16 | 0xff000000u;
            }
}
#endif
