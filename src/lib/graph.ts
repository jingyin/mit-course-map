import { Course, courses, courseMap, DEPARTMENTS, DEPT_COLORS, variantGroups, variantOf } from "@/data/courses";

export interface GraphNode {
  id: string; // canonical course ID
  title: string;
  dept: string;
  color: string;
  sccIndex: number;
  variantIds: string[]; // all variant IDs (length 1 if not a variant group)
  sortKey: number; // for ordering
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "prereq" | "coreq";
}

export interface PrereqGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sccs: string[][];
}

/** Convert course ID to a numeric sort key for ordering */
function sortKeyFor(id: string): number {
  // Extract department number and course number
  const match = id.match(/^(\d+)\.(\w+)/);
  if (!match) return 99999;
  const dept = parseInt(match[1], 10);
  const rest = match[2];
  // Convert the rest to a number, treating letters as fractions
  let num = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch >= "0" && ch <= "9") {
      num = num * 10 + parseInt(ch, 10);
    } else {
      // letter suffix: A=1, B=2, ...
      num = num + (ch.toUpperCase().charCodeAt(0) - 64) * 0.01;
    }
  }
  return dept * 10000 + num;
}

/** Resolve a course ID to its canonical form (handles variants) */
function canonical(id: string): string {
  return variantOf.get(id) ?? id;
}

