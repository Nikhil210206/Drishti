import type { FastifyInstance } from "fastify";

export interface Booking {
  pnr: string;
  train: string;
  trainNo: string;
  from: string;
  to: string;
  date: string;
  cls: string;
  quota: string;
  passengers: { name: string; age: string; gender: string; berth: string }[];
  total: number;
  createdAt: string;
}

export const bookings: Booking[] = [];
export const complaints: { id: string; category: string; text: string; pnr?: string; createdAt: string }[] = [];

/** Tiny in-memory backend for the Pathik Rail mock, so tests can verify what the agent did. */
export function registerMockApi(app: FastifyInstance) {
  app.post("/api/bookings", async (req) => {
    const b = req.body as Omit<Booking, "pnr" | "createdAt">;
    const pnr = String(4000000000 + Math.floor(Math.random() * 999999999)).slice(0, 10);
    const booking = { ...b, pnr, createdAt: new Date().toISOString() };
    bookings.push(booking);
    return booking;
  });
  app.get("/api/bookings", async () => bookings);
  app.post("/api/complaints", async (req) => {
    const c = req.body as { category: string; text: string; pnr?: string };
    const rec = { ...c, id: `CMP${1000 + complaints.length}`, createdAt: new Date().toISOString() };
    complaints.push(rec);
    return rec;
  });
  app.get("/api/complaints", async () => complaints);
  app.post("/api/reset", async () => {
    bookings.length = 0;
    complaints.length = 0;
    return { ok: true };
  });
}
