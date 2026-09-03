# Metron benchmark

This standalone module is repository tooling, not part of the Hydra application package. Every run is selected by an explicit, committed JSON configuration:

```sh
node benchmark/run.js --config benchmark/configs/v1.json
```

The v1 configuration uses the isolated Hydra development server on port 3857 and writes one immutable directory beneath `benchmark/runs/`. Each run contains its config snapshot, environment metadata, raw Codex JSON events, per-case results, and aggregate summary. Prompts and outputs are deliberately retained in benchmark artifacts; normal Metron telemetry remains content-free.

Start or refresh the isolated server before a real run. This uses the committed benchmark Hydra configuration, disposable runtime data, and port 3857; it does not modify the normal or saved development Hydra homes:

```sh
node benchmark/hydra.js refresh
node benchmark/hydra.js serve
```

The app build copies `src/`, its runtime dependency, and selected vendor assets only. It does not copy this directory.
