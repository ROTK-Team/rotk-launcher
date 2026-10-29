# Player image settings

ReShade is not allowed on ROTK. This module gives every player the parts of it
that do not help them see other players: colour (saturation, vibrance, contrast,
temperature, presets), colour-blind modes and sharpening. It runs inside the
existing gameplay DLL and needs no extra file.

## What it does

The pass reuses the FPS counter's DXGI `Present` hook. Just before the stock
`Present` of the game's main swap chain, it copies the back buffer, then draws
one full-screen triangle that sharpens (the cross-neighbourhood form of AMD
FidelityFX CAS) and maps the colour through a 32³ LUT. The shaders are shader
model 4.0, so any Direct3D 11 GPU (feature level 10.0 and up) runs them. Their
bytecode is committed in `image_pass_shaders.h`; regenerate it with
`build-image-shaders.ps1` (fxc from the Windows SDK) after editing
`image_pass.hlsl`.

Neutral settings skip the pass entirely, with no copy and no draw. The pass also
leaves the image alone for multisampled, array or floating-point back buffers,
for test presentations and for repeated frames (`DXGI_PRESENT_DO_NOT_SEQUENCE`).
A Direct3D failure disables it for that device. Every state the draw touches is
saved and restored, and no back-buffer reference outlives the frame, so the game
can still resize its buffers. The colour applies to the whole frame, HUD
included, as ReShade did.

## What it refuses

- **Any change in the shadows.** Colours darker than 20 % luma come out
  exactly as the game draws them, and the settings fade in up to 45 %. Without
  this, Vivid made two close dark colours (dark clothing on dark foliage) 1.3×
  easier to tell apart, and all sliders at maximum 1.75× (3.4× for 5 % of
  pairs), even though nothing got lighter. Sharpening fades in the same way.
  Above the shadows, the output luma is still capped: brighter colours gain at
  most 0.12. To see better in the dark, players keep the game's own Brightness
  slider.
- **Distance-based effects** such as removing fog or outlining characters. The
  pass never receives the depth buffer.
- **Values past the menu limits** or custom shaders. Values are clamped in the
  DLL (saturation 0.6–1.4, vibrance 0–1, contrast 0.85–1.25, temperature −1–1,
  sharpness 0–1), and the shaders are fixed.

## Settings

The Graphics menu writes these keys under `[UI]` in `UserOptions.ini`. A worker
reads the file again within a second of each change. Decimals are read the same
way in every system language.

| Key | Values |
| --- | --- |
| `rotk_img_mode` | 1 on; anything else is the stock image, whatever the other keys say |
| `rotk_img_preset` | 0 none, 1 vivid, 2 contrast, 3 soft, 4 custom |
| `rotk_img_saturation`, `rotk_img_vibrance`, `rotk_img_contrast`, `rotk_img_temperature`, `rotk_img_sharpness` | used by preset 4 only |
| `rotk_img_daltonism` | 0 none, 1 protanopia, 2 deuteranopia, 3 tritanopia, combined with any preset |

Removing the gameplay marker stops the pass within two seconds, like the other
hooks.

## Checks

`test-dinput8-proxy.ps1` runs two tests:

- `image_lut_test` applies the shadow rules to every LUT texel (no dark colour
  lighter, every colour under 20 % luma unchanged), for every preset and
  colour-blind mode, the 16 slider corners and 200 random mixes. It also
  checks the neutral identity, clamping, NaN handling and preset resolution.
- `image_pass_test` runs the real pass on WARP. It compares pixels against a CPU
  reference for R8G8B8A8, B8G8R8A8, both sRGB variants and the flip model, and
  checks the restored game state, the resize after a pass, the refusal of
  half-float and 4× MSAA buffers, sharpening of an edge (a dark edge stays
  as drawn), the order inside the Present hook and the rebuild after a
  device change.

Breaking the colour lookup, the viewport restore or the shadow rule makes these
tests fail.

In game (28/10/2026, local server, RTX 4090, main menu): the pass installed
and every preset, colour-blind mode and slider extreme changed the image live.
Off came back to the stock image (mean difference 0.17/255). At most 0.28 % of
the dark pixels came out lighter, which is the menu character's animation. That
includes the hardest attempt allowed by the sliders. Before sharpening was
capped, maximum sharpening lit 3.3 % of them.

Not yet checked: other GPUs, overlays (Steam, Discord, RTSS), Proton, GPU cost,
and the anti-cheat.
