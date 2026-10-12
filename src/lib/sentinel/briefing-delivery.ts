import { BriefingLocatorSchema, BriefingPayloadSchema, BriefingReceiptSchema } from "./briefing-contracts";
import { IdSchema, SENTINEL_LIMITS } from "./contracts";
export class SentinelDeliveryError extends Error {
  constructor(){super("The complete briefing could not be verified. No download was prepared.");this.name="SentinelDeliveryError";}
}
async function sha(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes as BufferSource))].map(v=>v.toString(16).padStart(2,"0")).join("");}
/** Buffers a bounded UTF-8 entity, verifies complete bytes and lineage, then offers a Blob. Never attests a disk save. */
export async function verifyBriefingDelivery(response:Response,expected:{organizationId?:string;incidentId:string;mode:string;revisionId:string;format:"json"|"html"}){
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const scope=BriefingLocatorSchema.parse({incidentId:expected.incidentId,mode:expected.mode,id:expected.revisionId});
  const organizationId=expected.organizationId===undefined?undefined:IdSchema.parse(expected.organizationId).toLowerCase();
  const encoded=response.headers.get("X-Sentinel-Artifact-Receipt");
  if(response.status!==200||!response.body||!encoded||!/^[A-Za-z0-9_-]{1,8192}$/.test(encoded))throw Error();
  const decoded=atob(encoded.replaceAll("-","+").replaceAll("_","/"));
  const receipt=BriefingReceiptSchema.parse(JSON.parse(decoded));
  if(organizationId!==undefined&&receipt.scope.organizationId!==organizationId||receipt.scope.incidentId!==scope.incidentId||receipt.scope.mode!==scope.mode||receipt.planRevisionId!==scope.id||receipt.format!==expected.format||
   response.headers.get("X-Sentinel-Artifact-SHA256")!==receipt.contentHash||response.headers.get("X-Sentinel-Artifact-Bytes")!==String(receipt.contentBytes))throw Error();
  const mime=receipt.format==="json"?"application/json":"text/html";
  if(response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase()!==mime)throw Error();
  // Fetch exposes the decompressed entity; the custom length/hash refer to these serialized UTF-8 bytes.
  const transportLength=response.headers.get("Content-Length");
  if(!response.headers.has("Content-Encoding")&&transportLength!==null&&transportLength!==String(receipt.contentBytes))throw Error();
  reader=response.body.getReader();const bytes=new Uint8Array(receipt.contentBytes);let length=0;
  while(true){const step=await reader.read();if(step.done)break;length+=step.value.byteLength;
   if(length>SENTINEL_LIMITS.briefingBytes||length>receipt.contentBytes)throw Error();bytes.set(step.value,length-step.value.byteLength);}
  if(length!==receipt.contentBytes)throw Error();
  if(await sha(bytes)!==receipt.contentHash)throw Error();const content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  let value:unknown;
  if(receipt.format==="json")value=JSON.parse(content);
  else{
   const document=new DOMParser().parseFromString(content,"text/html");
   if(document.querySelector('meta[name="sentinel-artifact-id"]')?.getAttribute("content")!==receipt.artifactId||
    document.querySelectorAll("#sentinel-briefing-lineage").length!==1)throw Error();
   const lineage=document.querySelector("#sentinel-briefing-lineage");if(lineage?.getAttribute("type")!=="application/json")throw Error();value=JSON.parse(lineage.textContent??"");
  }
  const payload=BriefingPayloadSchema.parse(value);
  if(payload.plan.id!==scope.id||payload.scope.incidentId!==scope.incidentId||payload.scope.mode!==scope.mode||payload.scope.organizationId!==receipt.scope.organizationId||
   payload.redactionProfile!==receipt.redactionProfile||payload.id!==(receipt.sourceArtifactId??receipt.artifactId)||receipt.format==="json"&&payload.receiptId!==receipt.id)throw Error();
  for(const x of payload.evidence.claims){
   if(x.claim.claimText!==null&&await sha(new TextEncoder().encode(x.claim.claimText))!==x.claimTextHash)throw Error();
   if(x.claim.excerpt!==null&&(await sha(new TextEncoder().encode(x.claim.excerpt))!==x.claim.excerptHash||new TextEncoder().encode(x.claim.excerpt).byteLength!==x.claim.excerptEnd-x.claim.excerptStart))throw Error();
  }
  return {blob:new Blob([bytes],{type:mime+";charset=utf-8"}),receipt,payload,status:"download_prepared" as const};
 }catch{try{await reader?.cancel();}catch{}throw new SentinelDeliveryError();}
 finally{reader?.releaseLock();}
}
