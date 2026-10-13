import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { AppError, DEFAULT_MODEL, ENDPOINT, invokeJev, readConfig } from "../router.mjs";
import {
  CATALOG, SIGNALS, advisorStatus, buildAdvisorRequest, compareArchitectures,
  decisionEndpoint, interpretAdvisorResponse, invokeDecision,
} from "../advisor.mjs";
import { createApp } from "../server.mjs";
import { createUsageStore } from "../usage.mjs";

const config = {
  apiKey: "synthetic-jev-key", model: DEFAULT_MODEL,
  foundryEndpoint: "https://synthetic.services.ai.azure.com/",
  decisionDeployment: "my-decision-deployment", foundryApiKey: "synthetic-foundry-key",
};
const input = { prompt: "Build a reusable Cowork skill and MCP integration.", context: "Internal account managers." };
function fixture(choice = "cowork_plugin") {
  return {
    model: "synthetic-model",
    answers: {
      architecture: {
        type: "choice", choice,
        probabilities: Object.fromEntries(Object.keys(CATALOG).map((key) => [key, key === choice ? 0.92 : 0.01])),
      },
      ...Object.fromEntries(Object.keys(SIGNALS).map((key) => [key, { type: "noul", noul: 0.05 }])),
    },
    usage: { input_tokens: 123, output_tokens: 45 },
  };
}

test("advisor rubric covers all approved paths and Agent Builder distinctions", () => {
  const request = buildAdvisorRequest(input);
  assert.deepEqual(request.state, { scenario: input.prompt, requirements: input.context });
  assert.deepEqual(Object.keys(request.questions.architecture.criteria), [
    "declarative", "standard", "github_harness", "foundry_prompt", "foundry_hosted",
    "cowork_plugin", "workflow", "existing", "unsure",
  ]);
  assert.match(request.questions.architecture.instructions, /untrusted/);
  assert.match(request.questions.architecture.instructions, /Agent Builder limitations/);
  assert.match(CATALOG.cowork_plugin.criteria, /MCP/);
  assert.match(advisorStatus(config).reference, /AgentPlatformAdvisor/);
});

test("optional confidence and real model/usage are preserved without forcing a rationale", () => {
  for (const choice of Object.keys(CATALOG)) {
    const result = interpretAdvisorResponse(fixture(choice));
    assert.equal(result.recommendation, choice);
    assert.equal(result.confidence, null);
    assert.equal(result.model, "synthetic-model");
    assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45 });
  }
});

test("missing, malformed, mismatched and nonfinite outputs never become recommendations", () => {
  for (const bad of [null, {}, { answers: null }]) assert.throws(() => interpretAdvisorResponse(bad), AppError);
  for (const mutate of [
    (value) => { value.answers.architecture.choice = "nonexistent"; },
    (value) => { value.answers.architecture.choice = "standard"; },
    (value) => { value.answers.architecture.probabilities.cowork_plugin = NaN; },
    (value) => { value.answers.architecture.probabilities.extra = 0; },
    (value) => { value.answers.architecture.probabilities.cowork_plugin = 0.3; },
    (value) => { delete value.answers.architecture.probabilities.unsure; },
    (value) => { value.answers.architecture.confidence = 2; },
    (value) => { value.answers.missing_context.noul = "0.1"; },
    (value) => { delete value.answers.custom_runtime; },
    (value) => { value.model = ""; },
  ]) {
    const bad = fixture();
    mutate(bad);
    assert.throws(() => interpretAdvisorResponse(bad), AppError);
  }
});