export function buildGraph(deptFilter?: string[]): PrereqGraph {
  const relevantCourses = deptFilter
    ? courses.filter((c) => deptFilter.includes(c.dept))
    : courses;

  // Determine which canonical IDs are relevant
  // Skip courses whose canonical ID belongs to a different department
  // (cross-listed courses only appear under their lowest-numbered dept)
  const canonicalIds = new Set<string>();
  for (const course of relevantCourses) {
    const cid = canonical(course.id);
    if (deptFilter && cid !== course.id) {
      const canonCourse = courseMap.get(cid);
      if (canonCourse && !deptFilter.includes(canonCourse.dept)) continue;
    }
    canonicalIds.add(cid);
  }

  // Collect edges using canonical IDs, deduplicating
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  const externalRefs = new Set<string>();

  function addEdge(src: string, tgt: string, type: "prereq" | "coreq") {
    const cs = canonical(src);
    const ct = canonical(tgt);
    if (cs === ct) return; // self-loop from variant merging
    const key = `${cs}->${ct}:${type}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    if (!canonicalIds.has(cs) && courseMap.has(src)) externalRefs.add(cs);
    if (!canonicalIds.has(ct) && courseMap.has(tgt)) externalRefs.add(ct);
    edges.push({ source: cs, target: ct, type });
  }

  for (const course of relevantCourses) {
    for (const prereq of course.prereqs) {
      if (courseMap.has(prereq)) {
        addEdge(prereq, course.id, "prereq");
      }
    }
    for (const coreq of course.coreqs) {
      if (courseMap.has(coreq)) {
        addEdge(coreq, course.id, "coreq");
      }
    }
  }

  // Add external references and their inter-edges
  for (const extId of externalRefs) {
    canonicalIds.add(extId);
  }
  // Second pass: add edges between external reference nodes
  for (const extId of externalRefs) {
    const variants = variantGroups.get(extId) ?? [extId];
    for (const vid of variants) {
      const vc = courseMap.get(vid);
      if (!vc) continue;
      for (const prereq of vc.prereqs) {
        if (courseMap.has(prereq)) {
          const cp = canonical(prereq);
          if (canonicalIds.has(cp)) addEdge(prereq, vid, "prereq");
        }
      }
      for (const coreq of vc.coreqs) {
        if (courseMap.has(coreq)) {
          const cc = canonical(coreq);
          if (canonicalIds.has(cc)) addEdge(coreq, vid, "coreq");
        }
      }
    }
  }

  // Build node list from canonical IDs
  const nodes: GraphNode[] = [];
  for (const cid of canonicalIds) {
    const course = courseMap.get(cid);
    const d = course?.dept ?? "?";
    const variants = variantGroups.get(cid);
    nodes.push({
      id: cid,
      title: course?.title ?? cid,
      dept: d,
      color: DEPT_COLORS[d] ?? "#999",
      sccIndex: -1,
      variantIds: variants ?? [cid],
      sortKey: sortKeyFor(cid),
    });
  }

  // Sort nodes by sort key so layout processes them in order
  nodes.sort((a, b) => a.sortKey - b.sortKey);

  // Find SCCs
  const sccs = findSCCs(new Set(nodes.map((n) => n.id)), edges);
  const multiNodeSCCs = sccs.filter((scc) => scc.length > 1);
  for (let i = 0; i < multiNodeSCCs.length; i++) {
    for (const nodeId of multiNodeSCCs[i]) {
      const node = nodes.find((n) => n.id === nodeId);
      if (node) node.sccIndex = i;
    }
  }

  return { nodes, edges, sccs: multiNodeSCCs };
}

function findSCCs(nodeIds: Set<string>, edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const edge of edges) {
    if (adj.has(edge.source)) {
      adj.get(edge.source)!.push(edge.target);
    }
  }

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const result: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      result.push(scc);
    }
  }

  for (const v of nodeIds) {
    if (!indices.has(v)) {
      strongconnect(v);
    }
  }

  return result;
}

export function getPrereqChain(courseId: string): Set<string> {
  const cid = canonical(courseId);
  const visited = new Set<string>();
  const queue = [cid];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const course = courseMap.get(current);
    if (!course) continue;

    for (const prereq of course.prereqs) {
      const cp = canonical(prereq);
      if (!visited.has(cp)) queue.push(cp);
    }
    for (const coreq of course.coreqs) {
      const cc = canonical(coreq);
      if (!visited.has(cc)) queue.push(cc);
    }
  }

  // Also check all variants of the canonical course
  const variants = variantGroups.get(cid) ?? [cid];
  for (const vid of variants) {
    const vc = courseMap.get(vid);
    if (!vc) continue;
    for (const prereq of vc.prereqs) {
      const cp = canonical(prereq);
      if (!visited.has(cp) && cp !== cid) {
        // Recurse
        const sub = getPrereqChain(cp);
        for (const s of sub) visited.add(s);
        visited.add(cp);
      }
    }
  }

  visited.delete(cid);
  return visited;
}

export function getDependents(courseId: string): Set<string> {
  const cid = canonical(courseId);
  const reverseAdj = new Map<string, Set<string>>();
  for (const course of courses) {
    const ct = canonical(course.id);
    for (const prereq of course.prereqs) {
      const cp = canonical(prereq);
      if (cp === ct) continue;
      if (!reverseAdj.has(cp)) reverseAdj.set(cp, new Set());
      reverseAdj.get(cp)!.add(ct);
    }
    for (const coreq of course.coreqs) {
      const cc = canonical(coreq);
      if (cc === ct) continue;
      if (!reverseAdj.has(cc)) reverseAdj.set(cc, new Set());
      reverseAdj.get(cc)!.add(ct);
    }
  }

  const visited = new Set<string>();
  const queue = [cid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of reverseAdj.get(current) ?? []) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  visited.delete(cid);
  return visited;
}

export function getDeptName(deptCode: string): string {
  return DEPARTMENTS[deptCode] ?? `Department ${deptCode}`;
}

export function getGraphStats() {
  const deptCounts: Record<string, number> = {};
  let totalWithPrereqs = 0;
  let totalCoreqs = 0;
  for (const course of courses) {
    deptCounts[course.dept] = (deptCounts[course.dept] ?? 0) + 1;
    if (course.prereqs.length > 0) totalWithPrereqs++;
    if (course.coreqs.length > 0) totalCoreqs++;
  }
  const graph = buildGraph();
  return {
    totalCourses: courses.length,
    totalEdges: graph.edges.length,
    totalWithPrereqs,
    totalCoreqs,
    sccCount: graph.sccs.length,
    deptCounts,
    sccs: graph.sccs,
  };
}
