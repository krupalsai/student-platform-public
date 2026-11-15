import type { SupabaseClient } from "@supabase/supabase-js";

type GraphNode = {
  node_id: string;
  node_type: string;
  name: string;
  summary: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  confidence: number | null;
};
type GraphEdge = {
  source_node_id: string;
  target_node_id: string;
  relationship: string;
  confidence: number | null;
};

/**
 * Source-grounded business-flow trace. This deliberately reports graph
 * evidence and traversal direction rather than inventing runtime order.
 * The Admin Copilot may interpret the evidence, but must label inference.
 */
export async function traceBusinessFlow(
  db: SupabaseClient,
  rawQuery: string,
): Promise<{
  activeVersion: string;
  query: string;
  evidence: Array<{
    role: "entrypoint" | "implementation" | "data" | "dependency" | "documentation";
    nodeType: string;
    name: string;
    summary: string;
    filePath: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    confidence: number;
  }>;
  relationships: Array<{ from: string; relation: string; to: string; confidence: number }>;
  caveat: string;
} | { available: false; reason: string }> {
  const query = rawQuery.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!query) return { available: false, reason: "Provide a feature, API route, or business process to trace." };

  const { data: state, error: stateError } = await db.from("knowledge_graph_state")
    .select("active_graph_version").eq("singleton", true).maybeSingle();
  if (stateError || !state?.active_graph_version) {
    return { available: false, reason: "The architecture graph has not been published yet." };
  }
  const version = String(state.active_graph_version);
  const stop = new Set(["the", "and", "for", "with", "from", "what", "where", "when", "how", "does", "our", "show", "explain", "trace", "flow", "process", "into", "this", "that", "work"]);
  const terms = [...new Set(query.split(/[^a-zA-Z0-9_./-]+/)
    .filter(term => term.length >= 3 && !stop.has(term.toLowerCase())))].slice(0, 5);
  if (!terms.length) return { activeVersion: version, query, evidence: [], relationships: [], caveat: "No searchable terms were found." };

  const filters = terms.flatMap(term => {
    const safe = term.replace(/[^a-zA-Z0-9_./-]/g, "");
    return ["name.ilike.%" + safe + "%", "summary.ilike.%" + safe + "%", "file_path.ilike.%" + safe + "%"];
  });
  const { data: seeds, error } = await db.from("knowledge_graph_nodes")
    .select("node_id,node_type,name,summary,file_path,line_start,line_end,confidence")
    .eq("graph_version", version).or(filters.join(",")).limit(40);
  if (error) return { available: false, reason: "Business-flow search is temporarily unavailable." };

  const rank = (node: GraphNode) => {
    const typeRank: Record<string, number> = {
      api: 0, document_section: 1, database_table: 2, function: 3, file: 4,
    };
    const exact = terms.some(term => node.name.toLowerCase() === term.toLowerCase()) ? -2 : 0;
    return (typeRank[node.node_type] ?? 8) + exact;
  };
  const selected = [...(seeds ?? [])].sort((a, b) => rank(a as GraphNode) - rank(b as GraphNode)).slice(0, 5) as GraphNode[];
  if (!selected.length) return { activeVersion: version, query, evidence: [], relationships: [], caveat: "No matching source evidence was found in the active graph." };

  const nodeMap = new Map<string, GraphNode>(selected.map(node => [node.node_id, node]));
  const edgeMap = new Map<string, GraphEdge>();
  let frontier = selected.map(node => node.node_id);
  const traversable = new Set(["implemented_by", "handles", "calls", "reads_from", "writes_to", "imports", "defines_schema"]);
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const [out, incoming] = await Promise.all([
      db.from("knowledge_graph_edges").select("source_node_id,target_node_id,relationship,confidence")
        .eq("graph_version", version).in("source_node_id", frontier).limit(120),
      db.from("knowledge_graph_edges").select("source_node_id,target_node_id,relationship,confidence")
        .eq("graph_version", version).in("target_node_id", frontier).limit(120),
    ]);
    if (out.error || incoming.error) return { available: false, reason: "Business-flow relationships could not be loaded." };
    const edges = [...(out.data ?? []), ...(incoming.data ?? [])] as GraphEdge[];
    const next = new Set<string>();
    for (const edge of edges) {
      if (!traversable.has(edge.relationship)) continue;
      edgeMap.set([edge.source_node_id, edge.relationship, edge.target_node_id].join(":"),
        edge);
      const other = nodeMap.has(edge.source_node_id) ? edge.target_node_id
        : nodeMap.has(edge.target_node_id) ? edge.source_node_id : null;
      if (other && !nodeMap.has(other)) next.add(other);
    }
    if (!next.size) break;
    const ids = [...next].slice(0, 50);
    const { data: related, error: relatedError } = await db.from("knowledge_graph_nodes")
      .select("node_id,node_type,name,summary,file_path,line_start,line_end,confidence")
      .eq("graph_version", version).in("node_id", ids).limit(50);
    if (relatedError) return { available: false, reason: "Business-flow evidence could not be loaded." };
    for (const node of (related ?? []) as GraphNode[]) nodeMap.set(node.node_id, node);
    frontier = ids.filter(id => nodeMap.has(id));
  }

  const edges = [...edgeMap.values()].filter(edge => nodeMap.has(edge.source_node_id) && nodeMap.has(edge.target_node_id));
  const evidence = [...nodeMap.values()].slice(0, 45).map(node => ({
    role: node.node_type === "api" ? "entrypoint" as const
      : node.node_type === "database_table" ? "data" as const
      : node.node_type === "document_section" ? "documentation" as const
      : node.node_type === "function" ? "implementation" as const : "dependency" as const,
    nodeType: node.node_type, name: node.name, summary: node.summary,
    filePath: node.file_path, lineStart: node.line_start, lineEnd: node.line_end,
    confidence: Number(node.confidence ?? 1),
  }));
  const relationships = edges.slice(0, 100).map(edge => ({
    from: nodeMap.get(edge.source_node_id)?.name ?? edge.source_node_id,
    relation: edge.relationship,
    to: nodeMap.get(edge.target_node_id)?.name ?? edge.target_node_id,
    confidence: Number(edge.confidence ?? 1),
  }));
  return {
    activeVersion: version, query, evidence, relationships,
    caveat: "These are static repository relationships, not proof of runtime execution order. Distinguish directly indexed evidence from inferred business-process steps. Source paths and line ranges are the verification anchors.",
  };
}
