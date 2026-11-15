-- Architecture metadata only. No student, payment, or uploaded-document data.
create table if not exists public.knowledge_graph_runs (
  id uuid primary key default gen_random_uuid(),
  graph_version text not null,
  commit_sha text not null,
  status text not null default 'running' check (status in ('running','completed','failed')),
  node_count integer not null default 0,
  edge_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists knowledge_graph_runs_started_idx on public.knowledge_graph_runs(started_at desc);

create table if not exists public.knowledge_graph_nodes (
  graph_version text not null,
  node_id text not null,
  node_type text not null,
  name text not null,
  summary text not null default '',
  file_path text,
  line_start integer,
  line_end integer,
  content_hash text,
  confidence numeric(4,3) not null default 1 check (confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  primary key(graph_version,node_id)
);
create index if not exists knowledge_graph_nodes_type_idx on public.knowledge_graph_nodes(graph_version,node_type);
create index if not exists knowledge_graph_nodes_path_idx on public.knowledge_graph_nodes(graph_version,file_path);
create index if not exists knowledge_graph_nodes_search_idx on public.knowledge_graph_nodes using gin(to_tsvector('simple',name || ' ' || summary));

create table if not exists public.knowledge_graph_edges (
  graph_version text not null,
  edge_id text not null,
  source_node_id text not null,
  target_node_id text not null,
  relationship text not null,
  confidence numeric(4,3) not null default 1 check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  primary key(graph_version,edge_id),
  foreign key(graph_version,source_node_id) references public.knowledge_graph_nodes(graph_version,node_id) on delete cascade,
  foreign key(graph_version,target_node_id) references public.knowledge_graph_nodes(graph_version,node_id) on delete cascade
);
create index if not exists knowledge_graph_edges_source_idx on public.knowledge_graph_edges(graph_version,source_node_id);
create index if not exists knowledge_graph_edges_target_idx on public.knowledge_graph_edges(graph_version,target_node_id);

create table if not exists public.knowledge_graph_state (
  singleton boolean primary key default true check(singleton),
  active_graph_version text,
  updated_at timestamptz not null default now()
);
insert into public.knowledge_graph_state(singleton,active_graph_version) values(true,null) on conflict(singleton) do nothing;

alter table public.knowledge_graph_runs enable row level security;
alter table public.knowledge_graph_nodes enable row level security;
alter table public.knowledge_graph_edges enable row level security;
alter table public.knowledge_graph_state enable row level security;
revoke all on public.knowledge_graph_runs,public.knowledge_graph_nodes,public.knowledge_graph_edges,public.knowledge_graph_state from anon,authenticated;
grant all on public.knowledge_graph_runs,public.knowledge_graph_nodes,public.knowledge_graph_edges,public.knowledge_graph_state to service_role;

create or replace function public.publish_knowledge_graph(p_run_id uuid,p_graph_version text,p_nodes jsonb,p_edges jsonb)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if p_graph_version is null or length(p_graph_version)<7 then raise exception 'Invalid graph version'; end if;
  if jsonb_typeof(p_nodes)<>'array' or jsonb_typeof(p_edges)<>'array' or jsonb_array_length(p_nodes)=0 then
    raise exception 'Nodes and edges must be non-empty JSON arrays';
  end if;
  delete from public.knowledge_graph_edges where graph_version=p_graph_version;
  delete from public.knowledge_graph_nodes where graph_version=p_graph_version;
  insert into public.knowledge_graph_nodes(graph_version,node_id,node_type,name,summary,file_path,line_start,line_end,content_hash,confidence,metadata)
  select p_graph_version,x.node_id,x.node_type,x.name,coalesce(x.summary,''),x.file_path,x.line_start,x.line_end,x.content_hash,coalesce(x.confidence,1),coalesce(x.metadata,'{}'::jsonb)
  from jsonb_to_recordset(p_nodes) as x(node_id text,node_type text,name text,summary text,file_path text,line_start integer,line_end integer,content_hash text,confidence numeric,metadata jsonb);
  insert into public.knowledge_graph_edges(graph_version,edge_id,source_node_id,target_node_id,relationship,confidence,evidence,metadata)
  select p_graph_version,x.edge_id,x.source_node_id,x.target_node_id,x.relationship,coalesce(x.confidence,1),coalesce(x.evidence,'{}'::jsonb),coalesce(x.metadata,'{}'::jsonb)
  from jsonb_to_recordset(p_edges) as x(edge_id text,source_node_id text,target_node_id text,relationship text,confidence numeric,evidence jsonb,metadata jsonb);
  update public.knowledge_graph_state set active_graph_version=p_graph_version,updated_at=now() where singleton=true;
  update public.knowledge_graph_runs set status='completed',node_count=jsonb_array_length(p_nodes),edge_count=jsonb_array_length(p_edges),completed_at=now(),error_message=null where id=p_run_id;
  delete from public.knowledge_graph_edges where graph_version not in(select graph_version from public.knowledge_graph_runs where status='completed' order by completed_at desc nulls last limit 3);
  delete from public.knowledge_graph_nodes where graph_version not in(select graph_version from public.knowledge_graph_runs where status='completed' order by completed_at desc nulls last limit 3);
end;
$$;
revoke all on function public.publish_knowledge_graph(uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.publish_knowledge_graph(uuid,text,jsonb,jsonb) to service_role;
