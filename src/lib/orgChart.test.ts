import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrgChartTree, type OrgChartEmployee } from "./orgChart.js";

const employee = (id: string, managerId: string | null): OrgChartEmployee => ({
  id,
  fullName: id,
  role: "EMPLOYEE",
  designation: null,
  managerId,
  userId: null,
});

test("nests reports under multiple roots", () => {
  const warnings: string[] = [];
  const roots = buildOrgChartTree(
    [employee("ceo", null), employee("cto", null), employee("dev", "cto")],
    (message) => warnings.push(message),
  );

  assert.equal(roots.length, 2);
  const cto = roots.find((root) => root.id === "cto")!;
  assert.equal(cto.reports.length, 1);
  assert.equal(cto.reports[0]!.id, "dev");
  assert.deepEqual(warnings, []);
});

test("treats an orphaned managerId as a root and warns", () => {
  const warnings: string[] = [];
  const roots = buildOrgChartTree([employee("a", "missing-manager")], (message) => warnings.push(message));

  assert.equal(roots.length, 1);
  assert.equal(roots[0]!.id, "a");
  assert.equal(warnings.length, 1);
});

test("breaks a manager cycle instead of looping forever", () => {
  const warnings: string[] = [];
  const roots = buildOrgChartTree([employee("a", "b"), employee("b", "a")], (message) => warnings.push(message));

  // No test timeout tripped -> the cycle didn't recurse forever. The pair
  // still has to show up somewhere in the tree rather than vanish.
  const flatten = (nodes: typeof roots): string[] => nodes.flatMap((node) => [node.id, ...flatten(node.reports)]);
  assert.deepEqual(new Set(flatten(roots)), new Set(["a", "b"]));
  assert.ok(warnings.length >= 1);
});
