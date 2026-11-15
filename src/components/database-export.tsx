"use client";
import { useState } from "react";
export function DatabaseExport() {
  const [key,setKey]=useState("");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  async function download(){
    setBusy(true);setMessage("");
    try {
      const response=await fetch('/api/export',{headers:{Authorization:`Bearer ${key.trim()}`},cache:'no-store'});
      if(!response.ok) throw new Error((await response.json()).error ?? "Export failed");
      // Consume the stream and verify its footer before offering a file as complete.
      const reader=response.body!.getReader();
      const chunks:Uint8Array[]=[];let tail="";let bytes=0;
      const decoder=new TextDecoder();
      while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);bytes+=value.length;tail=(tail+decoder.decode(value,{stream:true})).slice(-8192);setMessage(`Downloading ${(bytes/1048576).toFixed(1)} MB…`);}
      tail+=decoder.decode();
      const footer=JSON.parse(tail.trim().split('\n').at(-1)!);
      if(footer.type!=="complete")throw new Error("Incomplete export. Please retry.");
      const blob=new Blob(chunks as BlobPart[],{type:'application/x-ndjson'});
      const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`keel-database-${new Date().toISOString().slice(0,10)}.jsonl`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
      setMessage(`Export complete: ${footer.tables} tables, ${footer.rows} records.`);
    } catch(error){setMessage(error instanceof Error?error.message:"Export failed");}
    finally{setKey("");setBusy(false);}
  }
  return <section className="database-export"><h3>Export database</h3><p>All records, snapshots and alert history as JSONL.</p>
    <label>Export key<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder="Enter your export key" disabled={busy}/></label>
    <button className="outline-control" disabled={busy||!key.trim()} onClick={()=>void download()}>{busy?"Exporting…":"Download entire database"}</button>
    <p role="status">{message}</p></section>;
}
