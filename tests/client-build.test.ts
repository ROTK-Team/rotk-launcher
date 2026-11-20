import { describe, expect, it } from "vitest";
import {
  depotDownloadCommand,
  identifyClientBuild,
  SUPPORTED_CLIENT_BUILDS,
  UnsupportedClientBuildError,
} from "../electron/services/client-build.js";

describe("supported H1Z1 client builds", () => {
  it("identifies the supported Steam executable by size and SHA-256", () => {
    const expected = SUPPORTED_CLIENT_BUILDS[0];
    expect(identifyClientBuild(expected.executableSize, expected.executableSha256)).toEqual(expected);
  });

  it("rejects an unknown or modified executable with the Steam command that fetches the supported one", () => {
    expect(() => identifyClientBuild(82_158_616, "0".repeat(64))).toThrow(UnsupportedClientBuildError);
    expect(() => identifyClientBuild(82_158_616, "0".repeat(64)))
      .toThrow(/ne prend pas encore en charge.*Commande : download_depot 433850 433851 1929288548044868931$/);
  });

  it("asks Steam for a one-file delta from the installed manifest", () => {
    // 9048628616520611413 = Steam's 2026-11-20 update, which only replaced H1Z1.exe.
    expect(depotDownloadCommand("9048628616520611413"))
      .toBe("download_depot 433850 433851 1929288548044868931 9048628616520611413");
    expect(depotDownloadCommand(null)).toBe("download_depot 433850 433851 1929288548044868931");
    expect(depotDownloadCommand("1929288548044868931")).toBe("download_depot 433850 433851 1929288548044868931");
    expect(depotDownloadCommand("12; quit")).toBe("download_depot 433850 433851 1929288548044868931");
  });
});
