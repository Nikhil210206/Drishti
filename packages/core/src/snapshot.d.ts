import type { Snapshot, SnapshotOptions } from "./types.js";

/** Build the page model. Runs inside the page; must stay self-contained. */
export declare function snapshotPage(opts?: SnapshotOptions): Snapshot;
