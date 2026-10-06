"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { API, api } from "../../../../lib/api";

type Room={id:string;title:string;status:"active"|"ended";role:"interviewer"|"candidate"|"observer";document:string;document_revision:number;runtime_id?:string|null};
type Presence={userId:string;role:string;state:string;lastSeenAt:string};
type EventRow={id:number;kind:string;actor_user_id?:string;created_at:string;payload?:{revision?:number;mode?:string}};
type TextChange={index:number;deleteCount:number;insert:string};
type PendingOperation={type:"document.op";clientId:string;sequence:number;baseRevision:number;change:TextChange;operationId:string};
type PrivateNote={id:string;body:string;created_at:string;updated_at:string};
type ParticipantRole="interviewer"|"candidate"|"observer";

function wsUrl(roomId:string,after:number){const base=new URL(API);const proto=base.protocol==="https:"?"wss:":"ws:";return `${proto}//${base.host}/v1/interview-rooms/${roomId}/ws?after=${after}`;}
function textChange(before:string,after:string):TextChange{let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;let beforeEnd=before.length;let afterEnd=after.length;while(beforeEnd>start&&afterEnd>start&&before[beforeEnd-1]===after[afterEnd-1]){beforeEnd--;afterEnd--;}return{index:start,deleteCount:beforeEnd-start,insert:after.slice(start,afterEnd)};}

