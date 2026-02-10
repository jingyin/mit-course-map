"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  ReactFlow,
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  Panel,
  ConnectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  buildGraph,
  getPrereqChain,
  getDependents,
  getDeptName,
  type PrereqGraph,
  type GraphNode as GNode,
} from "@/lib/graph";
import { DEPARTMENTS, DEPT_COLORS, courseMap, variantGroups, variantOf, courses } from "@/data/courses";
import type { GraphEdge } from "@/lib/graph";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 50;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

const elk = new ELK();

async function layoutGraph(
  graph: PrereqGraph
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const edgeSet = new Set<string>();
  const uniqueEdges: typeof graph.edges = [];
  for (const e of graph.edges) {
    const key = `${e.source}->${e.target}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      uniqueEdges.push(e);
    }
  }

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.spacing.nodeNode": "25",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.greedySwitchType": "TWO_SIDED",
      "elk.layered.thoroughness": "100",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=20,left=20,bottom=20,right=20]",
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: uniqueEdges.map((edge, i) => ({
      id: `e-${i}`,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layout = await elk.layout(elkGraph);

  const posMap = new Map<string, { x: number; y: number }>();
  for (const child of layout.children ?? []) {
    posMap.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }

  const nodes: Node[] = graph.nodes.map((node) => {
    const pos = posMap.get(node.id) ?? { x: 0, y: 0 };
    const isSCC = node.sccIndex >= 0;
    const displayTitle = truncate(node.title, 28);
    const isVariant = node.variantIds.length > 1;
    return {
      id: node.id,
      position: { x: pos.x, y: pos.y },
      data: {
        label: (
          <div style={{ textAlign: "center", lineHeight: 1.2, padding: "2px 0" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#222" }}>
              {displayTitle}
            </div>
            <div style={{ fontSize: 9, color: "#888", marginTop: 1 }}>
              {isVariant
                ? node.variantIds.slice(0, 3).join(", ") +
                  (node.variantIds.length > 3
                    ? ` +${node.variantIds.length - 3}`
                    : "")
                : node.id}
            </div>
          </div>
        ),
        title: node.title,
        dept: node.dept,
        sccIndex: node.sccIndex,
        variantIds: node.variantIds,
        nodeId: node.id,
      },
      style: {
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        background: node.color + "22",
        border: `2px solid ${node.color}`,
        borderRadius: 6,
        fontSize: 11,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#333",
        padding: "2px 4px",
        cursor: "pointer",
        ...(isSCC
          ? {
              borderStyle: "double",
              borderWidth: 4,
              boxShadow: `0 0 8px ${node.color}55`,
            }
          : {}),
      },
      type: "default",
    };
  });

  const edges: Edge[] = uniqueEdges.map((edge, i) => ({
    id: `e-${edge.source}-${edge.target}-${i}`,
    source: edge.source,
    target: edge.target,
    type: "default",
    animated: edge.type === "coreq",
    style: {
      stroke: edge.type === "coreq" ? "#e74c3c" : "#888",
      strokeWidth: edge.type === "coreq" ? 2 : 1,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 12,
      height: 12,
      color: edge.type === "coreq" ? "#e74c3c" : "#888",
    },
  }));

  return { nodes, edges };
}

export default function PrereqGraph() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const isInitialMount = useRef(true);

  // Read initial state from URL
  const initialDept = searchParams.get("dept") ?? "8";
  const initialCourse = searchParams.get("course");

  const [selectedDept, setSelectedDept] = useState<string>(
    initialDept in DEPARTMENTS ? initialDept : "8"
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedCourse, setSelectedCourse] = useState<string | null>(
    initialCourse
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [highlightMode, setHighlightMode] = useState<
    "none" | "prereqs" | "dependents"
  >(initialCourse ? "prereqs" : "none");

  const graph = useMemo(() => buildGraph([selectedDept]), [selectedDept]);

  // Sync state to URL
  useEffect(() => {
    // Skip the initial mount to avoid replacing the URL we just read from
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    const params = new URLSearchParams();
    params.set("dept", selectedDept);
    if (selectedCourse) params.set("course", selectedCourse);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [selectedDept, selectedCourse, router]);

  useEffect(() => {
    let cancelled = false;
    layoutGraph(graph).then(({ nodes: layoutNodes, edges: layoutEdges }) => {
      if (!cancelled) {
        setNodes(layoutNodes);
        setEdges(layoutEdges);
        setLayoutVersion((v) => v + 1);
      }
    });
    return () => { cancelled = true; };
  }, [graph, setNodes, setEdges]);

  useEffect(() => {
    if (!selectedCourse || highlightMode === "none") {
      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          style: { ...n.style, opacity: 1 },
        }))
      );
      setEdges((eds) =>
        eds.map((e) => ({
          ...e,
          style: { ...e.style, opacity: 1 },
        }))
      );
      return;
    }

    const highlighted =
      highlightMode === "prereqs"
        ? getPrereqChain(selectedCourse)
        : getDependents(selectedCourse);
    highlighted.add(selectedCourse);

    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        style: {
          ...n.style,
          opacity: highlighted.has(n.id) ? 1 : 0.15,
        },
      }))
    );

    setEdges((eds) =>
      eds.map((e) => ({
        ...e,
        style: {
          ...e.style,
          opacity:
            highlighted.has(e.source) && highlighted.has(e.target) ? 1 : 0.08,
        },
      }))
    );
  }, [selectedCourse, highlightMode, setNodes, setEdges, layoutVersion]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const nodeId = (node.data as { nodeId?: string })?.nodeId ?? node.id;
      if (selectedCourse === nodeId) {
        setSelectedCourse(null);
        setHighlightMode("none");
      } else {
        setSelectedCourse(nodeId);
        setHighlightMode("prereqs");
      }
    },
    [selectedCourse]
  );

  const selectDept = (deptCode: string) => {
    setSelectedDept(deptCode);
    setSelectedCourse(null);
    setHighlightMode("none");
  };

  const courseInfo = selectedCourse ? courseMap.get(selectedCourse) : null;
  const selectedNode = selectedCourse
    ? graph.nodes.find((n) => n.id === selectedCourse)
    : null;

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    // Search across ALL courses, not just the current department
    const seen = new Set<string>();
    const results: { id: string; title: string; dept: string }[] = [];
    for (const course of courses) {
      const cid = variantOf.get(course.id) ?? course.id;
      if (seen.has(cid)) continue;
      const variants = variantGroups.get(cid) ?? [cid];
      if (
        cid.toLowerCase().includes(q) ||
        course.title.toLowerCase().includes(q) ||
        variants.some((v) => v.toLowerCase().includes(q))
      ) {
        seen.add(cid);
        const canonCourse = courseMap.get(cid);
        results.push({
          id: cid,
          title: canonCourse?.title ?? course.title,
          dept: canonCourse?.dept ?? course.dept,
        });
      }
      if (results.length >= 8) break;
    }
    return results;
  }, [searchQuery]);

  const focusOnNode = (nodeId: string) => {
    // Switch to the course's department if needed
    const course = courseMap.get(nodeId);
    if (course && course.dept !== selectedDept) {
      setSelectedDept(course.dept);
    }
    setSelectedCourse(nodeId);
    setHighlightMode("prereqs");
    setSearchQuery("");
  };

  // Collect all prereqs from all variants for the detail panel
  const allPrereqs = useMemo(() => {
    if (!selectedNode) return [];
    const pset = new Set<string>();
    for (const vid of selectedNode.variantIds) {
      const vc = courseMap.get(vid);
      if (vc) vc.prereqs.forEach((p) => pset.add(p));
    }
    // Deduplicate by canonical
    const canonSet = new Set<string>();
    for (const p of pset) {
      const vof = variantGroups.get(p);
      canonSet.add(vof ? vof[0] : p);
    }
    // Remove self
    canonSet.delete(selectedCourse!);
    return Array.from(canonSet);
  }, [selectedNode, selectedCourse]);

  const exportSvg = useCallback(() => {
    if (nodes.length === 0) return;

    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    // Build position map from current ReactFlow nodes
    const posMap = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      posMap.set(n.id, { x: n.position.x, y: n.position.y });
    }

    // Compute bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.position.y + NODE_HEIGHT);
    }
    const pad = 40;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const svgW = maxX - minX;
    const svgH = maxY - minY;

    // Deduplicate edges
    const edgeSet = new Set<string>();
    const uniqueEdges: GraphEdge[] = [];
    for (const e of graph.edges) {
      const key = `${e.source}->${e.target}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        uniqueEdges.push(e);
      }
    }

    // Build node info map from graph data
    const nodeInfo = new Map<string, typeof graph.nodes[0]>();
    for (const gn of graph.nodes) {
      nodeInfo.set(gn.id, gn);
    }

    // SVG parts
    const parts: string[] = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="${minX} ${minY} ${svgW} ${svgH}" style="font-family: system-ui, -apple-system, sans-serif;">`);

    // Defs for arrow markers
    parts.push(`<defs>`);
    parts.push(`<marker id="arrow-prereq" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#888"/></marker>`);
    parts.push(`<marker id="arrow-coreq" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#e74c3c"/></marker>`);
    parts.push(`</defs>`);

    // Background
    parts.push(`<rect x="${minX}" y="${minY}" width="${svgW}" height="${svgH}" fill="white"/>`);

    // Edges
    for (const edge of uniqueEdges) {
      const sp = posMap.get(edge.source);
      const tp = posMap.get(edge.target);
      if (!sp || !tp) continue;
      const x1 = sp.x + NODE_WIDTH / 2;
      const y1 = sp.y + NODE_HEIGHT;
      const x2 = tp.x + NODE_WIDTH / 2;
      const y2 = tp.y;
      const dy = Math.abs(y2 - y1) * 0.4;
      const color = edge.type === "coreq" ? "#e74c3c" : "#888";
      const sw = edge.type === "coreq" ? 2 : 1;
      const marker = edge.type === "coreq" ? "arrow-coreq" : "arrow-prereq";
      const dash = edge.type === "coreq" ? ` stroke-dasharray="6 3"` : "";
      parts.push(`<path d="M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${sw}" marker-end="url(#${marker})"${dash}/>`);
    }

    // Nodes
    for (const n of nodes) {
      const gn = nodeInfo.get(n.id);
      if (!gn) continue;
      const x = n.position.x;
      const y = n.position.y;
      const isSCC = gn.sccIndex >= 0;
      const fillColor = gn.color + "22";
      const strokeColor = gn.color;
      const sw = isSCC ? 3 : 2;

      parts.push(`<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="6" ry="6" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${sw}"/>`);

      // Title text
      const title = truncate(gn.title, 30);
      parts.push(`<text x="${x + NODE_WIDTH / 2}" y="${y + 20}" text-anchor="middle" font-size="11" font-weight="600" fill="#222">${esc(title)}</text>`);

      // Subtitle (variant IDs or single ID)
      const isVariant = gn.variantIds.length > 1;
      const subtitle = isVariant
        ? gn.variantIds.slice(0, 3).join(", ") + (gn.variantIds.length > 3 ? ` +${gn.variantIds.length - 3}` : "")
        : gn.id;
      parts.push(`<text x="${x + NODE_WIDTH / 2}" y="${y + 34}" text-anchor="middle" font-size="9" fill="#888">${esc(subtitle)}</text>`);
    }

    parts.push(`</svg>`);

    const blob = new Blob([parts.join("\n")], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mit-prereqs-dept-${selectedDept}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, graph, selectedDept]);

  const allCoreqs = useMemo(() => {
    if (!selectedNode) return [];
    const cset = new Set<string>();
    for (const vid of selectedNode.variantIds) {
      const vc = courseMap.get(vid);
      if (vc) vc.coreqs.forEach((p) => cset.add(p));
    }
    const canonSet = new Set<string>();
    for (const p of cset) {
      const vof = variantGroups.get(p);
      canonSet.add(vof ? vof[0] : p);
    }
    canonSet.delete(selectedCourse!);
    return Array.from(canonSet);
  }, [selectedNode, selectedCourse]);

  return (
    <div style={{ width: "100%", height: "100vh", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        connectionMode={ConnectionMode.Loose}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#e0e0e0" gap={20} />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            const dept = (n.data as { dept?: string })?.dept;
            return dept ? DEPT_COLORS[dept] ?? "#999" : "#999";
          }}
          style={{ border: "1px solid #ddd" }}
        />

        <Panel position="top-left">
          <div
            style={{
              background: "white",
              borderRadius: 8,
              padding: 12,
              boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
              maxWidth: 280,
              maxHeight: "calc(100vh - 100px)",
              overflowY: "auto",
            }}
          >
            <h2
              style={{
                margin: "0 0 8px 0",
                fontSize: 14,
                fontWeight: 700,
                color: "#333",
              }}
            >
              MIT Course Prerequisite Map
            </h2>

            <input
              type="text"
              placeholder="Search courses..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "6px 8px",
                fontSize: 12,
                border: "1px solid #ddd",
                borderRadius: 4,
                marginBottom: 8,
                boxSizing: "border-box",
              }}
            />
            {searchResults.length > 0 && (
              <div
                style={{
                  border: "1px solid #eee",
                  borderRadius: 4,
                  marginBottom: 8,
                  maxHeight: 150,
                  overflowY: "auto",
                }}
              >
                {searchResults.map((r) => (
                  <div
                    key={r.id}
                    onClick={() => focusOnNode(r.id)}
                    style={{
                      padding: "4px 8px",
                      fontSize: 11,
                      cursor: "pointer",
                      borderBottom: "1px solid #f0f0f0",
                    }}
                    onMouseEnter={(e) =>
                      ((e.target as HTMLElement).style.background = "#f0f0ff")
                    }
                    onMouseLeave={(e) =>
                      ((e.target as HTMLElement).style.background = "white")
                    }
                  >
                    <strong>{r.id}</strong>{" "}
                    <span style={{ color: "#666" }}>{r.title}</span>
                    {r.dept !== selectedDept && (
                      <span
                        style={{
                          marginLeft: 4,
                          fontSize: 9,
                          color: DEPT_COLORS[r.dept] ?? "#999",
                          fontWeight: 600,
                        }}
                      >
                        dept {r.dept}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>
              Department:
            </div>
            {Object.entries(DEPARTMENTS).map(([code, name]) => (
              <label
                key={code}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  padding: "2px 0",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="dept"
                  checked={selectedDept === code}
                  onChange={() => selectDept(code)}
                />
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: DEPT_COLORS[code],
                    flexShrink: 0,
                  }}
                />
                <span>
                  {code} - {name}
                </span>
              </label>
            ))}

            <div
              style={{
                marginTop: 8,
                padding: "6px 0",
                borderTop: "1px solid #eee",
                fontSize: 10,
                color: "#888",
              }}
            >
              {graph.nodes.length} nodes, {graph.edges.length} edges
              {graph.sccs.length > 0 && (
                <div style={{ marginTop: 2 }}>
                  {graph.sccs.length} corequisite group(s)
                  <span style={{ color: "#e74c3c" }}>
                    {" "}
                    (double border = coreq SCC)
                  </span>
                </div>
              )}
            </div>

            <div
              style={{
                marginTop: 6,
                paddingTop: 6,
                borderTop: "1px solid #eee",
                fontSize: 10,
                color: "#666",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  marginBottom: 2,
                }}
              >
                <div style={{ width: 20, height: 2, background: "#888" }} />
                Prerequisite
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 20, height: 2, background: "#e74c3c" }} />
                Corequisite (animated)
              </div>
            </div>

            <button
              onClick={exportSvg}
              style={{
                marginTop: 8,
                padding: "6px 12px",
                fontSize: 11,
                border: "1px solid #ddd",
                borderRadius: 4,
                background: "white",
                cursor: "pointer",
                fontWeight: 600,
                width: "100%",
                color: "#333",
              }}
            >
              Export SVG
            </button>
          </div>
        </Panel>

        {courseInfo && selectedNode && (
          <Panel position="top-right">
            <div
              style={{
                background: "white",
                borderRadius: 8,
                padding: 14,
                boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
                maxWidth: 320,
                fontSize: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "start",
                }}
              >
                <div>
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 16,
                      fontWeight: 700,
                      color: DEPT_COLORS[courseInfo.dept] ?? "#333",
                    }}
                  >
                    {courseInfo.title}
                  </h3>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#888",
                      marginTop: 2,
                    }}
                  >
                    {getDeptName(courseInfo.dept)}
                  </div>
                </div>
                <button
                  onClick={() => {
                    setSelectedCourse(null);
                    setHighlightMode("none");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    fontSize: 16,
                    cursor: "pointer",
                    color: "#999",
                    padding: "0 4px",
                  }}
                >
                  x
                </button>
              </div>

              {/* Variant course numbers */}
              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                }}
              >
                {selectedNode.variantIds.map((vid) => (
                  <span
                    key={vid}
                    style={{
                      background: "#f0f0f0",
                      border: "1px solid #ddd",
                      borderRadius: 3,
                      padding: "1px 6px",
                      fontSize: 10,
                      fontFamily: "var(--font-geist-mono), monospace",
                      fontWeight: 600,
                    }}
                  >
                    {vid}
                  </span>
                ))}
              </div>

              {allPrereqs.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div
                    style={{ fontWeight: 600, fontSize: 11, color: "#555" }}
                  >
                    Prerequisites:
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 4,
                      marginTop: 3,
                    }}
                  >
                    {allPrereqs.map((p) => {
                      const pc = courseMap.get(p);
                      return (
                        <span
                          key={p}
                          onClick={() => focusOnNode(p)}
                          style={{
                            background: pc ? "#e8f4fd" : "#f5f5f5",
                            border: "1px solid #ccc",
                            borderRadius: 3,
                            padding: "1px 6px",
                            fontSize: 10,
                            cursor: pc ? "pointer" : "default",
                            color: pc ? "#2980b9" : "#999",
                          }}
                          title={pc?.title}
                        >
                          {pc?.title
                            ? truncate(pc.title, 20) + ` (${p})`
                            : p}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {allCoreqs.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 11,
                      color: "#e74c3c",
                    }}
                  >
                    Corequisites (SCC):
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 4,
                      marginTop: 3,
                    }}
                  >
                    {allCoreqs.map((p) => {
                      const pc = courseMap.get(p);
                      return (
                        <span
                          key={p}
                          onClick={() => focusOnNode(p)}
                          style={{
                            background: "#fde8e8",
                            border: "1px solid #e74c3c",
                            borderRadius: 3,
                            padding: "1px 6px",
                            fontSize: 10,
                            cursor: "pointer",
                            color: "#c0392b",
                          }}
                          title={pc?.title}
                        >
                          {pc?.title
                            ? truncate(pc.title, 20) + ` (${p})`
                            : p}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                <button
                  onClick={() =>
                    setHighlightMode(
                      highlightMode === "prereqs" ? "none" : "prereqs"
                    )
                  }
                  style={{
                    padding: "4px 10px",
                    fontSize: 10,
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    background:
                      highlightMode === "prereqs" ? "#3498db" : "white",
                    color: highlightMode === "prereqs" ? "white" : "#333",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  Show Prereq Chain
                </button>
                <button
                  onClick={() =>
                    setHighlightMode(
                      highlightMode === "dependents" ? "none" : "dependents"
                    )
                  }
                  style={{
                    padding: "4px 10px",
                    fontSize: 10,
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    background:
                      highlightMode === "dependents" ? "#e67e22" : "white",
                    color: highlightMode === "dependents" ? "white" : "#333",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  Show Dependents
                </button>
              </div>
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}
