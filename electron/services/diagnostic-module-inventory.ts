import type { NativeDiagnosticEvent } from "./diagnostic-observer.js";

/**
 * Condenses the helper's report-only image inventory into the session record,
 * so a long session keeps it after native-events.jsonl rotates. Nothing here
 * decides anything about the player: it only lists what the helper saw.
 */
const KINDS = new Set(["system", "windows", "game", "other"]);
const LOCATIONS = new Set(["windows", "game", "temp", "app-data", "user-profile", "program-files", "program-data",
  "other-local", "removable", "network", "other", "unmapped-volume"]);
const SIGNATURES = new Set(["valid", "none", "chain-unverified", "expired", "invalid", "error", "not-checked"]);
const HASH_STATUSES = new Set(["unavailable", "too-large"]);
// A file name only: the helper never sends a folder, and a path here is refused.
const IMAGE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,95}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_LISTED = 64;
const MAX_LATE_SYSTEM = 32;

export interface ModuleInventoryImage {
  name: string;
  kind: "game" | "other";
  location: string;
  signature: string;
  signer: string | null;
  sha256: string | null;
  hashStatus?: string;
  late: boolean;
  unloaded: boolean;
}

export interface ModuleInventoryReport {
  schemaVersion: 1;
  scans: number;
  lastScanAt: string | null;
  lastScanComplete: boolean | null;
  counts: { images: number; system: number; windows: number; game: number; other: number; unnamed: number } | null;
  withoutValidSignature: number | null;
  debuggerSeen: boolean;
  sameNameProcessesMax: number | null;
  images: ModuleInventoryImage[];
  lateSystemImages: string[];
  listTruncated: boolean;
  failure: string | null;
  final: { reason: string; scans: number; failedScans: number; uncheckedAtEnd: number; addedTotal: number; removedTotal: number; maxScanMs: number; eventLimitReached: boolean } | null;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function text(value: unknown, pattern: RegExp | Set<string>): string | null {
  if (typeof value !== "string") return null;
  return (pattern instanceof Set ? pattern.has(value) : pattern.test(value)) ? value : null;
}

function signerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f]/g, "").trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

export class ModuleInventoryCollector {
  private readonly report: ModuleInventoryReport = {
    schemaVersion: 1, scans: 0, lastScanAt: null, lastScanComplete: null, counts: null, withoutValidSignature: null,
    debuggerSeen: false, sameNameProcessesMax: null, images: [], lateSystemImages: [], listTruncated: false, failure: null, final: null,
  };

  /** Returns true when the session record should be rewritten with snapshot(). */
  accept(event: NativeDiagnosticEvent): boolean {
    switch (event.event) {
      case "module-image": this.image(event); return false;
      case "module-image-unloaded": this.unloaded(event); return false;
      case "module-inventory": return this.scan(event);
      case "module-inventory-summary": return this.summary(event);
      case "module-inventory-failed": {
        this.report.failure = text(event.reason, /^[a-z-]{1,40}$/) ?? "unknown";
        return true;
      }
      default: return false;
    }
  }

  snapshot(): ModuleInventoryReport {
    return structuredClone(this.report);
  }

  private image(event: NativeDiagnosticEvent): void {
    const name = text(event.name, IMAGE_NAME);
    const kind = text(event.kind, KINDS);
    const location = text(event.location, LOCATIONS);
    if (!name || !kind || !location) return;
    const late = event.late === true;
    if (kind === "system" || kind === "windows") {
      if (!late) return;
      if (this.report.lateSystemImages.length >= MAX_LATE_SYSTEM) { this.report.listTruncated = true; return; }
      if (!this.report.lateSystemImages.includes(name)) this.report.lateSystemImages.push(name);
      return;
    }
    const existing = this.find(name, kind, location);
    const entry: ModuleInventoryImage = {
      name, kind: kind as "game" | "other", location,
      signature: text(event.signature, SIGNATURES) ?? "not-checked",
      signer: signerName(event.signer),
      sha256: text(event.sha256, SHA256),
      late, unloaded: false,
    };
    const hashStatus = text(event.hashStatus, HASH_STATUSES);
    if (hashStatus) entry.hashStatus = hashStatus;
    if (existing) {
      // A reload keeps the first sighting; only its state changes.
      existing.unloaded = false;
      return;
    }
    if (this.report.images.length >= MAX_LISTED) { this.report.listTruncated = true; return; }
    this.report.images.push(entry);
  }

  private unloaded(event: NativeDiagnosticEvent): void {
    const name = text(event.name, IMAGE_NAME);
    const kind = text(event.kind, KINDS);
    if (!name || (kind !== "game" && kind !== "other")) return;
    for (const image of this.report.images) {
      if (image.kind === kind && image.name.toLowerCase() === name.toLowerCase()) image.unloaded = true;
    }
  }

  private scan(event: NativeDiagnosticEvent): boolean {
    const scan = count(event.scan);
    const images = count(event.images);
    if (scan === null || images === null) return false;
    this.report.scans = Math.max(this.report.scans, scan);
    this.report.lastScanAt = typeof event.at === "string" && !Number.isNaN(Date.parse(event.at)) ? event.at : null;
    this.report.lastScanComplete = event.complete === true;
    this.report.counts = {
      images, system: count(event.system) ?? 0, windows: count(event.windows) ?? 0, game: count(event.game) ?? 0,
      other: count(event.other) ?? 0, unnamed: count(event.unnamed) ?? 0,
    };
    this.report.withoutValidSignature = count(event.withoutValidSignature);
    if (event.debuggerPresent === true) this.report.debuggerSeen = true;
    const sameName = count(event.sameNameProcesses);
    if (sameName !== null) this.report.sameNameProcessesMax = Math.max(this.report.sameNameProcessesMax ?? 0, sameName);
    return true;
  }

  private summary(event: NativeDiagnosticEvent): boolean {
    const reason = text(event.reason, new Set(["process-exited", "stopped"]));
    if (!reason) return false;
    if (event.debuggerSeen === true) this.report.debuggerSeen = true;
    const sameName = count(event.sameNameProcessesMax);
    if (sameName !== null) this.report.sameNameProcessesMax = Math.max(this.report.sameNameProcessesMax ?? 0, sameName);
    this.report.final = {
      reason,
      scans: count(event.scans) ?? 0,
      failedScans: count(event.failedScans) ?? 0,
      uncheckedAtEnd: count(event.uncheckedAtEnd) ?? 0,
      addedTotal: count(event.addedTotal) ?? 0,
      removedTotal: count(event.removedTotal) ?? 0,
      maxScanMs: typeof event.maxScanMs === "number" && Number.isFinite(event.maxScanMs) && event.maxScanMs >= 0 ? event.maxScanMs : 0,
      eventLimitReached: event.eventLimitReached === true,
    };
    this.report.scans = Math.max(this.report.scans, this.report.final.scans);
    return true;
  }

  private find(name: string, kind: string, location: string): ModuleInventoryImage | undefined {
    const lower = name.toLowerCase();
    return this.report.images.find((image) => image.kind === kind && image.location === location && image.name.toLowerCase() === lower);
  }
}
