import { describe, expect, it } from "vitest";
import { passengerMismatch, requestedPassengers } from "../src/agent/passengers.js";

const asked = (...texts: string[]) => requestedPassengers(texts);

describe("requestedPassengers", () => {
  it("reads a count said right before tickets or people, in any of the languages", () => {
    // The live run this guard is for: two tickets, one passenger filled in.
    expect(
      asked("कल दिल्ली से वाराणसी के लिए AC 3 tier में दो टिकट बुक करो, एक मेरे लिए और एक मेरे पति रवि वर्मा के लिए, उनकी उम्र 36 साल है।"),
    ).toBe(2);
    expect(asked("Book 2 tickets from Delhi to Agra tomorrow")).toBe(2);
    expect(asked("tickets for 3 people to Pune")).toBe(3);
    expect(asked("हम चार लोगों के लिए टिकट चाहिए")).toBe(4);
    expect(asked("२ टिकट बुक करो")).toBe(2);
    expect(asked("ரெண்டு டிக்கெட் புக் பண்ணுங்க")).toBe(2);
    expect(asked("இரண்டு பேருக்கு டிக்கெட் வேணும்")).toBe(2);
    expect(asked("మూడు టికెట్లు బుక్ చేయి")).toBe(3);
    expect(asked("ಎರಡು ಟಿಕೆಟ್ ಬುಕ್ ಮಾಡಿ")).toBe(2);
    expect(asked("രണ്ട് ടിക്കറ്റ് ബുക്ക് ചെയ്യൂ")).toBe(2);
    expect(asked("दोन तिकिटं बुक करा")).toBe(2);
    expect(asked("બે ટિકિટ બુક કરો")).toBe(2);
    expect(asked("ਦੋ ਟਿਕਟਾਂ ਬੁੱਕ ਕਰੋ")).toBe(2);
    expect(asked("দুটো টিকিট বুক করো")).toBe(2);
    expect(asked("ଦୁଇଟି ଟିକେଟ ବୁକ୍ କର")).toBe(2);
  });

  it("reads words that mean so many people", () => {
    expect(asked("ఇద్దరికి టికెట్లు బుక్ చేయి")).toBe(2);
    expect(asked("ಇಬ್ಬರಿಗೆ ಟಿಕೆಟ್ ಬೇಕು")).toBe(2);
    expect(asked("दोघांसाठी तिकीट बुक करा")).toBe(2);
    expect(asked("তিনজনের জন্য টিকিট")).toBe(3);
    expect(asked("രണ്ടുപേർക്ക് ടിക്കറ്റ് വേണം")).toBe(2);
    expect(asked("a ticket for the two of us")).toBe(2);
  });

  it("lets a class or quota word stand between the number and the tickets", () => {
    expect(asked("book three sleeper tickets to Madurai")).toBe(3);
    expect(asked("दो तत्काल टिकट बुक करो")).toBe(2);
  });

  it("does not take a class, a date, a time or a number in the profile for a count", () => {
    expect(asked("AC 3 tier ticket book karo")).toBeUndefined();
    expect(asked("book my ticket in 2 tier")).toBeUndefined();
    expect(asked("3 AC ticket to Lucknow")).toBeUndefined();
    expect(asked("2S ticket to Mysuru")).toBeUndefined();
    expect(asked("6 October ka ticket book karo")).toBeUndefined();
    expect(asked("दो जनवरी को टिकट बुक करो")).toBeUndefined();
    expect(asked("चार बजे की टिकट")).toBeUndefined();
    expect(asked("train 12951 ticket", "34", "9000000001")).toBeUndefined();
    expect(asked("ನಾಳೆ ಬೆಂಗಳೂರಿನಿಂದ ಮೈಸೂರಿಗೆ ನನ್ನ second sitting ticket-ನ book ಮಾಡಿ.")).toBeUndefined();
  });

  it('does not read "कर दो" ("do it") as two', () => {
    expect(asked("मेरा टिकट बुक कर दो")).toBeUndefined();
    expect(asked("जल्दी से बुक कर दो टिकट चेन्नई की")).toBeUndefined();
  });

  it("gives nothing for one ticket, and the last count said wins", () => {
    expect(asked("एक टिकट बुक करो")).toBeUndefined();
    expect(asked("நாளைக்கு மதுரைக்கு தட்கல்ல ஒரு ஸ்லீப்பர் டிக்கெட்")).toBeUndefined();
    expect(asked("book two tickets", "no, three tickets")).toBe(3);
    expect(asked("book two tickets", "just one ticket is fine")).toBeUndefined();
    // Ends on a one: unclear, so no count rather than a wrong one.
    expect(asked("दो टिकट, एक टिकट मेरे लिए और एक टिकट रवि के लिए")).toBeUndefined();
  });
});

describe("passengerMismatch", () => {
  const two = ["book two tickets, one for me and one for Ravi Verma"];
  const facts = (people: string) => `Train Delhi–Varanasi Express (22923); Date Tue, 6 Oct, 2026; ${people}; Total ₹975`;

  it("says when the page lists fewer or more passengers than asked", () => {
    expect(passengerMismatch(two, facts("Passengers Asha Verma (34, Female)"))).toBe(
      "the user asked for 2 passengers, but the page lists 1 (Asha Verma (34, Female))",
    );
    expect(passengerMismatch(two, facts("Passengers Asha Verma (34, Female), Ravi Verma (36, Male), Meena Verma (8, Female)"))).toContain(
      "but the page lists 3",
    );
  });

  it("is quiet when they match, when no count was said, or when the page lists nobody it can count", () => {
    expect(passengerMismatch(two, facts("Passengers Asha Verma (34, Female), Ravi Verma (36, Male)"))).toBe("");
    expect(passengerMismatch(["book my ticket"], facts("Passengers Asha Verma (34, Female)"))).toBe("");
    expect(passengerMismatch(two, "Train Delhi–Varanasi Express (22923); Total ₹975")).toBe("");
    expect(passengerMismatch(two, facts("Passengers 1 Adult"))).toBe("");
  });
});
