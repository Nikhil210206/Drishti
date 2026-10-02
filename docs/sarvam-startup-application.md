# Sarvam Startup Program application (draft)

A draft for you to adapt and submit yourself. Numbers are from the repo as of 2026-10-02; check them before sending.

**Product:** Drishti (दृष्टि), a voice-first web agent for blind and low-vision Indians. You say what you want in any of 11 Indian languages. Drishti operates the website for you, reads options and documents back in your language, and asks for a spoken "yes" before anything irreversible.

**Stage:**
- Working prototype built for the Sarvam buildathon (submitted 2026-09-26).
- Now in a 16-week build to a public 1.0: a free Chrome and Edge extension, with a beta for blind testers through NGOs from late December 2026.
- Open source (Apache-2.0): github.com/Nikhil210206/Drishti

**How it uses Sarvam (every stage of the loop):**
- Saaras v4 realtime STT with automatic language detection and station-name keyterms.
- Sarvam-105B as the tool-calling browser agent.
- Bulbul v3 streaming TTS.
- Sarvam Vision (Doc AI) to read bills and letters.
- Mayura and Sarvam Translate to read pages aloud in the user's language.

**Why credits matter:** the product is free for blind users, and the build has a ₹0 hosting budget.
- A booking task costs about ₹1–3 in API calls today. The Phase 1 target is ≤ ₹1.
- Credits let testers and early users use Drishti at no cost while we get there.
- A free fallback tier (browser speech plus screen-reader output) covers users when credits run out.

**Ask:**
1. Startup Program credits for 6–12 months.
2. **Higher rate limits.** The Starter tier's 40 LLM requests/minute, shared across all users, caps us at roughly 10 concurrent users (about 4 LLM calls per user per minute during a task).

**Safety and privacy:**
- A deterministic confirmation gate before pay, submit, send or delete.
- Passwords, OTPs, card numbers and Aadhaar are never typed.
- An allowlisted navigation policy.
- Page content and documents are never stored on our servers. The relay only forwards requests.

**Contact:** Nikhil, nikhilbalamurugan@gmail.com
