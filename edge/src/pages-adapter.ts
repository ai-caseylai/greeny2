import * as page0 from "../../spa/functions/api/alerts/[id]";
import * as page1 from "../../spa/functions/api/automations/[id]";
import * as page2 from "../../spa/functions/api/automations/[id]/run";
import * as page3 from "../../spa/functions/api/automations/index";
import * as page4 from "../../spa/functions/api/crop-batches/[id]";
import * as page5 from "../../spa/functions/api/crop-batches/index";
import * as page6 from "../../spa/functions/api/dashboard/stats";
import * as page7 from "../../spa/functions/api/devices/[id]";
import * as page8 from "../../spa/functions/api/filters/index";
import * as page9 from "../../spa/functions/api/harvests/index";
import * as page10 from "../../spa/functions/api/notifications/index";
import * as page11 from "../../spa/functions/api/offices/[id]";
import * as page12 from "../../spa/functions/api/offices/index";
import * as page13 from "../../spa/functions/api/personnel/index";
import * as page14 from "../../spa/functions/api/rack-environment/index";
import * as page15 from "../../spa/functions/api/rack-vegetables/[id]";
import * as page16 from "../../spa/functions/api/rack-vegetables/index";
import * as page17 from "../../spa/functions/api/racks/[id]";
import * as page18 from "../../spa/functions/api/racks/index";
import * as page19 from "../../spa/functions/api/relay-logs";
import * as page20 from "../../spa/functions/api/reports/summary";
import * as page21 from "../../spa/functions/api/reports/usage";
import * as page22 from "../../spa/functions/api/tasks/[id]";
import * as page23 from "../../spa/functions/api/tasks/index";
import * as page24 from "../../spa/functions/api/users/[id]";
import * as page25 from "../../spa/functions/api/users/index";
import * as page26 from "../../spa/functions/api/workbuddy/send-whatsapp";
import * as page27 from "../../spa/functions/api/workbuddy/status";

