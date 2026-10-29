#include "../image_lut.h"
#undef NDEBUG
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static uint32_t lut[IMAGE_LUT_TEXELS];

static float channel(uint32_t texel, int shift) {
    return (float)((texel >> shift) & 0xff) / 255.0f;
}

/* The fairness rule, checked on every LUT texel: shadows never come out lighter. */
static void assert_no_shadow_lift(const image_params *p) {
    image_build_lut(p, lut);
    for (int b = 0; b < IMAGE_LUT_SIZE; ++b)
        for (int g = 0; g < IMAGE_LUT_SIZE; ++g)
            for (int r = 0; r < IMAGE_LUT_SIZE; ++r) {
                uint32_t t = lut[(b * IMAGE_LUT_SIZE + g) * IMAGE_LUT_SIZE + r];
                float in[3] = {r / 31.0f, g / 31.0f, b / 31.0f};
                float out[3] = {channel(t, 0), channel(t, 8), channel(t, 16)};
                float limit = image_luma_limit(image_luma(in));
                assert((t >> 24) == 0xff);
                if (image_luma(out) > limit + 1.5f / 255.0f) {
                    fprintf(stderr, "lift at %d,%d,%d: %f > %f\n", r, g, b, image_luma(out), limit);
                    abort();
                }
                if (image_luma(in) < 0.3f) assert(image_luma(out) <= image_luma(in) + 1.5f / 255.0f);
                /* Shadows are left exactly as drawn: no lighter, and no easier to tell apart. */
                if (image_luma(in) < 0.2f)
                    for (int k = 0; k < 3; ++k) assert(fabsf(out[k] - in[k]) <= 0.6f / 255.0f);
            }
}

static float random_unit(void) {
    return (float)rand() / (float)RAND_MAX;
}

int main(void) {
    image_params p;
    /* Neutral settings are an exact identity, so the pass can be skipped. */
    image_build_lut(&image_neutral, lut);
    for (int i = 0; i < IMAGE_LUT_TEXELS; ++i) {
        int r = i % 32, g = i / 32 % 32, b = i / 1024;
        assert((lut[i] & 0xff) == (uint32_t)lrintf(r * 255.0f / 31.0f));
        assert((lut[i] >> 8 & 0xff) == (uint32_t)lrintf(g * 255.0f / 31.0f));
        assert((lut[i] >> 16 & 0xff) == (uint32_t)lrintf(b * 255.0f / 31.0f));
    }
    assert(image_lut_neutral(image_resolve(IMAGE_PRESET_OFF, image_neutral)));
    assert(image_resolve(IMAGE_PRESET_OFF, image_neutral).sharpness == 0.0f);

    /* Hand-edited values are clamped to the menu limits. */
    p = image_sanitize((image_params){5.0f, -3.0f, 9.0f, 4.0f, 7.0f, 9});
    assert(p.saturation == 1.4f && p.vibrance == 0.0f && p.contrast == 1.25f);
    assert(p.temperature == 1.0f && p.sharpness == 1.0f && p.daltonism == 0);
    p = image_sanitize((image_params){NAN, NAN, NAN, NAN, NAN, -1});
    assert(p.saturation == 0.6f && p.contrast == 0.85f && p.sharpness == 0.0f && p.daltonism == 0);

    /* Presets ignore the sliders, keep daltonism, and unknown presets are neutral. */
    p = image_resolve(IMAGE_PRESET_VIVID, (image_params){0.6f, 0.0f, 0.85f, -1.0f, 0.0f, 2});
    assert(p.saturation == 1.15f && p.sharpness == 0.4f && p.daltonism == 2);
    p = image_resolve(99, (image_params){1.4f, 1.0f, 1.25f, 1.0f, 1.0f, 1});
    assert(image_lut_neutral((image_params){p.saturation, p.vibrance, p.contrast, p.temperature, 0, 0}) && p.daltonism == 1);
    p = image_resolve(IMAGE_PRESET_CUSTOM, (image_params){1.3f, 0.5f, 1.1f, 0.2f, 0.7f, 0});
    assert(p.saturation == 1.3f && p.sharpness == 0.7f);

    /* Every preset, every daltonism mode, the slider extremes and random mixes. */
    for (int preset = 0; preset < IMAGE_PRESET_CUSTOM; ++preset)
        for (int mode = 0; mode <= 3; ++mode) {
            p = image_resolve(preset, (image_params){1, 0, 1, 0, 0, mode});
            assert_no_shadow_lift(&p);
        }
    for (int corner = 0; corner < 16; ++corner) {
        p = (image_params){corner & 1 ? 1.4f : 0.6f, corner & 2 ? 1.0f : 0.0f,
            corner & 4 ? 1.25f : 0.85f, corner & 8 ? 1.0f : -1.0f, 1.0f, corner % 4};
        assert_no_shadow_lift(&p);
    }
    srand(1315);
    for (int i = 0; i < 200; ++i) {
        p = (image_params){0.6f + 0.8f * random_unit(), random_unit(), 0.85f + 0.4f * random_unit(),
            2.0f * random_unit() - 1.0f, random_unit(), rand() % 4};
        assert_no_shadow_lift(&p);
    }

    /* The presets do change the picture, and daltonism moves red/green apart. */
    {
        float in[3] = {0.6f, 0.4f, 0.3f}, out[3];
        image_params vivid = image_resolve(IMAGE_PRESET_VIVID, image_neutral);
        image_params protan = image_resolve(IMAGE_PRESET_OFF, (image_params){1, 0, 1, 0, 0, 1});
        image_grade(&vivid, in, out);
        assert(out[0] - out[2] > in[0] - in[2] + 0.02f);
        image_grade(&protan, in, out);
        assert(fabsf(out[0] - in[0]) + fabsf(out[1] - in[1]) + fabsf(out[2] - in[2]) > 0.02f);
    }
    puts("image LUT tests passed");
    return 0;
}