test("abstention thresholds and signal conflicts preserve the raw choice", () => {
  for (const [signal, probability] of [["missing_context", 0.65], ["custom_runtime", 0.8]]) {
    const response = fixture();
    response.answers[signal].noul = probability;
    const result = interpretAdvisorResponse(response);
    assert.equal(result.recommendation, "unsure");
    assert.equal(result.modelChoice, "cowork_plugin");
    assert.ok(result.policyReasons.length);
  }
  const conflict = fixture("standard");
  conflict.answers.cowork_extension.noul = 0.8;
  assert.equal(interpretAdvisorResponse(conflict).recommendation, "unsure");
  const weak = fixture();
  weak.answers.architecture.probabilities.cowork_plugin = 0.64;
  weak.answers.architecture.probabilities.standard = 0.29;
  assert.equal(interpretAdvisorResponse(weak).recommendation, "unsure");
  weak.answers.architecture.probabilities.cowork_plugin = 0.65;
  weak.answers.architecture.probabilities.standard = 0.28;
  assert.equal(interpretAdvisorResponse(weak).recommendation, "cowork_plugin");
  const missing = fixture();
  missing.answers.missing_context.noul = 0.649;
  assert.equal(interpretAdvisorResponse(missing).recommendation, "cowork_plugin");
  const component = fixture();
  component.answers.workflow_component.noul = 0.75;
  assert.equal(interpretAdvisorResponse(component).supportingComponents.length, 1);
});

test("Decision-1 requires complete configuration and an HTTPS resource origin", async () => {
  for (const key of ["foundryEndpoint", "decisionDeployment", "foundryApiKey"]) {
    await assert.rejects(invokeDecision({}, { ...config, [key]: "" }, () => assert.fail("No network call")), AppError);
  }
  for (const endpoint of ["invalid", "http://example.org", "https://example.org/api/projects/test", "https://user:pass@example.org", "https://example.org/?secret=a", "https://example.org/#x"]) {
    assert.throws(() => decisionEndpoint({ ...config, foundryEndpoint: endpoint }), AppError);
    assert.equal(advisorStatus({ ...config, foundryEndpoint: endpoint }).providers.decision.configured, false);
  }
});

test("both real transports send the same state and questions, with provider-specific model and auth", async () => {
  const bodies = {};
  const result = await compareArchitectures(input, config, {
    jev: (request, settings) => invokeJev(request, settings, {
      fetch: async (url, init) => {
        assert.equal(url, ENDPOINT);
        assert.match(new Headers(init.headers).get("authorization"), /synthetic-jev-key/);
        bodies.jev = JSON.parse(init.body);
        return Response.json(fixture());
      },
    }),
    decision: (request, settings) => invokeDecision(request, settings, async (url, init) => {
      assert.equal(url, "https://synthetic.services.ai.azure.com/providers/microsoft/v1/systemone");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["api-key"], config.foundryApiKey);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      bodies.decision = JSON.parse(init.body);
      return Response.json(fixture());
    }),
  });
  assert.deepEqual(bodies.jev.questions, bodies.decision.questions);
  assert.deepEqual(bodies.jev.state, bodies.decision.state);
  assert.equal(bodies.jev.model, DEFAULT_MODEL);
  assert.equal(bodies.decision.model, config.decisionDeployment);
  assert.equal(result.comparison, "agree");
});

test("Decision-1 provider errors, timeouts and invalid JSON are explicit, sanitized and not retried", async () => {
  for (const status of [400, 401, 402, 403, 404, 422, 429, 500]) {
    let calls = 0;
    await assert.rejects(invokeDecision({}, config, async () => {
      calls++;
      return Response.json({ error: "private account details" }, { status });
    }), (error) => error instanceof AppError && !error.message.includes("private account") && (status !== 429 || error.status === 429));
    assert.equal(calls, 1);
  }
  await assert.rejects(invokeDecision({}, config, async () => new Response("invalid")), /invalid JSON/);
  await assert.rejects(invokeDecision({}, config, async () => { throw new DOMException("test", "TimeoutError"); }), /timed out/);
  await assert.rejects(invokeDecision({}, config, async () => { throw new TypeError("private connection details"); }), /Could not connect/);
});

