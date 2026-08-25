import test from "node:test";
import assert from "node:assert/strict";
import moneySaver from "../src/selectors/money-saver.js";

const context = {
  providers: { lmstudio: { baseUrl: "http://127.0.0.1:11239" } },
  messages: { latestUser: [{ text: "hello" }] },
  features: { actualContextTokens: 10 },
  candidates: [],
  machine: {},
};

async function withClassifierResult(content, callback) {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await callback(() => request);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const [score, model] of [
  [1, "lmstudio/liquid/lfm2.5-1.2b"],
  [2, "lmstudio/google/gemma-4-26b-a4b-qat"],
  [3, "gpt-5.6-sol"],
]) {
  test(`Money Saver maps classifier score ${score}`, async () => {
    await withClassifierResult(JSON.stringify({ score }), async (getRequest) => {
      assert.equal(await moneySaver(context), model);
      const request = getRequest();
      assert.equal(request.url, "http://127.0.0.1:11239/v1/chat/completions");
      assert.equal(request.body.reasoning_effort, "none");
      assert.equal(request.body.chat_template_kwargs.enable_thinking, false);
      assert.equal(request.body.response_format.json_schema.schema.properties.score.enum.length, 3);
    });
  });
}

test("Money Saver rejects malformed or extra classifier output", async () => {
  for (const content of ["1", '{"score":4}', '{"score":1,"explanation":"simple"}']) {
    await withClassifierResult(content, async () => {
      await assert.rejects(moneySaver(context), (error) => error.code === "HYDRA_MONEY_SAVER_SCORE");
    });
  }
});
