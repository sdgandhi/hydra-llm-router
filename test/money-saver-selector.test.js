import test from "node:test";
import assert from "node:assert/strict";
import moneySaver from "../src/selectors/money-saver.js";

const context = {
  messages: { latestUser: [{ text: "hello" }] },
  features: {
    nonSystemPromptTokens: 10,
    previousUserMessages: 2,
    previousAgentMessages: 1,
  },
};

async function withClassifierResult(content, callback) {
  const originalCall = globalThis.__hydraCallSelectorModel;
  let request;
  globalThis.__hydraCallSelectorModel = async (input) => {
    request = input;
    return content;
  };
  try {
    await callback(() => request);
  } finally {
    globalThis.__hydraCallSelectorModel = originalCall;
  }
}

for (const [score, model] of [
  [1, "lmstudio/liquid/lfm2.5-1.2b"],
  [2, "lmstudio/google/gemma-4-26b-a4b-qat"],
  [3, "gpt-5.6-sol"],
]) {
  test(`Money Saver maps classifier score ${score}`, async () => {
    await withClassifierResult(JSON.stringify({ selection: score }), async (getRequest) => {
      assert.equal(await moneySaver(context), score);
      const request = getRequest();
      assert.deepEqual(request.selectionSlugs, [
        "lmstudio/liquid/lfm2.5-1.2b",
        "lmstudio/google/gemma-4-26b-a4b-qat",
        "gpt-5.6-sol",
      ]);
      assert.ok(request.prompt.includes(`${score} = ${model}`));
      assert.equal(request.contextSummary.nonSystemPromptTokens, 10);
    });
  });
}

test("Money Saver rejects malformed or extra classifier output", async () => {
  for (const content of ["1", '{"selection":4}', '{"selection":1,"explanation":"simple"}']) {
    await withClassifierResult(content, async () => {
      await assert.rejects(moneySaver(context), (error) => error.code === "HYDRA_MONEY_SAVER_SCORE");
    });
  }
});
