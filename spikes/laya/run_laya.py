"""
Spike 5: base (not fine-tuned) laya-multilingual on the 50 confirmation replies.

Not run yet: needs `pip install "laya[onnx]"` (pulls PyTorch) and downloads the
convaiinnovations/laya-multilingual checkpoint from Hugging Face on first use.

    python3 -m venv spikes/laya/.venv && spikes/laya/.venv/bin/pip install "laya[onnx]" pyyaml
    spikes/laya/.venv/bin/python spikes/laya/run_laya.py

Writes spikes/laya/results/laya.json in the same shape as baseline.json so the two compare.
"""
import json
import pathlib
import time

import yaml
from laya import Router

HERE = pathlib.Path(__file__).parent
rows = yaml.safe_load((HERE / "utterances.yaml").read_text())

QUESTION = {
    "confirm": {
        "type": "choice",
        "instructions": "Drishti asked the user to confirm a payment. Did the user clearly say yes, clearly say no, or neither?",
        "criteria": {
            "yes": "clearly agrees to go ahead now, with no condition or question",
            "no": "refuses, cancels, or tells Drishti to stop or wait",
            "unclear": "asks a question, adds a condition, hesitates, or says something else",
        },
    }
}

router = Router()  # routes non-Latin scripts to laya-multilingual
by_lang, misses, latencies = {}, [], []
for r in rows:
    t0 = time.perf_counter()
    out = router.predict({"body": r["text"]}, QUESTION)
    latencies.append((time.perf_counter() - t0) * 1000)
    ans = out["answers"]["confirm"]
    got, probs = ans["choice"], ans.get("probabilities", {})
    s = by_lang.setdefault(r["lang"], {"n": 0, "ok": 0, "unsafe": 0})
    s["n"] += 1
    s["ok"] += got == r["label"]
    s["unsafe"] += got == "yes" and r["label"] != "yes"
    if got != r["label"]:
        misses.append(f'{r["lang"]} "{r["text"]}" -> {got} {probs} (want {r["label"]})')

total = {k: sum(s[k] for s in by_lang.values()) for k in ("n", "ok", "unsafe")}
for lang, s in by_lang.items():
    print(f'{lang}: {s["ok"]}/{s["n"]} ({round(100 * s["ok"] / s["n"])}%), unsafe yes: {s["unsafe"]}')
latencies.sort()
print(f'all: {total["ok"]}/{total["n"]}, unsafe yes: {total["unsafe"]}, p50 {latencies[len(latencies) // 2]:.0f} ms on CPU')
(HERE / "results").mkdir(exist_ok=True)
(HERE / "results/laya.json").write_text(json.dumps({"byLang": by_lang, "total": total, "misses": misses, "p50ms": latencies[len(latencies) // 2]}, ensure_ascii=False, indent=2))
