# Spike 5: base Laya-multilingual on 50 yes/no replies (hi, ta, bn)

**Decision: pending the Laya run, which needs your OK for a large download.** The keyword baseline it has to beat is measured, and the spike already paid off: it exposed and fixed an **unsafe-yes bug in the safety gate**.

- Data: `spikes/laya/utterances.yaml`, 50 replies to a payment confirmation.
  - 17 Hindi, 17 Tamil, 16 Bengali; labels yes / no / unclear.
  - Hand-written, including hard cases: "yes, but first…", "I don't know", polite stop, emphatic yes, romanised replies.
  - **Needs a native-speaker check** before Phase 1 reuses it.
- Baseline: `npx tsx spikes/laya/baseline.ts` (today's `yesNo()` in `packages/core/src/agent/safety.ts`).
- Laya: `spikes/laya/run_laya.py`, written but not run.

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

## Laya run (not done yet)

It needs `pip install "laya[onnx]"`, which pulls PyTorch, and the `convaiinnovations/laya-multilingual` checkpoint (322M parameters) from Hugging Face. That is likely 1–2 GB of downloads in total.

Command once approved:

```
python3 -m venv spikes/laya/.venv && spikes/laya/.venv/bin/pip install "laya[onnx]" pyyaml
spikes/laya/.venv/bin/python spikes/laya/run_laya.py
```

Gate for this spike: compare against the baseline above. The **adoption** gate stays as planned for Phase 4: ≥95% on control and confirm in *every* one of the 11 languages, zero unsafe yes, and an acceptable runtime footprint. The base model is expected near chance (the README cites 0.36 zero-shot versus 0.77 fine-tuned). The point of this run is to see whether Indic scripts are read at all; community reports say Bengali failed.

## Implication

The deterministic gate is now at 0 unsafe on this set. Laya can only ever **add** a confirmation, never remove one. Its value is mostly in the command router and in cutting LLM fallbacks, not in confirm safety.
