import { createHash } from "node:crypto";
export function sha256(value){return createHash("sha256").update(value).digest("hex");}
export function stableId(type,value){return type+":"+value;}
export function sanitizeSummary(value){
 return String(value??"").replace(/\b[6-9]\d{9}\b/g,"[redacted-phone]")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[redacted-email]")
  .replace(/\b(?:sk|pk|api|secret|token)[-_]?[A-Za-z0-9_-]{16,}\b/gi,"[redacted-secret]")
  .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi,"Bearer [redacted]")
  .replace(/\b\d{5,}\b/g,"[redacted-number]").slice(0,900);
}
export function validateGraph(nodes,edges){
 const errors=[],ids=new Set(),edgeIds=new Set();
 for(const [i,n] of nodes.entries()){
  if(!n?.node_id||!n?.node_type||!n?.name){errors.push("node["+i+"] missing required fields");continue;}
  if(ids.has(n.node_id))errors.push("duplicate node id: "+n.node_id);
  ids.add(n.node_id);
  if(typeof n.confidence!=="number"||n.confidence<0||n.confidence>1)errors.push("node["+i+"] invalid confidence");
 }
 for(const [i,e] of edges.entries()){
  if(!e?.edge_id||!e?.source_node_id||!e?.target_node_id||!e?.relationship){errors.push("edge["+i+"] missing required fields");continue;}
  if(edgeIds.has(e.edge_id))errors.push("duplicate edge id: "+e.edge_id);
  edgeIds.add(e.edge_id);
  if(!ids.has(e.source_node_id))errors.push("edge["+i+"] dangling source "+e.source_node_id);
  if(!ids.has(e.target_node_id))errors.push("edge["+i+"] dangling target "+e.target_node_id);
  if(typeof e.confidence!=="number"||e.confidence<0||e.confidence>1)errors.push("edge["+i+"] invalid confidence");
 }
 if(!nodes.length)errors.push("graph contains no nodes");
 return errors;
}
