import { describe, expect, it } from "vitest";
import { gameLauncherInternals } from "../electron/services/game-launcher.js";
import {
  DEFAULT_RUNTIME_CONFIG,
  RUNTIME_CONFIGS,
  runtimeConfigFor,
  runtimeConfigList,
  serverList,
} from "../electron/services/runtime-config.js";

describe("public ROTK runtime", () => {
  it("targets the GAME 2 gateway and every public login listener", () => {
    expect(DEFAULT_RUNTIME_CONFIG.environment).toBe("production");
    expect(DEFAULT_RUNTIME_CONFIG.label).toBe("ROTK LIVE");
    // The Gateway moved off :80 so Nginx can own it for the website; the port
    // must travel into every URL the client is handed.
    expect(DEFAULT_RUNTIME_CONFIG.gatewayOrigin).toBe("http://162.19.94.95:8080");
    // Le grant vocal doit viser un hôte que CET environnement sert vraiment :
    // le nom OVH du VPS de test pinné ici auparavant n'avait ni certificat
    // valide ni route, donc pas un seul joueur n'obtenait de voix.
    expect(DEFAULT_RUNTIME_CONFIG.voiceGrantOrigin).toBe("https://rotk.app");
    expect(serverList(DEFAULT_RUNTIME_CONFIG)).toBe(
      "162.19.94.95:20042;162.19.94.95:20043;162.19.94.95:20044;162.19.94.95:20045",
    );
  });

  it("defaults to GAME 2 and never to the test infrastructure", () => {
    expect(DEFAULT_RUNTIME_CONFIG.id).toBe("game2");
    expect(runtimeConfigFor(undefined)).toBe(RUNTIME_CONFIGS.game2);
    expect(runtimeConfigFor("test")).toBe(RUNTIME_CONFIGS.test);
    // An identifier the renderer invented resolves to the default, never to an
    // arbitrary endpoint set.
    expect(runtimeConfigFor("game3")).toBe(RUNTIME_CONFIGS.game2);
    expect(runtimeConfigList().map((runtime) => runtime.id)).toEqual(["game2", "test"]);
  });

  it("gives the test server its own account service, gateway and login listeners", () => {
    const test = RUNTIME_CONFIGS.test;

    expect(test.environment).toBe("development");
    expect(test.gatewayOrigin).toBe("http://148.113.198.176:8080");
    expect(test.voiceGrantOrigin).toBe("https://test.rotk.app");
    expect(test.websiteOrigin).toBe("https://test.rotk.app");
    expect(test.launchTicketUrl).toBe("https://test.rotk.app/api/launcher/ticket");
    expect(test.attestationChallengeUrl).toBe(
      "https://test.rotk.app/api/launcher/attestation/challenge",
    );
    expect(serverList(test)).toBe(
      "148.113.198.176:20042;148.113.198.176:20043;148.113.198.176:20044;148.113.198.176:20045",
    );
  });

  it("never lets one server's endpoints leak into the other", () => {
    const game2 = JSON.stringify(RUNTIME_CONFIGS.game2);
    const test = JSON.stringify(RUNTIME_CONFIGS.test);

    expect(game2).not.toContain("148.113.198.176");
    expect(game2).not.toContain("test.rotk.app");
    expect(test).not.toContain("162.19.94.95");
    expect(test).not.toContain("https://rotk.app");
  });

  it("sends the test launch to the test login listeners and account service", () => {
    const args = gameLauncherInternals.buildLaunchArguments(
      "T".repeat(43),
      RUNTIME_CONFIGS.test,
      "C:\\ROTK\\logs",
      "install-1",
      "http://127.0.0.1:49152/rest/auth/session/create",
      "en",
    );

    expect(args).toContain("Internationalization:Locale=en_us");
    expect(args).toContain(
      "server=148.113.198.176:20042;148.113.198.176:20043;148.113.198.176:20044;148.113.198.176:20045",
    );
    expect(args).toContain("CommandQueue:motd_uri=http://148.113.198.176:8080/");
    expect(args.join(" ")).not.toContain("162.19.94.95");
  });

  it("passes only the short ticket and bounded GAME 2 endpoints to H1Z1", () => {
    const durableKey = "0123456789abcdef0123456789abcdef";
    const launchTicket = "T".repeat(43);
    const args = gameLauncherInternals.buildLaunchArguments(
      launchTicket,
      DEFAULT_RUNTIME_CONFIG,
      "C:\\ROTK\\logs",
      "install-1",
      "http://127.0.0.1:49152/rest/auth/session/create",
      "fr",
    );

    expect(args).toContain("Internationalization:Locale=en_us");
    expect(args).toContain(`sessionid=${launchTicket}`);
    expect(args.join(" ")).not.toContain(durableKey);
    expect(args).toContain(
      `server=162.19.94.95:20042;162.19.94.95:20043;162.19.94.95:20044;162.19.94.95:20045`,
    );
    expect(args).toContain(
      "SteamGatewayUrl=http://127.0.0.1:49152/rest/auth/session/create",
    );
    expect(args).toContain("VivoxGrantUrl=https://rotk.app");
    expect(args).toContain("CommandQueue:motd_uri=http://162.19.94.95:8080/");
    expect(args.some((argument) => (
      argument.includes("162.19.94.95:8080/rest/auth/session/create")
    ))).toBe(false);
    expect(args.join(" ")).not.toMatch(
      /token.?key|private.?key|client.?secret|password/i,
    );
  });

  it("accepts only a credential-free HTTPS origin for voice grants", () => {
    expect(
      gameLauncherInternals.validateVoiceGrantOrigin("https://voice.rotk.app"),
    ).toBe("https://voice.rotk.app");
    expect(() =>
      gameLauncherInternals.validateVoiceGrantOrigin("http://voice.rotk.app"),
    ).toThrow(/voice grant origin/i);
    expect(() =>
      gameLauncherInternals.validateVoiceGrantOrigin(
        "https://user:password@voice.rotk.app",
      ),
    ).toThrow(/voice grant origin/i);
    expect(() =>
      gameLauncherInternals.validateVoiceGrantOrigin(
        "https://voice.rotk.app/voice/v1/login?token=secret",
      ),
    ).toThrow(/voice grant origin/i);
  });

  it("uses only the account-service Steam identity for the shim environment", () => {
    const environment = gameLauncherInternals.sanitizedEnvironment({
      steamId: "76561198000000001",
      displayName: "ROTK Player",
    });

    expect(environment.STEAMID).toBe("76561198000000001");
    expect(environment.H1Z1_OVERRIDE_STEAMID).toBe("76561198000000001");
    expect(environment.H1Z1_OVERRIDE_PERSONA).toBe("ROTK Player");
  });

  it("formats native startup failures as unsigned Windows exception codes", () => {
    expect(gameLauncherInternals.windowsExitCode(-1_073_741_571)).toBe(
      "0xC00000FD",
    );
    expect(gameLauncherInternals.windowsExitCode(-1_073_741_819)).toBe(
      "0xC0000005",
    );
    expect(gameLauncherInternals.windowsExitCode(null)).toBe("inconnu");
  });
});
