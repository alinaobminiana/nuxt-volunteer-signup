import './env.js';
import { z } from 'zod';
import config from './config.js';
import { openStore } from './store.js';
import { sendMail } from './mail.js';
import { AppError, rateLimit } from './security.js';

const fieldSchema = field => {
  if (field.type === 'checkbox') return z.enum(['on','true'], {error:`${field.label} is required.`});
  let value=z.string().trim().min(1,`${field.label} is required.`).max(field.type==='textarea'?2000:300,`${field.label} is too long.`);
  if(field.type==='email') value=value.email('Enter a valid email address.').transform(s=>s.toLowerCase());
  if(field.type==='url') value=value.refine(s=>{try{return ['https:','http:'].includes(new URL(s).protocol)}catch{return false}},'Enter an HTTP or HTTPS URL.');
  if(field.type==='datetime-local') value=value.refine(s=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && Number.isFinite(Date.parse(s+'Z')) && new Date(s+'Z').toISOString().slice(0,16)===s, 'Enter a valid date and time.');
  if(field.options) value=value.refine(s=>field.options.some(option=>option.value===s),'Choose one of the listed options.');
  return value;
};
export const submissionSchema=z.object(Object.fromEntries(config.fields.map(f=>[f.name,fieldSchema(f)])));

export function createService({store=openStore(), deliver=sendMail}={}) {
  const {db,records,find,insert,atomic,queue}=store;
  const notify=(row,key,to,subject,text)=>queue(`${row.id}:${key}`,{to:[to],subject,text,category:`${config.kind}.${key}`,customVariables:{record_id:row.id,workflow:config.kind},headers:{'X-Workflow-Reference':row.id}});
  const instructions={welcome:'Arrive at the main entrance at 09:00. We will show you the sign-in desk.',setup:'Meet at the loading entrance at 08:00. Wear comfortable shoes.',cleanup:'Meet by the stage at 17:00. Supplies will be provided.'};
const onSubmit=data=>{if(find(data.email))return {};const row=insert(config.kind,data,'registered',data.email);notify(row,'signup',data.email,'Your Community Day volunteer details',`Hello ${data.name},\nThank you for joining the ${data.role} team.\n${instructions[data.role]}\nYour availability: ${data.availability}`);return row};
  let flushing=null;
  function flush() {
    return flushing ||= run().finally(()=>{flushing=null});
  }
  async function run() {
    const save=(id,result)=>db.prepare('UPDATE outbox SET status=?,provider_id=?,error=? WHERE id=?').run(result.status,result.providerId || '',result.error || null,id);
    while(true) {
        const candidates=db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 20").all();
        if(!candidates.length)break;
        const claimed=[];
        for(const row of candidates) {
          const message=JSON.parse(row.payload);
          if(db.prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(row.id).changes)claimed.push({...row,message});
        }
        for(const row of claimed) {
          try {const result=await deliver(row.message); if(!['accepted','logged'].includes(result?.status))throw Object.assign(new Error('Unrecognized send result.'),{uncertain:true});save(row.id,result);}
          catch(error){save(row.id,{status:error.uncertain?'unknown':'failed',error:error.message || 'Sending failed.'});}
        }
      }
  }
  async function submit(input, identity='local') {
    const parsed=submissionSchema.safeParse(input);
    if(!parsed.success)throw new AppError(parsed.error.issues[0].message);
    const data=parsed.data;
    rateLimit(db,`ip:${identity}`);
    if(data.email)rateLimit(db,`recipient:${data.email}`,3);
    const result=atomic(()=>onSubmit(data));
    await flush();
    let message=result.message || config.success;
    if(result.id){
      const states=db.prepare('SELECT status FROM outbox WHERE dedupe_key LIKE ?').all(`${result.id}:%`).map(row=>row.status);
      if(states.some(state=>['failed','unknown','pending','sending'].includes(state)))message+=' The email has not been confirmed as sent yet; the operator can review its status.';
      else if(states.includes('logged'))message+=' The email was recorded locally; no message was sent.';
    }
    return {ok:true,message,id:result.id || null};
  }
  function adminView() {return {records:records(config.kind),outbox:db.prepare('SELECT id,status,error,created_at FROM outbox ORDER BY created_at DESC LIMIT 30').all()};}
  function retryFailed() {db.prepare("UPDATE outbox SET status='pending',error=NULL WHERE status='failed'").run();return flush();}
  return {store,submit,adminView,flush,retryFailed};
}
let singleton;
export function service() {return singleton ||= createService();}
