import type { SupabaseClient } from "@supabase/supabase-js";

export interface KnowledgeSearchResult {
  activeVersion: string;
  nodes: Array<{
    id: string; type: string; name: string; summary: string;
    filePath: string | null; lineStart: number | null; lineEnd: number | null;
    confidence: number;
    relationships: Array<{ type: string; target: string; targetType: string }>;
  }>;
}

/** Read-only repository architecture retrieval for trusted server-side agents. */
export async function searchKnowledgeGraph(
  db: SupabaseClient,
  rawQuery: string,
): Promise<KnowledgeSearchResult | { available: false; reason: string }> {
  const query = rawQuery.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!query) return { available: false, reason: "Provide an architecture or code question." };

  const { data: state, error: stateError } = await db.from("knowledge_graph_state")
    .select("active_graph_version").eq("singleton", true).maybeSingle();
  if (stateError || !state?.active_graph_version) {
    return { available: false, reason: "The architecture graph has not been published yet." };
  }

  const version = state.active_graph_version as string;
  const stopWords = new Set(["the", "and", "for", "with", "from", "what", "where", "when", "how", "does", "our", "show", "explain", "find", "trace", "into", "this", "that", "about"]);
  const terms = [...new Set(query.split(/[^a-zA-Z0-9_./-]+/).filter(term => term.length >= 3 && !stopWords.has(term.toLowerCase())))].slice(0, 5);
  if (!terms.length) return { activeVersion: version, nodes: [] };
  const filters = terms.flatMap(term => {
    const safe = term.replace(/[^a-zA-Z0-9_./-]/g, "");
    return ["name.ilike.%" + safe + "%", "summary.ilike.%" + safe + "%", "file_path.ilike.%" + safe + "%"];
  });
  const { data: matches, error: queryError } = await db.from("knowledge_graph_nodes")
    .select("node_id,node_type,name,summary,file_path,line_start,line_end,confidence")
    .eq("graph_version", version).or(filters.join(",")).limit(24);
  if (queryError) return { available: false, reason: "Architecture search is temporarily unavailable." };

  const unique = new Map<string, any>();
  for (const row of matches || []) unique.set(row.node_id, row);
  const selected = [...unique.values()].slice(0, 10);
  if (!selected.length) return { activeVersion: version, nodes: [] };

  const ids = selected.map(row => row.node_id);
  const [outgoing, incoming] = await Promise.all([
    db.from("knowledge_graph_edges").select("source_node_id,target_node_id,relationship")
      .eq("graph_version", version).in("source_node_id", ids).limit(40),
    db.from("knowledge_graph_edges").select("source_node_id,target_node_id,relationship")
      .eq("graph_version", version).in("target_node_id", ids).limit(40),
  ]);
  const edgeError = outgoing.error || incoming.error;
  if (edgeError) return { available: false, reason: "Architecture relationships could not be loaded." };
  const edges = [...(outgoing.data || []), ...(incoming.data || [])];

  const relatedIds = [...new Set((edges || []).flatMap((edge: any) => [edge.source_node_id, edge.target_node_id]))];
  const related = relatedIds.length
    ? await db.from("knowledge_graph_nodes").select("node_id,node_type,name")
        .eq("graph_version", version).in("node_id", relatedIds).limit(60)
    : { data: [] as any[] };
  const relatedMap = new Map((related.data || []).map((node: any) => [node.node_id, node]));

  return {
    activeVersion: version,
    nodes: selected.map(row => ({
      id: row.node_id, type: row.node_type, name: row.name, summary: row.summary,
      filePath: row.file_path, lineStart: row.line_start, lineEnd: row.line_end,
      confidence: Number(row.confidence ?? 1),
      relationships: (edges || []).filter((edge: any) => edge.source_node_id === row.node_id || edge.target_node_id === row.node_id)
        .map((edge: any) => {
          const otherId = edge.source_node_id === row.node_id ? edge.target_node_id : edge.source_node_id;
          const target: any = relatedMap.get(otherId);
          return { type: edge.relationship, target: target?.name || otherId, targetType: target?.node_type || "unknown" };
        }),
    })),
  };
}