import {ownsDevice,deviceScope,smallJSON,json} from './access';
import type {Env} from './index';
import type {User} from './stamplc-protocol';
const routes=[
{pattern:new RegExp("^/api/alerts/([^/]+)/?$"),keys:["id"],module:page0},
{pattern:new RegExp("^/api/automations/([^/]+)/?$"),keys:["id"],module:page1},
{pattern:new RegExp("^/api/automations/([^/]+)/run/?$"),keys:["id"],module:page2},
{pattern:new RegExp("^/api/automations/?$"),keys:[],module:page3},
{pattern:new RegExp("^/api/crop-batches/([^/]+)/?$"),keys:["id"],module:page4},
{pattern:new RegExp("^/api/crop-batches/?$"),keys:[],module:page5},
{pattern:new RegExp("^/api/dashboard/stats/?$"),keys:[],module:page6},
{pattern:new RegExp("^/api/devices/([^/]+)/?$"),keys:["id"],module:page7},
{pattern:new RegExp("^/api/filters/?$"),keys:[],module:page8},
{pattern:new RegExp("^/api/harvests/?$"),keys:[],module:page9},
{pattern:new RegExp("^/api/notifications/?$"),keys:[],module:page10},
{pattern:new RegExp("^/api/offices/([^/]+)/?$"),keys:["id"],module:page11},
{pattern:new RegExp("^/api/offices/?$"),keys:[],module:page12},
{pattern:new RegExp("^/api/personnel/?$"),keys:[],module:page13},
{pattern:new RegExp("^/api/rack-environment/?$"),keys:[],module:page14},
{pattern:new RegExp("^/api/rack-vegetables/([^/]+)/?$"),keys:["id"],module:page15},
{pattern:new RegExp("^/api/rack-vegetables/?$"),keys:[],module:page16},
{pattern:new RegExp("^/api/racks/([^/]+)/?$"),keys:["id"],module:page17},
{pattern:new RegExp("^/api/racks/?$"),keys:[],module:page18},
{pattern:new RegExp("^/api/relay-logs/?$"),keys:[],module:page19},
{pattern:new RegExp("^/api/reports/summary/?$"),keys:[],module:page20},
{pattern:new RegExp("^/api/reports/usage/?$"),keys:[],module:page21},
{pattern:new RegExp("^/api/tasks/([^/]+)/?$"),keys:["id"],module:page22},
{pattern:new RegExp("^/api/tasks/?$"),keys:[],module:page23},
{pattern:new RegExp("^/api/users/([^/]+)/?$"),keys:["id"],module:page24},
{pattern:new RegExp("^/api/users/?$"),keys:[],module:page25},
{pattern:new RegExp("^/api/workbuddy/send-whatsapp/?$"),keys:[],module:page26},
{pattern:new RegExp("^/api/workbuddy/status/?$"),keys:[],module:page27}
];
const itemOffice:Record<string,string>={
  racks:'SELECT office_id FROM racks WHERE id=?',
  'rack-vegetables':'SELECT r.office_id FROM rack_vegetables v JOIN racks r ON r.id=v.rack_id WHERE v.id=?',
  'crop-batches':'SELECT office_id FROM crop_batches WHERE id=?',
  automations:'SELECT office_id FROM automations WHERE id=?',
  tasks:'SELECT hotel_id AS office_id FROM tasks WHERE id=?'
};
async function ownsRow(env:Env,user:User,sql:string,id:unknown){if(user.role==='superadmin')return true;if(!user.office_id)return false;const row=await env.DB.prepare(sql).bind(id).first<{office_id:number}>();return !!row&&row.office_id===user.office_id;}
async function stats(env:Env,user:User){
  const ds=deviceScope(user,'d.id'),ts=deviceScope(user,'t.device_id'),as=deviceScope(user,'a.device_id'),now=Math.floor(Date.now()/1000),today=Math.floor((Date.now()+28800000)/86400000)*86400-28800;
  const [devices,aggregate,alertRows,distribution,recent]=await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS total,SUM(CASE WHEN d.last_seen>? THEN 1 ELSE 0 END) AS online FROM devices d WHERE '+ds.clause).bind(now-90,...ds.params).first<any>(),
    env.DB.prepare('SELECT AVG(t.ph) AS ph,AVG(t.ec) AS ec,AVG(t.water_temp) AS temp FROM telemetry t WHERE '+ts.clause+' AND t.created_at>=?').bind(...ts.params,today).first<any>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM alerts a WHERE '+as.clause+' AND a.created_at>=?').bind(...as.params,today).first<any>(),
    env.DB.prepare('SELECT d.status,COUNT(*) AS count FROM devices d WHERE '+ds.clause+' GROUP BY d.status').bind(...ds.params).all(),
    env.DB.prepare('SELECT a.*,d.name AS device_name FROM alerts a LEFT JOIN devices d ON a.device_id=d.id WHERE '+as.clause+' AND a.acknowledged=0 ORDER BY a.created_at DESC LIMIT 10').bind(...as.params).all()
  ]);
  return {online_devices:devices?.online||0,total_devices:devices?.total||0,today_alerts:alertRows?.count||0,avg_ph:aggregate?.ph??null,avg_ec:aggregate?.ec??null,avg_temp:aggregate?.temp??null,device_distribution:distribution.results,recent_alerts:recent.results,status_basis:'recent_device_heartbeat'};
}
async function usage(request:Request,env:Env,user:User){
  const days=Math.max(1,Math.min(365,Number(new URL(request.url).searchParams.get('days'))||7)),scope=deviceScope(user,'t.device_id');
  const rows=await env.DB.prepare("SELECT date(COALESCE(t.utc_ms,t.created_at*1000)/1000,'unixepoch','+8 hours') AS date,d.id AS device_id,d.name AS device_name,COUNT(*) AS readings,AVG(t.ph) AS avg_ph,AVG(t.ec) AS avg_ec,AVG(t.water_temp) AS avg_temp,NULL AS total_liters,NULL AS avg_flow FROM telemetry t JOIN devices d ON d.id=t.device_id WHERE "+scope.clause+' AND t.created_at>=? GROUP BY date,d.id ORDER BY date DESC,d.id').bind(...scope.params,Math.floor(Date.now()/1000)-days*86400).all();return json(rows.results);
}
export async function managementAPI(request:Request,env:Env,execution:ExecutionContext,user:User):Promise<Response|null>{
  let url=new URL(request.url),path=url.pathname.replace(/\/+$/,'')||'/',method=request.method;const parts=path.split('/').filter(Boolean),resource=parts[1];
  if(path==='/api/dashboard/stats'&&method==='GET')return json(await stats(env,user));
  if(path==='/api/reports/usage'&&method==='GET')return usage(request,env,user);
  if(path==='/api/reports/summary'&&method==='GET'){
    const summary=await stats(env,user),scope=deviceScope(user,'a.device_id');
    const alerts=await env.DB.prepare('SELECT COUNT(*) AS n FROM alerts a WHERE '+scope.clause).bind(...scope.params).first<any>();
    const own=user.role==='superadmin'?{clause:'1=1',params:[]}:{clause:'hotel_id=?',params:[user.office_id??-1]};
    const tasks=await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status=? AND '+own.clause).bind('pending',...own.params).first<any>();
    const filters=await env.DB.prepare('SELECT COUNT(*) AS n FROM filters WHERE status=? AND '+own.clause).bind('active',...own.params).first<any>();
    return json({total_devices:summary.total_devices,online_devices:summary.online_devices,total_alerts:alerts?.n||0,pending_tasks:tasks?.n||0,active_filters:filters?.n||0});
  }
  if(path==='/api/relay-logs'&&method==='GET'){
    const scope=deviceScope(user,'c.device_id'),id=url.searchParams.get('device_id'),params:any[]=[...scope.params];let where=scope.clause;
    if(id){if(!(await ownsDevice(env,user,id)))return json({error:'Forbidden'},403);where+=' AND c.device_id=?';params.push(id);}
    const result=await env.DB.prepare('SELECT c.* FROM relay_commands c WHERE '+where+' ORDER BY c.issued_ms DESC LIMIT 200').bind(...params).all();return json(result.results);
  }
  if(resource==='workbuddy'&&(!env.WORKBUDDY_API_URL||!env.WORKBUDDY_API_KEY))return json({error:'Notification integration is not configured on this deployment'},503);
  if(resource==='automations'&&parts[3]==='run')return json({error:'Automatic actuation is unavailable; use authorized manual relay controls'},501);
  const route=routes.find(item=>item.pattern.test(path));if(!route)return null;
  const match=path.match(route.pattern)!;const params:Record<string,string>={};route.keys.forEach((key,index)=>params[key]=decodeURIComponent(match[index+1]));
  let body:any={};
  if(!['GET','HEAD'].includes(method)){try{const text=await request.clone().text();body=text?JSON.parse(text):{};if(text.length>16384)return json({error:'Request too large'},413);}catch{return json({error:'Invalid JSON'},400);}}
  if(user.role==='staff'&&!['GET','HEAD'].includes(method))return json({error:'Read-only account'},403);
  if(resource==='devices'&&params.id&&!(await ownsDevice(env,user,params.id)))return json({error:'Forbidden'},403);
  if(resource==='devices'&&method==='DELETE')return json({error:'Device history is retained; use maintenance status instead of deleting it'},409);
  if(resource==='alerts'&&params.id){const alert=await env.DB.prepare('SELECT device_id FROM alerts WHERE id=?').bind(params.id).first<{device_id:string}>();if(!alert)return json({error:'Not found'},404);if(!(await ownsDevice(env,user,alert.device_id)))return json({error:'Forbidden'},403);}
  if(user.role!=='superadmin'){
    if(!user.office_id)return json({error:'Assigned office required'},403);
    if(resource==='offices'&&!['GET','HEAD'].includes(method))return json({error:'Superadmin required'},403);
    if(itemOffice[resource]&&params.id&&!(await ownsRow(env,user,itemOffice[resource],params.id)))return json({error:'Forbidden'},403);
    if(resource==='users'&&params.id){const target=await env.DB.prepare('SELECT id,role,office_id FROM users WHERE id=?').bind(params.id).first<any>();if(!target||target.office_id!==user.office_id||(target.id!==user.id&&target.role!=='staff'))return json({error:'Forbidden'},403);}
    const requestedOffice=body.office_id??url.searchParams.get('office_id');if(requestedOffice!=null&&Number(requestedOffice)!==user.office_id)return json({error:'Office outside account scope'},403);
    if(['racks','automations','crop-batches'].includes(resource))body.office_id=user.office_id;
    if(method==='GET'){url.searchParams.set('office_id',String(user.office_id));url.searchParams.set('hotel_id',String(user.office_id));}
    const rackId=body.rack_id??url.searchParams.get('rack_id');if(rackId!=null&&!(await ownsRow(env,user,'SELECT office_id FROM racks WHERE id=?',rackId)))return json({error:'Rack outside account scope'},403);
    if(body.batch_id!=null&&!(await ownsRow(env,user,'SELECT office_id FROM crop_batches WHERE id=?',body.batch_id)))return json({error:'Batch outside account scope'},403);
    if(body.personnel_id!=null&&!(await ownsRow(env,user,'SELECT hotel_id AS office_id FROM personnel WHERE id=?',body.personnel_id)))return json({error:'Person outside account scope'},403);
    const deviceId=body.device_id??url.searchParams.get('device_id');if(deviceId!=null&&!(await ownsDevice(env,user,deviceId)))return json({error:'Device outside account scope'},403);
    if(['rack-vegetables','rack-environment'].includes(resource)&&!params.id&&rackId==null)return json({error:'Owned rack_id required'},400);
  }
  const headers=new Headers(request.headers);if(!['GET','HEAD'].includes(method)){headers.set('Content-Type','application/json');request=new Request(url.toString(),{method,headers,body:JSON.stringify(body)});}else request=new Request(url.toString(),request);
  const module:any=route.module,name='onRequest'+method[0]+method.slice(1).toLowerCase();const entry=module[name]??module.onRequest;if(!entry)return json({error:'Method not allowed'},405);
  const handlers=Array.isArray(entry)?entry:[entry];let nextIndex=0;
  const context:any={request,env,params,data:{user:{...user,hotel_id:user.office_id}},waitUntil:(promise:Promise<unknown>)=>execution.waitUntil(promise),passThroughOnException:()=>{},next:async()=>{const handler=handlers[nextIndex++];return handler?handler(context):json({error:'Not found'},404);}};
  let response:Response=await context.next();
  if(method==='GET'&&user.role!=='superadmin'&&response.ok&&response.headers.get('Content-Type')?.includes('application/json')){
    let data:any;try{data=await response.clone().json();}catch{return response;}
    if(Array.isArray(data)){
      if(resource==='offices')data=data.filter(row=>row.id===user.office_id);
      else if(['racks','automations','crop-batches','harvests','users'].includes(resource))data=data.filter(row=>row.office_id===user.office_id);
      else if(['tasks','personnel','notifications'].includes(resource))data=data.filter(row=>row.hotel_id===user.office_id);
      response=json(data,response.status);
    }
  }
  const responseHeaders=new Headers(response.headers);responseHeaders.set('Cache-Control','no-store');return new Response(response.body,{status:response.status,headers:responseHeaders});
}
