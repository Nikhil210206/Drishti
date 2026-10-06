-- Per-device daily usage, in quota units (see src/quota.ts). One row per device per day.
CREATE TABLE IF NOT EXISTS usage (
  device TEXT NOT NULL,
  day TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device, day)
);
