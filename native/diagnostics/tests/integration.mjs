// Real Windows debugging API tests. Only the dedicated fixture is exercised.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runRoot = path.join(root, 'native', 'diagnostics', 'dist', `integration-${Date.now()}`);
const helperPath = path.join(runRoot, 'ROTK.Diagnostics.Test.exe');
const fixturePath = path.join(runRoot, 'ROTK.Diagnostics.Fixture.exe');
const boundedHelperPath = path.join(runRoot, 'ROTK.Diagnostics.Bounded.Test.exe');
const productionHelper = path.join(root, 'resources', 'diagnostics', 'ROTK.Diagnostics.exe');
await mkdir(runRoot, { recursive: true });

function build(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
}
build('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-diagnostics.ps1', '-TestBuild', '-OutputPath', helperPath]);
build('zig', ['cc', '-target', 'x86_64-windows-gnu', '-O0', '-g', '-Wall', '-Wextra', '-Werror', '-Wl,--stack,1048576', '-o', fixturePath, 'native/diagnostics/tests/fixture.c']);
build('zig', ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-s', '-Wall', '-Wextra', '-Werror', '-municode', '-DROTK_DIAGNOSTICS_TEST=1', '-DPERF_LOG_LIMIT=4096ULL', '-DPERF_MAX_DURATION=2500ULL', '-o', boundedHelperPath, 'native/diagnostics/diagnostics.c', '-ldbghelp', '-lpsapi', '-lversion']);

function processWithLines(executable, args = []) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [], pending = new Set();
  let buffer = '', stderr = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      let item = line;
      if (line.startsWith('{')) item = JSON.parse(line);
      lines.push(item);
      for (const waiter of [...pending]) if (waiter.predicate(item)) {
        pending.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(item);
      }
    }
  });
  const exit = new Promise(resolve => child.on('close', (code, signal) => {
    closed = true; resolve({ code, signal });
    for (const waiter of [...pending]) {
      pending.delete(waiter); clearTimeout(waiter.timer);
      waiter.reject(new Error(`Process exited (${code}, ${signal}) while waiting. ${stderr}\n${JSON.stringify(lines.slice(-8))}`));
    }
  }));
  child.stdin.on('error', () => {});
  return {
    child, lines, exit,
    wait(predicate, timeout = 75000) {
      const existing = lines.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      if (closed) return Promise.reject(new Error(`Already exited: ${stderr}\n${JSON.stringify(lines)}`));
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          pending.delete(waiter);
          reject(new Error(`Timed out waiting. ${stderr}\n${JSON.stringify(lines.slice(-8))}`));
        }, timeout);
        pending.add(waiter);
      });
    },
    command(command) { child.stdin.write(`${command}\n`); },
    cleanup() { if (!closed) child.kill(); },
  };
}

async function fixture(t) {
  const target = processWithLines(fixturePath);
  t.after(() => target.cleanup());
  await target.wait(line => line === 'ready');
  return target;
}

async function watch(t, target, name, extraArguments = []) {
  const directory = path.join(runRoot, name);
  const helper = processWithLines(helperPath, ['--watch', '--pid', String(target.child.pid), '--output', directory, ...extraArguments]);
  t.after(() => helper.cleanup());
  await helper.wait(event => event.event === 'attached');
  await helper.wait(event => event.event === 'attach-breakpoint');
  return { helper, directory };
}

async function inspectDump(directory, filename, expectedException) {
  const dump = await readFile(path.join(directory, filename));
  assert.equal(dump.toString('ascii', 0, 4), 'MDMP');
  const streamCount = dump.readUInt32LE(8), streamDirectory = dump.readUInt32LE(12);
  const streams = new Map();
  for (let i = 0; i < streamCount; ++i) {
    const offset = streamDirectory + 12 * i;
    streams.set(dump.readUInt32LE(offset), { size: dump.readUInt32LE(offset + 4), rva: dump.readUInt32LE(offset + 8) });
  }
  assert.ok(streams.has(3), 'ThreadListStream');
  assert.ok(streams.has(4), 'ModuleListStream');
  assert.ok(streams.has(7), 'SystemInfoStream');
  assert.ok(streams.has(17), 'ThreadInfoListStream');
  if (expectedException !== undefined) {
    const exception = streams.get(6);
    assert.ok(exception, 'ExceptionStream');
    assert.equal(dump.readUInt32LE(exception.rva + 8), expectedException);
    assert.ok(dump.readBigUInt64LE(exception.rva + 24) > 0n, 'exception address captured');
    assert.ok(dump.readUInt32LE(exception.rva + 160) > 0, 'exception thread context captured');
  } else assert.equal(streams.has(6), false, 'manual snapshots do not invent a fatal exception');
  return { dump, streams };
}

