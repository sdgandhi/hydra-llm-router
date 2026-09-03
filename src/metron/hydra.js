import { randomUUID } from "node:crypto";

export const METRON_RESPONSE_OBSERVER = Symbol("metronResponseObserver");

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputDetails = value.input_tokens_details ?? value.prompt_tokens_details ?? {};
  const outputDetails = value.output_tokens_details ?? value.completion_tokens_details ?? {};
  const usage = {
    input_tokens: finiteNumber(value.input_tokens ?? value.prompt_tokens),
    cached_input_tokens: finiteNumber(inputDetails.cached_tokens),
    output_tokens: finiteNumber(value.output_tokens ?? value.completion_tokens),
    reasoning_output_tokens: finiteNumber(outputDetails.reasoning_tokens),
    total_tokens: finiteNumber(value.total_tokens),
  };
  return Object.values(usage).some((item) => item != null) ? usage : null;
}

function responseUsage(payload) {
  return normalizedUsage(payload?.response?.usage ?? payload?.usage);
}

function responseStatus(payload) {
  return payload?.response?.status ?? payload?.status ?? null;
}

function outputKind(type) {
  if (type === "response.output_text.delta") return "text";
  if (type === "response.reasoning_summary_text.delta") return "reasoning_summary";
  if (type === "response.function_call_arguments.delta") return "function_call";
  if (type === "response.custom_tool_call_input.delta") return "custom_tool_call";
  return null;
}

function sessionIdFromRequest(req) {
  const value = req?.headers?.["session-id"] ?? req?.headers?.["x-session-id"];
  return Array.isArray(value) ? value[0] : value ?? null;
}

export function createMetronEmitter(store, { onError = () => {} } = {}) {
  let pending = Promise.resolve();
  return {
    emit(event) {
      if (!store) return Promise.resolve(null);
      pending = pending.then(() => store.emit(event)).catch((error) => {
        onError(error);
        return null;
      });
      return pending;
    },
    flush() {
      return pending;
    },
  };
}

export function createHydraTelemetry({ store, clock = () => new Date(), idFactory = randomUUID, onError } = {}) {
  const emitter = createMetronEmitter(store, { onError });

  function now() {
    return clock();
  }

  function beginGeneration({
    req,
    res,
    requestedModel,
    targetModel = requestedModel,
    provider,
    syntheticModel = null,
    phase = "direct",
    attempt = 1,
  }) {
    const generationId = idFactory();
    const sessionId = sessionIdFromRequest(req);
    const startedAt = now();
    let firstOutputAt = null;
    let usage = null;
    let observedStatus = null;
    let finished = false;

    const common = {
      source: "hydra",
      sessionId,
      generationId,
      completeness: "exact",
    };

    const observer = {
      event(type, payload) {
        const kind = outputKind(type);
        if (kind && firstOutputAt == null) {
          firstOutputAt = now();
          void emitter.emit({
            ...common,
            type: "generation.first_output",
            occurredAt: firstOutputAt,
            data: {
              kind,
              latency_ms: firstOutputAt.valueOf() - startedAt.valueOf(),
            },
          });
        }
        usage = responseUsage(payload) ?? usage;
        observedStatus = responseStatus(payload) ?? observedStatus;
      },
      json(payload) {
        usage = responseUsage(payload) ?? usage;
        observedStatus = responseStatus(payload) ?? observedStatus;
        if (firstOutputAt == null && (payload?.output?.length ?? 0) > 0) {
          firstOutputAt = now();
        }
      },
    };
    if (res) res[METRON_RESPONSE_OBSERVER] = observer;

    void emitter.emit({
      ...common,
      type: "generation.started",
      occurredAt: startedAt,
      data: {
        requested_model: requestedModel,
        target_model: targetModel,
        provider,
        synthetic_model: syntheticModel,
        phase,
        attempt,
      },
    });

    return {
      generationId,
      async finish(status = "completed", data = {}) {
        if (finished) return;
        finished = true;
        if (res?.[METRON_RESPONSE_OBSERVER] === observer) delete res[METRON_RESPONSE_OBSERVER];
        const completedAt = now();
        await emitter.emit({
          ...common,
          type: "generation.completed",
          occurredAt: completedAt,
          data: {
            requested_model: requestedModel,
            target_model: targetModel,
            provider,
            synthetic_model: syntheticModel,
            phase,
            attempt,
            status: status === "completed" ? observedStatus ?? status : status,
            duration_ms: completedAt.valueOf() - startedAt.valueOf(),
            time_to_first_output_ms: firstOutputAt == null
              ? null
              : firstOutputAt.valueOf() - startedAt.valueOf(),
            usage,
            ...data,
          },
        });
      },
    };
  }

  async function routeDecision({ req, requestedModel, selectedModel, fallback, stickyReuse, selectorDurationMs }) {
    await emitter.emit({
      source: "hydra",
      type: "route.decision",
      sessionId: sessionIdFromRequest(req),
      completeness: "exact",
      data: {
        requested_model: requestedModel,
        selected_model: selectedModel,
        fallback: Boolean(fallback),
        sticky_reuse: Boolean(stickyReuse),
        selector_duration_ms: finiteNumber(selectorDurationMs),
      },
    });
  }

  return { beginGeneration, routeDecision, flush: () => emitter.flush() };
}

export function observeMetronSse(res, event, data) {
  res?.[METRON_RESPONSE_OBSERVER]?.event(event, data);
}

export function observeMetronJson(res, data) {
  res?.[METRON_RESPONSE_OBSERVER]?.json(data);
}
