import type { EmployeeRole } from "../../generated/prisma/client.js";

export interface OrgChartEmployee {
  id: string;
  fullName: string;
  role: EmployeeRole;
  designation: string | null;
  managerId: string | null;
  userId: string | null;
}

export interface OrgChartNode {
  id: string;
  fullName: string;
  role: EmployeeRole;
  designation: string | null;
  hasPortalAccess: boolean;
  reports: OrgChartNode[];
}

// Builds the reporting forest from a flat employee list in one pass: employees
// with no manager (or a manager outside this set — orphaned) become roots;
// everyone else is attached under their manager. `warn` gets one line per
// orphan and per cycle found. Runs in O(n) — each employee is attached at
// most once, thanks to `visited`, which is also what stops a managerId cycle
// (A -> B -> A) from recursing forever: the second time a node is reached it's
// already visited and gets skipped instead of re-descended into.
export const buildOrgChartTree = (employees: OrgChartEmployee[], warn: (message: string) => void): OrgChartNode[] => {
  const idsInOrg = new Set(employees.map((employee) => employee.id));
  const nodeById = new Map<string, OrgChartNode>(
    employees.map((employee) => [
      employee.id,
      {
        id: employee.id,
        fullName: employee.fullName,
        role: employee.role,
        designation: employee.designation,
        hasPortalAccess: employee.userId !== null,
        reports: [],
      },
    ]),
  );

  const childrenByManagerId = new Map<string, OrgChartEmployee[]>();
  const rootEmployees: OrgChartEmployee[] = [];
  for (const employee of employees) {
    if (employee.managerId && idsInOrg.has(employee.managerId)) {
      const siblings = childrenByManagerId.get(employee.managerId) ?? [];
      siblings.push(employee);
      childrenByManagerId.set(employee.managerId, siblings);
    } else {
      if (employee.managerId) {
        warn(`[org-chart] employee=${employee.id} managerId=${employee.managerId} not found in org — treating as root`);
      }
      rootEmployees.push(employee);
    }
  }

  const visited = new Set<string>();
  const attach = (employee: OrgChartEmployee): OrgChartNode => {
    visited.add(employee.id);
    const node = nodeById.get(employee.id)!;
    for (const child of childrenByManagerId.get(employee.id) ?? []) {
      if (visited.has(child.id)) {
        warn(`[org-chart] employee=${child.id} is part of a manager cycle — skipping to avoid an infinite loop`);
        continue;
      }
      node.reports.push(attach(child));
    }
    return node;
  };

  const roots = rootEmployees.map(attach);

  // Anyone still unvisited belongs to a cycle with no managerless ancestor
  // reachable from it (e.g. A -> B -> A with nothing pointing into the pair
  // from outside) — surface each such cycle as its own root instead of
  // silently dropping those employees from the tree.
  for (const employee of employees) {
    if (!visited.has(employee.id)) {
      warn(`[org-chart] employee=${employee.id} unreachable from any root (manager cycle) — surfacing as a root`);
      roots.push(attach(employee));
    }
  }

  return roots;
};
