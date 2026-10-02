# Spike 5: base Laya-multilingual on 50 yes/no replies (hi, ta, bn)

**Decision: NO-GO for the base model anywhere near confirmation. GO to keep Laya on the planned fine-tuning track** (dataset in Phase 1, fine-tune in Phase 3, adopt-or-drop at the end of Phase 4).

- Base `laya-multilingual` reads Indic scripts but scores 31/50 with **9 unsafe yeses**.
- The keyword gate scores 47/50 with 0 unsafe.
- The spike also exposed and fixed an **unsafe-yes bug in the keyword gate itself**.

- Data: `spikes/laya/utterances.yaml`, 50 replies to a payment confirmation.
  - 17 Hindi, 17 Tamil, 16 Bengali; labels yes / no / unclear.
  - Hand-written, including hard cases: "yes, but first…", "I don't know", polite stop, emphatic yes, romanised replies.
  - **Needs a native-speaker check** before Phase 1 reuses it.
- Baseline: `npx tsx spikes/laya/baseline.ts` (today's `yesNo()` in `packages/core/src/agent/safety.ts`).
- Laya: `spikes/laya/run_laya.py` (laya 0.3.24, ONNX Runtime 1.30, CPU, every reply pinned to the multilingual checkpoint).

## Keyword baseline

"Unsafe yes" means the gate heard yes when the user had not clearly said yes. It is the one error that can pay.

| | Before fix | After fix |
|---|---|---|
| Hindi | 14/17, 1 unsafe | 15/17, 0 unsafe |
| Tamil | 15/17, 1 unsafe | 17/17, 0 unsafe |
| Bengali | 13/16, 1 unsafe | 15/16, 0 unsafe |
| **All** | **42/50 (84%), 3 unsafe** | **47/50 (94%), 0 unsafe** |

**Bug found:** "हाँ लेकिन पहले सीट बताओ" ("yes, but first tell me the seat") and its Tamil and Bengali equivalents counted as **yes**, so Drishti would have paid while the user was asking a question.

**Fix (in `yesNo`):** a yes that comes with a hedge ("but / first / before / wait / how much / what" in all 11 languages) or a question mark is now *unclear*, so the gate asks again. The fix also adds "থামুন" (polite stop) to no and "கண்டிப்பா" (definitely) to yes. Tests are in `packages/core/test/safety.test.ts`.

The fix was designed after seeing this set, so 94% is optimistic. The Phase 1 dataset (11 languages, generated with Sarvam Translate plus spot checks) is the honest measure.

Remaining misses are all safe-direction (no versus unclear): "रुकिए, पहले दाम बताइए", "मुझे नहीं पता" and "জানি না" are read as no.

## Laya results (2026-10-02)

Setup:
- Base checkpoint, zero-shot, on this Mac's CPU.
- One `choice` question with three options (yes / no / unclear), with plain-English criteria.
- Install: `spikes/laya/.venv` (about 1.0 GB with PyTorch) plus the checkpoint in `~/.cache/huggingface`. The checkpoint download took about 76 s.

| | Laya base | Keyword gate (after fix) |
|---|---|---|
| Hindi | 10/17 (59%), **5 unsafe** | 15/17 (88%), 0 unsafe |
| Tamil | 9/17 (53%), **4 unsafe** | 17/17 (100%), 0 unsafe |
| Bengali | 12/16 (75%), 0 unsafe | 15/16 (94%), 0 unsafe |
| **All** | **31/50 (62%), 9 unsafe** | **47/50 (94%), 0 unsafe** |
| Latency | **24 ms p50** per reply | under 1 ms |

**What the misses show:**
- **Plain negations read as yes:** "मत करो" ("don't do it") → yes at 0.94, "nahi yaar, cancel karo" → yes, "நிறுத்துங்க" ("stop") → yes. This alone rules the base model out of any confirm decision.
- **Hedges read as yes:** "हाँ लेकिन पहले सीट बताओ", "முதல்ல விலை சொல்லுங்க", "शायद, सोचने दो". It almost never picks *unclear* for Indic text.
- **Romanised and colloquial yeses read as no:** "haan bhai kar do", "seri seri, pannunga", "haan, kore dao", "অবশ্যই করুন".
- **Indic scripts are read**, not ignored. Bengali was its best language (75%, no unsafe yes). I could not reproduce the community report of 100% failure on Bengali script, at least on this small set.
- **English sanity check is excellent:** "yes, go ahead" 0.99 yes, "no, cancel it" 0.91 no, "wait, how much is it?" 0.98 unclear. So the question schema works, and the gap is Indic and code-mixed language. Fine-tuning targets exactly that.

A runner bug was caught and fixed along the way: PyYAML (YAML 1.1) parses bare `yes`/`no` as booleans. Labels in `utterances.yaml` are now quoted. The first run's "6/50" was this bug, not the model.

## Implication

The deterministic gate is now at 0 unsafe on this set, and stays the authority. Laya can only ever **add** a confirmation, never remove one. At 24 ms on CPU, speed is not the problem; accuracy on Indic and code-mixed speech is.

**Phase 1 dataset priorities**, from the misses:
- negations ("मत करो", "நிறுத்துங்க");
- romanised and code-mixed replies;
- hedged yeses;
- "I don't know"-style replies.

Re-run this exact script on the fine-tuned checkpoint in Phase 3 for a like-for-like comparison.
