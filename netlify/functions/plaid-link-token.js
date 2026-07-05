const PLAID_BASE = { production:"https://production.plaid.com", development:"https://development.plaid.com", sandbox:"https://sandbox.plaid.com" }[process.env.PLAID_ENV || "production"];
const H = { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json" };
const bad = (code,msg)=>({statusCode:code,headers:H,body:JSON.stringify({error:msg})});
const ok  = (obj)=>({statusCode:200,headers:H,body:JSON.stringify(obj)});

async function plaid(path, body){
  const r = await fetch(PLAID_BASE+path,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SECRET,...body})});
  const j = await r.json();
  if(!r.ok) throw new Error(j.error_message || j.error_code || "Plaid error");
  return j;
}
async function rest(path, method="GET", body=null, prefer=null){
  const h = { apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:"Bearer "+process.env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type":"application/json" };
  if(prefer) h.Prefer = prefer;
  const r = await fetch(process.env.SUPABASE_URL+"/rest/v1/"+path,{method,headers:h,body:body?JSON.stringify(body):null});
  const t = await r.text();
  if(!r.ok) throw new Error("DB: "+t.slice(0,200));
  return t? JSON.parse(t):null;
}
/* Verify the caller's Supabase session + membership in the household */
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
function envCheck(){
  for(const k of ["PLAID_CLIENT_ID","PLAID_SECRET","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY"])
    if(!process.env[k]) return k+" is not set in Netlify environment variables";
  return null;
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:H,body:""};
  if(event.httpMethod!=="POST") return bad(405,"POST only");
  const miss=envCheck(); if(miss) return bad(500,miss);
  try{
    const { userId } = await requireMember(event);
    const j = await plaid("/link/token/create",{
      user:{ client_user_id:userId },
      client_name:"WealthHQ",
      products:["transactions"],
      country_codes:["US"],
      language:"en"
    });
    return ok({ link_token:j.link_token });
  }catch(e){ return bad(400, e.message); }
};
