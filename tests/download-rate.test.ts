import { describe, expect, it } from "vitest";
import { DownloadRateMeter } from "../electron/services/download-rate.js";

const KB = 1024;

function clockedMeter() {
  let now = 0;
  const rate = new DownloadRateMeter(() => now);
  return {
    rate,
    wait(milliseconds: number): void {
      now += milliseconds;
    },
    /** Bytes arriving at `bytesPerSecond` for `seconds`, one chunk every 100 ms. */
    receive(bytesPerSecond: number, seconds: number): void {
      for (let chunk = 0; chunk < seconds * 10; chunk += 1) {
        now += 100;
        rate.add(bytesPerSecond / 10);
      }
    },
  };
}

describe("asset download speed", () => {
  it("waits for two seconds of data before a speed, and five before a time left", () => {
    const { rate, receive } = clockedMeter();
    rate.resume();
    receive(300 * KB, 1);
    expect(rate.estimate(10_000 * KB)).toEqual({});
    receive(300 * KB, 2);
    expect(rate.estimate(10_000 * KB)).toEqual({ bytesPerSecond: 300 * KB });
    receive(300 * KB, 3);
    expect(rate.estimate(9_000 * KB)).toEqual({ bytesPerSecond: 300 * KB, secondsLeft: 30 });
  });

  it("leaves paused time out, so the gap between two packs keeps the speed", () => {
    const { rate, receive, wait } = clockedMeter();
    rate.resume();
    receive(300 * KB, 6);
    rate.pause();
    wait(45_000);
    expect(rate.estimate(1_000 * KB)).toEqual({});
    rate.resume();
    receive(300 * KB, 1);
    expect(rate.estimate(3_000 * KB)).toEqual({ bytesPerSecond: 300 * KB, secondsLeft: 10 });
  });

  it("follows a new speed once it fills the window", () => {
    const { rate, receive } = clockedMeter();
    rate.resume();
    receive(100 * KB, 20);
    receive(500 * KB, 5);
    const halfway = rate.estimate(1_000 * KB).bytesPerSecond!;
    expect(halfway).toBeGreaterThan(250 * KB);
    expect(halfway).toBeLessThan(350 * KB);
    receive(500 * KB, 6);
    expect(rate.estimate(1_000 * KB)).toEqual({ bytesPerSecond: 500 * KB, secondsLeft: 2 });
  });

  it("falls to zero during a stall and then drops the time left", () => {
    const { rate, receive, wait } = clockedMeter();
    rate.resume();
    receive(300 * KB, 10);
    wait(5_000);
    const slowing = rate.estimate(3_000 * KB);
    expect(slowing.bytesPerSecond).toBeLessThan(200 * KB);
    expect(slowing.secondsLeft).toBeGreaterThan(15);
    wait(6_000);
    expect(rate.estimate(3_000 * KB)).toEqual({ bytesPerSecond: 0 });
  });

  it("gives no time left once nothing remains", () => {
    const { rate, receive } = clockedMeter();
    rate.resume();
    receive(300 * KB, 6);
    expect(rate.estimate(0)).toEqual({ bytesPerSecond: 300 * KB });
  });

  it("starts paused: a pack found in the cache never starts the clock", () => {
    const { rate, wait } = clockedMeter();
    wait(10_000);
    expect(rate.estimate(1_000 * KB)).toEqual({});
  });
});
