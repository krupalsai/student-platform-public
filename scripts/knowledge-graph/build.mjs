#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import ts from "typescript";
import { createClient } from "@supabase/supabase-js";
import { sha256, stableId, validateGraph, sanitizeSummary } from "./graph-core.mjs";

const root = process.cwd();
const nodeMap = new Map();
const edgeMap = new Map();
const skip = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", "android", "ios", "media-server"]);
const rel = p => path.relative(root, p).split(path.sep).join("/");
const lineAt = (s, i) => s.slice(0, i).split("\n").length;
function addNode(n) {
  const safe = { ...n, name: sanitizeSummary(n.name), summary: sanitizeSummary(n.summary) };
  const existing = nodeMap.get(safe.node_id);
  if (!existing) nodeMap.set(safe.node_id, { confidence: 1, metadata: {}, ...safe });
  else nodeMap.set(safe.node_id, { ...existing, ...safe, metadata: { ...(existing.metadata || {}), ...(safe.metadata || {}) } });
  return safe.node_id;
}
function addEdge(a,b,type,evidence={},metadata={}) {
  if (!nodeMap.has(a) || !nodeMap.has(b)) return;
  const id = type + ":" + sha256(a + "|" + b + "|" + JSON.stringify(evidence)).slice(0,20);
  edgeMap.set(id,{edge_id:id,source_node_id:a,target_node_id:b,relationship:type,confidence:1,evidence,metadata});
}
async function walk(dir) {
  let entries=[]; try { entries=await fs.readdir(dir,{withFileTypes:true}); } catch { return []; }
  const out=[];
  for (const e of entries) {
    if (e.name.startsWith(".") || skip.has(e.name)) continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory()) out.push(...await walk(p)); else if(e.isFile()) out.push(p);
  }
  return out;
}
function comment(sf,n) {
  const ranges=ts.getLeadingCommentRanges(sf.text,n.getFullStart())||[];
  for(const r of ranges.reverse()){
    const v=sf.text.slice(r.pos,r.end).replace(/^\/\*\*?/,"").replace(/\*\/$/,"").replace(/^\s*\* ?/gm,"").trim();
    if(v) return v.split(/\n\s*\n/)[0].replace(/\s+/g," ").slice(0,400);
  }
  return "";
}
function symbol(n,type,file,sf,name) {
  const start=lineAt(sf.text,n.getStart(sf));
  return {node_id:stableId(type,file+"#"+name+"@"+start),node_type:type,name,
    summary:comment(sf,n)||type+" "+name+" declared in "+file+".",file_path:file,
    line_start:start,line_end:lineAt(sf.text,n.getEnd()),content_hash:sha256(n.getText(sf)),
    confidence:1,metadata:{extraction:"typescript-ast"}};
}
function resolve(importer,spec,known) {
  let base;
  if(spec.startsWith("@/")) base=path.join(root,"src",spec.slice(2));
  else if(spec.startsWith(".")) base=path.resolve(path.dirname(path.join(root,importer)),spec);
  else return null;
  const candidates=[base,...[".ts",".tsx",".js",".jsx",".mjs",".json"].map(x=>base+x),
    ...["index.ts","index.tsx","index.js"].map(x=>path.join(base,x))];
  for(const p of candidates) if(known.has(rel(p))) return rel(p);
  return null;
}
async function main(){
  const found=[];
  for(const dir of ["src","supabase/migrations","docs",".github/workflows","scripts/knowledge-graph"]) found.push(...await walk(path.join(root,dir)));
  for(const file of ["README.md","package.json","tsconfig.json","next.config.js","next.config.ts","vercel.json"]) {
    try { await fs.access(path.join(root,file)); found.push(path.join(root,file)); } catch {}
  }
  const paths=found.map(rel).sort(),known=new Set(paths);
  const code=paths.filter(p=>/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)&&!p.endsWith(".d.ts"));
  const sql=paths.filter(p=>/^supabase\/migrations\/.*\.sql$/i.test(p));
  const docs=paths.filter(p=>/^docs\/.*\.md$/i.test(p)||p==="README.md");

  // Pre-register every source file before parsing imports so edges to files
  // that sort later are not silently discarded.
  for(const file of code) addNode({
    node_id:stableId("file",file),node_type:"file",name:path.basename(file),
    summary:"Source file discovered by repository scanner.",file_path:file,
    line_start:1,line_end:0,confidence:1,metadata:{extraction:"file-inventory"}
  });

  for(const file of code){
    const source=await fs.readFile(path.join(root,file),"utf8");
    const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const fileId=addNode({node_id:stableId("file",file),node_type:"file",name:path.basename(file),
      summary:"Source file containing "+source.split("\n").length+" lines of application code.",
      file_path:file,line_start:1,line_end:source.split("\n").length,content_hash:sha256(source),
      confidence:1,metadata:{language:file.endsWith(".tsx")?"tsx":"typescript"}});
    const symbols=new Map();
    const pendingCalls=[];
    function visit(n,owner=null){
      let current=owner;
      if(ts.isFunctionDeclaration(n)&&n.name){
        const info=symbol(n,"function",file,sf,n.name.text);current=addNode(info);symbols.set(n.name.text,current);
        addEdge(fileId,current,"contains",{file_path:file,line:info.line_start});
      }else if(ts.isClassDeclaration(n)&&n.name){
        const info=symbol(n,"class",file,sf,n.name.text);current=addNode(info);addEdge(fileId,current,"contains",{file_path:file,line:info.line_start});
      }else if(ts.isMethodDeclaration(n)&&n.name){
        const info=symbol(n,"function",file,sf,n.name.getText(sf));current=addNode(info);
        addEdge(owner||fileId,current,"contains",{file_path:file,line:info.line_start});
      }else if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer&&(ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer))){
        const info=symbol(n,"function",file,sf,n.name.text);current=addNode(info);symbols.set(n.name.text,current);
        addEdge(fileId,current,"contains",{file_path:file,line:info.line_start});
      }else if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==="from"&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0])){
        const table=n.arguments[0].text;
        if(/^[a-z_][a-z0-9_]*$/i.test(table)){
          const tid=addNode({node_id:stableId("database_table",table),node_type:"database_table",name:table,
            summary:"Database table referenced by application code: "+table+".",file_path:file,
            line_start:lineAt(source,n.getStart(sf)),line_end:lineAt(source,n.getEnd()),
            confidence:0.95,metadata:{extraction:"supabase-from-call"}});
          const chain=source.slice(n.getStart(sf),Math.min(source.length,n.getEnd()+600));
          const write=/\.(insert|update|upsert|delete)\s*\(/.test(chain);
          addEdge(current||fileId,tid,write?"writes_to":"reads_from",{file_path:file,line:lineAt(source,n.getStart(sf))},{table});
        }
      } else if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)) {
        pendingCalls.push({name:n.expression.text,owner:current||fileId,line:lineAt(source,n.getStart(sf))});
      }
      ts.forEachChild(n,c=>visit(c,current));
    }
    visit(sf);
    for(const call of pendingCalls) if(symbols.has(call.name))
      addEdge(call.owner,symbols.get(call.name),"calls",{file_path:file,line:call.line},{symbol:call.name});
    function imports(n){
      if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)){
        const target=resolve(file,n.moduleSpecifier.text,known);
        if(target)addEdge(fileId,stableId("file",target),"imports",{file_path:file,line:lineAt(source,n.getStart(sf))},{specifier:n.moduleSpecifier.text});
      }
      ts.forEachChild(n,imports);
    }
    imports(sf);
    // Index environment-variable NAMES only; never read or persist their values.
    for(const match of source.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g)) {
      const variable = match[1];
      const variableId = addNode({node_id:stableId("environment_variable",variable),node_type:"environment_variable",
        name:variable,summary:"Server environment variable referenced by application code; its value is intentionally not indexed.",
        confidence:1,metadata:{extraction:"process-env-reference"}});
      addEdge(fileId,variableId,"references_config",{file_path:file,line:lineAt(source,match.index)});
    }
    const route=file.match(/^src\/app\/(.*)\/route\.(ts|js)$/);
    if(route){
      const name="/"+route[1].replace(/\[(\.\.\.)?([^\]]+)\]/g,":$2");
      const api=addNode({node_id:stableId("api",name),node_type:"api",name,
        summary:"Next.js route handler implemented by "+file+".",file_path:file,line_start:1,
        line_end:source.split("\n").length,content_hash:sha256(source),confidence:1,metadata:{}});
      addEdge(api,fileId,"implemented_by",{file_path:file,line:1});
      for(const method of ["GET","POST","PUT","PATCH","DELETE"])if(symbols.has(method))
        addEdge(api,symbols.get(method),"handles",{file_path:file,line:nodeMap.get(symbols.get(method)).line_start},{method});
    }
  }
  for(const file of sql){
    const source=await fs.readFile(path.join(root,file),"utf8");
    const migration=addNode({node_id:stableId("migration",file),node_type:"migration",name:path.basename(file),
      summary:"SQL schema migration: "+path.basename(file),file_path:file,line_start:1,
      line_end:source.split("\n").length,content_hash:sha256(source),confidence:1,metadata:{extraction:"sql-patterns"}});
    const pattern=/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["']?([a-z_][a-z0-9_]*)["']?/gi;
    for(const m of source.matchAll(pattern)){
      const table=m[1].toLowerCase();
      const tid=addNode({node_id:stableId("database_table",table),node_type:"database_table",name:table,
        summary:"Database table declared in migration "+path.basename(file)+".",file_path:file,
        line_start:lineAt(source,m.index),line_end:lineAt(source,m.index),confidence:1,metadata:{extraction:"sql-create-table"}});
      addEdge(migration,tid,"defines_schema",{file_path:file,line:lineAt(source,m.index)});
    }
  }
  for(const file of docs){
    const source=await fs.readFile(path.join(root,file),"utf8");
    const lines=source.split("\n");
    const first=source.split(/\n\s*\n/).map(x=>x.replace(/^#+\s*/gm,"").trim()).find(Boolean)||"Documentation file "+file;
    const documentId=addNode({node_id:stableId("document",file),node_type:"document",name:path.basename(file),
      summary:first.replace(/\s+/g," ").slice(0,500),file_path:file,line_start:1,
      line_end:lines.length,content_hash:sha256(source),confidence:1,metadata:{extraction:"markdown"}});
    let heading=path.basename(file),headingLine=1,paragraphs=[];
    const flushSection=(endLine)=>{
      const body=paragraphs.join(" ").replace(/\s+/g," ").trim();
      if(!body)return;
      const sectionId=addNode({node_id:stableId("document_section",file+"#"+heading+"@"+headingLine),
        node_type:"document_section",name:heading,summary:body.slice(0,900),file_path:file,
        line_start:headingLine,line_end:endLine,content_hash:sha256(body),confidence:1,
        metadata:{extraction:"markdown-section"}});
      addEdge(documentId,sectionId,"contains_section",{file_path:file,line:headingLine});
    };
    let inCode=false;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(line.trim().startsWith(String.fromCharCode(96,96,96))){inCode=!inCode;continue;}
      if(inCode)continue;
      const match=line.match(/^#{1,4}\s+(.+)$/);
      if(match){flushSection(i);heading=match[1].trim();headingLine=i+1;paragraphs=[];continue;}
      const trimmed=line.trim();
      if(!trimmed||trimmed.startsWith("|")||/^[-*_]{3,}$/.test(trimmed))continue;
      if(paragraphs.join(" ").length<1400) paragraphs.push(trimmed.replace(/^[-*+]\s+/,"").replace(/^\d+[.)]\s+/,""));
    }
    flushSection(lines.length);
  }
  const configs=paths.filter(file=>["package.json","tsconfig.json","next.config.js","next.config.ts","vercel.json"].includes(file)||file.startsWith(".github/workflows/"));
  for(const file of configs){
    const source=await fs.readFile(path.join(root,file),"utf8");
    let summary="Application configuration file "+file+".";
    if(file==="package.json"){
      try {
        const manifest=JSON.parse(source);
        summary="Project package manifest. Runtime dependencies: "+Object.keys(manifest.dependencies||{}).join(", ")+".";
      } catch {}
    } else if(file.startsWith(".github/workflows/")) {
      const title=source.match(/^name:\s*(.+)$/m);
      summary="GitHub Actions workflow. "+(title?title[1]:"Workflow configuration.");
    }
    addNode({node_id:stableId("config",file),node_type:"config",name:path.basename(file),
      summary:summary.slice(0,500),file_path:file,line_start:1,line_end:source.split("\n").length,
      content_hash:sha256(source),confidence:1,metadata:{extraction:"configuration-file"}});
  }
  const ns=[...nodeMap.values()],es=[...edgeMap.values()],errors=validateGraph(ns,es);
  if(errors.length)throw new Error("Graph validation failed: "+errors.slice(0,20).join("; "));
  const aggregate=createHash("sha256");
  for(const n of ns)aggregate.update(n.node_id+":"+(n.content_hash||"")+"\n");
  for(const e of es)aggregate.update(e.edge_id+"\n");
  const version=process.env.GITHUB_SHA||aggregate.digest("hex"),commit=process.env.GITHUB_SHA||"local";
  console.log(JSON.stringify({graphVersion:version,files:paths.length,sourceFiles:code.length,migrations:sql.length,documents:docs.length,nodes:ns.length,edges:es.length,validated:true},null,2));
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url||!key){if(process.argv.includes("--require-persistence"))throw new Error("Supabase secrets are required for publishing.");console.log("Dry run only; graph was not persisted.");return;}
  const db=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}}),runId=randomUUID();
  const started=await db.from("knowledge_graph_runs").insert({id:runId,graph_version:version,commit_sha:commit,status:"running"});
  if(started.error)throw started.error;
  try{
    const result=await db.rpc("publish_knowledge_graph",{p_run_id:runId,p_graph_version:version,p_nodes:ns,p_edges:es});
    if(result.error)throw result.error;
    console.log("Published "+ns.length+" nodes and "+es.length+" edges.");
  }catch(error){
    await db.from("knowledge_graph_runs").update({status:"failed",error_message:String(error).slice(0,1500),completed_at:new Date().toISOString()}).eq("id",runId);
    throw error;
  }
}
main().catch(e=>{console.error("[knowledge-graph] "+(e?.message||e));process.exitCode=1;});
