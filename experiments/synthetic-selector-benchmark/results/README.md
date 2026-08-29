# Results: 2026-08-28

The experiment ran 930 selector calls through isolated development Hydra on port 3858. LM Studio exposed `liquid/lfm2.5-1.2b` and `google/gemma-4-26b-a4b-qat`; both were already loaded. The corpus contains ten low-, ten medium-, and ten high-complexity cases.

The JSON files in this directory contain the complete variant configuration, corpus snapshot, per-case route, fallback status, and measured latency. The table below highlights the most informative results; 25 distinct variants were tested.

| Variant | Correct | Valid format | Low | Medium | High | Mean latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Gemma, latest user, class JSON, `temperature=0` | 90/90 | 90/90 | 30/30 | 30/30 | 30/30 | 407 ms |
| Gemma, latest user, class JSON, Google sampling | 30/30 | 30/30 | 10/10 | 10/10 | 10/10 | 394 ms |
| Gemma, full context, class JSON | 29/30 | 30/30 | 10/10 | 9/10 | 10/10 | 1783 ms |
| Gemma, full context, direct slug | 10/30 | 30/30 | 10/10 | 0/10 | 0/10 | 1847 ms |
| Liquid, latest user, boundary examples, class JSON | 84/90 | 90/90 | 24/30 | 30/30 | 30/30 | 384 ms |
| Liquid, latest user, boundary rubric, class JSON | 27/30 | 30/30 | 9/10 | 8/10 | 10/10 | 364 ms |
| Liquid, latest user, base rubric, class JSON | 23/30 | 30/30 | 6/10 | 7/10 | 10/10 | 347 ms |
| Liquid, full context, class JSON | 11/30 | 30/30 | 0/10 | 10/10 | 1/10 | 722 ms |
| Liquid, full context, direct slug baseline | 8/30 | 28/30 | 8/10 | 0/10 | 0/10 | 699 ms |
| Liquid, latest user, direct slug | 1/30 | 2/30 | 1/10 | 0/10 | 0/10 | 417 ms |

“Google sampling” is `temperature=1.0`, `top_p=0.95`, and `top_k=64`. Its single 30-case run tied deterministic Gemma, but only deterministic Gemma received the three-repeat stability run.

## Findings

1. **Use a constrained class label, then map it to a slug.** LM Studio JSON Schema made every structured variant parseable, including Liquid. Asking Liquid to emit one of three long slugs directly was substantially worse. Even constrained model-slug JSON reached only 12/30, while constrained LOW/MEDIUM/HIGH JSON reached 23/30 before prompt calibration.
2. **Send only the latest user message for this classifier.** With the same base rubric and class schema, Liquid improved from 11/30 with full context to 23/30 with only the latest user message, while mean latency fell from 722 ms to 347 ms. Gemma improved from 29/30 to 30/30 and fell from 1783 ms to about 400 ms.
3. **Do not send generic token/capability metadata unless the rubric uses it.** Liquid's latest-user-plus-metadata class variant scored 20/30 versus 23/30 without metadata. The metadata shifted all low tasks into the medium tier in that run.
4. **Small-model calibration is brittle.** Liquid reached 28/30 after adding boundary examples, but a more detailed “calibrated” rubric collapsed to 10/30 by selecting LOW for everything. Binary cascades and asking for a written reason also underperformed. More instructions were not reliably better.
5. **Liquid's best errors were conservative.** Across the 90-call stability run, its six errors were the same two low-complexity cases routed upward; it classified every medium and high case correctly. That may be acceptable for a cost-saving router, but it is not perfect.
6. **Gemma is the recommended selector for accuracy.** Latest-user-only, class JSON, thinking disabled, and `temperature=0` achieved 90/90. The Google sampling defaults also achieved 30/30 once, so deterministic sampling is preferable here because it has the stronger stability evidence and removes sampling variance.

## Recommendation

For the production prompt-router template, the evidence favors:

- selector model: `lmstudio/google/gemma-4-26b-a4b-qat`
- selector context: latest user message only
- output: JSON Schema with enum `low | medium | high`, mapped to configured model slugs after parsing
- thinking: disabled
- sampling: `temperature=0`
- fallback: keep the strongest cloud model for malformed output or selector failure

For a lower-cost Liquid selector, use the boundary-example class-JSON variant and accept conservative over-routing of a small fraction of trivial prompts. The 28/30 single-run result and 84/90 stability result are benchmark-calibrated; they should be validated on an unseen holdout set before replacing the existing selector.
