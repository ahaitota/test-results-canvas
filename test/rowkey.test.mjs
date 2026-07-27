import test from "node:test";
import assert from "node:assert/strict";
import { assignRowKeys, rowKey, rowIdentity } from "../src/rowkey.mjs";
import { parseJUnit } from "../src/parsers/junit.mjs";

test("unique identities each get #0", () => {
  const a = { name: "A", className: "C" };
  const b = { name: "B", className: "C" };
  assignRowKeys([a, b]);
  assert.ok(a.__rowKey.endsWith("#0"));
  assert.ok(b.__rowKey.endsWith("#0"));
  assert.notEqual(a.__rowKey, b.__rowKey);
});

test("same-name results on different targets stay distinct and order-independent", () => {
  const make = () => [
    { name: "T", className: "C", framework: "net8.0", storage: "a/net8.0/x.dll" },
    { name: "T", className: "C", framework: "net9.0", storage: "a/net9.0/x.dll" },
  ];
  const fwd = make(); assignRowKeys(fwd);
  const k8 = fwd[0].__rowKey, k9 = fwd[1].__rowKey;

  const rev = make().reverse(); assignRowKeys(rev);
  assert.equal(rev.find(t => t.framework === "net8.0").__rowKey, k8);
  assert.equal(rev.find(t => t.framework === "net9.0").__rowKey, k9);
  assert.ok(k8.endsWith("#0") && k9.endsWith("#0"));
  assert.notEqual(k8, k9);
});

test("reversed same-target retries keep their keys (ordinal from metadata)", () => {
  // Two retries of the same test on the same target, told apart by startTime.
  const make = () => [
    { name: "T", className: "C", framework: "net8.0", storage: "x.dll", status: "fail", startTime: "2026-01-01T10:00:01Z", message: "boom" },
    { name: "T", className: "C", framework: "net8.0", storage: "x.dll", status: "pass", startTime: "2026-01-01T10:00:05Z" },
  ];
  const fwd = make(); assignRowKeys(fwd);
  const failFwd = fwd.find(t => t.status === "fail").__rowKey;
  const passFwd = fwd.find(t => t.status === "pass").__rowKey;

  const rev = make().reverse(); assignRowKeys(rev);
  const failRev = rev.find(t => t.status === "fail").__rowKey;
  const passRev = rev.find(t => t.status === "pass").__rowKey;

  // The earlier-started (fail) retry is always #0, whichever way the rows arrive.
  assert.equal(failFwd, failRev);
  assert.equal(passFwd, passRev);
  assert.ok(failFwd.endsWith("#0"));
  assert.ok(passFwd.endsWith("#1"));
  assert.notEqual(failFwd, passFwd);
});

test("reversed duplicate rows differing only by duration keep their keys", () => {
  const make = () => [
    { name: "D", className: "C", suite: "S", durationMs: 5 },
    { name: "D", className: "C", suite: "S", durationMs: 12 },
  ];
  const fwd = make(); assignRowKeys(fwd);
  const kFast = fwd.find(t => t.durationMs === 5).__rowKey;
  const kSlow = fwd.find(t => t.durationMs === 12).__rowKey;

  const rev = make().reverse(); assignRowKeys(rev);
  assert.equal(rev.find(t => t.durationMs === 5).__rowKey, kFast);
  assert.equal(rev.find(t => t.durationMs === 12).__rowKey, kSlow);
  assert.notEqual(kFast, kSlow);
});

test("rowKey falls back to identity when no key is assigned", () => {
  const t = { name: "X", className: "C" };
  assert.equal(rowKey(t), rowIdentity(t));
});

test("repeated/missing-id JUnit rows differing only by hostname keep their keys when reversed", () => {
  // Same suite/class/name across two agents, no usable id -> identity ties; only
  // the parsed hostname (computerName) tells them apart.
  const xml = `<testsuites>
    <testsuite name="S" hostname="agent-1"><testcase name="T" classname="C" time="0.01"/></testsuite>
    <testsuite name="S" hostname="agent-2"><testcase name="T" classname="C" time="0.01"/></testsuite>
  </testsuites>`;
  const fwd = parseJUnit(xml); assignRowKeys(fwd);
  const k1 = fwd.find(t => t.computerName === "agent-1").__rowKey;
  const k2 = fwd.find(t => t.computerName === "agent-2").__rowKey;
  assert.notEqual(k1, k2);

  const rev = parseJUnit(xml).reverse(); assignRowKeys(rev);
  assert.equal(rev.find(t => t.computerName === "agent-1").__rowKey, k1);
  assert.equal(rev.find(t => t.computerName === "agent-2").__rowKey, k2);
});

test("rows differing only by method or adapter stay distinct and order-independent", () => {
  const make = () => [
    { name: "T", className: "C", suite: "S", method: "M1", adapter: "vstest" },
    { name: "T", className: "C", suite: "S", method: "M2", adapter: "vstest" },
    { name: "T", className: "C", suite: "S", method: "M1", adapter: "xunit" },
  ];
  const fwd = make(); assignRowKeys(fwd);
  const key = t => fwd.find(x => x.method === t.method && x.adapter === t.adapter).__rowKey;
  const keys = fwd.map(key);
  assert.equal(new Set(keys).size, 3);

  const rev = make().reverse(); assignRowKeys(rev);
  make().forEach(t => {
    const k = fwd.find(x => x.method === t.method && x.adapter === t.adapter).__rowKey;
    assert.equal(rev.find(x => x.method === t.method && x.adapter === t.adapter).__rowKey, k);
  });
});
