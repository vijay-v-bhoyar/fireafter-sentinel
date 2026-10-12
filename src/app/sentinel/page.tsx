import Link from "next/link";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getIncidentAuthorizationContext } from "@/lib/fireafter-supabase";
import { IdSchema, ModeSchema, RoleSchema } from "@/lib/sentinel/contracts";
import { SentinelWorkspace } from "@/components/sentinel/sentinel-workspace";
import { workspaceViews } from "@/lib/sentinel/workspace-navigation";
import "@/components/sentinel/sentinel.css";
export const dynamic="force-dynamic";
const querySchema=z.strictObject({incidentId:z.string().trim().min(1).max(256).optional(),mode:ModeSchema.default('live'),view:z.enum(workspaceViews).default('overview'),revision:IdSchema.optional()});
export default async function SentinelPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const parsed=querySchema.safeParse(await searchParams);
 if(!parsed.success)return <Entry title="Workspace request invalid" text="Choose one incident, evidence mode and workspace view. Duplicated or unsupported parameters cannot select a review."/>;
 const q=parsed.data;if(!q.incidentId)return <Entry title="Open an incident for Sentinel review" text="Choose an incident from the action queue, then open Sentinel review. Live, replay and synthetic records remain separate."/>;
 const user=await getCurrentUser();
 if(!user)return <Entry title="Sign in to review evidence" text="Sentinel review requires your new project's configured account and workspace membership. An unavailable database cannot provide an authenticated review." login={`/login?returnTo=${encodeURIComponent(`/sentinel?${new URLSearchParams({incidentId:q.incidentId,mode:q.mode,view:q.view,...(q.revision?{revision:q.revision}:{})})}`)}`}/>;
 const identity=z.object({id:IdSchema,organizationId:IdSchema,role:RoleSchema}).safeParse(user);
 if(!identity.success)return <Entry title="Workspace access unavailable" text="Your account needs a current viewer, analyst or coordinator membership."/>;
 let incident;
 try{incident=await getIncidentAuthorizationContext(q.incidentId);}catch{incident=null;}
 if(!incident||incident.organizationId!==identity.data.organizationId)return <Entry title="Incident unavailable" text="This incident could not be read in your current workspace. Restore access and retry; no review or decision was recorded."/>;
 return <SentinelWorkspace key={`${identity.data.id}:${incident.databaseIncidentId}:${q.mode}`} identity={identity.data} incidentId={incident.databaseIncidentId} label={incident.domainIncidentId} mode={q.mode} view={q.view} revisionId={q.revision??null}/>;
}
function Entry({title,text,login}:{title:string;text:string;login?:string}){return <main className="sentinel-shell sentinel-entry"><h1>{title}</h1><p>{text}</p>{login&&<Link href={login}>Sign in</Link>}<Link href="/">Open incident action queue</Link></main>;}
