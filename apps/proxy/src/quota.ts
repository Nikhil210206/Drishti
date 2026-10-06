/**
 * Per-device daily quota in D1. KV's free plan allows only 1,000 writes a day, one per request
 * would run out with a handful of users; D1 allows 100,000, the same as the Workers request cap.
 *
 * Units are rough cost: one LLM step ≈ ₹0.07, a Doc AI page ≈ ₹1, a speech session ≈ a few paise
 * per minute. 400 units a day is about 40 tasks, far above what one person does.
 */
export const UNITS = {
  chat: 1,
  translate: 1,
  docJob: 10,
  docPoll: 0,
  stt: 2,
  tts: 1,
} as const;

export type Kind = keyof typeof UNITS;

/** India's calendar day, so the quota resets at midnight for the people using it. */
export function istDay(now = Date.now()): string {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Add this request's units; false when the device is over its daily limit. */
export async function spend(db: D1Database, device: string, kind: Kind, limit: number, now = Date.now()): Promise<boolean> {
  const units = UNITS[kind];
  if (!units) return true;
  const row = await db
    .prepare(
      "INSERT INTO usage (device, day, units) VALUES (?1, ?2, ?3) ON CONFLICT (device, day) DO UPDATE SET units = units + excluded.units RETURNING units",
    )
    .bind(device, istDay(now), units)
    .first<{ units: number }>();
  return (row?.units ?? 0) <= limit;
}
