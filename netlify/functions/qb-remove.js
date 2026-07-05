const QB_API = (process.env.QB_ENV === "sandbox")
  ? "https://sandbox-quickbooks.api.intuit.com"
  : "https://quickbooks.api.intuit.com";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const H = { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Content-Type":"application/json" };
const bad = (code,msg)=>({statusCode:code,headers:H,body:JSON.stringify({error:msg})});
const ok  = (obj)=>({statusCode:200,headers:H,body:JSON.stringify(obj)});

async function rest(path, method="GET", body=null, prefer=null){
  const h = { apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:"Bearer "+process.env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type":"application/json" };
  if(prefer) h.Prefer = prefer;
  const r = await fetch(process.env.SUPABASE_URL+"/rest/v1/"+path,{method,headers:h,body:body?JSON.stringify(body):null});
  const t = await r.text();
  if(!r.ok) throw new Error("DB: "+t.slice(0,200));
  return t? JSON.parse(t):null;
}
async function requireMember(event){
  const jwt = (event.headers.authorization||event.headers.Authorization||"").replace(/^Bearer\s+/i,"");
  if(!jwt) throw new Error("Not signed in");
  const r = await fetch(process.env.SUPABASE_URL+"/auth/v1/user",{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+jwt}});
  if(!r.ok) throw new Error("Invalid session");
  const user = await r.json();
  const body = JSON.parse(event.body||"{}");
  const hh = body.household_id;
  if(!hh) throw new Error("Missing household_id");
  const mem = await rest(`whq_household_members?household_id=eq.${hh}&user_id=eq.${user.id}&select=role`);
  if(!mem.length) throw new Error("Not a member of this household");
  return { userId:user.id, hh, body };
}
async function qbTokenRequest(params){
  const basic = Buffer.from(process.env.QB_CLIENT_ID+":"+process.env.QB_CLIENT_SECRET).toString("base64");
  const r = await fetch(QB_TOKEN_URL,{method:"POST",
    headers:{ Authorization:"Basic "+basic, "Content-Type":"application/x-www-form-urlencoded", Accept:"application/json" },
    body:new URLSearchParams(params).toString()});
  const j = await r.json();
  if(!r.ok) throw new Error(j.error_description || j.error || "Intuit token error");
  return j;
}
/* Refresh (tokens rotate — always persist the new refresh_token) and return a live access token */
async function qbAccessToken(realm_id){
  const rows = await rest(`whq_qb_tokens?realm_id=eq.${encodeURIComponent(realm_id)}&select=*`);
  if(!rows.length) throw new Error("QuickBooks connection not found");
  const tok = await qbTokenRequest({ grant_type:"refresh_token", refresh_token:rows[0].refresh_token });
  await rest(`whq_qb_tokens?realm_id=eq.${encodeURIComponent(realm_id)}`,"PATCH",{
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now()+ (tok.expires_in||3600)*1000).toISOString()
  });
  return tok.access_token;
}
async function qbGet(realm_id, access, path){
  const r = await fetch(`${QB_API}/v3/company/${realm_id}/${path}${path.includes("?")?"&":"?"}minorversion=75`,{
    headers:{ Authorization:"Bearer "+access, Accept:"application/json" }});
  const j = await r.json();
  if(!r.ok) throw new Error((j.Fault && j.Fault.Error && j.Fault.Error[0] && j.Fault.Error[0].Message) || "QuickBooks API error");
  return j;
}
function envCheck(){
  for(const k of ["QB_CLIENT_ID","QB_CLIENT_SECRET","QB_REDIRECT_URI","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY"])
    if(!process.env[k]) return k+" is not set in Netlify environment variables";
  return null;
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:H,body:""};
  if(event.httpMethod!=="POST") return bad(405,"POST only");
  const miss=envCheck(); if(miss) return bad(500,miss);
  try{
    const { hh, body } = await requireMember(event);
    if(!body.realm_id) return bad(400,"Missing realm_id");
    const rid = encodeURIComponent(body.realm_id);
    const rows = await rest(`whq_qb_tokens?realm_id=eq.${rid}&household_id=eq.${hh}&select=refresh_token`);
    if(rows.length){
      try{
        const basic = Buffer.from(process.env.QB_CLIENT_ID+":"+process.env.QB_CLIENT_SECRET).toString("base64");
        await fetch("https://developer.api.intuit.com/v2/oauth2/tokens/revoke",{method:"POST",
          headers:{ Authorization:"Basic "+basic, "Content-Type":"application/json" },
          body:JSON.stringify({ token: rows[0].refresh_token })});
      }catch(e){}
    }
    await rest(`whq_qb_tokens?realm_id=eq.${rid}&household_id=eq.${hh}`,"DELETE");
    await rest(`whq_qb_connections?realm_id=eq.${rid}&household_id=eq.${hh}`,"DELETE");
    return ok({ removed:true });
  }catch(e){ return bad(400, e.message); }
};
