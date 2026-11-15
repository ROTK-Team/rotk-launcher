import { describe, expect, it } from "vitest";
import { phaseAfterSelection } from "../electron/services/setup-phase";

describe("picking a folder", () => {
  it("moves the setup forward while nothing is installed", () => {
    expect(phaseAfterSelection("unconfigured", "source-selected")).toBe("source-selected");
    expect(phaseAfterSelection("source-selected", "destination-selected")).toBe("destination-selected");
    expect(phaseAfterSelection("destination-selected", "source-selected")).toBe("source-selected");
  });

  it("leaves a damaged installation's error behind once the player picks something", () => {
    expect(phaseAfterSelection("error", "source-selected")).toBe("source-selected");
  });

  it("keeps an installed client ready: the pick is only a draft for the next install", () => {
    expect(phaseAfterSelection("ready", "source-selected")).toBe("ready");
    expect(phaseAfterSelection("ready", "destination-selected")).toBe("ready");
  });

  it("never interrupts an install or a game", () => {
    for (const phase of ["installing", "launching", "running"] as const) {
      expect(phaseAfterSelection(phase, "source-selected")).toBe(phase);
      expect(phaseAfterSelection(phase, "destination-selected")).toBe(phase);
    }
  });
});
