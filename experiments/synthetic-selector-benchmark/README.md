# Synthetic selector benchmark

This experiment measures whether a local selector chooses Hydra's low-, medium-, and high-complexity generation routes. It is deliberately separate from production selectors.

The fixed corpus in `cases.json` contains 30 labeled prompts: ten low, ten medium, and ten high. Every run adds the same long standing system policy and short irrelevant message history, allowing variants to compare full context against latest-user-only context. A selection counts as correct only when the selector returns a valid allowlisted result without Hydra fallback and that result matches the label.

Variants cover:

- Liquid LFM2.5 1.2B and Gemma 4 26B A4B selector models
- full context, latest user only, and latest user plus compact metadata
- zero-shot rubric and few-shot prompts
- direct slug output and JSON-Schema-constrained model, string-label, and numeric-label output
- deterministic sampling and Google's published Gemma 4 sampling defaults

The experiment is motivated by three primary sources:

- [Liquid's LFM2.5 1.2B documentation](https://docs.liquid.ai/lfm/models/lfm25-1.2b-instruct) describes a 1.2B instruction-tuned model with a 32K context window and native tool calling.
- [LM Studio's structured-output documentation](https://lmstudio.ai/docs/developer/openai-compat/structured-output) documents JSON Schema constraints for `/v1/chat/completions` and notes that its MLX engine uses Outlines.
- [Google's Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4) describes the 26B A4B MoE model and recommends `temperature=1.0`, `top_p=0.95`, and `top_k=64`.

## Run

Use a dedicated development home and listener so the experiment cannot touch Desktop Hydra:

```sh
export HYDRA_DEV_HOME="$HOME/.hydra-selector-benchmark"
export HYDRA_DEV_CODEX_HOME="$HOME/.codex-hydra-selector-benchmark"
export HYDRA_DEV_PORT=3858
npm run dev:setup
node experiments/synthetic-selector-benchmark/prepare.js
npm run dev:serve
node scripts/dev-hydra.js refresh
node experiments/synthetic-selector-benchmark/run.js \
  --base-url=http://127.0.0.1:3858 \
  --output=experiments/synthetic-selector-benchmark/results/latest.json
npm run dev:stop
```

Set `HYDRA_BENCH_LMSTUDIO_URL` before `prepare.js` when LM Studio is not at `http://127.0.0.1:11239`. Use `--variants=id-1,id-2` to run a subset and `--repeats=3` to check stability.

The runner rejects port 3847. Selector inference occurs inside the isolated Hydra worker; `/hydra/route` performs selection without running the chosen generation model.

## Interpretation

`formatValid` means the selector produced a parseable allowlisted choice and Hydra did not fall back. `correct` additionally requires the selected route to equal the labeled low, medium, or high route. A high score should therefore not hide malformed output that happened to fall back to the expected high model.

Committed result files record the exact corpus, variant settings, per-case output, fallback status, and latency so later model or LM Studio versions can be compared without changing the benchmark.

See [results/README.md](results/README.md) for the August 28, 2026 findings. The strongest Gemma variant reached 90/90 over three repeats; the strongest Liquid variant reached 84/90 and made only conservative upward-routing errors.
