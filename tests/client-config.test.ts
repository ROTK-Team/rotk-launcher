import { describe, expect, it } from "vitest";
import {
  clientConfigInternals,
  synchronizeClientConfig,
  synchronizeUserOptions,
} from "../electron/services/client-config.js";
import type { RuntimeConfig } from "../electron/services/runtime-config.js";

const runtime: RuntimeConfig = {
  id: "game2",
  environment: "production",
  label: "ROTK Europe",
  gatewayOrigin: "https://gateway.rotk.app",
  voiceGrantOrigin: "https://voice.rotk.app",
  loginHost: "login.rotk.app",
  loginPorts: [20042, 20043],
  websiteOrigin: "https://rotk.app",
  launchTicketUrl: "https://accounts.rotk.app/createLaunchTicket",
  attestationChallengeUrl: "https://accounts.rotk.app/beginLauncherAttestation",
  tpmEnrolBeginUrl: "https://accounts.rotk.app/api/launcher/tpm/enroll-begin",
  tpmEnrolCompleteUrl: "https://accounts.rotk.app/api/launcher/tpm/enroll-complete",
};
const authKey = "0123456789abcdef0123456789abcdef";
const localCreateSessionUrl = "http://127.0.0.1:49152/rest/auth/session/create";

describe("UserOptions synchronization", () => {
  it("makes the social menu language follow the launcher locale", () => {
    const original = "[Display]\nWidth=1920\n\n[Rendering]\nOverallQuality=-1\n\n[UI]\nHideNames=0\nROTKSocialLanguage=en\n";
    expect(synchronizeUserOptions(original, "fr")).toBe(
      "[Display]\nWidth=1920\n\n[Rendering]\nOverallQuality=-1\n\n[UI]\nHideNames=0\nROTKSocialLanguage=fr\n",
    );
    expect(synchronizeUserOptions("[Display]\nWidth=1920\n", "zh")).toBe(
      "[Display]\nWidth=1920\n\n[UI]\nROTKSocialLanguage=en\n\n[Rendering]\nOverallQuality=-1\n",
    );
  });

  it("forces OverallQuality to Custom so hand-edited graphics keys survive InitDevice()", () => {
    // A player edited FloraQuality by hand but left the default preset: the
    // client would re-apply preset 3 over FloraQuality at the next launch.
    const original = "[Rendering]\nOverallQuality=3\nFloraQuality=1\n\n[UI]\nROTKSocialLanguage=fr\n";
    const once = synchronizeUserOptions(original, "fr");
    expect(once).toBe("[Rendering]\nOverallQuality=-1\nFloraQuality=1\n\n[UI]\nROTKSocialLanguage=fr\n");
    expect(synchronizeUserOptions(once, "fr")).toBe(once);
  });
});

describe("ClientConfig synchronization", () => {
  it("is idempotent and removes stale duplicate directives", () => {
    const original = [
      "sessionid=ffffffffffffffffffffffffffffffff",
      "Server=old.example:1",
      "Server=old.example:2",
      "SteamGatewayUrl=http://old.invalid/session",
      "",
      "[CommandQueue]",
      "motd_uri=http://old.invalid/",
      "motd_uri=http://duplicate.invalid/",
      "cb_uri=http://old.invalid/",
      "",
      "[LaunchTelemetry]",
      "Url=http://old.invalid/telemetry",
      "",
    ].join("\r\n");

    const once = synchronizeClientConfig(original, runtime, localCreateSessionUrl);
    const twice = synchronizeClientConfig(once, runtime, localCreateSessionUrl);

    expect(twice).toBe(once);
    expect(once.match(/^sessionid=/gim)).toBeNull();
    expect(once.match(/^Server=/gim)).toHaveLength(1);
    expect(once.match(/^motd_uri=/gim)).toHaveLength(1);
    expect(once).toContain("Server=login.rotk.app:20042;login.rotk.app:20043");
    expect(once).toContain(`SteamGatewayUrl=${localCreateSessionUrl}`);
    expect(once).not.toContain(authKey);
    expect(once).toContain("SoeAuthTicketUrl=https://gateway.rotk.app/rest/client/session/create");
  });

  it("inserts root directives before the first INI section", () => {
    const result = clientConfigInternals.upsertIniDirective("[CommandQueue]\nfoo=bar\n", {
      section: null,
      key: "Server",
      value: "127.0.0.1:20042",
    });

    expect(result.indexOf("Server=127.0.0.1:20042")).toBeLessThan(
      result.indexOf("[CommandQueue]"),
    );
  });

  it("preserves comments and rejects non-loopback session gateways", () => {
    const original = "; do not remove this comment\n[Custom]\nValue=kept\n";
    const result = synchronizeClientConfig(original, runtime, localCreateSessionUrl);
    expect(result).toContain("; do not remove this comment");
    expect(result).toMatch(/\[Custom]\r?\nValue=kept/);
    expect(() => synchronizeClientConfig(
      original,
      runtime,
      `http://203.0.113.10/rest/auth/session/create?sessionid=${authKey}`,
    )).toThrow(
      "Invalid local ROTK session gateway URL",
    );
  });

  it("does not persist a session ID anywhere in ClientConfig.ini", () => {
    const synchronized = synchronizeClientConfig(
      `sessionid=${authKey}\r\nSteamGatewayUrl=http://old.invalid/`,
      runtime,
      localCreateSessionUrl,
    );

    expect(synchronized).toContain(`SteamGatewayUrl=${localCreateSessionUrl}`);
    expect(synchronized).not.toContain(authKey);
    expect(synchronized).not.toMatch(/^sessionid=/gim);
  });
});
