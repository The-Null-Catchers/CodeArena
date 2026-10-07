"use client";

import { useEffect, useState } from "react";
import { api } from "../../../../lib/api";

type ParticipantRole="interviewer"|"candidate"|"observer";
type Participant={user_id:string;email:string;role:ParticipantRole;invited_by?:string|null;joined_at:string;disabled:boolean};

export default function ParticipantDirectory({roomId,enabled,roomActive}:{roomId:string;enabled:boolean;roomActive:boolean}){
  const [items,setItems]=useState<Participant[]>([]);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState<string|null>(null);
  const [error,setError]=useState("");

  const load=async()=>{
    if(!enabled)return;
    setLoading(true);setError("");
    try{const result=await api(`/v1/interview-rooms/${roomId}/participants`);setItems(result.items||[]);}catch(e){setError((e as Error).message);}finally{setLoading(false);}
  };

  useEffect(()=>{void load();},[roomId,enabled]);

  const changeRole=async(userId:string,role:ParticipantRole)=>{
    setSaving(userId);setError("");
    try{
      await api(`/v1/interview-rooms/${roomId}/participants`,{method:"POST",body:JSON.stringify({userId,role})});
      await load();
    }catch(e){setError((e as Error).message);}finally{setSaving(null);}
  };

  if(!enabled)return null;
  return <section className="panel">
    <div className="panel-head"><span>PARTICIPANT DIRECTORY</span><button className="button small" disabled={loading} onClick={()=>void load()}>{loading?"Loading…":"Refresh"}</button></div>
    <div style={{padding:16,display:"grid",gap:10}}>
      {error&&<div className="error" role="alert">{error}</div>}
      {!loading&&items.length===0?<span className="muted">No persisted participants yet.</span>:items.map(p=><div key={p.user_id} style={{borderTop:"1px solid var(--border)",paddingTop:10,display:"grid",gap:6}}>
        <div style={{display:"flex",justifyContent:"space-between",gap:8,alignItems:"center"}}><span>{p.email}</span><span className="mono">{p.user_id.slice(0,8)}…</span></div>
        <div className="form-row" style={{justifyContent:"space-between",alignItems:"center"}}>
          <small className="muted">Joined {new Date(p.joined_at).toLocaleString()}{p.disabled?" · account disabled":""}</small>
          <select aria-label={`Role for ${p.email}`} value={p.role} disabled={!roomActive||saving===p.user_id||p.disabled} onChange={e=>void changeRole(p.user_id,e.target.value as ParticipantRole)} style={{maxWidth:150}}><option value="interviewer">Interviewer</option><option value="candidate">Candidate</option><option value="observer">Observer</option></select>
        </div>
      </div>)}
    </div>
  </section>;
}
