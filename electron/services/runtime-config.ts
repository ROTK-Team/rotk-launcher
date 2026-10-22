import {
  DEFAULT_SERVER_ID,
  SERVER_IDS,
  isServerId,
  type ServerId,
} from "../../shared/launch-profile.js";
import { ASSET_FEED_URL } from "./asset-sync.js";

export interface RuntimeConfig {
  id: ServerId;
  environment: "development" | "production";
  label: string;
  gatewayOrigin: string;
  /** Public HTTPS origin used only to obtain short-lived, scoped voice grants. */
  voiceGrantOrigin: string;
  loginHost: string;
  loginPorts: number[];
  websiteOrigin: string;
  launchTicketUrl: string;
  /** Phase A of integrity attestation: issues the signed single-use challenge. */
  attestationChallengeUrl: string;
  /** Level-2 TPM anchor (#320 §A): enrolment of the identity key under the endorsement key. */
  tpmEnrolBeginUrl: string;
  tpmEnrolCompleteUrl: string;
  /** feed.json the asset sync installs from: the packs follow the server. */
  assetFeedUrl: string;
}

/**
 * The bounded set of ROTK infrastructures the launcher may talk to.
 *
 * Every endpoint the client is handed derives from one of these entries and
 * from nothing the renderer supplies. Selecting a server therefore switches a
 * whole coherent contract — gateway, login listeners, account service and
 * attestation authority — never one URL at a time.
 */
export const RUNTIME_CONFIGS: Readonly<Record<ServerId, RuntimeConfig>> = Object.freeze({
  game2: Object.freeze({
    id: "game2",
    environment: "production",
    label: "ROTK LIVE",
    // The Gateway moved off :80 so Nginx can own it for the website. Nothing in
    // the client requires 80 — it only ever learns this URL from here, and the
    // port travels with it into every derived value below.
    gatewayOrigin: "http://162.19.94.95:8080",
    // Le nom OVH par défaut du VPS de TEST était pinné ici : en production le
    // certificat ne couvre pas ce nom et rien n'y sert /voice/v1, donc aucun
    // client n'a jamais obtenu de grant. rotk.app est le vhost qui relaie
    // désormais ces deux routes vers le Gateway en loopback.
    voiceGrantOrigin: "https://rotk.app",
    loginHost: "162.19.94.95",
    loginPorts: [20042, 20043, 20044, 20045],
    websiteOrigin: "https://rotk.app",
    launchTicketUrl: "https://rotk.app/api/launcher/ticket",
    attestationChallengeUrl: "https://rotk.app/api/launcher/attestation/challenge",
    tpmEnrolBeginUrl: "https://rotk.app/api/launcher/tpm/enroll-begin",
    tpmEnrolCompleteUrl: "https://rotk.app/api/launcher/tpm/enroll-complete",
    assetFeedUrl: ASSET_FEED_URL,
  }),
  test: Object.freeze({
    id: "test",
    environment: "development",
    label: "ROTK TEST",
    // Same layout as GAME 2 on the test VPS: the game Gateway sits on 8080 and
    // Nginx terminates TLS for test.rotk.app on the same address.
    gatewayOrigin: "http://148.113.198.176:8080",
    // Même contrat que GAME 2 : le grant se prend sur le vhost qui termine le
    // TLS de cet environnement, jamais sur le nom OVH resté sans listener.
    voiceGrantOrigin: "https://test.rotk.app",
    loginHost: "148.113.198.176",
    loginPorts: [20042, 20043, 20044, 20045],
    websiteOrigin: "https://test.rotk.app",
    launchTicketUrl: "https://test.rotk.app/api/launcher/ticket",
    attestationChallengeUrl: "https://test.rotk.app/api/launcher/attestation/challenge",
    tpmEnrolBeginUrl: "https://test.rotk.app/api/launcher/tpm/enroll-begin",
    tpmEnrolCompleteUrl: "https://test.rotk.app/api/launcher/tpm/enroll-complete",
    // The packs under test: the public feed stays what LIVE installs.
    assetFeedUrl: "https://raw.githubusercontent.com/ROTK-Team/assets/beta/feed.json",
  }),
} satisfies Record<ServerId, RuntimeConfig>);

/** GAME 2 stays the default: an unconfigured launcher never lands on test. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = RUNTIME_CONFIGS[DEFAULT_SERVER_ID];

/** Resolves a persisted or renderer-provided identifier to a bounded contract. */
export function runtimeConfigFor(value: unknown): RuntimeConfig {
  return isServerId(value) ? RUNTIME_CONFIGS[value] : DEFAULT_RUNTIME_CONFIG;
}

export function runtimeConfigList(): RuntimeConfig[] {
  return SERVER_IDS.map((id) => RUNTIME_CONFIGS[id]);
}

export function serverList(runtime: RuntimeConfig): string {
  return runtime.loginPorts.map((port) => `${runtime.loginHost}:${port}`).join(";");
}
