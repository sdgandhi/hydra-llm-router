import test from "node:test";
import assert from "node:assert/strict";
import { ResponsesCommentaryTransform } from "../src/responses-commentary.js";

function runTransform(transform, headers, chunks) {
  const transformedHeaders = transform.headers(headers);
  const output = chunks.flatMap((chunk) => transform.write(Buffer.from(chunk)));
  output.push(...transform.end());
  return { headers: transformedHeaders, body: output.join("") };
}

test("prepends routing commentary to a JSON Responses result", () => {
  const transform = new ResponsesCommentaryTransform("Hydra routed this turn to gpt-test.");
  const response = { id: "resp_cloud", status: "completed", output: [] };
  const result = runTransform(
    transform,
    { "content-type": "application/json", "content-length": "10" },
    [JSON.stringify(response).slice(0, 12), JSON.stringify(response).slice(12)],
  );
  const body = JSON.parse(result.body);

  assert.equal(result.headers["content-length"], undefined);
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].phase, "commentary");
  assert.deepEqual(body.output[0].agent, { agent_name: "hydra-router" });
  assert.equal(body.output[0].content[0].text, "Hydra routed this turn to gpt-test.");
});

test("injects commentary first and shifts cloud stream indexes and sequence numbers", () => {
  const transform = new ResponsesCommentaryTransform("Hydra routed this turn to gpt-test.");
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_cloud",
      status: "completed",
      output: [{ id: "msg_answer", type: "message", role: "assistant", status: "completed", content: [] }],
    },
  };
  const upstream = [
    "event: response.in_progress\n",
    'data: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_cloud"}}\n\n',
    "event: response.output_item.done\n",
    'data: {"type":"response.output_item.done","sequence_number":2,"output_index":0,"item":{"id":"msg_answer"}}\n\n',
    `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const split = upstream.indexOf("response.completed") + 9;
  const result = runTransform(
    transform,
    { "content-type": "text/event-stream" },
    [upstream.slice(0, split), upstream.slice(split)],
  );

  assert.match(result.body, /"type":"response.output_item.added","output_index":0/);
  assert.match(result.body, /"type":"response.output_item.done","sequence_number":8,"output_index":1/);
  assert.match(result.body, /"phase":"commentary"/);
  assert.match(result.body, /"agent_name":"hydra-router"/);
  assert.ok(result.body.indexOf("response.output_text.delta") < result.body.indexOf("msg_answer"));

  const completedPayload = result.body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line))
    .find((event) => event.type === "response.completed");
  assert.equal(completedPayload.response.output.length, 2);
  assert.equal(completedPayload.response.output[0].phase, "commentary");
  assert.equal(completedPayload.response.output[1].id, "msg_answer");
});