test("providers start in parallel and remain independent", async () => {
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const pending = compareArchitectures(input, config, {
    jev: async () => new Promise((resolve) => { release = () => resolve(fixture()); }),
    decision: async () => { began(); throw new AppError(429, "Decision-1 quota reached."); },
  });
  await started;
  release();
  const result = await pending;
  assert.equal(result.comparison, "incomplete");
  assert.equal(result.providers.jev.status, "success");
  assert.equal(result.providers.decision.status, "error");
  const missing = await compareArchitectures(input, { apiKey: "", model: DEFAULT_MODEL });
  assert.equal(missing.comparison, "incomplete");
  assert.match(missing.providers.decision.error, /not configured/);
  assert.match(missing.providers.jev.error, /TYPESAFE_API_KEY/);
  const malformed = await compareArchitectures(input, config, { jev: async () => ({}), decision: async () => fixture() });
  assert.equal(malformed.providers.jev.status, "error");
  assert.equal(malformed.providers.decision.status, "success");
});

test("disagreement and abstention are distinct from agreement", async () => {
  for (const [choice, expected] of [["standard", "disagree"], ["unsure", "needs_clarification"]]) {
    const result = await compareArchitectures(input, config, { jev: async () => fixture(), decision: async () => fixture(choice) });
    assert.equal(result.comparison, expected);
  }
});

test("Foundry configuration is read without exposing keys through status", async () => {
  const settings = await readConfig({
    TYPESAFE_API_KEY: config.apiKey, FOUNDRY_ENDPOINT: config.foundryEndpoint,
    DECISION_DEPLOYMENT: config.decisionDeployment, FOUNDRY_API_KEY: config.foundryApiKey,
    PUBLIC_ORIGIN: "",
  }, new URL("nonexistent.env", import.meta.url));
  assert.equal(settings.decisionDeployment, config.decisionDeployment);
  const status = advisorStatus(settings);
  assert.equal(status.providers.decision.configured, true);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-jev-key|synthetic-foundry-key|synthetic.services/);
});

test("HTTP advisor preserves original UI, shares usage/limits, rejects cross-site calls and stores no text", async (t) => {
  let total = 0;
  let finish;
  let begin;
  const started = new Promise((resolve) => { begin = resolve; });
  const server = createApp({
    getConfig: () => config,
    usage: { total: () => total, close() {}, increment: (...args) => { assert.deepEqual(args, []); total++; } },
    compareScenario: async (value) => {
      assert.deepEqual(value, input);
      assert.equal(total, 1);
      begin();
      return new Promise((resolve) => { finish = () => resolve({ providers: {} }); });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  assert.match(await (await fetch(url)).text(), /Ask Jev/);
  assert.match(await (await fetch(`${url}/advisor`)).text(), /Microsoft-Decision-1/);
  assert.equal((await fetch(`${url}/advisor/`)).status, 200);
  const status = await (await fetch(`${url}/api/advisor/status`)).text();
  assert.doesNotMatch(status, /synthetic-foundry-key|synthetic-jev-key/);
  for (const path of ["/.env", "/usage.sqlite", "/advisor.mjs"]) assert.equal((await fetch(`${url}${path}`)).status, 404);
  assert.equal((await post("/api/advisor", input, { Origin: "https://untrusted.example" })).status, 403);
  assert.equal((await post("/api/advisor", { prompt: "" })).status, 400);
  assert.equal(total, 0);
  const pending = post("/api/advisor", input);
  await started;
  assert.equal((await post("/api/classify", input)).status, 429);
  finish();
  assert.equal((await pending).status, 200);
  assert.equal((await (await fetch(`${url}/api/status`)).json()).totalSubmissions, 1);
});

test("HTTP partial and missing-provider failures count once per comparison", async (t) => {
  const usage = createUsageStore(":memory:");
  const server = createApp({ getConfig: () => ({ model: DEFAULT_MODEL }), usage });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/advisor`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).comparison, "incomplete");
  assert.equal(usage.total(), 1);
});

test("advisor UI scripts parse and never persist scenario text", async () => {
  const html = await readFile(new URL("../advisor.html", import.meta.url), "utf8");
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  assert.doesNotMatch(html, /localStorage|sessionStorage|innerHTML/);
  assert.match(html, /submittedRevision !== revision/);
  assert.match(html, /\/api\/advisor/);
});
