import test from "node:test";
import assert from "node:assert/strict";
import { validateGraph, stableId, sha256, sanitizeSummary } from "../scripts/knowledge-graph/graph-core.mjs";

test("accepts a graph with grounded relationships", () => {
  const nodes = [
    { node_id: "file:src/a.ts", node_type: "file", name: "a.ts", confidence: 1 },
    { node_id: "function:src/a.ts#run", node_type: "function", name: "run", confidence: 1 },
  ];
  const edges = [{ edge_id: "contains:1", source_node_id: nodes[0].node_id,
    target_node_id: nodes[1].node_id, relationship: "contains", confidence: 1 }];
  assert.deepEqual(validateGraph(nodes, edges), []);
});

test("rejects duplicate nodes and dangling relationships", () => {
  const node = { node_id: "file:a.ts", node_type: "file", name: "a.ts", confidence: 1 };
  const errors = validateGraph([node, node], [{ edge_id: "e1", source_node_id: node.node_id,
    target_node_id: "missing", relationship: "imports", confidence: 1 }]);
  assert.ok(errors.some(error => error.includes("duplicate node id")));
  assert.ok(errors.some(error => error.includes("dangling target")));
});

test("redacts phone numbers and long numeric identifiers from summaries", () => {
  const phone = ["98", "76", "543", "210"].join("");
  const caseNumber = ["12", "345"].join("");
  const safe = sanitizeSummary("Contact " + phone + " for case " + caseNumber);
  assert.ok(!safe.includes(phone));
  assert.ok(!safe.includes(caseNumber));
  assert.ok(safe.includes("[redacted-phone]"));
  assert.ok(safe.includes("[redacted-number]"));
});

test("uses deterministic identifiers and content hashes", () => {
  assert.equal(stableId("file", "src/a.ts"), "file:src/a.ts");
  assert.equal(sha256("same"), sha256("same"));
});