export default function InterviewRoomPage(){
  const {id}=useParams<{id:string}>();
  const [room,setRoom]=useState<Room|null>(null);const [doc,setDoc]=useState("");const [revision,setRevision]=useState(0);
  const [presence,setPresence]=useState<Presence[]>([]);const [events,setEvents]=useState<EventRow[]>([]);const [status,setStatus]=useState("connecting");const [error,setError]=useState("");const [saving,setSaving]=useState(false);const [dirty,setDirty]=useState(false);
  const [participantUserId,setParticipantUserId]=useState("");const [participantRole,setParticipantRole]=useState<ParticipantRole>("candidate");const [participantSaving,setParticipantSaving]=useState(false);
  const [notes,setNotes]=useState<PrivateNote[]>([]);const [noteBody,setNoteBody]=useState("");const [noteSaving,setNoteSaving]=useState(false);
  const cursor=useRef(0);const socket=useRef<WebSocket|null>(null);const reconnect=useRef<ReturnType<typeof setTimeout>|null>(null);const reconnectAttempt=useRef(0);
  const baseline=useRef("");const baseRevision=useRef(0);const dirtyRef=useRef(false);const pending=useRef<PendingOperation|null>(null);const clientId=useRef("");const sequence=useRef(0);

  const refreshRoom=async(replaceDraft=true)=>{const r=await api(`/v1/interview-rooms/${id}`);setRoom(r);baseline.current=r.document||"";baseRevision.current=Number(r.document_revision||0);setRevision(baseRevision.current);if(replaceDraft){setDoc(baseline.current);dirtyRef.current=false;setDirty(false);}return r as Room;};
  const loadNotes=async()=>{const result=await api(`/v1/interview-rooms/${id}/private-notes`);setNotes(result.items||[]);};
  useEffect(()=>{void refreshRoom().then(r=>{if(r.role==="interviewer")void loadNotes().catch(e=>setError((e as Error).message));}).catch(e=>setError((e as Error).message));},[id]);

  useEffect(()=>{if(!id)return;let closed=false;
    const connect=()=>{const token=sessionStorage.getItem("ca_access");if(!token){window.location.assign("/login");return;}setStatus("connecting");const ws=new WebSocket(wsUrl(id,cursor.current),["codearena.v1",`codearena.jwt.${token}`]);socket.current=ws;
      ws.onopen=()=>{reconnectAttempt.current=0;setStatus("live");setError("");if(pending.current)ws.send(JSON.stringify(pending.current));};
      ws.onmessage=ev=>{try{const m=JSON.parse(ev.data);
        if(m.type==="snapshot"){if(m.room&&typeof m.room.document==="string"&&!dirtyRef.current&&!pending.current){baseline.current=m.room.document;setDoc(m.room.document);}if(m.room&&Number.isFinite(m.room.documentRevision)&&!dirtyRef.current&&!pending.current){baseRevision.current=Number(m.room.documentRevision);setRevision(baseRevision.current);}if(Number.isFinite(m.cursor))cursor.current=Math.max(cursor.current,Number(m.cursor));if(Array.isArray(m.presence))setPresence(m.presence);}
        else if(m.type==="ready"&&Number.isFinite(m.cursor))cursor.current=Math.max(cursor.current,Number(m.cursor));
        else if(m.type==="ack"&&(m.operation==="document.op"||m.operation==="document.update")){pending.current=null;setSaving(false);cursor.current=Math.max(cursor.current,Number(m.eventId||0));void refreshRoom(true);}
        else if(m.type==="error"){pending.current=null;setSaving(false);if(m.code==="revision_conflict"||m.code==="rebase_unavailable")void refreshRoom(false);setError(m.message||m.code||"WebSocket error");}
        else if(m.type==="presence.changed"){const p=m.presence as Presence;setPresence(x=>[...x.filter(i=>i.userId!==p.userId),p]);}
        else if(m.type==="presence.left")setPresence(x=>x.filter(i=>i.userId!==m.userId));
        else if(m.type==="event"&&m.event){const e=m.event as EventRow;cursor.current=Math.max(cursor.current,Number(e.id||0));setEvents(x=>[...x.filter(i=>i.id!==Number(e.id)),{...e,id:Number(e.id)}].slice(-100));if(e.kind==="document.updated"&&!dirtyRef.current&&!pending.current)void refreshRoom(true);if(e.kind==="room.ended")setRoom(r=>r?{...r,status:"ended"}:r);}
      }catch{/* Ignore malformed realtime frames; server validation is authoritative. */}};
      ws.onclose=()=>{if(closed)return;setStatus("reconnecting");const attempt=reconnectAttempt.current++;const delay=Math.min(30000,500*2**attempt)+Math.floor(Math.random()*250);reconnect.current=setTimeout(connect,delay);};ws.onerror=()=>setStatus("reconnecting");
    };connect();return()=>{closed=true;if(reconnect.current)clearTimeout(reconnect.current);socket.current?.close();};
  },[id]);

  const sendDocument=()=>{if(!room||room.status!=="active"||room.role==="observer"||!socket.current||socket.current.readyState!==WebSocket.OPEN||pending.current)return;if(doc===baseline.current){dirtyRef.current=false;setDirty(false);return;}if(!clientId.current)clientId.current=crypto.randomUUID();const message:PendingOperation={type:"document.op",clientId:clientId.current,sequence:sequence.current++,baseRevision:baseRevision.current,change:textChange(baseline.current,doc),operationId:crypto.randomUUID()};pending.current=message;setSaving(true);setError("");socket.current.send(JSON.stringify(message));};
  const endRoom=async()=>{try{await api(`/v1/interview-rooms/${id}/end`,{method:"POST"});await refreshRoom();}catch(e){setError((e as Error).message);}};
  const onDocumentChange=(value:string)=>{setDoc(value);dirtyRef.current=value!==baseline.current;setDirty(dirtyRef.current);};
  const addParticipant=async()=>{if(!participantUserId.trim())return;setParticipantSaving(true);setError("");try{await api(`/v1/interview-rooms/${id}/participants`,{method:"POST",body:JSON.stringify({userId:participantUserId.trim(),role:participantRole})});setParticipantUserId("");}catch(e){setError((e as Error).message);}finally{setParticipantSaving(false);}};
  const addNote=async()=>{if(!noteBody.trim())return;setNoteSaving(true);setError("");try{await api(`/v1/interview-rooms/${id}/private-notes`,{method:"POST",body:JSON.stringify({body:noteBody.trim()})});setNoteBody("");await loadNotes();}catch(e){setError((e as Error).message);}finally{setNoteSaving(false);}};

  return <>
    <div className="page-title"><div><h1>{room?.title||"Interview room"}</h1><p>Shared coding document with durable operation replay, deterministic rebasing, and live participant presence.</p></div><div className="form-row"><span className="pill">{status.toUpperCase()}</span><Link className="button small" href="/console/interviews">All rooms</Link>{room?.role==="interviewer"&&room.status==="active"&&<button className="button small danger" onClick={endRoom}>End room</button>}</div></div>
    {error&&<div className="error" role="alert">{error}</div>}
    <div style={{display:"grid",gridTemplateColumns:"minmax(0,2fr) minmax(280px,1fr)",gap:16}}>
      <section className="panel"><div className="panel-head"><span>SHARED DOCUMENT</span><span>revision {revision}{dirty?" · local changes":""}</span></div><div style={{padding:16}}><textarea value={doc} disabled={!room||room.status!=="active"||room.role==="observer"||saving} onChange={e=>onDocumentChange(e.target.value)} spellCheck={false} style={{width:"100%",minHeight:480,fontFamily:"var(--font-mono, monospace)",resize:"vertical"}}/><div className="form-row" style={{marginTop:12,justifyContent:"space-between"}}><span className="muted">Role: {room?.role||"—"} · {room?.status||"loading"} · incremental sync</span><button className="button" disabled={!dirty||!room||room.status!=="active"||room.role==="observer"||status!=="live"||saving} onClick={sendDocument}>{saving?"Syncing…":"Sync changes"}</button></div></div></section>
      <div style={{display:"grid",gap:16,alignContent:"start"}}>
        <section className="panel"><div className="panel-head"><span>LIVE PRESENCE</span><span>{presence.length}</span></div><div style={{padding:16,display:"grid",gap:10}}>{presence.length===0?<span className="muted">Waiting for participants…</span>:presence.map(p=><div key={p.userId} style={{display:"flex",justifyContent:"space-between",gap:8}}><span className="mono">{p.userId.slice(0,8)}…</span><span>{p.role} · {p.state}</span></div>)}</div></section>
        {room?.role==="interviewer"&&<section className="panel"><div className="panel-head"><span>ADD PARTICIPANT</span><span>interviewer only</span></div><div style={{padding:16,display:"grid",gap:10}}><input aria-label="Participant user ID" value={participantUserId} onChange={e=>setParticipantUserId(e.target.value)} placeholder="User UUID"/><select aria-label="Participant role" value={participantRole} onChange={e=>setParticipantRole(e.target.value as ParticipantRole)}><option value="candidate">Candidate</option><option value="observer">Observer</option><option value="interviewer">Interviewer</option></select><button className="button" disabled={participantSaving||!participantUserId.trim()||room.status!=="active"} onClick={addParticipant}>{participantSaving?"Adding…":"Add / update participant"}</button></div></section>}
        {room?.role==="interviewer"&&<section className="panel"><div className="panel-head"><span>PRIVATE NOTES</span><span>{notes.length}</span></div><div style={{padding:16,display:"grid",gap:10}}><textarea aria-label="Private interviewer note" value={noteBody} onChange={e=>setNoteBody(e.target.value)} placeholder="Visible only to you" maxLength={20000} rows={4}/><button className="button" disabled={noteSaving||!noteBody.trim()} onClick={addNote}>{noteSaving?"Saving…":"Save private note"}</button><div style={{display:"grid",gap:8,maxHeight:220,overflow:"auto"}}>{notes.length===0?<span className="muted">No private notes yet.</span>:notes.map(n=><div key={n.id} style={{borderTop:"1px solid var(--border)",paddingTop:8,whiteSpace:"pre-wrap"}}>{n.body}<br/><small className="muted">{new Date(n.updated_at).toLocaleString()}</small></div>)}</div></div></section>}
        <section className="panel"><div className="panel-head"><span>DURABLE EVENTS</span><span>{events.length}</span></div><div style={{padding:16,display:"grid",gap:8,maxHeight:300,overflow:"auto"}}>{events.length===0?<span className="muted">No live events yet.</span>:events.slice().reverse().map(e=><div key={e.id}><span className="mono">#{e.id}</span> {e.kind}{e.payload?.mode?` · ${e.payload.mode}`:""}<br/><small className="muted">{new Date(e.created_at).toLocaleTimeString()}</small></div>)}</div></section>
      </div>
    </div>
  </>;
}
