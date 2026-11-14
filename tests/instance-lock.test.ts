import { describe, expect, it } from "vitest";
import { LOCK_HANDOFF_WAIT_MS, acquireLockAfterHandoff, isElevationRelaunch } from "../electron/services/instance-lock";
import { ELEVATION_RELAUNCH_ARGUMENT } from "../electron/services/startup-elevation";

/** A lock that becomes free after `freeAtMs`, on a clock that only moves when the caller pauses. */
function handoff(freeAtMs: number, relaunched: boolean) {
  let clock = 0, requests = 0;
  return {
    relaunched,
    request: () => { requests += 1; return clock >= freeAtMs; },
    pause: (milliseconds: number) => { clock += milliseconds; },
    now: () => clock,
    stats: () => ({ requests, waited: clock }),
  };
}

describe("taking the single-instance lock", () => {
  it("takes a free lock at once", () => {
    const first = handoff(0, false);
    expect(acquireLockAfterHandoff(first)).toBe(true);
    expect(first.stats()).toEqual({ requests: 1, waited: 0 });
  });

  it("gives up at once when another launcher owns it and this is an ordinary start", () => {
    const second = handoff(Infinity, false);
    expect(acquireLockAfterHandoff(second)).toBe(false);
    expect(second.stats()).toEqual({ requests: 1, waited: 0 });
  });

  it("waits for the process that relaunched it to let go", () => {
    const relaunch = handoff(600, true);
    expect(acquireLockAfterHandoff(relaunch)).toBe(true);
    expect(relaunch.stats().waited).toBeGreaterThanOrEqual(600);
    expect(relaunch.stats().waited).toBeLessThan(1_500);
  });

  it("recognises the relaunch by the argument the elevation helper passes", () => {
    expect(isElevationRelaunch(["ROTK Launcher.exe", ELEVATION_RELAUNCH_ARGUMENT])).toBe(true);
    expect(isElevationRelaunch(["ROTK Launcher.exe"])).toBe(false);
  });

  it("stops waiting when a launcher that is really running keeps the lock", () => {
    const relaunch = handoff(Infinity, true);
    expect(acquireLockAfterHandoff(relaunch)).toBe(false);
    expect(relaunch.stats().waited).toBe(LOCK_HANDOFF_WAIT_MS);
  });
});
