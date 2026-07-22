// Tests for the label generator (issue #3). Forward-slash paths so node:path
// behaves the same on POSIX CI and Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { labelForPath } from "../src/labels.mjs";

test("labelForPath uses the bare filename when there is no collision", () => {
  assert.equal(labelForPath("/projA/results.trx", new Map(), []), "results.trx");
});

test("labelForPath prefixes the parent folder when the bare name collides", () => {
  const discovered = new Map([["results.trx", "/projA/results.trx"]]);
  assert.equal(labelForPath("/projB/results.trx", discovered, []), "projB/results.trx");
});

test("labelForPath also avoids collisions with local extension-folder files", () => {
  assert.equal(
    labelForPath("/projB/results.trx", new Map(), ["results.trx"]),
    "projB/results.trx"
  );
});

test("labelForPath adds a counter when the parent-prefixed label is also taken", () => {
  const discovered = new Map([
    ["results.trx", "/projA/results.trx"],
    ["proj/results.trx", "/x/proj/results.trx"],
  ]);
  assert.equal(labelForPath("/y/proj/results.trx", discovered, []), "proj/results.trx (2)");
});

test("labelForPath returns the existing label when the path is already registered", () => {
  const discovered = new Map([["projB/results.trx", "/projB/results.trx"]]);
  assert.equal(labelForPath("/projB/results.trx", discovered, []), "projB/results.trx");
});

// Issue #3: the full label round-trips to the right project; its basename (the
// old /load bug) resolves to the wrong one.
test("a discovered label round-trips; its basename resolves to the wrong project (issue #3)", () => {
  const discovered = new Map();
  const pathA = "/projA/results.trx";
  const pathB = "/projB/results.trx";

  const labelA = labelForPath(pathA, discovered, []);
  discovered.set(labelA, pathA);
  const labelB = labelForPath(pathB, discovered, []);
  discovered.set(labelB, pathB);

  assert.equal(labelA, "results.trx");
  assert.equal(labelB, "projB/results.trx");

  // Full label -> right project (what /load must store):
  assert.equal(discovered.get(labelB), pathB);

  // basename(labelB) collapses to labelA -> wrong project (the old bug):
  assert.equal(basename(labelB), "results.trx");
  assert.equal(discovered.get(basename(labelB)), pathA);
  assert.notEqual(discovered.get(basename(labelB)), pathB);
});
