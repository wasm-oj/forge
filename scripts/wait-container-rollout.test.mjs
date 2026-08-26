import assert from "node:assert/strict";
import test from "node:test";

import {
  assessContainerRollout,
  containerRolloutBaseline,
  configuredContainerRolloutTarget,
  inspectContainerRollout,
  parseContainerRolloutBaseline,
  waitForContainerRollout,
} from "./wait-container-rollout.mjs";

const image = `registry.cloudflare.com/account/submission@sha256:${"a".repeat(64)}`;
const nextImage = `registry.cloudflare.com/account/submission@sha256:${"b".repeat(64)}`;
const target = Object.freeze({ className: "SubmissionJudgeContainer", name: "submission-production" });
const applicationId = "a0341d3a-33dc-469a-a7ac-26061efd46db";

function readyFixture(overrides = {}) {
  const summary = {
    id: applicationId,
    image,
    instances: 7,
    name: target.name,
    state: "ready",
    version: 14,
    ...overrides.summary,
  };
  const info = {
    configuration: { image },
    health: {
      errors: [],
      instances: { active: 0, assigned: 0, failed: 0, healthy: 7, scheduling: 0, starting: 0, stopped: 0 },
    },
    id: applicationId,
    instances: 7,
    name: target.name,
    version: 14,
    ...overrides.info,
  };
  const instances = overrides.instances ?? [
    { id: "historical", state: "inactive", version: null },
    { id: "current", state: "running", version: 14 },
  ];
  return {
    assessment: assessContainerRollout(target, summary, info, instances, overrides.baseline ?? null),
    info,
    instances,
    summary,
  };
}

test("configured target requires one repository-built Container", () => {
  assert.deepEqual(configuredContainerRolloutTarget({ containers: [{
    class_name: target.className,
    image: "./Dockerfile",
    name: target.name,
  }] }), target);
  assert.throws(
    () => configuredContainerRolloutTarget({ containers: [{ ...target, class_name: target.className, image: "repo:latest" }] }),
    /built from \.\/Dockerfile/u,
  );
  assert.throws(() => configuredContainerRolloutTarget({ containers: [] }), /exactly one/u);
});

test("ready assessment accepts inactive history and exact live version", () => {
  const result = readyFixture().assessment;
  assert.equal(result.ready, true);
  assert.equal(result.version, 14);
  assert.equal(result.healthyInstances, 7);
  assert.deepEqual(result.reasons, []);
});

test("baseline requires the deploy to advance the exact application and image", () => {
  const captured = containerRolloutBaseline(target, readyFixture(), "2026-08-26T00:00:00.000Z");
  const baseline = parseContainerRolloutBaseline(target, captured);
  assert.deepEqual(baseline, { applicationId, image, version: 14 });

  const unchanged = readyFixture({ baseline }).assessment;
  assert.equal(unchanged.ready, false);
  assert.match(unchanged.reasons.join("\n"), /has not advanced past baseline 14/u);
  assert.match(unchanged.reasons.join("\n"), /image has not changed/u);

  const advanced = readyFixture({
    baseline,
    info: { configuration: { image: nextImage }, version: 15 },
    instances: [{ id: "current", state: "running", version: 15 }],
    summary: { image: nextImage, version: 15 },
  }).assessment;
  assert.equal(advanced.ready, true);
});

test("assessment rejects an active rollout and inconsistent image queries", () => {
  const result = readyFixture({
    info: { active_rollout_id: "79699b91-24b1-49d8-be4d-bb280af0b594" },
    summary: { image: nextImage },
  }).assessment;
  assert.equal(result.ready, false);
  assert.match(result.reasons.join("\n"), /image changed between queries/u);
  assert.match(result.reasons.join("\n"), /still has an active rollout/u);
});

test("assessment rejects non-terminal health and an old live instance", () => {
  const result = readyFixture({
    summary: { image: image.replace(/a{64}$/u, "b".repeat(64)), state: "active" },
    info: {
      health: {
        errors: ["rollout"],
        instances: { active: 1, assigned: 0, failed: 0, healthy: 6, scheduling: 0, starting: 0, stopped: 0 },
      },
    },
    instances: [{ id: "old", state: "running", version: 13 }],
  }).assessment;
  assert.equal(result.ready, false);
  assert.match(result.reasons.join("\n"), /not ready/u);
  assert.match(result.reasons.join("\n"), /health contains errors/u);
  assert.match(result.reasons.join("\n"), /healthy instance count 6/u);
  assert.match(result.reasons.join("\n"), /counter active is not terminal/u);
  assert.match(result.reasons.join("\n"), /old.*version 13 is not target 14/u);
});

test("inspection resolves the exact application and reads every instances page", async () => {
  const calls = [];
  const fixture = readyFixture({ instances: [] });
  const wranglerJson = async (args) => {
    calls.push(args);
    if (args[0] === "list") return [fixture.summary];
    if (args[0] === "info") return fixture.info;
    if (!args.includes("--page-token")) {
      return { instances: [{ id: "current", state: "running", version: 14 }], result_info: { next_page_token: "next" } };
    }
    return { instances: [{ id: "history", state: "inactive", version: null }], result_info: { next_page_token: null } };
  };
  const observation = await inspectContainerRollout(target, { configPath: "rendered.json", timeoutMs: 1_000, wranglerJson });
  assert.equal(observation.assessment.ready, true);
  assert.equal(observation.instances.length, 2);
  assert.deepEqual(calls.at(-1), ["instances", applicationId, "--per-page", "100", "--page-token", "next"]);
});

test("waiter requires two consecutive observations of the same exact version", async () => {
  const observations = [readyFixture(), readyFixture({ summary: { version: 15 }, info: { version: 15 }, instances: [] }), readyFixture({
    summary: { version: 15 }, info: { version: 15 }, instances: [],
  })];
  let clock = 0;
  const statuses = [];
  const result = await waitForContainerRollout({
    configPath: "rendered.json",
    inspect: async () => observations.shift(),
    now: () => clock,
    pollIntervalMs: 5,
    sleep: async (milliseconds) => { clock += milliseconds; },
    stableObservations: 2,
    target,
    timeoutMs: 100,
    writeStatus: (message) => statuses.push(message),
  });
  assert.equal(result.assessment.version, 15);
  assert.equal(statuses.length, 3);
  assert.match(statuses.at(-1), /stable 2\/2/u);
});

test("waiter fails closed at its deadline after query failures", async () => {
  let clock = 0;
  await assert.rejects(
    waitForContainerRollout({
      configPath: "rendered.json",
      inspect: async () => { throw new Error("status unavailable"); },
      now: () => clock,
      pollIntervalMs: 5,
      sleep: async (milliseconds) => { clock += milliseconds; },
      stableObservations: 2,
      target,
      timeoutMs: 12,
      writeStatus: () => {},
    }),
    /within 12ms: status unavailable/u,
  );
});
