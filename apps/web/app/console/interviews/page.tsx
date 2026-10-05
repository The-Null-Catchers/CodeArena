"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../../lib/api";

type Room = { id:string; title:string; status:"active"|"ended"; role:string; project_id:string; document_revision:number; created_at:string };
type Project = { id:string; name:string };

export default function InterviewsPage(){
  const [rooms,setRooms]=useState<Room[]>([]); const [projects,setProjects]=useState<Project[]>([]);
  const [projectId,setProjectId]=useState(""); const [title,setTitle]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  const load=async()=>{ try { const [r,p]=await Promise.all([api("/v1/interview-rooms"),api("/v1/projects")]); setRooms(r.items||[]); setProjects(p.items||[]); if(!projectId && p.items?.[0]?.id) setProjectId(p.items[0].id); } catch(e){ setError((e as Error).message); } };
  useEffect(()=>{ void load(); },[]);
  const create=async()=>{ if(!projectId||!title.trim()) return; setBusy(true); setError(""); try{ const room=await api("/v1/interview-rooms",{method:"POST",body:JSON.stringify({projectId,title:title.trim()})}); window.location.assign(`/console/interviews/${room.id}`); }catch(e){ setError((e as Error).message); setBusy(false);} };
  return <>
    <div className="page-title"><div><h1>Interview rooms</h1><p>Run collaborative coding interviews with durable shared state and live presence.</p></div><span className="pill">LIVE COLLABORATION</span></div>
    {error&&<div className="error" role="alert">{error}</div>}
    <section className="panel"><div className="panel-head"><span>CREATE ROOM</span><span>WebSocket + durable replay</span></div>
      <div className="form-row" style={{padding:16,alignItems:"end",flexWrap:"wrap"}}>
        <label style={{minWidth:220}}>Project<select value={projectId} onChange={e=>setProjectId(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label style={{flex:1,minWidth:260}}>Title<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Senior backend interview" maxLength={120}/></label>
        <button className="button" disabled={busy||!projectId||!title.trim()} onClick={create}>{busy?"Creating…":"Create room"}</button>
      </div>
    </section>
    <section className="panel" style={{marginTop:16}}><div className="panel-head"><span>YOUR ROOMS</span><button className="button small" onClick={()=>void load()}>Refresh</button></div>
      {rooms.length===0?<p className="code muted" style={{padding:16}}>No interview rooms yet.</p>:<div className="table-wrap"><table><thead><tr><th>Room</th><th>Status</th><th>Role</th><th>Revision</th><th>Created</th></tr></thead><tbody>{rooms.map(r=><tr key={r.id}><td><Link href={`/console/interviews/${r.id}`}>{r.title}</Link></td><td><span className={`state ${r.status==="ended"?"failed":"completed"}`}>{r.status}</span></td><td>{r.role}</td><td className="mono">{r.document_revision}</td><td>{new Date(r.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}
