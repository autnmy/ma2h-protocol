import test from "node:test";
import assert from "node:assert/strict";
import { runVectors } from "../src/conformance.js";

test("all executable conformance vectors meet their declared expectation", () => {
  const report = runVectors();
  const failures = report.results.filter((r) => r.status === "fail");
  assert.equal(report.failed, 0, `failures: ${JSON.stringify(failures, null, 2)}`);
  assert.ok(report.passed >= 23, `expected >= 23 executable passes, got ${report.passed}`);
});

test("the dp-001 signature vector is exercised and passes", () => {
  const report = runVectors();
  const dp = report.results.find((r) => r.id.startsWith("dp-001"));
  assert.ok(dp, "dp-001 vector present");
  assert.equal(dp.status, "pass");
});

test("the dp-003 payload-tamper vector is exercised and passes", () => {
  const report = runVectors();
  const dp = report.results.find((r) => r.id.startsWith("dp-003"));
  assert.ok(dp, "dp-003 vector present");
  assert.equal(dp.status, "pass");
});

test("the dp-004 numeric-payload vector is exercised and passes", () => {
  const report = runVectors();
  const dp = report.results.find((r) => r.id.startsWith("dp-004"));
  assert.ok(dp, "dp-004 vector present");
  assert.equal(dp.status, "pass");
});

test("the dp-005 inbound-signature vector is exercised and passes", () => {
  const report = runVectors();
  const dp = report.results.find((r) => r.id.startsWith("dp-005"));
  assert.ok(dp, "dp-005 vector present");
  assert.equal(dp.status, "pass");
});

test("the dp-006 inbound-tamper vector is exercised and passes", () => {
  const report = runVectors();
  const dp = report.results.find((r) => r.id.startsWith("dp-006"));
  assert.ok(dp, "dp-006 vector present");
  assert.equal(dp.status, "pass");
});

test("the dp-008 ack-signature vector is exercised and passes", () => {
  const report = runVectors();
  const dp = report.results.find((r) => r.id.startsWith("dp-008"));
  assert.ok(dp, "dp-008 vector present");
  assert.equal(dp.status, "pass");
});

test("the dp-009 ack-tamper vector is exercised and passes", () => {
  const report = runVectors();
  const dp = report.results.find((r) => r.id.startsWith("dp-009"));
  assert.ok(dp, "dp-009 vector present");
  assert.equal(dp.status, "pass");
});

test("the v0.5 schema-validation vectors are exercised and pass (spec/v0.5.md)", () => {
  const report = runVectors();
  const v05 = report.results.filter((r) => r.id.startsWith("sv-0") && Number(r.id.slice(3, 6)) >= 17);
  assert.ok(v05.length >= 16, `expected >= 16 v0.5 vectors, got ${v05.length}`);
  for (const r of v05) assert.equal(r.status, "pass", `${r.id}: ${r.detail ?? ""}`);
});
