/** What the launcher does when its window is closed. */
export const CLOSE_BEHAVIORS = ["quit", "tray"] as const;
export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number];

/** What the launcher does with its window once H1Z1 has started. */
export const GAME_START_BEHAVIORS = ["keep", "minimize", "close"] as const;
export type GameStartBehavior = (typeof GAME_START_BEHAVIORS)[number];

/** Download speed limits offered, in megabytes per second; 0 is no limit. */
export const DOWNLOAD_SPEED_LIMITS = [0, 5, 2, 1] as const;

export interface LauncherPreferences {
  closeBehavior: CloseBehavior;
  gameStartBehavior: GameStartBehavior;
  /** Windows notifications: install finished, launcher update ready. */
  notifications: boolean;
  /** Megabytes per second for the ROTK file downloads; 0 means no limit. */
  downloadSpeedLimit: number;
}

/** A launcher that never chose behaves as it always did; notifications are the one addition. */
export const DEFAULT_PREFERENCES: LauncherPreferences = Object.freeze({
  closeBehavior: "quit",
  gameStartBehavior: "keep",
  notifications: true,
  downloadSpeedLimit: 0,
});

const VALID: { [K in keyof LauncherPreferences]: (value: unknown) => boolean } = {
  closeBehavior: (value) => (CLOSE_BEHAVIORS as readonly unknown[]).includes(value),
  gameStartBehavior: (value) => (GAME_START_BEHAVIORS as readonly unknown[]).includes(value),
  notifications: (value) => typeof value === "boolean",
  downloadSpeedLimit: (value) => (DOWNLOAD_SPEED_LIMITS as readonly unknown[]).includes(value),
};

/**
 * The stored preferences, read field by field: what this build knows is kept,
 * the rest is left out. A value written by another version of the launcher
 * must not cost the player every other preference.
 */
export function storedPreferences(value: unknown): Partial<LauncherPreferences> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([field, fieldValue]) =>
    // Own fields only: "valueOf" names a method of every object, not a preference.
    Object.hasOwn(VALID, field) && VALID[field as keyof LauncherPreferences](fieldValue)));
}

/**
 * The preferences the window asks to change. Null when a field or a value is
 * not one this build knows: nothing is then applied.
 */
export function readPreferences(value: unknown): Partial<LauncherPreferences> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const read = storedPreferences(value);
  return Object.keys(read).length === Object.keys(value).length ? read : null;
}
