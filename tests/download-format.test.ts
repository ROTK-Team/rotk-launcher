import { describe, expect, it } from "vitest";
import { formatDownloadSpeed, formatTimeLeft, roundTimeLeft } from "../src/download-format.js";

const KB = 1024;
const MB = 1024 * 1024;

describe("asset download speed and time left wording", () => {
  it("writes KB/s, then MB/s, in every language", () => {
    expect(formatDownloadSpeed(312 * KB, "en")).toBe("312 KB/s");
    expect(formatDownloadSpeed(312 * KB, "fr")).toBe("312 KB/s");
    expect(formatDownloadSpeed(312 * KB, "zh")).toBe("312 KB/s");
    expect(formatDownloadSpeed(2.4 * MB, "en")).toBe("2.4 MB/s");
    expect(formatDownloadSpeed(2.4 * MB, "fr")).toBe("2,4 MB/s");
    expect(formatDownloadSpeed(2.4 * MB, "zh")).toBe("2.4 MB/s");
  });

  it("never writes four digits of KB/s, nor a negative speed", () => {
    expect(formatDownloadSpeed(999 * KB, "en")).toBe("999 KB/s");
    expect(formatDownloadSpeed(999.6 * KB, "en")).toBe("1.0 MB/s");
    expect(formatDownloadSpeed(0, "en")).toBe("0 KB/s");
    expect(formatDownloadSpeed(-5, "en")).toBe("0 KB/s");
    expect(formatDownloadSpeed(Number.NaN, "fr")).toBe("0 KB/s");
  });

  it("rounds to 5 s under a minute, to the minute under an hour, then to 5 min", () => {
    expect(roundTimeLeft(0.4)).toEqual({ hours: 0, minutes: 0, seconds: 5 });
    expect(roundTimeLeft(42)).toEqual({ hours: 0, minutes: 0, seconds: 45 });
    expect(roundTimeLeft(56)).toEqual({ hours: 0, minutes: 1, seconds: 0 });
    expect(roundTimeLeft(25 * 60 + 20)).toEqual({ hours: 0, minutes: 25, seconds: 0 });
    expect(roundTimeLeft(59 * 60 + 50)).toEqual({ hours: 1, minutes: 0, seconds: 0 });
    expect(roundTimeLeft(85 * 60 + 40)).toEqual({ hours: 1, minutes: 25, seconds: 0 });
    expect(roundTimeLeft(0)).toBeNull();
    expect(roundTimeLeft(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("reads naturally in English", () => {
    expect(formatTimeLeft(42, "en")).toBe("about 45 s left");
    expect(formatTimeLeft(25 * 60, "en")).toBe("about 25 min left");
    expect(formatTimeLeft(85 * 60, "en")).toBe("about 1 h 25 min left");
    expect(formatTimeLeft(2 * 3600, "en")).toBe("about 2 h left");
  });

  it("agrees restante with the duration in French", () => {
    expect(formatTimeLeft(42, "fr")).toBe("environ 45 s restantes");
    expect(formatTimeLeft(60, "fr")).toBe("environ 1 min restante");
    expect(formatTimeLeft(25 * 60, "fr")).toBe("environ 25 min restantes");
    expect(formatTimeLeft(3600, "fr")).toBe("environ 1 h restante");
    expect(formatTimeLeft(85 * 60, "fr")).toBe("environ 1 h 25 min restantes");
  });

  it("reads naturally in Chinese", () => {
    expect(formatTimeLeft(42, "zh")).toBe("剩余约 45 秒");
    expect(formatTimeLeft(25 * 60, "zh")).toBe("剩余约 25 分钟");
    expect(formatTimeLeft(85 * 60, "zh")).toBe("剩余约 1 小时 25 分钟");
  });

  it("shows nothing when the estimate is not a time", () => {
    expect(formatTimeLeft(0, "en")).toBeNull();
    expect(formatTimeLeft(Number.NaN, "zh")).toBeNull();
  });
});
