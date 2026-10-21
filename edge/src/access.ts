
import {verifyJWT} from './auth';
import {json,DEVICE_ID_RE,type User} from './stamplc-protocol';
export interface AccessEnv { DB:D1Database; }
export async function setting(env:AccessEnv,key:string):Promise<string>{const row=await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{value:string}>();return row?.value||'';}
export async function currentUser(token:string,env:AccessEnv):Promise<User|null>{
  const secret=await setting(env,'jwt_secret');if(!secret||!token)return null;
  const payload=await verifyJWT(token,secret);const sub=Number(payload?.sub);if(!Number.isSafeInteger(sub)||sub<1)return null;
  const user=await env.DB.prepare('SELECT id,username,role,office_id,display_name FROM users WHERE id=? AND active=1').bind(sub).first<any>();
  if(!user||!['superadmin','office_admin','staff'].includes(user.role))return null;
  return {...user,sub:user.id,office_id:user.office_id??null};
}
export function bearer(request:Request):string {const auth=request.headers.get('Authorization')||'';return auth.startsWith('Bearer ')?auth.slice(7):'';}
export async function ownsDevice(env:AccessEnv,user:User,deviceId:string):Promise<boolean>{
  if(!DEVICE_ID_RE.test(deviceId))return false;if(user.role==='superadmin')return true;if(!user.office_id)return false;
  return !!(await env.DB.prepare('SELECT 1 AS allowed FROM racks WHERE device_id=? AND office_id=? LIMIT 1').bind(deviceId,user.office_id).first());
}
export function deviceScope(user:User,alias='device_id'):{clause:string;params:Array<number>} {return user.role==='superadmin'?{clause:'1=1',params:[]}:{clause:'EXISTS(SELECT 1 FROM racks own_rack WHERE own_rack.device_id='+alias+' AND own_rack.office_id=?)',params:[user.office_id??-1]};}
export function isReadOnlyRequest(method:string,path:string):boolean {return method==='GET'||method==='HEAD'||method==='OPTIONS'||(method==='POST'&&path==='/api/chat');}
export async function smallJSON(request:Request,max=8192):Promise<any>{const raw=await request.text();if(raw.length>max)throw new Error('Request too large');return JSON.parse(raw);}
export {json};
