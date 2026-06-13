import test from "node:test";
import assert from "node:assert/strict";
import { runVectors } from "../src/conformance.js";

test("all executable conformance vectors meet their declared expectation", () => {
  const report = runVectors();
  const failures = report.results.filter((r) => r.status === "fail");
  assert.equal(report.failed, 0, `failures: ${JSON.stringify(failures, null, 2)}`);
  assert.ok(report.passed >= 9, `expected >= 9 executable passes, got ${report.passed}`);
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
