// ROTK image pass: contrast-adaptive sharpening, then the player's colour LUT.
// Shader model 4.0 so every Direct3D 11 GPU (feature level 10.0+) runs it.
// Never reads depth: distance-based effects are impossible by construction.
// Rebuild image_pass_shaders.h with build-image-shaders.ps1 after editing.

Texture2D<float4> frame : register(t0);
Texture3D<float4> lut : register(t1);
SamplerState lut_sampler : register(s0);

cbuffer image_constants : register(b0) {
    float sharpness;   // 0..1
    float srgb_output; // 1 when the render target view encodes sRGB itself
    int2 frame_max;    // width - 1, height - 1
};

float4 vs_main(uint id : SV_VertexID) : SV_Position {
    float2 uv = float2((id << 1) & 2, id & 2);
    return float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

float3 texel(int2 p) {
    return frame.Load(int3(clamp(p, int2(0, 0), frame_max), 0)).rgb;
}

float3 to_linear(float3 c) {
    return c <= 0.04045 ? c / 12.92 : pow(max((c + 0.055) / 1.055, 0.0), 2.4);
}

float4 ps_main(float4 position : SV_Position) : SV_Target {
    int2 p = int2(position.xy);
    float3 c = texel(p);
    if (sharpness > 0.0) {
        // Cross neighbourhood of AMD FidelityFX CAS (MIT): sharpen less where contrast is already high.
        float3 n = texel(p + int2(0, -1)), s = texel(p + int2(0, 1));
        float3 w = texel(p + int2(-1, 0)), e = texel(p + int2(1, 0));
        float3 low = min(c, min(min(n, s), min(w, e)));
        float3 high = max(c, max(max(n, s), max(w, e)));
        float3 amp = sqrt(saturate(min(low, 2.0 - high) / max(high, 1e-5)));
        float3 weight = -amp / lerp(8.0, 5.0, sharpness);
        float3 sharp = saturate((c + (n + s + w + e) * weight) / (1.0 + 4.0 * weight));
        // Same rule as the LUT (image_luma_limit): an edge may get deeper, a shadow never lighter.
        float3 luma = float3(0.2126, 0.7152, 0.0722);
        float before = dot(c, luma);
        // Shadows are left untouched (image_strength in image_lut.h), mid-tones fade in.
        sharp = lerp(c, sharp, smoothstep(0.2, 0.45, before));
        float after = dot(sharp, luma);
        float limit = before + 0.12 * smoothstep(0.3, 0.7, before);
        c = after > limit ? sharp * (limit / after) : sharp;
    }
    c = lut.SampleLevel(lut_sampler, c * (31.0 / 32.0) + 0.5 / 32.0, 0).rgb;
    return float4(srgb_output > 0.5 ? to_linear(c) : c, 1.0);
}
