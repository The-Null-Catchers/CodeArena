"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { API, api } from "../../../../lib/api";

type Room={id:string;title:string;status:"active"|"ended";role:"interviewer"|"candidate"|"observer";document:string;document_revision:number;runtime_id?:string|null};
type Presence={userId:string;role:string;state:string;lastSeenAt:string};
type EventRow={id:number;kind:string;actor_user_id?:string;created_at:string};

function wsUrl(roomId:string,after:number){ const base=new URL(API); const proto=base.protocol==="https:"?"wss:":"ws:"; return `${proto}//${base.host}/v1/interview-rooms/${roomId}/ws?after=${after}`; }

export default function InterviewRoomPage(){
  const {id}=useParams<{id:string}>(); const [room,setRoom]=useState<Room|null>(null); const [doc,setDoc]=useState(""); const [revision,setRevision]=useState(0);
  const [presence,setPresence]=useState<Presence[]>([]); const [events,setEvents]=useState<EventRow[]>([]); const [status,setStatus]=useState("connecting"); const [error,setError]=useState("");
  const cursor=useRef(0); const socket=useRef<WebSocket|null>(null); const reconnect=useRef<ReturnType<typeof setTimeout>|null>(null); const pending=useRef(false);
  const refreshRoom=async()=>{ const r=await api(`/v1/interview-rooms/${id}`); setRoom(r); setDoc(r.document||""); setRevision(Number(r.document_revision||0)); };
  useEffect(()=>{ void refreshRoom().catch(e=>setError((e as Error).message)); },[id]);
  useEffect(()=>{ if(!id) return; let closed=false;
    const connect=()=>{ const token=sessionStorage.getItem("ca_access"); if(!token){window.location.assign("/login");return;} setStatus("connecting"); const ws=new WebSocket(wsUrl(id,cursor.current),["codearena.v1",`codearena.jwt.${token}`]); socket.current=ws;
      ws.onopen=()=>{setStatus("live");setError("");};
      ws.onmessage=ev=>{ try{ const m=JSON.parse(ev.data); if(m.type==="snapshot"){ if(typeof m.document==="string")setDoc(m.document); if(Number.isFinite(m.documentRevision))setRevision(m.documentRevision); if(Array.isArray(m.presence))setPresence(m.presence); }
        else if(m.type==="ack"&&m.operation==="document.update"){ pending.current=false; setRevision(Number(m.revision)); }
        else if(m.type==="error"){ pending.current=false; if(m.code==="revision_conflict"){ setRevision(Number(m.currentRevision||0)); void refreshRoom(); } setError(m.message||m.code||"WebSocket error"); }
        else if(m.type==="presence.changed"){ const p=m.presence as Presence; setPresence(x=>[...x.filter(i=>i.userId!==p.userId),p]); }
        else if(m.type==="presence.left") setPresence(x=>x.filter(i=>i.userId!==m.userId));
        else if(m.type==="event"&&m.event){ const e=m.event; cursor.current=Math.max(cursor.current,Number(e.id||0)); setEvents(x=>[...x.filter(i=>i.id!==Number(e.id)),{...e,id:Number(e.id)}].slice(-100)); if(e.kind==="document.updated"&&!pending.current) void refreshRoom(); if(e.kind==="room.ended") setRoom(r=>r?{...r,status:"ended"}:r); }
      }catch{} };
      ws.onclose=()=>{ if(closed)return; setStatus("reconnecting"); reconnect.current=setTimeout(connect,1200); }; ws.onerror=()=>setStatus("reconnecting");
    }; connect(); return()=>{closed=true;if(reconnect.current)clearTimeout(reconnect.current);socket.current?.close();};
  },[id]);
  const sendDocument=()=>{ if(!room||room.status!=="active"||room.role==="observer"||!socket.current||socket.current.readyState!==WebSocket.OPEN)return; pending.current=true; socket.current.send(JSON.stringify({type:"document.update",document:doc,expectedRevision:revision,operationId:crypto.randomUUID()})); };
  const endRoom=async()=>{ try{ await api(`/v1/interview-rooms/${id}/end`,{method:"POST"}); await refreshRoom(); }catch(e){setError((e as Error).message);} };
  return <>
    <div className="page-title"><div><h1>{room?.title||"Interview room"}</h1><p>Shared coding document with durable replay, revision checks, and live participant presence.</p></div><div className="form-row"><span className="pill">{status.toUpperCase()}</span><Link className="button small" href="/console/interviews">All rooms</Link>{room?.role==="interviewer"&&room.status==="active"&&<button className="button small danger" onClick={endRoom}>End room</button>}</div></div>
    {error&&<div className="error" role="alert">{error}</div>}
    <div style={{display:"grid",gridTemplateColumns:"minmax(0,2fr) minmax(260px,1fr)",gap:16}}>
      <section className="panel"><div className="panel-head"><span>SHARED DOCUMENT</span><span>revision {revision}</span></div><div style={{padding:16}}><textarea value={doc} disabled={!room||room.status!=="active"||room.role==="observer"} onChange={e=>setDoc(e.target.value)} spellCheck={false} style={{width:"100%",minHeight:480,fontFamily:"var(--font-mono, monospace)",resize:"vertical"}}/><div className="form-row" style={{marginTop:12,justifyContent:"space-between"}}><span className="muted">Role: {room?.role||"—"} · {room?.status||"loading"}</span><button className="button" disabled={!room||room.status!=="active"||room.role==="observer"||status!=="live"||pending.current} onClick={sendDocument}>Sync document</button></div></div></section>
      <div style={{display:"grid",gap:16,alignContent:"start"}}>
        <section className="panel"><div className="panel-head"><span>LIVE PRESENCE</span><span>{presence.length}</span></div><div style={{padding:16,display:"grid",gap:10}}>{presence.length===0?<span className="muted">Waiting for participants…</span>:presence.map(p=><div key={p.userId} style={{display:"flex",justifyContent:"space-between",gap:8}}><span className="mono">{p.userId.slice(0,8)}…</span><span>{p.role} · {p.state}</span></div>)}</div></section>
        <section className="panel"><div className="panel-head"><span>DURABLE EVENTS</span><span>{events.length}</span></div><div style={{padding:16,display:"grid",gap:8,maxHeight:300,overflow:"auto"}}>{events.length===0?<span className="muted">No live events yet.</span>:events.slice().reverse().map(e=><div key={e.id}><span className="mono">#{e.id}</span> {e.kind}<br/><small className="muted">{new Date(e.created_at).toLocaleTimeString()}</small></div>)}</div></section>
      </div>
    </div>
  </>;
}
