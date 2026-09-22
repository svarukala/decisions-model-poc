import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, buildRequest, classify, interpretResponse, validateInput, DEFAULT_MODEL, ENDPOINT } from "../router.mjs";
import { createApp } from "../server.mjs";
import { savePrompt } from "../history.mjs";

function fixture(choice = "chat") {
  return {
    model: DEFAULT_MODEL,
    answers: {
      route: {
        type: "choice", choice, confidence: 0.85,
        probabilities: choice === "chat" ? { chat: 0.9, cowork: 0.05, unsure: 0.05 } : { chat: 0.05, cowork: 0.9, unsure: 0.05 },
      },
      execution: { type: "noul", noul: choice === "cowork" ? 0.9 : 0.1 },
      missing_context: { type: "noul", noul: 0.05 },
    },
    usage: { input_tokens: 450, output_tokens: 30 },
  };
}

test("input validation rejects empty, oversized and malformed input", () => {
  for (const value of [null, [], {}, { prompt: " " }, { prompt: 2 }, { prompt: "a".repeat(8001) }, { prompt: "a", context: 2 }, { prompt: "a", context: "a".repeat(3001) }]) {
    assert.throws(() => validateInput(value), AppError);
  }
  assert.deepEqual(validateInput({ prompt: " hello " }), { prompt: "hello", context: "" });
});

test("rubric preserves context and separates instructions from user data", () => {
  const request = buildRequest({ prompt: "yes", context: "Update the tracker" }, DEFAULT_MODEL);
  assert.equal(request.state.previous_context, "Update the tracker");
  assert.equal(request.questions.route.type, "choice");
  assert.match(request.questions.route.instructions, /untrusted/);
  assert.deepEqual(Object.keys(request.questions.route.criteria), ["chat", "cowork", "unsure"]);
});

test("clear Chat and Cowork responses produce recommendations", () => {
  for (const route of ["chat", "cowork"]) {
    const result = interpretResponse(fixture(route));
    assert.equal(result.recommendation, route);
    assert.equal(result.model, DEFAULT_MODEL);
    assert.equal(result.usage.inputTokens, 450);
  }
});

test("ambiguous, missing-context and contradictory signals abstain", () => {
  const ambiguous = fixture();
  ambiguous.answers.route.probabilities = { chat: 0.5, cowork: 0.3, unsure: 0.2 };
  assert.equal(interpretResponse(ambiguous).recommendation, "unsure");
  const missing = fixture();
  missing.answers.missing_context.noul = 0.8;
  assert.equal(interpretResponse(missing).recommendation, "unsure");
  const contradiction = fixture();
  contradiction.answers.execution.noul = 0.9;
  assert.equal(interpretResponse(contradiction).recommendation, "unsure");
  const explicit = fixture();
  explicit.answers.route.choice = "unsure";
  explicit.answers.route.probabilities = { chat: 0.05, cowork: 0.05, unsure: 0.9 };
  assert.equal(interpretResponse(explicit).recommendation, "unsure");
});

test("malformed provider results never become recommendations", () => {
  for (const value of [null, {}, { answers: {} }]) assert.throws(() => interpretResponse(value), AppError);
  const invalid = fixture();
  invalid.answers.route.probabilities.chat = 2;
  assert.throws(() => interpretResponse(invalid), AppError);
  const inconsistent = fixture();
  inconsistent.answers.route.choice = "cowork";
  assert.throws(() => interpretResponse(inconsistent), AppError);
});

test("real SDK serializes the request for the real endpoint with auth", async () => {
  let calls = 0;
  const result = await classify({ prompt: "Rewrite a sentence." }, { apiKey: "synthetic-test-key", model: DEFAULT_MODEL }, {
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, ENDPOINT);
      assert.equal(init.method, "POST");
      assert.ok(new Headers(init.headers).get("authorization").includes("synthetic-test-key"));
      const body = JSON.parse(init.body);
      assert.equal(body.state.user_prompt, "Rewrite a sentence.");
      assert.equal(body.model, DEFAULT_MODEL);
      assert.equal(body.questions.route.type, "choice");
      return Response.json(fixture());
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.recommendation, "chat");
});

test("missing key fails without making a network request", async () => {
  await assert.rejects(classify({ prompt: "hello" }, { apiKey: "", model: DEFAULT_MODEL }, {
    fetch: () => assert.fail("Must not call Jev without a key"),
  }), (error) => error.status === 503);
});

