import { spawn } from "node:child_process";

export type HwidReaderFailure = "timeout" | "cancelled" | "execution" | "output_limit";

/** Never includes the command, stderr or hardware values in the error message. */
export class HwidReaderError extends Error {
  constructor(readonly reason: HwidReaderFailure, readonly stdout = "") {
    super("Hardware reader did not complete.");
    this.name = "HwidReaderError";
  }
}

export interface HwidReaderHandle {
  readonly output: Promise<string>;
  /** Resolves only after the child and its stdio have closed. */
  readonly closed: Promise<void>;
}

export interface HwidReaderOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Own the direct reader process until close, including on cancellation. Fixed
 * PowerShell readers do not launch external child programs. WMI services are
 * OS-owned and are deliberately not terminated with the reader.
 */
export function startHwidReaderProcess(
  executable: string,
  args: readonly string[],
  options: HwidReaderOptions,
): HwidReaderHandle {
  if (options.signal.aborted) {
    return { output: Promise.reject(new HwidReaderError("cancelled")), closed: Promise.resolve() };
  }
  let resolveOutput!: (output: string) => void;
  let rejectOutput!: (error: HwidReaderError) => void;
  let resolveClosed!: () => void;
  const output = new Promise<string>((resolve, reject) => { resolveOutput = resolve; rejectOutput = reject; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failure: HwidReaderFailure | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, [...args], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    rejectOutput(new HwidReaderError("execution"));
    resolveClosed();
    return { output, closed };
  }

  const stop = (reason: HwidReaderFailure): void => {
    failure ??= reason;
    // SIGKILL maps to forced process termination on Windows. Do not settle
    // output here: callers must not start replacement work before close.
    try { child.kill("SIGKILL"); } catch { /* The close/error handlers retain ownership. */ }
  };
  const abort = (): void => stop("cancelled");
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();

  const receive = (data: Buffer, stdout: boolean): void => {
    bytes += data.length;
    if (bytes > MAX_OUTPUT_BYTES) { stop("output_limit"); return; }
    if (stdout) chunks.push(data);
  };
  child.stdout!.on("data", (data: Buffer) => receive(data, true));
  child.stderr!.on("data", (data: Buffer) => receive(data, false));
  child.stdout!.on("error", () => stop("execution"));
  child.stderr!.on("error", () => stop("execution"));
  child.once("error", () => { failure ??= "execution"; });
  child.once("close", (code) => {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    const stdout = Buffer.concat(chunks).toString("utf8");
    if (failure || code !== 0) rejectOutput(new HwidReaderError(failure ?? "execution", stdout));
    else resolveOutput(stdout);
    resolveClosed();
  });
  return { output, closed };
}
