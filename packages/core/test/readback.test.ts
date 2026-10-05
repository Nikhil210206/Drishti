import { describe, expect, it } from "vitest";
import { duplicatePassenger, looksComplete, readback, readbackPassengers } from "../src/agent/readback.js";
import { element, page } from "./fakes.js";

const REVIEW = [
  "- Bengaluru–Mysuru Sampark Kranti Express (20162) · SBC 19:50 → MYS 22:40 · Tue, 6 Oct, 2026 · SL · General Review your journey Train Bengaluru–Mysuru Sampark Kranti Express (20162) From",
  "- KSR Bengaluru (SBC) at 19:50 To Mysuru Junction (MYS) at 22:40 Date Tue, 6 Oct, 2026 Class Sleeper (SL) Passengers Asha Verma (34, Male) Ticket fare × 1 ₹145 Convenience fee ₹20 Total ₹165",
  '[74] clickable "PROCEED TO PAY"',
].join("\n");

describe("readback", () => {
  it("reads the booking facts from a review page, whatever the model claims", () => {
    const s = page("http://localhost:5174/#/review", { "74": element("PROCEED TO PAY") }, REVIEW);
    const r = readback(s, 74, s.elements["74"]);
    expect(r).toContain("Date Tue, 6 Oct, 2026");
    expect(r).toContain("Class Sleeper (SL)");
    expect(r).toContain("Passengers Asha Verma (34, Male)");
    expect(r).toContain("Total ₹165");
  });

  it("reads a long passenger list, so a triple booking of one person is caught", () => {
    // From a live run that paid for three identical passengers.
    const text = [
      "- Hyderabad–Vijayawada Double Decker Express (22714) · SC 09:05 → BZA 14:00 · Tue, 6 Oct, 2026 · CC · General Review your journey Train Hyderabad–Vijayawada Double Decker Express (22714) From",
      "- Secunderabad Junction (SC) at 09:05 To Vijayawada Junction (BZA) at 14:00 Date Tue, 6 Oct, 2026 Class AC Chair Car (CC) Passengers",
      "- Asha Verma (34, Female), Asha Verma (34, Female), Asha Verma (34, Female) Ticket fare × 3 ₹1050 Convenience fee ₹20 Total ₹1070",
      '[56] clickable "PROCEED TO PAY"',
    ].join("\n");
    const s = page("http://localhost:5174/#/review", { "56": element("PROCEED TO PAY") }, text);
    const r = readback(s, 56, s.elements["56"]);
    expect(readbackPassengers(r)).toHaveLength(3);
    expect(duplicatePassenger(r)).toContain("Asha Verma (34, Female)");
    expect(r).toContain("Total ₹1070");
  });

  it("names the train row and the class box of a book button in a results list", () => {
    const text = [
      "- Tue, 6 Oct, 2026 · 9 trains found",
      'ROW: Sahyadri Intercity Express · (12981) · 14:25 · SBC · 2S · ₹90 · [56] clickable "book ticket (2S ₹90 14)"',
      'ROW: Sampark Kranti Express · (20162) · 19:50 · SBC · SL · ₹145 · [61] clickable "book ticket (SL ₹145 40)"',
    ].join("\n");
    const s = page("http://localhost:5174/#/results", { "61": element("book ticket (SL ₹145 40)") }, text);
    expect(readback(s, 61, s.elements["61"])).toBe("Sampark Kranti Express (20162); book ticket (SL ₹145 40); Tue, 6 Oct, 2026");
  });

  it("says nothing page-wide on a page about several dates", () => {
    const s = page("x", { "1": element("Pay") }, "- Tue, 6 Oct, 2026 or Wed, 7 Oct, 2026 · Total ₹100");
    expect(readback(s, 1, s.elements["1"])).toBe("");
  });
});

describe("looksComplete", () => {
  it.each(["- Booking confirmed! PNR 4123456700", "- Your complaint is registered. Reference number CMP1000", "- Payment successful"])(
    "%s",
    (text) => {
      expect(looksComplete(page("x", {}, text))).toBe(true);
    },
  );

  it("is false on a review page", () => {
    expect(looksComplete(page("x", {}, REVIEW))).toBe(false);
  });
});

describe("passengers in a readback", () => {
  const facts = "Train X (22576); Date Tue, 6 Oct, 2026; Passengers Asha Verma (34, Female), Asha Verma (34, Female); Tue, 6 Oct";
  it("lists them", () => {
    expect(readbackPassengers(facts)).toEqual(["Asha Verma (34, Female)", "Asha Verma (34, Female)"]);
    expect(readbackPassengers("PAY ₹180")).toEqual([]);
  });
  it("flags the same person twice, not two different people", () => {
    expect(duplicatePassenger(facts)).toBe("the same passenger is listed twice (Asha Verma (34, Female))");
    expect(duplicatePassenger("Passengers Asha Verma (34, Female), Ravi Verma (36, Male)")).toBe("");
  });
});