test("provider authentication, throttling and server errors are explicit and not retried", async () => {
  for (const [upstream, expected] of [[401, 502], [403, 502], [429, 429], [500, 502]]) {
    let calls = 0;
    await assert.rejects(classify({ prompt: "hello" }, { apiKey: "synthetic-test-key", model: DEFAULT_MODEL }, {
      fetch: async () => {
        calls++;
        return Response.json({ message: "secret provider detail" }, { status: upstream });
      },
    }), (error) => error.status === expected && !error.message.includes("secret provider detail"));
    assert.equal(calls, 1);
  }
});

async function withServer(t, overrides = {}) {
  const server = createApp({ recordPrompt: async () => {}, ...overrides });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP serves UI and status without exposing configuration secrets", async (t) => {
  const url = await withServer(t, { getConfig: async () => ({ apiKey: "do-not-expose", model: DEFAULT_MODEL }) });
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ask Jev/);
  const status = await (await fetch(`${url}/api/status`)).text();
  assert.equal(JSON.parse(status).configured, true);
  assert.ok(!status.includes("do-not-expose"));
  assert.equal((await fetch(`${url}/.env`)).status, 404);
});

test("HTTP rejects cross-site calls, malformed JSON, and invalid input", async (t) => {
  const recorded = [];
  const url = await withServer(t, {
    getConfig: async () => ({ apiKey: "", model: DEFAULT_MODEL }),
    recordPrompt: async (input) => recorded.push(input),
  });
  const post = (body, extra = {}) => fetch(`${url}/api/classify`, {
    method: "POST", headers: { "content-type": "application/json", ...extra }, body,
  });
  assert.equal((await post('{"prompt":"hello"}', { origin: "https://example.org" })).status, 403);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post('{"prompt":" "}')).status, 400);
  assert.equal((await post('{"prompt":"hello"}')).status, 503);
  assert.equal((await post("x".repeat(65537))).status, 413);
  assert.deepEqual(recorded, [{ prompt: "hello", context: "" }]);
});

test("HTTP returns classification and guards simultaneous requests", async (t) => {
  let complete;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const url = await withServer(t, {
    getConfig: async () => ({}),
    classifyPrompt: async () => {
      started();
      await new Promise((resolve) => { complete = resolve; });
      return interpretResponse(fixture());
    },
  });
  const post = () => fetch(`${url}/api/classify`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"prompt":"hello"}',
  });
  const first = post();
  await waiting;
  assert.equal((await post()).status, 429);
  complete();
  assert.equal((await (await first).json()).recommendation, "chat");
});

async function historyFile(t) {
  const directory = await mkdtemp(join(tmpdir(), "jev-history-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "prompt-history.jsonl");
}

test("history appends valid JSON lines, preserves multiline content, and excludes extra fields", async (t) => {
  const file = await historyFile(t);
  await savePrompt({ prompt: 'First line\n"Second line"', context: "Prior\ncontext", apiKey: "not-for-history" }, file);
  await savePrompt({ prompt: "Another prompt", context: "" }, file);
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  const entries = lines.map((line) => JSON.parse(line));
  assert.equal(entries[0].prompt, 'First line\n"Second line"');
  assert.equal(entries[0].context, "Prior\ncontext");
  assert.equal(new Date(entries[0].timestamp).toISOString(), entries[0].timestamp);
  assert.deepEqual(Object.keys(entries[0]), ["timestamp", "prompt", "context"]);
  assert.equal(entries[1].prompt, "Another prompt");
});

test("HTTP persists prompts before both successful and failed classification across server instances", async (t) => {
  const file = await historyFile(t);
  for (const succeeds of [true, false]) {
    const url = await withServer(t, {
      getConfig: async () => ({}),
      recordPrompt: (input) => savePrompt(input, file),
      classifyPrompt: async (input) => {
        assert.ok((await readFile(file, "utf8")).includes(input.prompt));
        if (!succeeds) throw new AppError(502, "Synthetic Jev failure.");
        return interpretResponse(fixture());
      },
    });
    const response = await fetch(`${url}/api/classify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: succeeds ? "Successful submission" : "Failed submission", context: "Example context" }),
    });
    assert.equal(response.status, succeeds ? 200 : 502);
    assert.equal((await fetch(`${url}/prompt-history.jsonl`)).status, 404);
  }
  const entries = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry.prompt), ["Successful submission", "Failed submission"]);
});

test("history write failure is visible and prevents a Jev call", async (t) => {
  const file = await historyFile(t);
  const url = await withServer(t, {
    recordPrompt: (input) => savePrompt(input, join(file, "unavailable.jsonl")),
    classifyPrompt: async () => assert.fail("Jev must not be called if history cannot be saved"),
  });
  const response = await fetch(`${url}/api/classify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "A valid prompt" }),
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Could not save prompt-history/);
});
