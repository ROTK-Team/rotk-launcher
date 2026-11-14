import { describe, expect, it } from "vitest";
import { WINDOW_RELOAD_ATTEMPTS, windowRecovery } from "../electron/services/window-recovery";

describe("a launcher window that lost its page", () => {
  it("is left alone when the page process ended normally", () => {
    expect(windowRecovery("clean-exit", 0)).toBe("ignore");
    expect(windowRecovery("clean-exit", 5)).toBe("ignore");
  });

  it("gets its page loaded again after a crash or a failed load", () => {
    for (const reason of ["crashed", "oom", "killed", "abnormal-exit", "integrity-failure", "load-failed"]) {
      expect(windowRecovery(reason, 0)).toBe("reload");
      expect(windowRecovery(reason, WINDOW_RELOAD_ATTEMPTS - 1)).toBe("reload");
    }
  });

  it("is given up on when reloading keeps failing", () => {
    expect(windowRecovery("crashed", WINDOW_RELOAD_ATTEMPTS)).toBe("give-up");
    expect(windowRecovery("load-failed", WINDOW_RELOAD_ATTEMPTS + 3)).toBe("give-up");
  });

  it("is given up on at once when Windows refuses to create the page process", () => {
    expect(windowRecovery("launch-failed", 0)).toBe("give-up");
  });
});
