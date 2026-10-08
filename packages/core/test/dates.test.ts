import { describe, expect, it } from "vitest";
import { dateMismatch, requestedDate, urlDateMismatch } from "../src/agent/dates.js";

// The eval's frozen clock: Mon 5 Oct 2026, 09:30 IST.
const NOW = new Date("2026-10-05T09:30:00+05:30");
const day = (texts: string[]) => requestedDate(texts, NOW)?.toISOString().slice(0, 10);

describe("requestedDate", () => {
  // Commands from eval/tasks, plus the other languages' words.
  const cases: [string, string | undefined][] = [
    ["कल चेन्नई से बेंगलुरु की स्लीपर क्लास की एक टिकट बुक करो, मेरे लिए", "2026-10-06"],
    ["परसों चेन्नई से मदुरै की स्लीपर टिकट बुक करो मेरे लिए", "2026-10-07"],
    ["நாளைக்கு சென்னையிலிருந்து பெங்களூருக்கு AC 3 tier டிக்கெட்", "2026-10-06"],
    ["நாளை மறுநாள் மதுரைக்கு டிக்கெட்", "2026-10-07"],
    ["কাল হাওড়া থেকে পাটনা যাওয়ার একটা স্লিপার টিকিট", "2026-10-06"],
    ["రేపు Secunderabad నుండి Vijayawada-కి నా కోసం chair car ticket book చేయండి.", "2026-10-06"],
    ["ನಾಳೆ ಬೆಂಗಳೂರಿನಿಂದ ಮೈಸೂರಿಗೆ", "2026-10-06"],
    ["Ernakulam-ൽ നിന്ന് Thiruvananthapuram-ലേക്ക് നാളെ", "2026-10-06"],
    ["उद्या Mumbai-वरून Pune-ला", "2026-10-06"],
    ["કાલે Ahmedabad-થી Jaipur માટે", "2026-10-06"],
    ["ਕੱਲ੍ਹ ਨੂੰ Chandigarh ਤੋਂ Amritsar", "2026-10-06"],
    ["କାଲି Howrah-ରୁ Bhubaneswar-କୁ", "2026-10-06"],
    ["Book me a ticket for tomorrow", "2026-10-06"],
    ["Book a chair car ticket for me from Nagpur to Bhopal on 12 October.", "2026-10-12"],
    ["a ticket for Oct 3", "2027-10-03"], // past dates mean next year
    ["आज की ट्रेन", "2026-10-05"],
    ["Kalupur to Surat, કાલુપુર", undefined], // a station, not "tomorrow"
    ["सकाल", undefined],
    ["कल, नहीं 12 October", undefined], // two dates: ambiguous, no check
    ["Mumbai to Pune", undefined],
  ];
  it.each(cases)("%s", (text, want) => {
    expect(day([text])).toBe(want);
  });
});

describe("dateMismatch", () => {
  it("refuses a booking on another day than asked", () => {
    expect(dateMismatch(["परसों मदुरै"], "Train Chennai–Madurai Mail (12200); Date Tue, 6 Oct, 2026; Class Sleeper (SL)", NOW)).toBe(
      "the user asked for the day after tomorrow (Wed, 7 Oct), but this is for Tue, 6 Oct",
    );
  });

  it("allows the asked day, and stays out of the way when unsure", () => {
    expect(dateMismatch(["कल मुंबई से पुणे"], "Date Tue, 6 Oct, 2026", NOW)).toBe("");
    expect(dateMismatch(["Mumbai to Pune"], "Date Wed, 7 Oct, 2026", NOW)).toBe("");
    expect(dateMismatch(["kal"], "Tue, 6 Oct, 2026 or Wed, 7 Oct, 2026", NOW)).toBe("");
    expect(dateMismatch(["kal"], "PAY ₹180", NOW)).toBe("");
  });
});

describe("urlDateMismatch", () => {
  const results = (d: string) => `http://localhost:5174/#/results?from=CSMT&to=PUNE&date=${d}&cls=ALL&quota=GN`;

  it("catches results for another day than asked (a live run answered 'tomorrow, 29 October')", () => {
    expect(urlDateMismatch(["trains from Mumbai to Pune tomorrow"], results("2026-10-29"), NOW)).toBe(
      "the user asked for tomorrow (Tue, 6 Oct), but this is for Thu, 29 Oct",
    );
  });

  it("lets the right day through, and pages whose address doesn't carry exactly one date", () => {
    expect(urlDateMismatch(["trains from Mumbai to Pune tomorrow"], results("2026-10-06"), NOW)).toBe("");
    expect(urlDateMismatch(["trains from Mumbai to Pune"], results("2026-10-29"), NOW)).toBe("");
    expect(urlDateMismatch(["today's news"], "https://news.example/2026/10/01/rains-in-chennai", NOW)).toBe("");
    expect(urlDateMismatch(["trains tomorrow"], "https://rail.example/?from=2026-10-06&to=2026-10-09", NOW)).toBe("");
  });
});
