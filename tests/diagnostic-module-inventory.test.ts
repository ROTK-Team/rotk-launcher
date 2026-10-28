import { describe, expect, it } from 'vitest';
import { ModuleInventoryCollector } from '../electron/services/diagnostic-module-inventory.js';

const image = (fields: Record<string, unknown>) => ({ event: 'module-image', scan: 2, late: true, ...fields });
const scan = (fields: Record<string, unknown>) => ({
  event: 'module-inventory', at: '2026-10-28T09:01:10.301Z', scan: 1, complete: true, images: 30, system: 22, windows: 1,
  game: 5, other: 2, unnamed: 0, withoutValidSignature: 4, added: 0, removed: 0, debuggerPresent: false, sameNameProcesses: 0, ...fields,
});

describe('module inventory summary for diagnostic reports', () => {
  it('lists game and third-party images with their signature, and only late Windows images by name', () => {
    const collector = new ModuleInventoryCollector();
    expect(collector.accept(image({ scan: 1, late: false, name: 'ntdll.dll', kind: 'system', location: 'windows' }))).toBe(false);
    collector.accept(image({ scan: 1, late: false, name: 'H1Z1.exe', kind: 'game', location: 'game', depth: 0, main: true, signature: 'not-checked' }));
    collector.accept(image({ name: 'overlay64.dll', kind: 'other', location: 'program-files', signature: 'valid', signer: 'Overlay Vendor Inc.' }));
    collector.accept(image({ name: 'unknown.dll', kind: 'other', location: 'temp', signature: 'none', signer: null, sha256: 'a'.repeat(64), bytes: 4096 }));
    collector.accept(image({ name: 'hid.dll', kind: 'system', location: 'windows' }));
    expect(collector.accept(scan({ scan: 2, added: 3 }))).toBe(true);
    const report = collector.snapshot();
    expect(report.images.map((entry) => [entry.name, entry.kind, entry.location, entry.signature, entry.signer, entry.sha256, entry.late])).toEqual([
      ['H1Z1.exe', 'game', 'game', 'not-checked', null, null, false],
      ['overlay64.dll', 'other', 'program-files', 'valid', 'Overlay Vendor Inc.', null, true],
      ['unknown.dll', 'other', 'temp', 'none', null, 'a'.repeat(64), true],
    ]);
    expect(report.lateSystemImages).toEqual(['hid.dll']);
    expect(report.counts).toEqual({ images: 30, system: 22, windows: 1, game: 5, other: 2, unnamed: 0 });
    expect(report.withoutValidSignature).toBe(4);
    expect(report.scans).toBe(2);
    expect(report.lastScanComplete).toBe(true);
  });

  it('refuses anything that is not a bare file name or a known class', () => {
    const collector = new ModuleInventoryCollector();
    for (const name of ['C:\\Users\\player\\tool.dll', '..\\x.dll', 'folder/x.dll', '', 'a'.repeat(96), 'line\nbreak.dll']) {
      collector.accept(image({ name, kind: 'other', location: 'temp', signature: 'none' }));
    }
    collector.accept(image({ name: 'x.dll', kind: 'kernel', location: 'temp' }));
    collector.accept(image({ name: 'x.dll', kind: 'other', location: 'C:\\Temp' }));
    collector.accept(image({ name: 'y.dll', kind: 'other', location: 'temp', signature: 'trust-me', sha256: 'not-a-hash' }));
    const report = collector.snapshot();
    expect(report.images).toEqual([{ name: 'y.dll', kind: 'other', location: 'temp', signature: 'not-checked', signer: null, sha256: null, late: true, unloaded: false }]);
  });

  it('marks unloads, keeps one entry per image and bounds the lists', () => {
    const collector = new ModuleInventoryCollector();
    collector.accept(image({ name: 'mod.dll', kind: 'other', location: 'app-data', signature: 'none' }));
    collector.accept({ event: 'module-image-unloaded', scan: 3, name: 'MOD.dll', kind: 'other', base: '0x1' });
    expect(collector.snapshot().images[0]!.unloaded).toBe(true);
    collector.accept(image({ scan: 4, name: 'mod.dll', kind: 'other', location: 'app-data', signature: 'none' }));
    expect(collector.snapshot().images).toHaveLength(1);
    expect(collector.snapshot().images[0]!.unloaded).toBe(false);
    for (let index = 0; index < 80; ++index) collector.accept(image({ name: `m${index}.dll`, kind: 'other', location: 'other-local', signature: 'none' }));
    for (let index = 0; index < 40; ++index) collector.accept(image({ name: `s${index}.dll`, kind: 'system', location: 'windows' }));
    const report = collector.snapshot();
    expect(report.images).toHaveLength(64);
    expect(report.lateSystemImages).toHaveLength(32);
    expect(report.listTruncated).toBe(true);
  });

  it('remembers a debugger and a second game process seen at any scan, and the final summary', () => {
    const collector = new ModuleInventoryCollector();
    collector.accept(scan({ scan: 1 }));
    collector.accept(scan({ scan: 2, debuggerPresent: true, sameNameProcesses: 1 }));
    collector.accept(scan({ scan: 3, debuggerPresent: false, sameNameProcesses: 0 }));
    expect(collector.accept({ event: 'module-inventory-summary', reason: 'process-exited', scans: 3, failedScans: 0, trackedImages: 30,
      untrackedImages: 0, uncheckedAtEnd: 1, addedTotal: 2, removedTotal: 1, debuggerSeen: true, sameNameProcessesMax: 1, maxScanMs: 12.5, eventLimitReached: false })).toBe(true);
    const report = collector.snapshot();
    expect(report.debuggerSeen).toBe(true);
    expect(report.sameNameProcessesMax).toBe(1);
    expect(report.final).toEqual({ reason: 'process-exited', scans: 3, failedScans: 0, uncheckedAtEnd: 1, addedTotal: 2, removedTotal: 1, maxScanMs: 12.5, eventLimitReached: false });
    expect(collector.accept({ event: 'module-inventory-summary', reason: 'whatever' })).toBe(false);
  });

  it('keeps a helper failure as a short reason and ignores unrelated events', () => {
    const collector = new ModuleInventoryCollector();
    expect(collector.accept({ event: 'sample', privateBytes: 1 })).toBe(false);
    expect(collector.accept({ event: 'module-inventory-failed', reason: 'query-image-name', win32Error: 5 })).toBe(true);
    expect(collector.accept(scan({ scan: 'x' }))).toBe(false);
    expect(collector.snapshot().failure).toBe('query-image-name');
  });
});
