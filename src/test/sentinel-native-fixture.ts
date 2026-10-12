import {createHmac} from 'node:crypto';
import type {PGlite} from '@electric-sql/pglite';
import {nativeRowFrame} from '../lib/sentinel/native-provenance';

/** Explicit test-only authority for a positive synthetic native snapshot. Never auto-sign mutations. */
export async function signSyntheticNativeFixture(db:PGlite,scope:{organizationId:string;incidentId:string;mode:string},snapshotId:string){
 const keyId='72000000-0000-4000-8000-000000000001',secret=Buffer.from('bc'.repeat(32),'hex');
 await db.query(`insert into public.sentinel_native_signing_keys(organization_id,id,secret_key,authority_evidence_hash,valid_from,valid_until)
   values($1,$2,$3,$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour') on conflict do nothing`,[scope.organizationId,keyId,secret,'b'.repeat(64)]);
 const row=(await db.query<Record<string,unknown>>('select * from public.source_snapshots where id=$1 and incident_id=$2',[snapshotId,scope.incidentId])).rows[0];
 if(!row)throw new Error('Synthetic native fixture missing');
 const frame=nativeRowFrame(row),text=[keyId,scope.organizationId,scope.incidentId,scope.mode,frame].join('\n');
 const binding={schemaVersion:1,keyId,organizationId:scope.organizationId,mode:scope.mode,frame,signature:createHmac('sha256',secret).update(text).digest('hex')};
 await db.query(`update public.source_snapshots set raw_payload=jsonb_set(raw_payload,'{sentinelNativeBinding}',$2::jsonb) where id=$1`,[snapshotId,JSON.stringify(binding)]);
}