test('second-chance access violation records exception, registers, modules, telemetry and real dump', async t => {
  const target = await fixture(t);
  const { helper, directory } = await watch(t, target, 'access-violation');
  target.command('av');
  const written = await helper.wait(event => event.event === 'dump-written');
  assert.equal(written.kind, 'fatal');
  assert.equal(written.exceptionStream, true);
  assert.equal(written.full, false);
  await helper.wait(event => event.event === 'exited');
  assert.equal((await helper.exit).code, 0);
  const exception = helper.lines.find(event => event.event === 'exception' && !event.firstChance);
  assert.equal(exception.code, '0xC0000005');
  assert.match(exception.registers.rip, /^0x[\dA-F]{16}$/);
  assert.equal(exception.contextAvailable, true);
  assert.ok(helper.lines.some(event => event.event === 'module' && event.name.includes('ntdll.dll')));
  assert.ok(helper.lines.some(event => event.event === 'sample' && event.privateBytes > 0));
  assert.equal(helper.lines.find(event => event.event === 'exited').exitCodeHex, '0xC0000005');
  await inspectDump(directory, written.path, 0xC0000005);
  const journal = (await readFile(path.join(directory, 'native-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(journal.some(event => event.event === 'dump-written'));
});

test('stack overflow is captured out of process with the actual exception stream', async t => {
  const target = await fixture(t);
  const { helper, directory } = await watch(t, target, 'stack-overflow');
  target.command('stack');
  const written = await helper.wait(event => event.event === 'dump-written');
  await inspectDump(directory, written.path, 0xC00000FD);
  assert.equal((await helper.wait(event => event.event === 'exited')).exitCodeHex, '0xC00000FD');
});

test('first-chance exceptions reach the game handler and have bounded event detail', async t => {
  const target = await fixture(t);
  const { helper, directory } = await watch(t, target, 'handled');
  target.command('handled');
  await target.wait(line => line === 'handled:100');
  target.command('exit');
  await helper.wait(event => event.event === 'exited');
  await helper.exit;
  assert.equal(helper.lines.filter(event => event.event === 'exception' && event.code === '0xE0424242').length, 3);
  assert.equal(helper.lines.find(event => event.event === 'exception-count' && event.code === '0xE0424242').count, 100);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.dmp')), false);
});

test('manual minidump and full dump preserve a running game and distinguish snapshots', async t => {
  const target = await fixture(t);
  const { helper, directory } = await watch(t, target, 'manual');
  helper.command('snapshot');
  const snapshot = await helper.wait(event => event.event === 'dump-written' && !event.full);
  await inspectDump(directory, snapshot.path);
  helper.command('full');
  const full = await helper.wait(event => event.event === 'dump-written' && event.full);
  const inspected = await inspectDump(directory, full.path);
  assert.ok(inspected.streams.has(9), 'Memory64ListStream for full dump');
  assert.notEqual(snapshot.path, full.path);
  target.command('ping');
  await target.wait(line => line === 'alive:debugger=1');
  helper.command('stop');
  assert.equal((await helper.wait(event => event.event === 'detached')).success, true);
  await helper.exit;
  target.command('ping');
  await target.wait(line => line === 'alive:debugger=0');
});

test('snapshot fallback never attaches a debugger', async t => {
  const target = await fixture(t);
  const directory = path.join(runRoot, 'standalone');
  const helper = processWithLines(helperPath, ['--snapshot', '--pid', String(target.child.pid), '--output', directory]);
  t.after(() => helper.cleanup());
  const written = await helper.wait(event => event.event === 'dump-written');
  assert.equal((await helper.exit).code, 0);
  await inspectDump(directory, written.path);
  assert.equal(helper.lines.some(event => event.event === 'attached'), false);
  target.command('ping');
  await target.wait(line => line === 'alive:debugger=0');
});

test('forcibly terminating helper leaves target alive and detached', async t => {
  const target = await fixture(t);
  const { helper } = await watch(t, target, 'helper-killed');
  helper.child.kill();
  await helper.exit;
  target.command('ping');
  await target.wait(line => line === 'alive:debugger=0');
});

test('launcher stdin EOF detaches cleanly without terminating the target', async t => {
  const target = await fixture(t);
  const { helper } = await watch(t, target, 'stdin-eof');
  helper.child.stdin.end();
  assert.equal((await helper.wait(event => event.event === 'detached')).success, true);
  await helper.exit;
  target.command('ping');
  await target.wait(line => line === 'alive:debugger=0');
});

test('production helper refuses the test fixture and arbitrary process names', async t => {
  const target = await fixture(t);
  for (const pid of [target.child.pid, process.pid]) {
    const helper = processWithLines(productionHelper, ['--watch', '--pid', String(pid), '--output', path.join(runRoot, `refused-${pid}`)]);
    t.after(() => helper.cleanup());
    const refusal = await helper.wait(event => event.event === 'attach-failed');
    assert.equal(refusal.reason, 'unexpected-process-name');
    assert.equal((await helper.exit).code, 3);
  }
  target.command('ping');
  await target.wait(line => line === 'alive:debugger=0');
});

test('a second debugger fails open while the existing session and game continue', async t => {
  const target = await fixture(t);
  const { helper } = await watch(t, target, 'first-debugger');
  const second = processWithLines(helperPath, ['--watch', '--pid', String(target.child.pid), '--output', path.join(runRoot, 'second-debugger')]);
  t.after(() => second.cleanup());
  assert.equal((await second.wait(event => event.event === 'attach-failed')).reason, 'debugger-present-or-unavailable');
  assert.equal((await second.exit).code, 3);
  target.command('ping');
  await target.wait(line => line === 'alive:debugger=1');
  helper.command('stop');
  await helper.exit;
});

test('legacy watch creates no optional performance recording or monotonic fields', async t => {
  const target = await fixture(t);
  const { helper, directory } = await watch(t, target, 'legacy-performance-off');
  target.command('exit');
  await helper.exit;
  assert.equal(helper.lines.some(event => String(event.event).startsWith('performance-')), false);
  assert.equal(helper.lines.some(event => Object.hasOwn(event, 'monotonicMs')), false);
  assert.equal((await readdir(directory)).some(name => name.startsWith('performance')), false);
});

test('debug records real 1s CPU memory IO page-fault thread counters and bounded peak summary', async t => {
  const target = await fixture(t);
  const { helper, directory } = await watch(t, target, 'debug-performance', ['--debug']);
  const status = await helper.wait(event => event.event === 'performance-status');
  assert.equal(status.requestedIntervalMs, 1000);
  assert.equal(status.frameTimesCollected, false);
  assert.equal(status.frameTimesStatus, 'separate-presentmon-required');
  assert.equal(status.fileLimitBytes, 16 * 1024 * 1024);
  assert.ok(BigInt(status.qpcFrequency) > 0n);
  await helper.wait(event => event.event === 'performance-sample');
  target.command('workload');
  await target.wait(line => line === 'workload:started');
  await helper.wait(event => event.event === 'performance-sample' && event.threadCount >= 3 && event.privateBytes > 64 * 1024 * 1024);
  await target.wait(line => line === 'workload:done');
  await helper.wait(event => event.event === 'performance-sample' && event.workingSetDeltaBytes < -32 * 1024 * 1024);
  target.command('exit'); await helper.exit;
  const samples = helper.lines.filter(event => event.event === 'performance-sample');
  assert.ok(samples.length >= 5);
  for (let index = 1; index < samples.length; ++index) {
    assert.ok(samples[index].elapsedMs >= samples[index - 1].elapsedMs);
    assert.ok(BigInt(samples[index].qpc) >= BigInt(samples[index - 1].qpc));
    assert.ok(samples[index].intervalMs >= 900 && samples[index].intervalMs < 2500, `sampling interval ${samples[index].intervalMs}`);
  }
  assert.ok(samples.some(sample => sample.cpuOneCorePercent > 25));
  assert.ok(samples.some(sample => sample.pageFaultDelta >= 1000));
  assert.ok(samples.some(sample => sample.readDeltaBytes >= 4 * 1024 * 1024));
  assert.ok(samples.some(sample => sample.writeDeltaBytes >= 4 * 1024 * 1024));
  assert.ok(samples.some(sample => sample.signals.includes('working-set-drop')));
  const summary = JSON.parse(await readFile(path.join(directory, 'performance-summary.json'), 'utf8'));
  assert.equal(summary.reason, 'process-exited');
  assert.equal(summary.sampleCount, samples.length);
  assert.equal(summary.qpcFrequency, status.qpcFrequency);
  assert.equal(summary.startQpc, status.startQpc);
  assert.ok(BigInt(summary.qpc) > BigInt(summary.startQpc));
  assert.ok(summary.peaks.privateBytes > 64 * 1024 * 1024);
  assert.ok(summary.peaks.threadCount >= 3);
  assert.ok(summary.totals.readBytes >= 32 * 1024 * 1024);
  assert.ok(summary.totals.writeBytes >= 32 * 1024 * 1024);
  assert.ok(summary.topIntervals.length <= 16);
  assert.ok(summary.overhead.helperCpuPercent < 2, `helper overhead ${summary.overhead.helperCpuPercent}%`);
  assert.ok(summary.overhead.sampleWorkMaxMs < 100, `sampler work peak ${summary.overhead.sampleWorkMaxMs} ms`);
  const journal = (await readFile(path.join(directory, 'performance.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter(event => event.event === 'performance-sample').length, samples.length);
  assert.ok((await readFile(path.join(directory, 'performance-summary.json'))).length < 64 * 1024);
  const native = await readFile(path.join(directory, 'native-events.jsonl'), 'utf8');
  assert.equal(native.includes('performance-sample'), false, 'performance samples never crowd out exception evidence');
  console.log(`Performance fixture: ${samples.length} samples; helper CPU ${summary.overhead.helperCpuPercent}%; sample work max ${summary.overhead.sampleWorkMaxMs} ms; file ${Buffer.byteLength(JSON.stringify(journal))} bytes`);
});

test('debug counters continue without debugger privileges when another helper is already attached', async t => {
  const target = await fixture(t);
  const { helper: first } = await watch(t, target, 'debug-existing-debugger');
  const directory = path.join(runRoot, 'debug-counters-fallback');
  const fallback = processWithLines(helperPath, ['--watch', '--debug', '--pid', String(target.child.pid), '--output', directory]);
  t.after(() => fallback.cleanup());
  await fallback.wait(event => event.event === 'attach-failed');
  const sample = await fallback.wait(event => event.event === 'performance-sample');
  assert.equal(sample.memoryAvailable, true);
  assert.equal(sample.threadsAvailable, false);
  target.command('ping'); await target.wait(line => line === 'alive:debugger=1');
  target.command('exit');
  await fallback.wait(event => event.event === 'exited');
  assert.equal((await fallback.exit).code, 0);
  await first.exit;
  const summary = JSON.parse(await readFile(path.join(directory, 'performance-summary.json'), 'utf8'));
  assert.equal(summary.reason, 'process-exited');
  assert.ok(summary.sampleCount >= 1);
});

test('debug crash still produces the fatal dump and persists a performance summary', async t => {
  const target = await fixture(t);
  const { helper, directory } = await watch(t, target, 'debug-fatal', ['--debug']);
  await helper.wait(event => event.event === 'performance-sample');
  target.command('av');
  const written = await helper.wait(event => event.event === 'dump-written');
  await inspectDump(directory, written.path, 0xC0000005);
  await helper.exit;
  const summary = JSON.parse(await readFile(path.join(directory, 'performance-summary.json'), 'utf8'));
  assert.equal(summary.reason, 'process-exited');
  assert.ok(summary.sampleCount >= 1);
  const fatal = helper.lines.find(event => event.event === 'exception' && event.firstChance === false);
  assert.equal(typeof fatal.monotonicMs, 'number');
  assert.ok(BigInt(fatal.qpc) > 0n);
});

test('debug retention rotates bounded logs and sampling time limit leaves crash observer attached', async t => {
  const target = await fixture(t);
  const directory = path.join(runRoot, 'debug-bounded');
  const helper = processWithLines(boundedHelperPath, ['--watch', '--debug', '--pid', String(target.child.pid), '--output', directory]);
  t.after(() => helper.cleanup());
  await helper.wait(event => event.event === 'attach-breakpoint');
  const summary = await helper.wait(event => event.event === 'performance-summary' && event.reason === 'duration-limit');
  assert.ok(summary.sampleCount >= 2 && summary.sampleCount <= 4);
  assert.ok(summary.storage.rotations >= 1);
  const names = await readdir(directory);
  assert.ok(names.includes('performance.jsonl.1'));
  assert.ok(names.includes('performance-summary.json'));
  assert.equal(names.includes('performance.jsonl.2'), false);
  const before = helper.lines.filter(event => event.event === 'performance-sample').length;
  target.command('ping'); await target.wait(line => line === 'alive:debugger=1');
  target.command('av');
  const dump = await helper.wait(event => event.event === 'dump-written');
  await inspectDump(directory, dump.path, 0xC0000005);
  await helper.exit;
  assert.equal(helper.lines.filter(event => event.event === 'performance-sample').length, before);
  const persisted = JSON.parse(await readFile(path.join(directory, 'performance-summary.json'), 'utf8'));
  assert.equal(persisted.reason, 'duration-limit');
});

for (const debug of [false, true]) {
  test(`launcher passive capture never attaches a debugger (Debug=${debug})`, async t => {
    const target = await fixture(t);
    const directory = path.join(runRoot, `passive-${debug}`);
    const helper = processWithLines(helperPath, ['--watch', '--counters-only', '--pid', String(target.child.pid), '--output', directory, ...(debug ? ['--debug'] : [])]);
    t.after(() => helper.cleanup());
    await helper.wait(event => event.event === 'observer-ready' && event.mode === 'passive' && event.debuggerAttached === false);
    target.command('ping');
    await target.wait(line => line === 'alive:debugger=0');
    if (debug) await helper.wait(event => event.event === 'performance-sample');
    assert.equal(helper.lines.some(event => event.event === 'attached' || event.event === 'attach-breakpoint'), false);
    helper.command('stop');
    assert.equal((await helper.exit).code, 0);
    assert.equal(helper.lines.some(event => event.event === 'dump-written'), false);
    target.command('exit');
    assert.equal((await target.exit).code, 0);
  });
}

for (const debug of [false, true]) {
  test(`production watch defaults to passive without relying on launcher flag (Debug=${debug})`, async t => {
    const directory = path.join(runRoot, `production-passive-${debug}`);
    await mkdir(directory, { recursive: true });
    const targetPath = path.join(directory, 'H1Z1.exe');
    await copyFile(fixturePath, targetPath);
    const target = processWithLines(targetPath);
    t.after(() => target.cleanup());
    await target.wait(line => line === 'ready');
    const helper = processWithLines(productionHelper, ['--watch', '--pid', String(target.child.pid), '--output', directory, ...(debug ? ['--debug'] : [])]);
    t.after(() => helper.cleanup());
    await helper.wait(event => event.event === 'observer-ready' && event.mode === 'passive');
    target.command('ping');
    await target.wait(line => line === 'alive:debugger=0');
    if (debug) await helper.wait(event => event.event === 'performance-sample');
    assert.equal(helper.lines.some(event => event.event === 'attached'), false);
    helper.command('stop');
    assert.equal((await helper.exit).code, 0);
    target.command('exit');
    assert.equal((await target.exit).code, 0);
  });
}