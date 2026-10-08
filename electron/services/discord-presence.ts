import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export const DISCORD_APPLICATION_ID = "1557698200842805348";
export const DISCORD_GAME_NAME = "ROTK: Return Of the Kill";
export const DISCORD_WEBSITE_URL = "https://rotk.app";
export const DISCORD_INVITE_URL = "https://discord.gg/JTr9NHTmCU";
// Public current branding; Discord proxies and caches this image itself.
export const DISCORD_LOGO_URL = "https://rotk.app/branding/rotk-logo.png";

const MAX_FRAME_BYTES = 64 * 1024;
const WINDOWS_PIPES = Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);

interface PresenceOptions {
  /** Test seams; production only connects to Discord's local Windows pipes. */
  pipePaths?: readonly string[];
  retryMs?: number;
  timeoutMs?: number;
}

function frame(opcode: number, payload: unknown): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * Best-effort Rich Presence through local Discord RPC. No token, OAuth, REST,
 * user identity or game credentials are needed. Nothing runs before a game
 * starts, and an absent/restarting Discord client can never block the game.
 */
export class DiscordPresence {
  private readonly paths: readonly string[];
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private socket: Socket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private game: { pid: number; startedAt: number } | null = null;
  private ready = false;
  private generation = 0;

  constructor(options: PresenceOptions = {}) {
    this.paths = options.pipePaths ?? (process.platform === "win32" ? WINDOWS_PIPES : []);
    this.retryMs = options.retryMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  start(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0 || this.game?.pid === pid) return;
    this.stop();
    this.game = { pid, startedAt: Math.floor(Date.now() / 1000) };
    this.connect(0, this.generation);
  }

  stop(): void {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearDeadline();
    const socket = this.socket;
    const game = this.game;
    const wasReady = this.ready;
    this.socket = null;
    this.game = null;
    this.ready = false;
    if (!socket) return;
    if (wasReady && game && !socket.destroyed) {
      // Flush a clear before closing; never wait on Discord at game/app exit.
      try {
        socket.end(frame(1, {
          cmd: "SET_ACTIVITY", args: { pid: game.pid, activity: null }, nonce: randomUUID(),
        }));
        const cleanup = setTimeout(() => socket.destroy(), 250);
        cleanup.unref();
        socket.once("close", () => clearTimeout(cleanup));
      } catch { socket.destroy(); }
    } else {
      socket.destroy();
    }
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private armDeadline(socket: Socket): void {
    this.clearDeadline();
    this.deadline = setTimeout(() => socket.destroy(), this.timeoutMs);
    this.deadline.unref();
  }

  private retry(generation: number): void {
    if (!this.game || generation !== this.generation || this.retryTimer || !this.paths.length) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect(0, generation);
    }, this.retryMs);
    this.retryTimer.unref();
  }

  private connect(index: number, generation: number): void {
    if (!this.game || generation !== this.generation) return;
    if (index >= this.paths.length) { this.retry(generation); return; }
    let socket: Socket;
    try { socket = createConnection(this.paths[index]); }
    catch { this.retry(generation); return; }
    this.socket = socket;
    this.ready = false;
    socket.unref();
    this.armDeadline(socket);
    let buffered: Buffer = Buffer.alloc(0);
    let activityNonce: string | null = null;
    let receivedReady = false;
    const active = (): boolean => this.socket === socket && generation === this.generation && this.game !== null;

    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (!active()) return;
      this.clearDeadline();
      this.socket = null;
      this.ready = false;
      if (receivedReady) this.retry(generation);
      else this.connect(index + 1, generation);
    });
    socket.once("connect", () => {
      if (!active()) { socket.destroy(); return; }
      socket.write(frame(0, { v: 1, client_id: DISCORD_APPLICATION_ID }));
    });
    socket.on("data", (chunk: Buffer) => {
      if (!active()) return;
      try {
        // Discord frames may be split across reads, or several may arrive at once.
        if (buffered.length + chunk.length > MAX_FRAME_BYTES + 8) { socket.destroy(); return; }
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 8) {
          const opcode = buffered.readUInt32LE(0);
          const length = buffered.readUInt32LE(4);
          if (length > MAX_FRAME_BYTES) { socket.destroy(); return; }
          if (buffered.length < length + 8) return;
          const body = buffered.subarray(8, 8 + length);
          buffered = buffered.subarray(8 + length);
          if (opcode === 2) { socket.destroy(); return; }
          if (opcode === 3) { socket.write(frame(4, body)); continue; }
          if (opcode !== 1) continue;
          const message = JSON.parse(body.toString("utf8")) as Record<string, unknown> | null;
          if (!message || typeof message !== "object") { socket.destroy(); return; }
          if (message.evt === "ERROR") { socket.destroy(); return; }
          if (!receivedReady && message.cmd === "DISPATCH" && message.evt === "READY") {
            receivedReady = true;
            this.ready = true;
            const game = this.game!;
            activityNonce = randomUUID();
            socket.write(frame(1, {
              cmd: "SET_ACTIVITY",
              args: {
                pid: game.pid,
                activity: {
                  name: DISCORD_GAME_NAME,
                  type: 0,
                  details: "In-game",
                  timestamps: { start: game.startedAt },
                  assets: { large_image: DISCORD_LOGO_URL, large_text: DISCORD_GAME_NAME },
                  buttons: [
                    { label: "Website", url: DISCORD_WEBSITE_URL },
                    { label: "Discord", url: DISCORD_INVITE_URL },
                  ],
                },
              },
              nonce: activityNonce,
            }));
            this.armDeadline(socket);
          } else if (activityNonce && message.cmd === "SET_ACTIVITY" && message.nonce === activityNonce) {
            this.clearDeadline();
          }
        }
      } catch { socket.destroy(); }
    });
  }
}
