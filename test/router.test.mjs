import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { AppError, buildRequest, classify, interpretResponse, validateInput, parsePublicOrigin, DEFAULT_MODEL, ENDPOINT } from "../router.mjs";
import { createApp } from "../server.mjs";
import { createUsageStore } from "../usage.mjs";

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

test("payment-required responses explain credits and billing without leaking provider details or retrying", async () => {
  for (const body of [null, "Payment Required", { detail: "Private account billing details" }]) {
    let calls = 0;
    await assert.rejects(classify({ prompt: "hello" }, { apiKey: "synthetic-test-key", model: DEFAULT_MODEL }, {
      fetch: async () => {
        calls++;
        return typeof body === "object"
          ? Response.json(body, { status: 402 })
          : new Response(body, { status: 402 });
      },
    }), (error) => {
      assert.equal(error.status, 402);
      assert.match(error.message, /insufficient credits or needs billing attention/);
      assert.match(error.message, /app owner/);
      assert.match(error.message, /https:\/\/console\.typesafe\.ai/);
      assert.doesNotMatch(error.message, /Private account|synthetic-test-key|Wait before trying/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("temporary rate limits are not described as exhausted credits", async () => {
  await assert.rejects(classify({ prompt: "hello" }, { apiKey: "synthetic-test-key", model: DEFAULT_MODEL }, {
    fetch: async () => Response.json({ detail: "Too many requests" }, { status: 429 }),
  }), (error) => {
    assert.equal(error.status, 429);
    assert.match(error.message, /rate limit/);
    assert.doesNotMatch(error.message, /credits|billing/);
    return true;
  });
});

async function withServer(t, overrides = {}) {
  const server = createApp({
    getConfig: async () => ({ apiKey: "", model: DEFAULT_MODEL, publicOrigin: "" }),
    usage: overrides.usage ?? createUsageStore(":memory:"),
    ...overrides,
  });
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
  assert.equal(JSON.parse(status).totalSubmissions, 0);
  assert.ok(!status.includes("do-not-expose"));
  assert.equal((await fetch(`${url}/.env`)).status, 404);
});

test("HTTP forwards the billing message through the UI's error response contract", async (t) => {
  const url = await withServer(t, {
    getConfig: async () => ({ apiKey: "synthetic-test-key", model: DEFAULT_MODEL }),
    classifyPrompt: (input, config) => classify(input, config, {
      fetch: async () => Response.json({ detail: "Private account details" }, { status: 402 }),
    }),
  });
  const response = await fetch(`${url}/api/classify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: '{"prompt":"Rewrite a sentence."}',
  });
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.match(body.error, /insufficient credits/);
  assert.doesNotMatch(body.error, /Private account/);
  assert.equal(body.recommendation, undefined);
});

test("HTTP rejects cross-site calls, malformed JSON, and invalid input", async (t) => {
  let count = 0;
  const url = await withServer(t, {
    getConfig: async () => ({ apiKey: "", model: DEFAULT_MODEL }),
    usage: {
      increment: (...args) => { assert.equal(args.length, 0); count++; },
      total: () => count,
      close() {},
    },
  });
  const post = (body, extra = {}) => fetch(`${url}/api/classify`, {
    method: "POST", headers: { "content-type": "application/json", ...extra }, body,
  });
  assert.equal((await post('{"prompt":"hello"}', { origin: "https://example.org" })).status, 403);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post('{"prompt":" "}')).status, 400);
  assert.equal((await post('{"prompt":"hello"}')).status, 503);
  assert.equal((await post("x".repeat(65537))).status, 413);
  assert.equal(count, 1);
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
  assert.equal((await (await fetch(`${url}/api/status`)).json()).totalSubmissions, 1);
});

async function usageFile() {
  const directory = await mkdtemp(join(tmpdir(), "jev-usage-http-test-"));
  return join(directory, "usage.sqlite");
}

test("HTTP counts successful and failed submissions without storing their text", async (t) => {
  const file = await usageFile();
  for (const succeeds of [true, false]) {
    const usage = createUsageStore(file);
    const url = await withServer(t, {
      getConfig: async () => ({}),
      usage,
      classifyPrompt: async () => {
        assert.equal(usage.total(), succeeds ? 1 : 2);
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
    assert.equal((await fetch(`${url}/usage.sqlite`)).status, 404);
    assert.equal((await (await fetch(`${url}/api/status`)).json()).totalSubmissions, succeeds ? 1 : 2);
  }
  const bytes = await readFile(file);
  for (const text of ["Successful submission", "Failed submission", "Example context"]) {
    assert.equal(bytes.includes(Buffer.from(text)), false);
  }
  t.after(() => rm(dirname(file), { recursive: true, force: true }));
});

test("counter write failure is visible and prevents a Jev call", async (t) => {
  const url = await withServer(t, {
    usage: {
      increment() { throw new AppError(503, "The submission counter is unavailable."); },
      total: () => 0,
      close() {},
    },
    classifyPrompt: async () => assert.fail("Jev must not be called if the count cannot be saved"),
  });
  const response = await fetch(`${url}/api/classify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "A valid prompt" }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /counter is unavailable/);
});

test("public origin configuration accepts only exact HTTPS origins", () => {
  assert.equal(parsePublicOrigin(""), "");
  assert.equal(parsePublicOrigin("https://demo.trycloudflare.com/"), "https://demo.trycloudflare.com");
  for (const origin of [
    "not a URL", "http://demo.trycloudflare.com", "https://*.trycloudflare.com",
    "https://user:password@demo.trycloudflare.com", "https://demo.trycloudflare.com/path",
    "https://demo.trycloudflare.com?query=1", "https://demo.trycloudflare.com#fragment",
  ]) {
    assert.throws(() => parsePublicOrigin(origin), /PUBLIC_ORIGIN/);
  }
});

// Node fetch rewrites Host, so use the HTTP client to reproduce proxy requests.
function proxyRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("tunnel host is blocked by default, including spoofed forwarding headers", async (t) => {
  const url = await withServer(t);
  const response = await proxyRequest(url, {
    headers: {
      host: "demo.trycloudflare.com", "x-forwarded-host": "localhost",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(response.status, 403);
});

test("configured tunnel accepts HTTPS same-origin submissions but not other origins or private files", async (t) => {
  const publicOrigin = "https://demo.trycloudflare.com";
  let calls = 0;
  const url = await withServer(t, {
    getConfig: async () => ({ apiKey: "not-exposed", model: DEFAULT_MODEL, publicOrigin }),
    classifyPrompt: async () => {
      calls++;
      return interpretResponse(fixture());
    },
  });
  const headers = { host: "demo.trycloudflare.com" };
  assert.equal((await proxyRequest(url, { headers })).status, 200);
  assert.equal((await fetch(url)).status, 200);
  const status = await proxyRequest(`${url}/api/status`, { headers });
  assert.equal(status.status, 200);
  assert.ok(!(await status.text()).includes("not-exposed"));
  for (const path of ["/.env", "/prompt-history.jsonl", "/usage.sqlite", "/usage.sqlite-journal", "/router.mjs"]) {
    assert.equal((await proxyRequest(`${url}${path}`, { headers })).status, 404);
  }
  const post = (origin, overrides = {}) => proxyRequest(`${url}/api/classify`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", origin, ...overrides },
    body: '{"prompt":"Rewrite a sentence."}',
  });
  assert.equal((await post(publicOrigin)).status, 200);
  assert.equal((await post(publicOrigin, { "sec-fetch-site": "same-origin" })).status, 200);
  for (const origin of ["https://other.trycloudflare.com", "http://demo.trycloudflare.com", url, "null"]) {
    assert.equal((await post(origin)).status, 403);
  }
  assert.equal((await post(publicOrigin, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await proxyRequest(url, { headers: { host: "other.trycloudflare.com" } })).status, 403);
  assert.equal(calls, 2);
});
