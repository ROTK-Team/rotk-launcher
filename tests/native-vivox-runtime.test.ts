import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VIVOX_PROXY_SHA256 } from "../electron/services/vivox-client.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("native Vivox+crouch runtime contract", () => {
  it("starts crouch only after the Windows loader phase", async () => {
    const source = await readFile(
      resolve(repositoryRoot, "native/vivoxproxy/vivoxsdk_x64_proxy.c"),
      "utf8",
    );
    const initializeStart = source.indexOf("static BOOL CALLBACK initialize_original");
    const initializeEnd = source.indexOf("static BOOL bearer_is_safe", initializeStart);
    const dllMainStart = source.indexOf("BOOL WINAPI DllMain");

    expect(initializeStart).toBeGreaterThanOrEqual(0);
    expect(initializeEnd).toBeGreaterThan(initializeStart);
    expect(dllMainStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(initializeStart, initializeEnd)).toContain(
      "crouch_parity_start();",
    );
    expect(source.slice(dllMainStart)).not.toContain("crouch_parity_start();");
  });

  it("loads rotkc.dll only by absolute path from the proxy directory and traces the result", async () => {
    const source = await readFile(
      resolve(repositoryRoot, "native/vivoxproxy/vivoxsdk_x64_proxy.c"),
      "utf8",
    );
    const loaderStart = source.indexOf("static void load_rotkc_module(void)");
    const loader = source.slice(loaderStart, source.indexOf("\n}\n", loaderStart));

    expect(loaderStart).toBeGreaterThanOrEqual(0);
    // No bare-name load that would walk the DLL search order.
    expect(source).not.toMatch(/LoadLibrary(?:Ex)?[AW]?\(\s*(?:L?"rotkc\.dll"|ROTKC_DLL_NAME)/u);
    expect(loader).toMatch(/crouch_sibling_path\(\s*ROTKC_DLL_NAME,\s*g_rotkc_path,/u);
    expect(loader).toMatch(
      /LoadLibraryExW\(\s*g_rotkc_path,\s*NULL,\s*LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR \|\s*LOAD_LIBRARY_SEARCH_SYSTEM32\);/u,
    );
    // The retry keeps the absolute path; only import resolution changes.
    expect(loader).toMatch(/LoadLibraryExW\(\s*g_rotkc_path,\s*NULL,\s*LOAD_WITH_ALTERED_SEARCH_PATH\);/u);
    expect(loader).toContain('"[rotk-vivoxproxy] rotkc: loaded"');
    expect(loader).toContain('"[rotk-vivoxproxy] rotkc: loaded with legacy import search"');
    expect(loader).toContain('"[rotk-vivoxproxy] rotkc: load failed error=%lu"');
    // DllMain may trace now: the trace path buffer must not be on its stack.
    const trace = source.slice(source.indexOf("static void proxy_trace_line(const char *event)"));
    expect(trace.slice(0, trace.indexOf("\n}\n"))).not.toMatch(/WCHAR path\[/u);
  });

  it("keeps a full Solo roster isolated without evicting live transitions", async () => {
    const [patchSource, cacheSource] = await Promise.all([
      readFile(
        resolve(repositoryRoot, "native/vivoxproxy/crouch_parity_patch.h"),
        "utf8",
      ),
      readFile(
        resolve(repositoryRoot, "native/vivoxproxy/crouch_state_cache.h"),
        "utf8",
      ),
    ]);
    const pressureStart = patchSource.indexOf("if (state == NULL)");
    const pressureEnd = patchSource.indexOf(
      "if (cache_lookup.event == CROUCH_STATE_CACHE_EVICTED)",
      pressureStart,
    );
    const failOpen = patchSource.slice(pressureStart, pressureEnd);
    const sequenceRead = patchSource.indexOf(
      "InterlockedIncrement64(&g_crouch_blend_call_count)",
      patchSource.indexOf("static uint16_t crouch_blend_weight_hook"),
    );
    const controlRead = patchSource.indexOf(
      "crouch_read_float_control(",
      sequenceRead,
    );
    const lockStart = patchSource.indexOf(
      "AcquireSRWLockExclusive(&g_crouch_state_lock)",
      controlRead,
    );
    const identityValidation = patchSource.indexOf(
      "crouch_validate_state_identity(",
      lockStart,
    );
    const timestampRead = patchSource.indexOf(
      "QueryPerformanceCounter(&now)",
      identityValidation,
    );

    expect(cacheSource).toContain("#define CROUCH_STATE_CAPACITY 256U");
    expect(cacheSource).toContain("candidate->generation != generation");
    expect(cacheSource).toContain("!crouch_state_cache_is_active(candidate, now_counter)");
    expect(cacheSource).toContain("selected = empty != NULL ? empty : oldest_stale");
    expect(cacheSource).not.toContain("((uintptr_t)network >> 4U)");
    expect(sequenceRead).toBeGreaterThanOrEqual(0);
    expect(controlRead).toBeGreaterThan(sequenceRead);
    expect(lockStart).toBeGreaterThan(controlRead);
    expect(identityValidation).toBeGreaterThan(lockStart);
    expect(timestampRead).toBeGreaterThan(identityValidation);
    expect(pressureStart).toBeGreaterThanOrEqual(0);
    expect(pressureEnd).toBeGreaterThan(pressureStart);
    for (const stockWeight of [
      "trajectory_weight",
      "events_weight",
      "sampled_events_weight",
      "sync_events_weight",
    ]) {
      expect(failOpen).toContain(stockWeight);
    }
    expect(failOpen).toMatch(
      /return original\(\s*attrib_blend_weights,\s*node_child_weights,\s*active_node_connections,\s*network,\s*node_def,\s*trajectory_weight,\s*events_weight,\s*sampled_events_weight,\s*sync_events_weight,\s*is_additive\s*\);/u,
    );
  });

  it("keeps the bundled binary, deployment policy and attestation sidecar aligned", async () => {
    const binaryPath = resolve(
      repositoryRoot,
      "resources/patches/vivoxsdk_x64.dll",
    );
    const [binary, sidecar] = await Promise.all([
      readFile(binaryPath),
      readFile(`${binaryPath}.sha256`, "utf8"),
    ]);
    const bundledHash = createHash("sha256").update(binary).digest("hex");

    expect(bundledHash).toBe(VIVOX_PROXY_SHA256);
    expect(sidecar.trim().split(/\s+/u)[0]).toBe(VIVOX_PROXY_SHA256);
  });
});
