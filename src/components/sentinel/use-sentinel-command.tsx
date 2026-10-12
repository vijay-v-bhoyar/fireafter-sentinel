"use client";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { IdSchema, ScopeSchema } from "@/lib/sentinel/contracts";
import { workspaceRequest, WorkspaceRequestError } from "@/lib/sentinel/workspace-client";

type Scope=z.infer<typeof ScopeSchema>;
const IntentSchema=z.strictObject({actorId:IdSchema,scope:ScopeSchema,path:z.string(),body:z.record(z.string(),z.unknown())});
const paths=/^\/api\/sentinel\/(?:constraints|policy|plans|runs|claims\/[0-9a-f-]{36}\/review|source-changes\/[0-9a-f-]{36}\/review|runs\/[0-9a-f-]{36}\/cancel)$/;
export function parseIntent(raw:string,scope:Scope,actorId:string){
 if(raw.length>131072)throw Error("Saved command exceeds capacity.");
 const p=IntentSchema.parse(JSON.parse(raw));
 if(p.actorId!==actorId||JSON.stringify(p.scope)!==JSON.stringify(scope)||!paths.test(p.path)||
  p.body.incidentId!==scope.incidentId||p.body.mode!==scope.mode||!IdSchema.safeParse(p.body.commandId).success)throw Error("Saved command belongs to another context.");
 return p;
}
const unavailable="__storage_unavailable__";
function subscribe(fn:()=>void){window.addEventListener("sentinel-command",fn);window.addEventListener("storage",fn);return ()=>{window.removeEventListener("sentinel-command",fn);window.removeEventListener("storage",fn);};}
export function useSentinelCommand(scope:Scope,actorId:string,kind:string){
 const key=`sentinel-command:${actorId}:${scope.organizationId}:${scope.incidentId}:${scope.mode}:${kind}`;
 const raw=useSyncExternalStore(subscribe,()=>{try{return sessionStorage.getItem(key);}catch{return unavailable;}},()=>null);
 const stored=useMemo(()=>{if(!raw)return {pending:null,fault:false};try{return {pending:parseIntent(raw,scope,actorId),fault:false};}catch{return {pending:null,fault:true};}},[raw,scope,actorId]);
 const lock=useRef(false),[busy,setBusy]=useState(false);
 function persist(value:string|null){if(value===null)sessionStorage.removeItem(key);else sessionStorage.setItem(key,value);window.dispatchEvent(new Event("sentinel-command"));}
 async function send(path:string,body:Record<string,unknown>,confirm:(value:unknown,body:Record<string,unknown>)=>void){
  if(lock.current)throw Error("This command is already being sent.");lock.current=true;setBusy(true);
  try{const result=await workspaceRequest<unknown>(path,scope,{body,scoped:false,signal:AbortSignal.timeout(30000)});confirm(result,body);persist(null);return result;}
  catch(e){if(e instanceof WorkspaceRequestError&&e.status>=400&&e.status<500)persist(null);throw e;}
  finally{lock.current=false;setBusy(false);}
 }
 return {busy,pending:stored.pending,blocked:!!raw,
  fault:stored.fault,
  async execute(path:string,body:Record<string,unknown>,confirm:(value:unknown,body:Record<string,unknown>)=>void){
   // Re-read synchronously: a second click must not outrun React's render.
   if(sessionStorage.getItem(key)!==null)throw Error("Reconcile or retry the original saved command before creating another.");
   const value=JSON.stringify({actorId,scope,path,body});parseIntent(value,scope,actorId);persist(value);return send(path,body,confirm);
  },
  async retry(confirm:(value:unknown,body:Record<string,unknown>)=>void){const current=sessionStorage.getItem(key);if(!current)throw Error("No saved command is available.");const p=parseIntent(current,scope,actorId);return send(p.path,p.body,confirm);}
 };
}
export function CommandRecovery({command,onRetry,canRetry=true}:{command:ReturnType<typeof useSentinelCommand>;onRetry:()=>void;canRetry?:boolean}){
 if(command.fault)return <p role="alert">The original command cannot be restored. New writes are blocked. Restore this browser session before retrying; do not assume a previous request failed.</p>;
 return command.pending?<article role="status"><h3>Command confirmation pending</h3><p>Original command: <code>{String(command.pending.body.commandId)}</code>. A missing response does not prove rollback. Retry sends the same saved intent.</p><button disabled={command.busy||!canRetry} onClick={onRetry}>Retry original saved command</button></article>:null;
}
