import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordPresence, DISCORD_APPLICATION_ID } from "../electron/services/discord-presence.js";

interface RpcMessage {
  cmd?: string;
  evt?: string;
  nonce?: string;
  v?: number;
  client_id?: string;
  args?: { pid: number; activity: null | {
    name: string; type: number; details: string; timestamps: { start: number };
    assets: { large_image: string; large_text: string };
    buttons: { label: string; url: string }[];
  } };
}

const controllers: DiscordPresence[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const pipePath = (): string => process.platform === "win32"
  ? `\\\\?\\pipe\\rotk-discord-test-${randomUUID()}`
  : join(tmpdir(), `rotk-rpc-${randomUUID()}.sock`);

function encode(opcode: number, data: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(data));
  const packet = Buffer.alloc(body.length + 8);
  packet.writeUInt32LE(opcode, 0);
  packet.writeUInt32LE(body.length, 4);
  body.copy(packet, 8);
  return packet;
}

async function discord(path: string, options: { ready?: boolean; acknowledge?: boolean } = {}) {
  const messages: { opcode: number; data: RpcMessage }[] = [];
  const clients: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    clients.push(socket);
    socket.on("error", () => undefined);
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4) + 8) {
        const opcode = buffer.readUInt32LE(0), size = buffer.readUInt32LE(4);
        const data = JSON.parse(buffer.subarray(8, 8 + size).toString()) as RpcMessage;
        buffer = buffer.subarray(8 + size);
        messages.push({ opcode, data });
        if (opcode === 0 && options.ready !== false) {
          // Split a READY header and combine the remainder with a PING frame.
          const ready = encode(1, { cmd: "DISPATCH", evt: "READY", data: { user: { id: "not-collected" } } });
          socket.write(ready.subarray(0, 5));
          socket.write(Buffer.concat([ready.subarray(5), encode(3, { nonce: "heartbeat" })]));
        } else if (opcode === 1 && options.acknowledge !== false) {
          socket.write(encode(1, { cmd: data.cmd, nonce: data.nonce, data: {} }));
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { messages, clients, activities: () => messages.filter(m => m.data.args?.activity).map(m => m.data) };
}

function presence(paths: string[], overrides: { retryMs?: number; timeoutMs?: number } = {}) {
  const controller = new DiscordPresence({ pipePaths: paths, retryMs: 30, timeoutMs: 500, ...overrides });
  controllers.push(controller);
  return controller;
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("Discord Rich Presence over a real local pipe", () => {
  it("publishes only the requested game card and buttons, handles fragmented frames, and clears on stop", async () => {
    const path = pipePath(), rpc = await discord(path), controller = presence([path]);
    expect(rpc.clients).toHaveLength(0);
    const started = Math.floor(Date.now() / 1000);
    controller.start(4242);
    await vi.waitFor(() => expect(rpc.activities()).toHaveLength(1));
    expect(rpc.messages[0]).toEqual({ opcode: 0, data: { v: 1, client_id: DISCORD_APPLICATION_ID } });
    expect(rpc.activities()[0].args).toEqual({ pid: 4242, activity: {
      name: "ROTK: Return Of the Kill", type: 0, details: "In-game",
      timestamps: { start: expect.any(Number) },
      assets: { large_image: "https://rotk.app/branding/rotk-logo.png", large_text: "ROTK: Return Of the Kill" },
      buttons: [
        { label: "Website", url: "https://rotk.app" },
        { label: "Discord", url: "https://discord.gg/JTr9NHTmCU" },
      ],
    } });
    expect(rpc.activities()[0].args!.activity!.timestamps.start).toBeGreaterThanOrEqual(started);
    expect(rpc.messages.some(m => m.opcode === 4 && m.data.nonce === "heartbeat")).toBe(true);
    controller.start(4242);
    controller.stop();
    await vi.waitFor(() => expect(rpc.messages.some(m => m.data.args?.activity === null && m.data.args.pid === 4242)).toBe(true));
    expect(rpc.activities()).toHaveLength(1);
  });

  it("finds a later pipe and reconnects after Discord restarts without resetting the game timer", async () => {
    const path = pipePath(), rpc = await discord(path), controller = presence([pipePath(), path]);
    controller.start(4242);
    await vi.waitFor(() => expect(rpc.activities()).toHaveLength(1));
    const first = rpc.activities()[0].args;
    rpc.clients[0].destroy();
    await vi.waitFor(() => expect(rpc.activities()).toHaveLength(2));
    expect(rpc.activities()[1].args).toEqual(first);
  });

  it("tolerates Discord starting after the game", async () => {
    const path = pipePath(), controller = presence([path]);
    expect(() => controller.start(4242)).not.toThrow();
    const rpc = await discord(path);
    await vi.waitFor(() => expect(rpc.activities()).toHaveLength(1));
  });

  it("cancels pending handshakes and retries when the game ends", async () => {
    const path = pipePath(), rpc = await discord(path, { ready: false }), controller = presence([path]);
    controller.start(4242);
    await vi.waitFor(() => expect(rpc.messages).toHaveLength(1));
    controller.stop();
    await vi.waitFor(() => expect(rpc.clients[0].destroyed).toBe(true));
    expect(rpc.activities()).toHaveLength(0);
    // A new game gets its own lifecycle after cancellation.
    controller.start(4343);
    await vi.waitFor(() => expect(rpc.clients).toHaveLength(2));
    rpc.clients[1].write(encode(1, { cmd: "DISPATCH", evt: "READY" }));
    await vi.waitFor(() => expect(rpc.activities()).toHaveLength(1));
    expect(rpc.activities()[0].args!.pid).toBe(4343);
  });

  it("abandons an oversized frame and proceeds to another Discord pipe", async () => {
    const first = pipePath(), second = pipePath();
    const malformed = await discord(first, { ready: false }), good = await discord(second);
    presence([first, second]).start(4242);
    await vi.waitFor(() => expect(malformed.messages).toHaveLength(1));
    const header = Buffer.alloc(8); header.writeUInt32LE(1, 0); header.writeUInt32LE(1024 * 1024, 4);
    malformed.clients[0].write(header);
    await vi.waitFor(() => expect(good.activities()).toHaveLength(1));
    expect(malformed.activities()).toHaveLength(0);
  });

  it("recovers when Discord never acknowledges the activity", async () => {
    const path = pipePath(), rpc = await discord(path, { acknowledge: false });
    presence([path], { timeoutMs: 100 }).start(4242);
    await vi.waitFor(() => expect(rpc.activities().length).toBeGreaterThanOrEqual(2));
    expect(rpc.activities()[1].args).toEqual(rpc.activities()[0].args);
  });

  it("ignores invalid game PIDs without connecting", () => {
    const controller = presence([pipePath()]);
    for (const pid of [0, -1, NaN, 1.5]) expect(() => controller.start(pid)).not.toThrow();
    controller.stop();
  });
});
