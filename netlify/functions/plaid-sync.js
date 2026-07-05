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

const ASSET_MAP = { checking:"Checking", savings:"Savings", "money market":"Money Market", cd:"Savings", hsa:"Other",
  brokerage:"Brokerage", ira:"Traditional IRA", roth:"Roth IRA", "401k":"401(k)", "401a":"401(k)", "403b":"401(k)", crypto:"Crypto" };
const LOAN_MAP = { mortgage:"Mortgage", home_equity:"Line of Credit", auto:"Vehicle Loan", student:"Personal Loan",
  personal:"Personal Loan", business:"Business Loan", "line of credit":"Line of Credit" };

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:H,body:""};
  if(event.httpMethod!=="POST") return bad(405,"POST only");
  const miss=envCheck(); if(miss) return bad(500,miss);
  try{
    const { hh } = await requireMember(event);
    const tokens = await rest(`whq_plaid_tokens?household_id=eq.${hh}&select=item_id,access_token`);
    if(!tokens.length) return ok({ synced:0, message:"No banks connected yet." });
    const items = await rest(`whq_plaid_items?household_id=eq.${hh}&select=item_id,institution_name`);
    const instOf = Object.fromEntries(items.map(i=>[i.item_id,i.institution_name||"Bank"]));

    let assets=[], liabs=[], skipped=0;
    for(const t of tokens){
      let j;
      try{ j = await plaid("/accounts/balance/get",{ access_token:t.access_token }); }
      catch(e){ skipped++; continue; }   // e.g. login expired at the bank
      const inst = instOf[t.item_id]||"Bank";
      for(const a of j.accounts){
        const label = `${inst} — ${a.name}${a.mask?" ···"+a.mask:""}`;
        const bal = a.balances.current ?? a.balances.available ?? 0;
        if(a.type==="depository" || a.type==="investment" || a.type==="brokerage"){
          const cat = a.type==="depository" ? (ASSET_MAP[(a.subtype||"").toLowerCase()]||"Checking")
                                            : (ASSET_MAP[(a.subtype||"").toLowerCase()]||"Brokerage");
          assets.push({ household_id:hh, plaid_account_id:a.account_id, name:label, category:cat, current_value:bal });
        }else if(a.type==="credit"){
          liabs.push({ household_id:hh, plaid_account_id:a.account_id, name:label, category:"Credit Card", balance:bal });
        }else if(a.type==="loan"){
          liabs.push({ household_id:hh, plaid_account_id:a.account_id, name:label,
            category:LOAN_MAP[(a.subtype||"").toLowerCase()]||"Other Debt", balance:bal });
        }
      }
      await rest(`whq_plaid_items?item_id=eq.${t.item_id}`,"PATCH",{ last_synced:new Date().toISOString() });
    }
    if(assets.length) await rest("whq_assets?on_conflict=plaid_account_id","POST",assets,"resolution=merge-duplicates");
    if(liabs.length)  await rest("whq_liabilities?on_conflict=plaid_account_id","POST",liabs,"resolution=merge-duplicates");
    return ok({ synced:assets.length+liabs.length, banks:tokens.length-skipped, skipped });
  }catch(e){ return bad(400, e.message); }
};
