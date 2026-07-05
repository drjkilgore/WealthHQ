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

/* Recursively find a summary row value by its label in a QBO report */
function findSummary(rows, label){
  for(const r of (rows||[])){
    if(r.Summary && r.Summary.ColData && r.Summary.ColData[0] &&
       String(r.Summary.ColData[0].value).toLowerCase() === label.toLowerCase()){
      const v = r.Summary.ColData[r.Summary.ColData.length-1].value;
      return parseFloat(String(v).replace(/,/g,"")) || 0;
    }
    if(r.Rows && r.Rows.Row){ const f = findSummary(r.Rows.Row, label); if(f !== null) return f; }
  }
  return null;
}
async function sumAccounts(realm, access, type){
  const q = encodeURIComponent(`select CurrentBalance from Account where AccountType = '${type}'`);
  const j = await qbGet(realm, access, `query?query=${q}`);
  return ((j.QueryResponse && j.QueryResponse.Account) || []).reduce((s,a)=>s+(+a.CurrentBalance||0),0);
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:H,body:""};
  if(event.httpMethod!=="POST") return bad(405,"POST only");
  const miss=envCheck(); if(miss) return bad(500,miss);
  try{
    const { hh } = await requireMember(event);
    const conns = await rest(`whq_qb_connections?household_id=eq.${hh}&select=*`);
    const mapped = conns.filter(c=>c.business_id);
    if(!mapped.length) return ok({ synced:0, message:"No QuickBooks company is assigned to a business yet." });

    const end = new Date().toISOString().slice(0,10);
    const start = new Date(Date.now()-365*864e5).toISOString().slice(0,10);
    let synced = 0, errors = [];

    for(const c of mapped){
      try{
        const access = await qbAccessToken(c.realm_id);
        const pl = await qbGet(c.realm_id, access, `reports/ProfitAndLoss?start_date=${start}&end_date=${end}`);
        const rows = (pl.Rows && pl.Rows.Row) || [];
        const income   = findSummary(rows, "Total Income");
        const expenses = findSummary(rows, "Total Expenses");
        const cogs     = findSummary(rows, "Total Cost of Goods Sold") || 0;

        const cash = await sumAccounts(c.realm_id, access, "Bank");
        const ar   = await sumAccounts(c.realm_id, access, "Accounts Receivable");
        const ap   = await sumAccounts(c.realm_id, access, "Accounts Payable");
        const cc   = await sumAccounts(c.realm_id, access, "Credit Card");
        const ltd  = await sumAccounts(c.realm_id, access, "Long Term Liability");

        const upd = {};
        if(income   !== null) upd.revenue_ttm  = income;
        if(expenses !== null) upd.expenses_ttm = expenses + cogs;
        upd.cash = cash; upd.accounts_receivable = ar; upd.accounts_payable = ap; upd.debt = cc + ltd;

        await rest(`whq_businesses?id=eq.${c.business_id}&household_id=eq.${hh}`,"PATCH",upd);
        await rest(`whq_qb_connections?realm_id=eq.${encodeURIComponent(c.realm_id)}`,"PATCH",{ last_synced:new Date().toISOString() });
        synced++;
      }catch(e){ errors.push((c.company_name||c.realm_id)+": "+e.message); }
    }
    return ok({ synced, errors });
  }catch(e){ return bad(400, e.message); }
};
