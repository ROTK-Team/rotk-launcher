import type { RuntimeConfig } from "./runtime-config.js";
import type { AppLocale } from "../../shared/locale.js";
import { serverList } from "./runtime-config.js";

interface IniDirective {
  section: string | null;
  key: string;
  value: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertIniDirective(config: string, directive: IniDirective): string {
  const newline = config.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(config);
  const lines = config.split(/\r?\n/);
  if (hadTrailingNewline && lines.at(-1) === "") lines.pop();

  const sectionHeader = /^\s*\[([^\]]+)]\s*$/;
  const directiveLine = new RegExp(`^\\s*${escapeRegExp(directive.key)}\\s*=`, "i");
  const targetSection = directive.section?.toLocaleLowerCase("en-US") ?? null;
  let currentSection: string | null = null;
  let firstMatch = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const header = sectionHeader.exec(lines[index]);
    if (header) {
      currentSection = header[1].trim().toLocaleLowerCase("en-US");
      continue;
    }
    if (currentSection === targetSection && directiveLine.test(lines[index])) {
      if (firstMatch < 0) {
        lines[index] = `${directive.key}=${directive.value}`;
        firstMatch = index;
      } else {
        lines[index] = "";
      }
    }
  }

  if (firstMatch < 0) {
    const rendered = `${directive.key}=${directive.value}`;
    if (targetSection === null) {
      const firstSection = lines.findIndex((line) => sectionHeader.test(line));
      lines.splice(firstSection >= 0 ? firstSection : lines.length, 0, rendered);
    } else {
      const headerIndex = lines.findIndex((line) => {
        const header = sectionHeader.exec(line);
        return header?.[1].trim().toLocaleLowerCase("en-US") === targetSection;
      });
      if (headerIndex >= 0) {
        let insertAt = headerIndex + 1;
        while (insertAt < lines.length && !sectionHeader.test(lines[insertAt])) insertAt += 1;
        lines.splice(insertAt, 0, rendered);
      } else {
        if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
        lines.push(`[${directive.section}]`, rendered);
      }
    }
  }

  const rendered = lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join(newline);
  return hadTrailingNewline ? `${rendered}${newline}` : rendered;
}

export function synchronizeClientConfig(
  config: string,
  runtime: RuntimeConfig,
  localCreateSessionUrl: string,
): string {
  // Remove any stale root-level session ID copied from Steam or an older ROTK
  // launcher. The key itself stays in Electron memory; SteamGatewayUrl points
  // at a short-lived loopback broker and therefore persists no credential.
  let synchronized = config.replace(/^\s*sessionid\s*=.*(?:\r?\n|$)/gim, "");
  const gatewayCreateSession = validateLocalCreateSessionUrl(localCreateSessionUrl);
  const directives: IniDirective[] = [
    { section: null, key: "Server", value: serverList(runtime) },
    { section: null, key: "SteamGatewayUrl", value: gatewayCreateSession },
    {
      section: "INGAMEPURCHASE",
      key: "SoeAuthTicketUrl",
      value: `${runtime.gatewayOrigin}/rest/client/session/create`,
    },
    { section: "CommandQueue", key: "motd_uri", value: `${runtime.gatewayOrigin}/` },
    { section: "CommandQueue", key: "cb_uri", value: `${runtime.gatewayOrigin}/` },
    { section: "CommandQueue", key: "eula_uri", value: `${runtime.gatewayOrigin}/` },
    {
      section: "LaunchTelemetry",
      key: "Url",
      value: `${runtime.gatewayOrigin}/h1z1xx/live/`,
    },
  ];
  for (const directive of directives) synchronized = upsertIniDirective(synchronized, directive);
  return synchronized;
}

/** Match the Chinese launcher option to the published Chinese game locale. */
export const GAME_LOCALE: Readonly<Record<AppLocale, string>> = { en: "en_us", fr: "en_us", zh: "zh_cn" };

/** Keep the custom social menu in English until its translations are validated. */
export function synchronizeUserOptions(config: string): string {
  return upsertIniDirective(config, {
    section: "UI",
    key: "ROTKSocialLanguage",
    value: "en",
  });
}

export function validateLocalCreateSessionUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid local ROTK session gateway URL");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.pathname !== "/rest/auth/session/create" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("Invalid local ROTK session gateway URL");
  }
  return parsed.href;
}

export const clientConfigInternals = { upsertIniDirective, validateLocalCreateSessionUrl };
