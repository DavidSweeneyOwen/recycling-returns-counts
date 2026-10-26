/* =========================================================================
   Recycling Returns — pipeline dashboard (redesign, October 2026)
   Data: /api/state. Stage rules: /pipeline.js (shared with the server, so the two
   can never disagree). Sections marked "LIVE CODE" are the pre-redesign dashboard's
   own functions carried over unchanged — /classic still runs the originals.
   ========================================================================= */
let STATE=null, VIEW='awaiting', Q={}, SHOW_ALL=false, menuOpen=false, B=null, FIRST=true;
let RECORDS=[], PRODMAP={}, chartTypeRef=null, chartTrendRef=null, reportsReady=false, LAST={};
let MONTHLY=[], ADMIN_PRODS=[], EDIT=null;
const nosoPicks=new Set(), wtnPicks=new Set();
const P=window.Pipeline;
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.h);toast.h=setTimeout(()=>t.classList.remove('show'),3400);}

/* ============ LIVE CODE: helpers, classifiers and actions (from the pre-redesign dashboard, unchanged) ============ */
function monthlyInfo(o){return MONTHLY.find(m=>{const k=String(m.match||m.name||'').toLowerCase();return k&&o.cust&&o.cust.toLowerCase().includes(k);});}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
/* A value passed as a JS string inside an onclick attribute: JSON-quoted, then HTML-escaped. */
function jsq(s){return esc(JSON.stringify(String(s??'')));}
function ukDate(iso){const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(iso||'');return m?`${m[3]}/${m[2]}/${m[1]}`:(iso||'');}
function crateLabel(c){
  if(c.crateTo&&c.crateTo!==c.crateFrom)return`Crates ${c.crateFrom}–${c.crateTo}`;
  return`Crate ${c.crateFrom||c.crate}`;
}
function ageDays(iso){const d=new Date(iso+'T00:00:00');return Math.max(0,Math.floor((Date.now()-d.getTime())/86400000));}
function ageBadge(o){const n=ageDays(o.date);const cls=n<=5?'g':(n<=10?'a':'r');return {cls,html:`<span class="age ${cls}">${n} day${n===1?'':'s'}</span>`};}
function lastCountDate(o){return o.counts.length?o.counts[o.counts.length-1].when.split(',')[0]:'';}
function counterNames(o){return [...new Set(o.counts.map(c=>c.by))].join(', ');}
function matchesFilter(o,f){if(!f)return true;return o.so.toLowerCase().includes(f)||o.cust.toLowerCase().includes(f);}
/* A drop-off still on its DROP- placeholder — the office hasn't attached the real
   SO yet. Keyed off the reference, not o.source, so it clears the moment one is. */
function noSo(o){return /^(DROP|MANUAL)-/.test(String(o.so||''))&&!o.noSoExpected;}
/* Every open, un-WTN'd drop-off for the same customer — one collection as far as
   the WTN, sales order and invoice are concerned. */
function openDropSiblings(o){
  if(!STATE||!o.dropOff||o.status!=='open'||o.wtn)return [];
  const k=String(o.cust||'').trim().toLowerCase();
  if(!k)return [];
  return STATE.orders.filter(x=>x.dropOff&&x.status==='open'&&!x.wtn&&String(x.cust||'').trim().toLowerCase()===k)
    .sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||a.id-b.id);   // oldest first, same as the server merges
}
/* A monthly customer gets ONE sales order a month, so every un-invoiced collection
   of theirs in the same calendar month belongs together. Returns them oldest first,
   with the one already carrying a real SO (if any) identified as the target. */
function monthlySiblings(o){
  if(!STATE)return [];
  const m=monthlyInfo(o);if(!m)return [];
  const key=m.code||m.name, month=String(o.date||'').slice(0,7);
  if(!/^\d{4}-\d{2}$/.test(month))return [];
  return STATE.orders.filter(x=>!x.invoicedAt&&String(x.date||'').slice(0,7)===month
      &&(()=>{const mi=monthlyInfo(x);return mi&&(mi.code||mi.name)===key;})())
    .sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||a.id-b.id);
}
const AGED_DAYS=90;   // three months on Awaiting Count and it archives itself
function isAged(o){return o.status==='open'&&!o.keepOpen&&ageDays(o.date)>AGED_DAYS;}
function dmy(s){const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s||'');return m?`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`:null;}
/* A drop-off that looks like a collection already counted against a real SO — same
   customer, counted within a fortnight. Catches the same delivery counted twice
   before anyone attaches an SO to something that has already been invoiced. */
function likelyDuplicate(o){
  if(!noSo(o)||!STATE)return null;
  const key=String(o.cust||'').trim().toLowerCase();
  if(key.replace(/[^a-z0-9]/g,'').length<4)return null;   // "E e" was matching inside "firE Extinguishers"
  const t1=new Date(dmy(lastCountDate(o))||o.date).getTime();
  return STATE.orders.find(x=>{
    if(x.id===o.id||noSo(x)||x.status!=='done')return false;
    const k2=String(x.cust||'').trim().toLowerCase();
    if(!k2||!(k2.includes(key)||key.includes(k2)))return false;
    const t2=new Date(dmy(lastCountDate(x))||x.date).getTime();
    return isFinite(t1)&&isFinite(t2)&&Math.abs(t1-t2)<=14*86400000;
  })||null;
}
function detailBlock(o,inv){
  const photos=[...new Set([o.photoId,...o.counts.map(c=>c.photoId)].filter(Boolean))];
  return `
    <div class="detail-grid">
      <div><h4>Total counted</h4><table>${o.totals.map(t=>`<tr><td>${esc(t.p)}</td><td>${t.q}</td></tr>`).join('')}</table></div>
      <div><h4>NetSuite lines (Phase 3 SO)</h4><table>${(o.nsLines||[]).map(l=>`<tr><td>${esc(l.code)}</td><td>${l.q}</td></tr>`).join('')}</table></div>
      <div><h4>Crate log</h4><div class="crate-log">${o.counts.map((c,ci)=>`<div class="entry-l">${crateLabel(c)} — ${esc(c.by)} — ${esc(c.when)}${o.invoicedAt?'':` <a href="#" onclick="event.preventDefault();event.stopPropagation();moveCrate(${o.id},${ci})" style="font-size:11px;margin-left:6px">move to another SO</a>`}<br>${c.lines.map(l=>esc(l.p)+' ×'+l.q).join(', ')}</div>`).join('')}</div></div>
    </div>
    ${photos.length?`<div style="margin-top:10px">${photos.map(id=>`<a class="btn small ghost" href="/api/photo/${encodeURIComponent(id)}" target="_blank" style="margin:0 6px 6px 0;display:inline-block">View photo</a>`).join('')}</div>`:''}
    <div class="actions">
      <div><label>SO created against count (manual until API)</label>
        <input value="${esc(o.finalSo||'')}" placeholder="pending API" onchange="setFinalSO(${o.id},this.value)"></div>
      ${inv?`<label class="tickbox"><input type="checkbox" checked onchange="mark(${o.id},'invoiced',this.checked)">Invoiced <span class="stamp">${esc(o.invoicedAt||'')}</span></label>`:''}
    </div>`;
}
async function closeShort(id,expected,received){
  const msg=`This order expected ${expected} crates but only ${received} ${received===1?'has':'have'} been counted.\n\nClose it at ${received} crate(s)? This completes the order, issues the WTN for what was actually returned, and can't be undone.`;
  if(!confirm(msg))return;
  const reason=prompt('Reason (e.g. customer confirmed only sending '+received+'):','')??'';
  const r=await fetch('/api/close-short',{method:'POST',body:JSON.stringify({orderId:id,reason})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  toast(`Closed short — ${j.wtn} issued for ${j.received} of ${j.expected} crates`);refresh();
}
async function mark(id,field,value){
  const r=await fetch('/api/mark',{method:'POST',body:JSON.stringify({orderId:id,field,value})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  const msgs={wtnSent:value?'WTN marked as sent':'WTN send unticked',invoiced:value?'Marked as invoiced':'Moved back to Counted',credit:value?'CO2 credit marked as issued':'Credit unticked'};
  toast(msgs[field]);refresh();
}
async function setFinalSO(id,v){await fetch('/api/final-so',{method:'POST',body:JSON.stringify({orderId:id,finalSo:v})});toast('SO number saved');refresh();}
/* Attach the real SO to a drop-off from the No SO Yet tab. */
/* Take a wrongly attached SO/TFO back off a drop-off — it returns to its DROP- number. */
async function unsetSo(id,so,drop){
  if(!confirm(`Take ${so} off this collection? It goes back to ${drop} (No SO Yet) with its counts kept.`))return;
  const r=await fetch('/api/unset-so',{method:'POST',body:JSON.stringify({orderId:id})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  toast(`${j.from} removed — back to ${j.to}`);
  refresh();
}
async function attachSo(id,inputId){
  const inp=document.getElementById(inputId||('nosoSo'+id));
  const so=(inp&&inp.value||'').trim();
  if(!so){toast('Enter the SO number');return;}
  const r=await fetch('/api/set-so',{method:'POST',body:JSON.stringify({orderId:id,so})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  toast(j.added?`${j.from} added to ${j.so} — now ${j.counted} of ${j.crates} crates${j.completed?', complete':''}`
       :j.absorbed?`${j.so} attached — merged with the collection NetSuite had raised`:`${j.so} attached`);
  refresh();
}
/* Move one counted crate onto the SO/TFO it really came in on — for undoing a wrong
   attach or merge. The Pallex consignment number is usually the answer. */
async function moveCrate(id,ci){
  const o=STATE.orders.find(x=>x.id===id)||{};const c=(o.counts||[])[ci];if(!c)return;
  const so=(prompt(`Move ${crateLabel(c).toLowerCase()} (${c.lines.map(l=>l.p+' ×'+l.q).join(', ')}) off ${o.so} onto which SO / TFO?`,'')||'').trim();
  if(!so)return;
  const r=await fetch('/api/move-crate',{method:'POST',body:JSON.stringify({orderId:id,countIndex:ci,so})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  toast(`Crate moved from ${j.from} to ${j.to} — now ${j.toCounted} of ${j.toCrates}`);refresh();
}
/* Fold every open drop-off for one customer into a single collection, so the admin
   raises one WTN, one sales order and one invoice rather than six. */
async function mergeDrops(id){
  const sibs=openDropSiblings(STATE.orders.find(o=>o.id===id)||{});
  const total=sibs.reduce((a,o)=>a+o.crates,0);
  if(!confirm(`Merge ${sibs.length} open drop-offs for ${sibs[0]?sibs[0].cust:'this customer'} into one collection of ${total} crate(s)?\n\nThe counts already taken are kept and re-sequenced. Collections that already have a WTN issued are left alone. This cannot be undone.`))return;
  const r=await fetch('/api/merge-drops',{method:'POST',body:JSON.stringify({orderId:id})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  toast(j.completed?`Merged into ${j.into} — ${j.crates} crates, complete, ${j.wtn} issued`
                   :`Merged ${j.merged+1} drop-offs into ${j.into} — ${j.crates} crates`);
  refresh();
}
/* ---- Ticking collections that are really one delivery ----
   The Rec team raise a fresh drop-off per crate, so one collection arrives as five or
   six rows under five or six spellings of the customer. Nothing can group those safely
   by name, so the office ticks them and the server folds exactly those. */
/* The keeper is whichever ticked row already carries a real SO; failing that the
   oldest, so the collection date stays the earliest of the set. */
function nosoKeeper(picked){
  return picked.find(o=>!/^(DROP|MANUAL)-/.test(String(o.so||'')))
      || picked.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||a.id-b.id)[0];
}
async function consolidatePicked(){
  const picked=[...nosoPicks].map(id=>STATE.orders.find(o=>o.id===id)).filter(Boolean);
  if(picked.length<2){toast('Tick at least two collections');return;}
  const keeper=nosoKeeper(picked), sources=picked.filter(o=>o.id!==keeper.id);
  const wtns=sources.filter(o=>o.wtn).map(o=>o.wtn);
  const crates=picked.reduce((a,o)=>a+(o.counted||0),0);
  if(!confirm(`Fold ${sources.length} collection(s) into ${keeper.so} (${keeper.cust})?\n\n`
    +`${crates} crate(s) counted in total.`
    +(wtns.length?`\n\n${wtns.length} waste transfer note(s) already issued (${wtns.join(', ')}) will be recorded against the result.`:'')
    +`\n\nThis cannot be undone.`))return;
  const r=await fetch('/api/consolidate',{method:'POST',body:JSON.stringify({targetId:keeper.id,sourceIds:sources.map(o=>o.id)})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  nosoPicks.clear();
  toast(`Folded ${j.folded} into ${j.into} — ${j.counted}/${j.crates} crates${j.completed?', complete':''}`);
  refresh();
}
/* Monthly customer — fold a whole month's collections onto that month's sales order.
   Crates sum, counts are re-sequenced, and any WTNs already issued are kept on the
   record rather than discarded. */
async function monthlyMerge(id){
  const o=STATE.orders.find(x=>x.id===id)||{};
  const sibs=monthlySiblings(o), month=String(o.date||'').slice(0,7);
  const tgt=sibs.find(x=>!/^(DROP|MANUAL)-/.test(String(x.so||'')));
  const crates=sibs.reduce((a,x)=>a+(x.counted||0),0);
  const wtns=sibs.filter(x=>x.wtn&&x.id!==(tgt||{}).id).map(x=>x.wtn);
  if(!confirm(`Consolidate ${sibs.length} ${o.cust} collections from ${month} into one`
    +`${tgt?' on '+tgt.so:''}?\n\n${crates} crate(s) counted across the month.`
    +(wtns.length?`\n\n${wtns.length} waste transfer note(s) already issued (${wtns.join(', ')}) will be recorded against the consolidated collection.`:'')
    +`\n\nThis cannot be undone.`))return;
  const r=await fetch('/api/monthly-merge',{method:'POST',body:JSON.stringify({orderId:id})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  toast(`${j.account} ${j.month} consolidated onto ${j.into} — ${j.folded+1} collections, ${j.counted}/${j.crates} crates`
    +(j.completed?`, complete`:''));
  refresh();
}
/* This customer only ever drops off — no SO is ever raised, so take the collection
   off the No SO Yet queue and remember them for next time. */
async function noSoExpected(id){
  const r=await fetch('/api/no-so-expected',{method:'POST',body:JSON.stringify({orderId:id,value:true})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  toast(`${j.cust} marked as drop-off only — future drop-offs skip this queue`);
  refresh();
}
/* Pull an archived collection back onto Awaiting Count — it is still expected. */
async function keepOpen(id){
  const r=await fetch('/api/keep-open',{method:'POST',body:JSON.stringify({orderId:id})});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  toast('Back on Awaiting Count');refresh();
}

/* ============ redesign: helpers ============ */
const ICON={
 roll:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 10-1.6 3.7M13 3v3h-3"/></svg>',
 edit:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3L6 13H3v-3z"/></svg>',
 chart:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13h12M4 10V7M8 10V3M12 10V6"/></svg>',
 box:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="3"/><path d="M3 6v7h10V6M6.5 9h3"/></svg>',
 users:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 3.3a2.4 2.4 0 010 4.4M12.5 9.4c1.5.4 2.5 1.7 2.5 3.6"/></svg>',
 lock:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>'
};
/* Roll-up membership is derived from the customer list (pipeline.js), so every call passes it. */
function stageOf(o){return P.stageOf(o,undefined,STATE.customers);}
function rollStateOf(o){return P.rollState(o,STATE.customers);}
function openRoll(code){return P.openRollup(STATE.orders,code,STATE.customers);}
function plural(n,w,p){return n+' '+(n===1?w:(p||w+'s'));}
/* Today in UK time, in the dd/mm/yyyy form the server stamps with. Never hard-coded. */
function todayUK(){return new Date().toLocaleDateString('en-GB',{timeZone:'Europe/London'});}
function units(o){return (o.totals||[]).reduce((a,t)=>a+t.q,0);}
function daysSinceUK(s){const iso=dmy(String(s||'').split(',')[0]);return iso?P.ageDays(iso):0;}
function agePill(n){const cls=n<=7?'':(n<=30?'mid':'old');return `<span class="age ${cls}">${n===0?'Today':plural(n,'day')}</span>`;}
function oldest(list,f){return list.length?Math.max(...list.map(f)):0;}
function byDate(a,b){return String(a.date||'').localeCompare(String(b.date||''))||a.id-b.id;}
function matches(o,f){if(!f)return true;f=f.toLowerCase();return [o.so,o.cust,o.wtn,o.nsRef,o.dropRef,o.claimedRef,o.finalSo].some(x=>String(x||'').toLowerCase().includes(f));}
function countsToday(o){return (o.counts||[]).filter(c=>String(c.when||'').split(',')[0]===todayUK());}
function adminName(){try{return localStorage.getItem('recAdmin')||'';}catch(e){return '';}}
async function api(path,body,headers){
  try{const r=await fetch(path,{method:'POST',headers:Object.assign({'Content-Type':'application/json'},headers||{}),body:JSON.stringify(body)});return await r.json();}
  catch(e){return {error:'Server unreachable — nothing was saved'};}
}
function rollVisits(r){return STATE.orders.filter(o=>P.billedOn(o,r.id).length);}
function eLines(es,f){const m={};(es||[]).forEach(c=>(c.lines||[]).forEach(l=>{const k=f(l);m[k]=(m[k]||0)+Number(l.q);}));return m;}
function sumProductsE(es){return eLines(es,l=>l.p);}
function sumCodesE(es){return eLines(es,l=>l.other?'Other':((PRODMAP[l.p]||{}).code||'UNMAPPED'));}
function unbilledOf(list){return [].concat(...list.map(o=>P.unbilled(o)));}
function packEntries(r){return [].concat(...STATE.orders.map(o=>P.billedOn(o,r.id)));}
function sumProducts(vs){const m={};vs.forEach(o=>(o.totals||[]).forEach(t=>{m[t.p]=(m[t.p]||0)+t.q;}));return m;}
function sumCodes(vs){const m={};vs.forEach(o=>(o.counts||[]).forEach(c=>(c.lines||[]).forEach(l=>{const k=l.other?'Other':((PRODMAP[l.p]||{}).code||'UNMAPPED');m[k]=(m[k]||0)+Number(l.q);})));return m;}
function kvList(m){const k=Object.keys(m).sort(),t=k.reduce((a,x)=>a+m[x],0);return k.map(x=>`<div class="kv"><span>${esc(x)}</span><b class="mono">${m[x]}</b></div>`).join('')+`<div class="kv total"><span>Total</span><b class="mono">${t}</b></div>`;}

/* ============ stages ============ */
function buckets(){
  const b={awaiting:[],noso:[],counted:[],wtn:[],processed:[],archive:[],monthly:[],rolled:[],removed:[]};
  (STATE.orders||[]).forEach(o=>{(b[stageOf(o)]||b.counted).push(o);});
  const R=STATE.rollups||[];
  b.rollPack=R.filter(r=>P.rollupStage(r)==='pack');
  b.rollWtn=R.filter(r=>P.rollupStage(r)==='wtn');
  b.rollDone=R.filter(r=>P.rollupStage(r)==='processed');
  b.pending=b.monthly.filter(o=>rollStateOf(o)==='pending');
  return b;
}
const STAGE_NAV=[['awaiting','Awaiting count'],['noso','No SO yet'],['counted','Counted'],['wtn','WTN sent'],['processed','Processed on NetSuite']];
function stageCount(k){if(k==='wtn')return B.wtn.length+B.rollWtn.length;if(k==='processed')return B.processed.length+B.rollDone.length;return B[k].length;}
function renderNav(){
  const st=STAGE_NAV.map(([k,l])=>`<button class="nav-item s-${k}" role="tab" aria-selected="${VIEW===k}" onclick="go('${k}')"><span class="dot"></span><span class="grow">${l}</span><span class="cnt">${N(stageCount(k))}</span></button>`).join('');
  const cs=STATE.customers||[],monthlyN=cs.filter(c=>c.billing==='monthly').length;
  const other=[
    ['monthly','Monthly accounts','roll','s-monthly',B.pending.length?`<span class="flag" title="Visits waiting for Confirm">${B.pending.length} to confirm</span>`:`<span class="cnt">${monthlyN}</span>`],
    ['amend','Amendments','edit','s-neutral',`<span class="cnt">${STATE.orders.filter(o=>o.amended).length}</span>`],
    ['reports','Reports','chart','s-neutral',''],
    ['archive','Archive','box','s-neutral',`<span class="cnt">${N(B.archive.length)}</span>`],
    ['customers','Customers','users','s-neutral',STATE.adminEnabled?`<span class="cnt">${cs.length}</span>`:`<span class="cnt" style="display:flex" title="Read-only until ADMIN_KEY is set">${ICON.lock}</span>`]
  ].map(([k,l,ic,cl,right])=>`<button class="nav-item ${cl}" role="tab" aria-selected="${VIEW===k}" onclick="go('${k}')">${ICON[ic]}<span class="grow">${l}</span>${right}</button>`).join('');
  document.getElementById('nav').innerHTML=`<div class="navgroup"><div class="navlabel">Pipeline</div>${st}</div><div class="divider"></div><div class="navgroup">${other}</div>`;
}
/* The sync status line and the store warning banner — same wording as live. */
function renderChrome(){
  const st=STATE.store||{},warn=document.getElementById('storeWarn');
  if(st.ready){warn.style.display='none';}
  else if(st.state==='starting'){warn.style.display='block';warn.style.background='#b45309';
    warn.textContent='Connecting to the data store — the figures below are not live yet.';}
  else{warn.style.display='block';warn.style.background='#b42318';
    warn.innerHTML='Data store unavailable — this dashboard is READ-ONLY and the figures below are NOT the live data. '
      +'Nothing is being saved and the Rec team cannot count. '+esc(st.error||'')
      +'<br>The live data is safe in the store; the app will pick it up on the next restart.';}
  const ls=STATE.lastSync;
  document.getElementById('syncDot').className='sync-dot '+(ls?(ls.ok?'ok':'bad'):'');
  document.getElementById('syncMsg').textContent=ls?`Auto-sync — last ${ls.when} (${ls.msg})`:'Waiting for first sync…';
}
function toggleMenu(){menuOpen=!menuOpen;document.getElementById('navwrap').classList.toggle('open',menuOpen);document.getElementById('menuBtn').setAttribute('aria-expanded',menuOpen);}
function go(k){VIEW=k;SHOW_ALL=false;try{localStorage.setItem('rrView',k);history.replaceState(null,'','#'+k);}catch(e){}if(menuOpen)toggleMenu();render(true);window.scrollTo(0,0);}
function render(entering){
  if(!STATE)return;
  B=buckets();renderNav();renderChrome();
  const isRep=VIEW==='reports',isAm=VIEW==='amend',pipe=document.getElementById('viewPipe');
  document.getElementById('viewReports').style.display=isRep?'block':'none';
  document.getElementById('viewAdmin').style.display=isAm?'block':'none';
  pipe.style.display=(isRep||isAm)?'none':'block';
  if(isRep){if(!reportsReady){populateReportFilters();reportsReady=true;}renderReports();reportsToday();if(entering)rowInfo();}
  else if(isAm){renderAdminList();amendToday();}
  else{pipe.innerHTML=(VIEWS[VIEW]||VIEWS.awaiting)();paintPicks();}
}
/* The guide (/guide.html) is only linked once the server really serves it: probed once at start. */
let GUIDE_OK=false;
function qm(key,label){return GUIDE_OK?`<a class="qmark" href="/guide.html#${key}" target="_blank" rel="noopener" aria-label="Guide: ${esc(label)}" title="Open the guide for ${esc(label)}">?</a>`:'';}
function probeGuide(){
  fetch('/guide.html',{cache:'no-store'}).then(r=>{
    if(r.ok&&/html/.test(r.headers.get('content-type')||'')){
      GUIDE_OK=true;document.getElementById('guideLink').hidden=false;
      document.querySelectorAll('.guide-q').forEach(e=>{e.hidden=false;});if(STATE)render();}
  }).catch(()=>{});
}
/* Title row: the noun, the Today line, one sentence on what to do here (with its "?"), and the lead figure on the right. */
function head(cls,title,today,what,right,lead,gk){
  const lf=lead?`<div class="leadfig"><div class="big${lead[0]===0?' zero':''}">${Number(lead[0]).toLocaleString('en-GB')}</div><div class="lbl">${lead[1]}</div></div>`:'';
  return `<div class="view-head ${cls}"><div class="vh-l"><h1>${title}</h1><div class="today"><span class="pip"></span><span>${today}</span></div>${what?`<p class="what"><span>${what}</span>${gk?qm(gk,title):''}</p>`:''}</div>${(lf||right)?`<div class="vh-r">${lf}${right||''}</div>`:''}</div>`;
}
function searchBox(k,ph){return `<input class="search" type="search" id="q_${k}" placeholder="${ph}" aria-label="${ph}" value="${esc(Q[k]||'')}" oninput="onSearch('${k}',this)">`;}
const N=n=>Number(n).toLocaleString('en-GB');
function onSearch(k,el){Q[k]=el.value;const p=el.selectionStart;render();const n=document.getElementById('q_'+k);if(n){n.focus();try{n.setSelectionRange(p,p);}catch(e){}}}
function empty(t,s){return `<div class="empty"><b>${t}</b>${s}</div>`;}

/* ============ cards ============ */
function photoLinks(o,compact){
  const ids=[...new Set([o.photoId,...(o.counts||[]).map(c=>c.photoId)].filter(Boolean))];
  return ids.map((id,i)=>`<a class="lbtn" href="/api/photo/${encodeURIComponent(id)}" target="_blank">View photo${ids.length>1?' '+(i+1):''}</a>`).join('');
}
function tagsFor(o,stage){
  const t=[];
  if(o.dropOff)t.push('<span class="badge s-noso">Drop-off</span>');
  if(o.needsReview)t.push(`<span class="badge s-noso" title="Photographed on the tablet but the number didn't match a live collection">Needs review${o.claimedRef?' — tried '+esc(o.claimedRef):''}</span>`);
  if(stage==='noso'){const d=likelyDuplicate(o);if(d)t.push(`<span class="badge s-awaiting" title="Same customer, counted within a fortnight — check this is not the same delivery twice">Possible duplicate of ${esc(d.so)}</span>`);}
  const m=monthlyInfo(o);if(m)t.push(`<span class="badge s-monthly" title="Tagged monthly in config">Monthly · ${esc(m.code||m.name)}</span>`);
  if(o.amended)t.push(`<span class="badge s-awaiting" title="${esc(o.amendments&&o.amendments.length?o.amendments[o.amendments.length-1].reason:'')}">Amended${o.wtnSentAt?'':' — resend WTN'}</span>`);
  if(o.short)t.push(`<span class="badge s-awaiting" title="${esc(o.short.reason||'')}">Short — ${o.short.received} of ${o.short.expected} returned</span>`);
  if(o.co2>0)t.push(`<span class="badge s-counted">CO2 buy-back · ${o.co2}${o.creditAt?' · credited':''}</span>`);
  if(o.rollOutAt)t.push(`<span class="badge s-monthly" title="${esc(o.rollOutWhy||'')}">Off the ${esc(o.rollCode)} roll-up</span>`);
  return t.join('');
}
function card(o,stage,foot,opts){
  opts=opts||{};
  const set=opts.pick==='noso'?nosoPicks:opts.pick==='wtn'?wtnPicks:null,key=opts.pick==='wtn'?'o'+o.id:o.id;
  const on=set&&set.has(key);
  const pick=set?`<label class="pick"><input type="checkbox" ${on?'checked':''} onchange="togglePick('${opts.pick}','${key}',this.checked)" aria-label="Select ${esc(o.so)}"></label>`:'';
  const pct=o.crates?Math.round(o.counted/o.crates*100):0;
  const lines=o.totals.length?o.totals.map(t=>`<div><span>${esc(t.p)}</span><b>${t.q}</b></div>`).join(''):'<div class="none">No crates counted yet</div>';
  return `<article class="card s-${stage} ${o.needsReview?'flagged':''} ${on?'sel-on':''}" ${set?`data-key="${key}"`:''}>
    <div class="card-top"><div><div class="ref">${pick}<span>${esc(o.so)}</span>${o.wtn?`<span>· ${esc(o.wtn)}</span>`:''}</div>
      <div class="cust">${esc(o.cust)}</div><div class="meta">${o.dropOff?'Dropped off':'Created'} ${esc(ukDate(o.date))}${o.by?' · '+esc(o.by):''}</div></div>${opts.age||''}</div>
    <div class="facts"><span><b>${o.counted}</b> of <b>${o.crates}</b> crates</span>${o.totals.length?`<span><b>${units(o)}</b> units</span>`:''}${lastCountDate(o)?`<span>Last count ${esc(lastCountDate(o))}</span>`:''}</div>
    ${stage==='awaiting'?`<div class="prog" role="img" aria-label="${pct}% counted"><i style="width:${pct}%"></i></div>`:''}
    <div class="tags">${tagsFor(o,stage)}</div>
    <div class="lines">${lines}</div>
    <div class="card-foot">${foot}</div></article>`;
}
const detailsBtn=o=>`<button class="lbtn" onclick="openDetails(${o.id})">Details</button>`;
const undoBtn=o=>o.dropRef&&!o.invoicedAt?`<button class="lbtn" onclick="unsetSo(${o.id},${jsq(o.so)},${jsq(o.dropRef)})">Wrong SO? Undo</button>`:'';
const creditBox=o=>o.co2>0?`<label class="tickbox"><input type="checkbox" ${o.creditAt?'checked':''} onchange="mark(${o.id},'credit',this.checked)">CO2 credit issued ${o.creditAt?`<span class="stamp">${esc(o.creditAt)}</span>`:''}</label>`:'';
/* Deep links: /#monthly, /#wtn … open that view. */
window.addEventListener('hashchange',()=>{const v=location.hash.slice(1);if(v!==VIEW&&(VIEWS[v]||v==='reports'||v==='amend'))go(v);});
/* Long queues (Awaiting runs to thousands) draw the oldest 120 first, then all on request. */
const PAGE=120;
function grid(list,fn,none){
  if(!list.length)return none;
  const shown=SHOW_ALL?list:list.slice(0,PAGE);
  return `<div class="grid">${shown.map(fn).join('')}</div>`
    +(list.length>shown.length?`<p style="margin-top:16px"><button class="btn quiet" onclick="SHOW_ALL=true;render()">Show all ${list.length}</button> <span class="meta">Showing the oldest ${shown.length} — search to find a specific one</span></p>`:'');
}

/* ============ views ============ */
const VIEWS={
 awaiting(){
  const all=B.awaiting.slice().sort(byDate),l=all.filter(o=>matches(o,Q.awaiting));
  const today=all.reduce((a,o)=>a+countsToday(o).reduce((s,c)=>s+(c.crateTo?c.crateTo-c.crateFrom+1:1),0),0);
  const shown=SHOW_ALL?l:l.slice(0,PAGE);
  const row=o=>{
    const sibs=openDropSiblings(o),pct=o.crates?Math.round(o.counted/o.crates*100):0;
    const merge=(sibs.length>1&&sibs[0].id===o.id)?`<button class="btn quiet sm" onclick="mergeDrops(${o.id})">Merge ${sibs.length} drop-offs into one</button>`:'';
    const tg=tagsFor(o,'awaiting');
    return `<tr><td data-label="Order"><div><span class="mono">${esc(o.so)}</span>${tg?`<div class="tagrow">${tg}</div>`:''}</div></td>
      <td data-label="Customer"><div><b style="font-weight:600">${esc(o.cust)}</b><span class="sub2">${o.dropOff?'Dropped off':'Created'} ${esc(ukDate(o.date))}${o.by?' · '+esc(o.by):''}</span></div></td>
      <td data-label="Counted"><div class="pbar s-awaiting"><div class="prog" role="img" aria-label="${pct}% counted"><i style="width:${pct}%"></i></div><span class="mono">${o.counted} of ${o.crates}</span></div></td>
      <td class="num" data-label="Units">${o.totals.length?N(units(o)):'<span style="color:var(--ink-3)">—</span>'}</td>
      <td data-label="Age" style="white-space:nowrap;color:var(--ink-2)">${plural(P.ageDays(o.date),'day')}</td>
      <td data-label=""><div class="rowact">${photoLinks(o,true)}${merge}${undoBtn(o)}${detailsBtn(o)}${o.counted>0?`<button class="btn quiet sm" onclick="closeShort(${o.id},${o.crates},${o.counted})">Close short</button>`:''}</div></td></tr>`;
  };
  return head('s-awaiting','Awaiting count',`${N(all.reduce((a,o)=>a+(o.crates-o.counted),0))} crates still to come · ${N(all.filter(o=>!o.counted).length)} orders not started · <b>${plural(today,'crate')} counted today</b> · oldest ${plural(oldest(all,o=>P.ageDays(o.date)),'day')}`,
    'Nothing to do until the rec team count the crates on /count. Close short only when the customer says fewer are coming.',searchBox('awaiting','Search SO or customer'),[all.length,'orders awaiting count'],'stage-awaiting')
   +(l.length?`<div class="tablewrap"><table class="stack"><thead><tr><th>Order</th><th>Customer</th><th>Crates counted</th><th class="num">Units</th><th>Age</th><th></th></tr></thead><tbody>${shown.map(row).join('')}</tbody></table></div>`
     +(l.length>shown.length?`<p class="morebar"><button class="btn quiet" onclick="SHOW_ALL=true;render()">Show all ${N(l.length)}</button> <span class="meta">Showing the oldest ${shown.length} — search to find a specific one</span></p>`:'')
     :empty('Nothing awaiting count','Every collection has been counted, or none match the search.'));
 },
 noso(){
  const all=B.noso.slice().sort(byDate),l=all.filter(o=>matches(o,Q.noso));
  return head('s-noso','No SO yet',`${all.filter(o=>o.needsReview).length} flagged for review · <b>${all.filter(o=>lastCountDate(o)===todayUK()).length} counted today</b> · oldest ${plural(oldest(all,o=>P.ageDays(o.date)),'day')}`,
    'Type the real SO against each drop-off and press Link SO. If several rows are one delivery, tick them and Combine.',searchBox('noso','Search ref or customer'),[all.length,all.length===1?'drop-off needs an SO':'drop-offs need an SO'],'stage-noso')
   +`<div class="bulk s-noso" id="nosoBar" hidden><span class="msg" id="nosoMsg"></span><button class="btn" onclick="consolidatePicked()">Combine into one</button><button class="btn quiet" onclick="clearPicks('noso')">Clear</button></div>`
   +grid(l,o=>{
     const sibs=monthlySiblings(o),tgt=sibs.find(x=>!P.isPlaceholder(x.so));
     const mm=sibs.length>1?`<button class="btn quiet sm" onclick="monthlyMerge(${o.id})" title="Monthly customer (config) — fold this month's collections onto one sales order">Consolidate ${esc(String(o.date||'').slice(0,7))} — ${sibs.length}${tgt?' onto '+esc(tgt.so):''}</button>`:'';
     return card(o,'noso',`<div class="field"><label for="nosoSo${o.id}">Attach the real SO</label><input class="in" id="nosoSo${o.id}" placeholder="e.g. SO824039" value="${o.claimedRef?esc(o.claimedRef):''}" onkeydown="if(event.key==='Enter')attachSo(${o.id},'nosoSo${o.id}')"></div>`
       +`${photoLinks(o)}${mm}<button class="lbtn" onclick="noSoExpected(${o.id})" title="This customer only ever drops off — take it off this queue and remember them">No SO expected</button>${detailsBtn(o)}<button class="btn primary" onclick="attachSo(${o.id},'nosoSo${o.id}')">Link SO</button>`,
       {pick:'noso',age:agePill(P.ageDays(o.date))});
   },empty('Every drop-off is matched to an SO','Counted drop-offs without an SO sit here until the real number is attached.'));
 },
 counted(){
  const all=B.counted.slice().sort(byDate),l=all.filter(o=>matches(o,Q.counted));
  return head('s-counted','Counted',`<b>${all.filter(o=>lastCountDate(o)===todayUK()).length} completed today</b> · ${plural(all.filter(o=>o.co2>0&&!o.creditAt).length,'CO2 credit')} due · oldest ${plural(oldest(all,o=>P.ageDays(o.date)),'day')}`,
    'Fully counted. Check the WTN, send it to the customer yourself, then Mark WTN sent.',searchBox('counted','Search SO, customer or WTN'),[all.length,'orders ready for the WTN'],'stage-counted')
   +grid(l,o=>card(o,'counted',
      (P.isPlaceholder(o.so)?`<div class="field"><label for="cntSo${o.id}">No SO — attach one</label><input class="in" id="cntSo${o.id}" placeholder="SO / TFO no." onkeydown="if(event.key==='Enter')attachSo(${o.id},'cntSo${o.id}')"></div>`:'')
      +`<a class="btn quiet sm" href="/wtn/${o.id}" target="_blank">View WTN</a>${creditBox(o)}${photoLinks(o)}${undoBtn(o)}${detailsBtn(o)}<button class="btn primary" onclick="mark(${o.id},'wtnSent',true)">Mark WTN sent</button>`,
      {age:agePill(P.ageDays(o.date))}),empty('Nothing waiting for a WTN','Collections land here when the final crate is counted.'));
 },
 wtn(){
  const all=B.wtn.slice().sort((a,b)=>daysSinceUK(b.wtnSentAt)-daysSinceUK(a.wtnSentAt)),l=all.filter(o=>matches(o,Q.wtn));
  const rolls=B.rollWtn.filter(r=>!Q.wtn||(r.name+' '+r.code+' '+r.wtn).toLowerCase().includes(Q.wtn.toLowerCase()));
  const total=all.length+B.rollWtn.length,sentToday=all.filter(o=>o.wtnSentAt===todayUK()).length+B.rollWtn.filter(r=>r.sentAt===todayUK()).length;
  return head('s-wtn','WTN sent',`<b>${sentToday} sent today</b> · oldest sent ${plural(Math.max(oldest(all,o=>daysSinceUK(o.wtnSentAt)),oldest(B.rollWtn,r=>daysSinceUK(r.sentAt))),'day')} ago`,
    'When it is done in NetSuite, type the SO or invoice number and Mark processed on NetSuite.',searchBox('wtn','Search SO, customer or WTN'),[total,'orders waiting for NetSuite'],'stage-wtn')
   +`<div class="bulk s-wtn" id="wtnBar"><label class="tickbox"><input type="checkbox" id="wtnAll" onchange="pickAllWtn(this.checked)"> Select all</label><span class="msg" id="wtnMsg"></span><button class="btn" id="wtnBulk" onclick="downloadSelected()" disabled>Download selected WTNs (0)</button></div>`
   +((l.length||rolls.length)?`<div class="grid">${rolls.map(rollCard).join('')}${l.map(o=>card(o,'wtn',
      `<div class="rowx"><span class="badge s-wtn"><span class="mono">${esc(o.wtn||'')}</span> · sent ${esc(o.wtnSentAt)}</span>${creditBox(o)}</div>`
      +`<div class="rowx"><a class="btn quiet sm" href="/wtn/${o.id}?print=1" target="_blank">Download WTN (PDF)</a><a class="btn quiet sm" href="/wtn/${o.id}" target="_blank">Reprint</a>${photoLinks(o)}${detailsBtn(o)}<button class="lbtn" onclick="mark(${o.id},'wtnSent',false)">Not sent — back to Counted</button></div>`
      +`<div class="field"><label for="ns${o.id}">NetSuite SO or invoice number</label><input class="in" id="ns${o.id}" placeholder="e.g. INV-190300" value="${esc(o.finalSo||'')}" onkeydown="if(event.key==='Enter')processOrder(${o.id})"></div><button class="btn primary" onclick="processOrder(${o.id})">Mark processed on NetSuite</button>`,
      {pick:'wtn',age:agePill(daysSinceUK(o.wtnSentAt))})).join('')}</div>`:empty('Nothing waiting on NetSuite','Orders appear here once their WTN is marked as sent.'));
 },
 processed(){
  let rows=B.processed.map(o=>({o,when:o.invoicedAt||''})).concat(B.rollDone.map(r=>({r,when:String(r.processedAt||'').split(',')[0]})));
  const total=rows.length,today=rows.filter(x=>x.when===todayUK()).length,f=(Q.processed||'').toLowerCase();
  rows=rows.filter(x=>x.o?matches(x.o,f):(x.r.name+' '+x.r.code+' '+x.r.wtn+' '+x.r.nsRef).toLowerCase().includes(f))
    .sort((a,b)=>String(dmy(b.when)||'').localeCompare(String(dmy(a.when)||'')));
  const shown=SHOW_ALL?rows:rows.slice(0,100);
  const row=x=>{
    if(x.r){const r=x.r,vs=rollVisits(r);return `<tr><td data-label="Order"><span class="mono">${esc(r.wtn)}</span> <span class="badge s-monthly">Monthly roll-up · ${plural(vs.length,'visit')}</span></td><td data-label="Customer">${esc(r.name)}</td><td class="mono" data-label="NetSuite no.">${esc(r.nsRef||'—')}</td><td data-label="Processed">${esc(x.when)}</td><td data-label="By">${esc(r.processedBy||'')}</td><td data-label="CO2 credit">—</td><td data-label="WTN"><a class="lbtn" href="/wtn/rollup/${r.id}?print=1" target="_blank">Season WTN (PDF)</a> <button class="lbtn" onclick="rollMark(${r.id},'processed',false)">Undo</button></td></tr>`;}
    const o=x.o;
    return `<tr><td data-label="Order"><span class="mono">${esc(o.so)}</span>${o.dropOff?' <span class="badge s-noso">Drop-off</span>':''}${o.amended?' <span class="badge s-awaiting">Amended</span>':''}${o.short?' <span class="badge s-awaiting">Short</span>':''}${monthlyInfo(o)?' <span class="badge s-monthly">Monthly</span>':''}</td>
      <td data-label="Customer">${esc(o.cust)}</td><td class="mono" data-label="NetSuite no.">${esc(o.nsRef||o.finalSo||'—')}</td><td data-label="Processed">${esc(o.invoicedAt)}</td><td data-label="By">${esc(o.processedBy||counterNames(o))}</td>
      <td data-label="CO2 credit">${o.co2>0?(o.creditAt?esc(o.creditAt):`<label class="tickbox"><input type="checkbox" onchange="mark(${o.id},'credit',this.checked)">due — ${o.co2}</label>`):'n/a'}</td>
      <td data-label="WTN"><a class="lbtn" href="/wtn/${o.id}?print=1" target="_blank">${esc(o.wtn||'WTN')} (PDF)</a> <button class="lbtn" onclick="openDetails(${o.id})">Details</button></td></tr>`;
  };
  return head('s-processed','Processed on NetSuite',`<b>${today} today</b> · latest ${esc((rows[0]&&rows[0].when)||'—')}`,
    'Nothing to do here. It is the record: reprint a WTN or open Details if someone asks.',searchBox('processed','Search ref, customer, WTN or NetSuite no.'),[total,'orders processed'],'stage-processed')
   +`<div class="notice"><span>Next phase: one click will raise the SO and invoice in NetSuite for you.</span><span style="display:flex;gap:10px;align-items:center"><button class="btn" disabled aria-disabled="true">Process in NetSuite</button><span class="badge s-awaiting">Coming soon</span></span></div>`
   +(rows.length?`<div class="tablewrap"><table class="stack"><thead><tr><th>Order</th><th>Customer</th><th>NetSuite no.</th><th>Processed</th><th>By</th><th>CO2 credit</th><th>WTN</th></tr></thead><tbody>${shown.map(row).join('')}</tbody></table></div>`
     +(rows.length>shown.length?`<p style="margin-top:12px"><button class="btn quiet" onclick="SHOW_ALL=true;render()">Show all ${rows.length}</button> <span class="meta">Showing the latest ${shown.length}</span></p>`:'')
     :empty('Nothing processed yet','Orders arrive here when they are marked processed on NetSuite.'));
 },
 monthly(){
  const cs=STATE.customers||[];
  const accts=cs.filter(c=>c.billing==='monthly'||openRoll(c.code).members.length||openRoll(c.code).pending.length);
  const visitsToday=B.monthly.filter(o=>countsToday(o).length).length;
  return head('s-monthly','Monthly accounts',`<b>${plural(accts.length,'account')}</b> on monthly rolling${B.pending.length?` · <b style="color:var(--amber)">${plural(B.pending.length,'visit')} to confirm</b>`:''} · ${plural(visitsToday,'visit')} counted today`,
    'Work down the four steps: confirm the visits, remove empty drop-offs, then Process. A roll-up closes when you Process, not on a calendar date.','',null,'monthly')
   +B.rollPack.map(packCard).join('')
   +(accts.length?accts.map(rollSection).join(''):empty('No monthly accounts','Switch a customer to monthly rolling in Customers (needs the admin key).'));
 },
 archive(){
  const all=B.archive.slice().sort(byDate),l=all.filter(o=>matches(o,Q.archive));
  return head('s-neutral','Archive',`Still uncounted three months after the SO was raised`,
    'If the delivery is still expected, put it back on Awaiting count and it picks up where it left off.',searchBox('archive','Search SO or customer'),[all.length,'collections archived'],'archive')
   +(l.length?`<div class="tablewrap"><table class="stack"><thead><tr><th>SO</th><th>Customer</th><th>Raised</th><th>Age</th><th>Counted so far</th><th></th></tr></thead><tbody>${(SHOW_ALL?l:l.slice(-PAGE).reverse()).map(o=>`<tr>
      <td class="mono" data-label="SO">${esc(o.so)}</td><td data-label="Customer">${esc(o.cust)}</td><td data-label="Raised">${esc(ukDate(o.date))}</td>
      <td data-label="Age"><span class="age old">${plural(Math.floor(P.ageDays(o.date)/30.4),'month')}</span></td>
      <td data-label="Counted so far">${o.counted} of ${o.crates} crates · ${units(o)?plural(units(o),'unit'):'nothing counted'}</td>
      <td style="text-align:right"><button class="btn quiet sm" onclick="keepOpen(${o.id})">Still expected — back to Awaiting</button>${o.counted>0?` <button class="btn quiet sm" onclick="closeShort(${o.id},${o.crates},${o.counted})">Close short</button>`:''}</td></tr>`).join('')}</tbody></table></div>`
     +(!SHOW_ALL&&l.length>PAGE?`<p style="margin-top:16px"><button class="btn quiet" onclick="SHOW_ALL=true;render()">Show all ${l.length}</button> <span class="meta">Showing the most recently archived ${PAGE} — search to find a specific one</span></p>`:'')
     :empty('Nothing archived','Collections still uncounted three months after the SO was raised move here on their own.'));
 },
 customers(){
  const cs=STATE.customers||[],f=(Q.customers||'').toLowerCase();
  const l=cs.filter(c=>!f||(c.name+' '+c.code+' '+(c.aliases||[]).join(' ')).toLowerCase().includes(f));
  const hist=[];cs.forEach(c=>(c.history||[]).forEach(h=>hist.push(Object.assign({cust:c.name},h))));
  hist.sort((a,b)=>String(dmy(b.when)||'').localeCompare(String(dmy(a.when)||''))||String(b.when).localeCompare(String(a.when)));
  const lock=STATE.adminEnabled?`<span class="lock-line">${ICON.lock}Changes need the admin key</span>`:`<span class="lock-line" style="color:#b42318">${ICON.lock}Set ADMIN_KEY on Render to enable changes</span>`;
  const btn=c=>!STATE.adminEnabled?`<span class="lock-line" title="Read-only">${ICON.lock}Read-only</span>`
    :c.billing==='monthly'?`<button class="btn quiet sm" onclick="billingDialog(${jsq(c.code)},'per-order')">Revert to per order</button>`
    :`<button class="btn quiet sm" onclick="billingDialog(${jsq(c.code)},'monthly')">Switch to monthly</button>`;
  return head('s-neutral','Customers',`${lock}`,'How each customer is billed. Switching a customer to monthly pulls their open orders into one roll-up. Reverting splits it back out. It is refused while a pack is unsent, or while an open order still has billed crates (Finish it first).',searchBox('customers','Search name, code or alias'),null,'customers')
   +`<div class="tablewrap"><table class="stack"><thead><tr><th>Customer</th><th>Aliases typed on /count</th><th class="num">Visits picked on /count</th><th>Billing</th></tr></thead><tbody>${l.map(c=>{const h=(c.history||[])[0];return `<tr>
      <td data-label="Customer"><b style="font-weight:600">${esc(c.name)}</b><div class="mono" style="font-size:12px;color:var(--ink-3)">${esc(c.code||'no code')}</div>${c.note?`<div class="meta">${esc(c.note)}</div>`:''}${h?`<div class="meta">Changed by ${esc(h.by)}, ${esc(h.when)}</div>`:''}</td>
      <td data-label="Aliases">${(c.aliases||[]).map(a=>`<span class="alias">${esc(a)}</span>`).join('')||'—'}</td>
      <td class="num" data-label="Visits">${STATE.orders.filter(o=>o.custCode&&o.custCode===c.code).length}</td>
      <td data-label="Billing"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="badge ${c.billing==='monthly'?'s-monthly':'s-neutral'}">${c.billing==='monthly'?'Monthly rolling':'Per order'}</span>${btn(c)}</div></td></tr>`;}).join('')}</tbody></table></div>`
   +`<div class="sec-title">Change history</div>`+(hist.length?`<ul class="hist-list">${hist.map(h=>`<li><b>${esc(h.cust)}</b><span>${h.from==='monthly'?'Monthly rolling':'Per order'} → ${h.to==='monthly'?'Monthly rolling':'Per order'}</span><span>${esc(h.by)}</span><span>${esc(h.when)}</span></li>`).join('')}</ul>`:'<p class="meta">No billing changes yet.</p>');
 }
};

/* ============ monthly roll-ups ============ */
const ROLL_SHOW={},ROLL_CAP=10;
function rollShow(k){ROLL_SHOW[k]=true;render();}
function jumpTo(id){const e=document.getElementById(id);if(e){e.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}}
function rollSection(c){
  const R=openRoll(c.code),all=R.members.concat(R.pending);
  const revert=c.billing==='monthly'?(STATE.adminEnabled?`<button class="btn quiet sm" onclick="billingDialog(${jsq(c.code)},'per-order')">Revert to per order</button>`:`<span class="lock-line">${ICON.lock}Revert needs the admin key</span>`):'';
  const oldestO=all.slice().sort(byDate)[0];
  const top=`<div><span class="badge">Monthly rolling · billed by the crate</span><h3>${esc(c.name)}</h3><div class="meta"><span class="mono">${esc(c.code)}</span>${all.length?` · open since ${esc(ukDate(oldestO.date))} · no SO until you process`:' · nothing open since the last Process'}</div></div>`;
  if(!all.length)return `<section class="roll s-monthly"><div class="roll-head">${top}</div><div class="roll-foot"><span class="hint">Every new ${esc(c.name)} order — NetSuite SO or drop-off — joins this roll-up.</span>${revert}</div></section>`;
  const ub=o=>P.unbilled(o),uc=o=>P.entriesCrates(ub(o)),uu=o=>P.entriesUnits(ub(o));
  const sum=(l,f)=>l.reduce((a,o)=>a+f(o),0);
  const groups=[
    ['pending','Needs confirm',R.pending,'Typed on the tablet or matched by alias — not billed until you confirm.'],
    ['ready','Ready to bill',R.ready,'Every crate counted so far is billed, whether or not more are coming.'],
    ['billed','Billed — no new crates',R.billedOpen,'Everything counted is on a season WTN. More crates go on the next one; Finish when no more are coming.'],
    ['empty','No crates counted yet',R.empty,'Nothing to bill. Remove an empty drop-off if nothing is coming.']];
  const vrow=o=>{
    const pend=rollStateOf(o)==='pending',ph=[...new Set([o.photoId,...(o.counts||[]).map(x=>x.photoId)].filter(Boolean))];
    const th=ph.length?`<a class="thumb" href="/api/photo/${encodeURIComponent(ph[0])}" target="_blank" title="View photo"><img src="/api/photo/${encodeURIComponent(ph[0])}" alt="Photo for ${esc(o.so)}" loading="lazy"></a>`:'<span class="thumb">No photo</span>';
    const kind=P.isPlaceholder(o.so)?'Drop-off':'NetSuite SO',billedC=P.entriesCrates((o.counts||[]).filter(x=>P.entryPack(o,x)));
    const match=pend?`<b>“${esc(o.typedCust||o.cust)}” — matched to ${esc(c.code)}, confirm</b><small>${kind}${o.dropOff?' typed on the tablet':' matched by alias'}</small>`
      :`<span class="tick"></span> ${esc(o.cust)}<small>${kind} · ${o.custMatch==='picked'?'picked from the list':o.rollConfirmedAt?'confirmed by '+esc(o.rollConfirmedBy||'Rec admin'):'name matches the account'}${billedC?` · ${plural(billedC,'crate')} already billed`:''}</small>`;
    const soNote=P.isPlaceholder(o.so)?'':`<span class="soNote">Has NetSuite SO ${esc(o.so)} — close it in NetSuite when the pack is invoiced</span>`;
    const photos=ph.map((id,i)=>`<a class="lbtn" href="/api/photo/${encodeURIComponent(id)}" target="_blank">Photo${ph.length>1?' '+(i+1):''}</a>`).join(' ');
    const act=pend?`<button class="btn amber sm" onclick="rollConfirm(${o.id},true)">Confirm</button><button class="lbtn" onclick="rollConfirm(${o.id},false)">Not ${esc(c.code)}</button>`
      :!(o.counts||[]).length&&o.dropOff?`<button class="btn quiet sm" onclick="rollRemove(${o.id})">Remove empty drop-off</button>`
      :(o.counts||[]).length&&!ub(o).length?`<button class="btn quiet sm" onclick="rollFinish(${o.id})">Finish</button>`:'';
    const last=`<div class="vact">${pend?'':esc(counterNames(o)||o.by||'')} ${act} ${photos} <button class="lbtn" onclick="openDetails(${o.id})">Details</button></div>`;
    return `<div class="visit ${pend?'pending':''}">${th}<div><div class="mono" style="font-size:12px;color:var(--ink-3)">${esc(o.so)}${o.dropRef?' · was '+esc(o.dropRef):''}</div><div>${esc(lastCountDate(o)||ukDate(o.date))}</div></div><div class="match">${match}${soNote}</div><div class="num">${plural(uc(o),'crate')}</div><div class="num">${N(uu(o))}</div>${last}</div>`;
  };
  const grp=([key,label,list,note])=>{
    if(!list.length)return '';
    const sk=c.code+key,sorted=list.slice().sort(byDate),shown=ROLL_SHOW[sk]?sorted:sorted.slice(0,ROLL_CAP);
    return `<div class="vgroup" id="g-${esc(c.code)}-${key}">${label}<span class="gm">${plural(list.length,'order')} · ${plural(sum(list,uc),'crate')} · ${N(sum(list,uu))} units</span></div>${note?`<p class="gnote">${note}</p>`:''}${shown.map(vrow).join('')}`
      +(sorted.length>shown.length?`<p class="morebar"><button class="btn quiet sm" onclick="rollShow(${jsq(sk)})">Show all ${plural(sorted.length,'order')}</button><span class="meta">Showing the oldest ${shown.length}</span></p>`:'');
  };
  const allE=unbilledOf(all),readyE=unbilledOf(R.ready);
  const removable=R.empty.filter(o=>o.dropOff).length,pending=R.pending.length;
  const names=new Set(R.pending.map(o=>String(o.typedCust||o.cust||'').trim())).size;
  /* The four things Rec Admin does here, in the order they do them. Each button calls the same function the row/dialog always did. */
  const steps=`<ol class="steps">
    <li class="${pending?'alarm':'done'}"><div class="sn">Needs confirm</div><div class="sd">${pending?`<b>${plural(pending,'visit')}</b> typed on the tablet or matched by alias. Nothing is billed until you confirm.`:'No visits are waiting for Confirm.'}</div><div class="sa">${pending?`<button class="btn quiet sm" onclick="jumpTo(${jsq('g-'+c.code+'-pending')})">Review the visits</button>`:''}</div></li>
    <li class="${pending?'todo':'done'}"><div class="sn">Confirm by name</div><div class="sd">${pending?`Tick the <b>${plural(names,'typed name')}</b> that are ${esc(c.name)} and confirm them all at once.`:'Nothing to confirm.'}</div><div class="sa"><button class="btn amber sm" onclick="confirmAllDialog(${jsq(c.code)})" ${pending?'':'disabled'}>Confirm by name…</button></div></li>
    <li class="${removable?'todo':'done'}"><div class="sn">Remove empty drop-off</div><div class="sd">${removable?`<b>${plural(removable,'drop-off')}</b> with nothing counted. Remove each from its row; it stays on record, never deleted.`:'No empty drop-offs to remove.'}</div><div class="sa">${removable?`<button class="btn quiet sm" onclick="jumpTo(${jsq('g-'+c.code+'-empty')})">Show them</button>`:''}</div></li>
    <li class="${R.ready.length?'todo':''}"><div class="sn">Process</div><div class="sd">${R.ready.length?`<b>${plural(P.entriesCrates(readyE),'crate')}</b> on ${plural(R.ready.length,'confirmed order')} ready. One season WTN and invoice pack.`:'Nothing ready to bill yet. Confirm visits or wait for counts.'}</div><div class="sa"><button class="btn red sm" onclick="processDialog(${jsq(c.code)})" ${R.ready.length?'':'disabled'}>Process ${esc(c.name.split(' ')[0])}</button></div></li></ol>`;
  const both=(f)=>{const a=f(allE),b=f(readyE),k=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
    const col=(x,c2)=>`<b class="mono ${c2}">${x}</b>`;
    return `<div class="kv hd"><span></span><span class="cols"><span class="c1" style="min-width:86px;text-align:right">Not billed yet</span><span style="min-width:76px;text-align:right">Ready to bill</span></span></div>`
      +k.map(x=>`<div class="kv"><span class="mono">${esc(x)}</span><span class="cols">${col(a[x]||0,'c1')}${col(b[x]||0,'c2')}</span></div>`).join('')
      +`<div class="kv total"><span>Total</span><span class="cols">${col(Object.values(a).reduce((p,q)=>p+q,0),'c1')}${col(Object.values(b).reduce((p,q)=>p+q,0),'c2')}</span></div>`;};
  return `<section class="roll s-monthly"><div class="roll-head">${top}
     <div class="stats"><div class="stat big1"><div class="v">${N(P.entriesUnits(readyE))}</div><div class="k">Units ready to bill</div></div><div class="stat"><div class="v">${N(all.length)}</div><div class="k">Orders</div></div><div class="stat"><div class="v">${N(P.entriesCrates(allE))}</div><div class="k">Crates not billed</div></div><div class="stat"><div class="v">${N(P.entriesUnits(allE))}</div><div class="k">Units not billed</div></div></div></div>
    ${steps}
    <div class="visits"><div class="vh"><span>Photo</span><span>Ref and date</span><span>Account</span><span class="r">Crates</span><span class="r">Units</span><span>Counted by</span></div>${groups.map(grp).join('')}</div>
    <div class="roll-cols"><div><h4>Units by product</h4>${both(sumProductsE)}</div><div><h4>Units by charge code</h4>${both(sumCodesE)}</div></div>
    <div class="roll-foot"><span class="hint">Process raises one season WTN and one invoice pack for every crate counted on a confirmed order. Crates counted later go on the next one.</span>
      <span style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${revert}</span></div></section>`;
}
/* Confirm by name: every typed name with its number of orders; Rec Admin ticks the ones to accept. */
function confirmAllDialog(code){
  const R=openRoll(code),g={};R.pending.forEach(o=>{const k=String(o.typedCust||o.cust||'').trim();(g[k]=g[k]||[]).push(o);});
  const names=Object.keys(g).sort((a,b)=>g[b].length-g[a].length);
  openDialog(`<h3 id="dTitle">Confirm orders as ${esc(code)}</h3><p class="lead">Each name below was typed on the tablet or matched by alias. Tick only the names that are this customer.</p>
    <div style="margin-top:14px;display:flex;flex-direction:column;gap:8px">${names.map((n,i)=>`<label class="tickbox" style="font-size:14px"><input type="checkbox" class="cfName" data-i="${i}"> “${esc(n)}” ×${g[n].length} <span class="meta">· ${plural(P.entriesUnits(unbilledOf(g[n])),'unit')}</span></label>`).join('')}</div>
    <div class="d-actions"><button class="btn quiet" onclick="closeDialog()">Cancel</button><button class="btn" onclick="confirmPicked(${jsq(code)})">Confirm ticked names</button></div>`);
  confirmAllDialog.groups=names.map(n=>g[n].map(o=>o.id));
}
async function confirmPicked(code){
  const ids=[...document.querySelectorAll('.cfName:checked')].flatMap(x=>confirmAllDialog.groups[+x.dataset.i]);
  if(!ids.length){toast('Tick at least one name');return;}
  const j=await api('/api/roll-confirm',{orderIds:ids,confirm:true,by:adminName()});
  if(j.error){toast(j.error);return;}
  closeDialog();toast(`${plural(j.count,'order')} confirmed onto ${code}`);refresh();
}
async function rollRemove(id){
  if(!confirm('Remove this empty drop-off from the roll-up? It is kept on record as removed, never deleted.'))return;
  const j=await api('/api/roll-remove',{orderId:id,by:adminName()});if(j.error){toast(j.error);return;}
  toast(`${j.so} removed from the roll-up`);refresh();
}
async function rollFinish(id){
  if(!confirm('Finish this order? Everything counted is already billed; no more crates are expected on it.'))return;
  const j=await api('/api/roll-finish',{orderId:id,by:adminName()});if(j.error){toast(j.error);return;}
  toast(`${j.so} finished on ${j.pack||'its season WTN'}`);refresh();
}
function packCard(r){
  const vs=rollVisits(r);
  return `<section class="roll s-wtn"><div class="roll-head"><div><span class="badge">Pack ready — not sent yet</span><h3>${esc(r.name)} — season WTN <span class="mono">${esc(r.wtn)}</span></h3>
    <div class="meta">${plural(vs.length,'order')}, ${esc(ukDate(r.from))} to ${esc(ukDate(r.to))} · ${plural(P.entriesCrates(packEntries(r)),'crate')} · ${P.entriesUnits(packEntries(r))} units · generated ${esc(r.createdAt)} by ${esc(r.createdBy)}</div></div></div>
    <div class="roll-foot"><span class="hint">Download the pack, send it to the customer yourself, then mark it as sent. It then waits in WTN sent for the NetSuite number.</span>
    <span style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><button class="lbtn" onclick="rollUndo(${r.id})">Void this pack</button><a class="btn quiet" href="/wtn/rollup/${r.id}?print=1" target="_blank">Download pack (PDF)</a><button class="btn" onclick="rollMark(${r.id},'sent',true)">Mark as sent</button></span></div></section>`;
}
function rollCard(r){
  const vs=rollVisits(r),key='r'+r.id,on=wtnPicks.has(key);
  return `<article class="card s-monthly ${on?'sel-on':''}" data-key="${key}"><div class="card-top"><div><div class="ref"><label class="pick"><input type="checkbox" ${on?'checked':''} onchange="togglePick('wtn','${key}',this.checked)" aria-label="Select ${esc(r.wtn)}"></label><span>Season WTN · ${esc(r.wtn)}</span></div>
    <div class="cust">${esc(r.name)}</div><div class="meta">${esc(r.code)} · ${plural(vs.length,'visit')}, ${esc(ukDate(r.from))} to ${esc(ukDate(r.to))}</div></div>${agePill(daysSinceUK(r.sentAt))}</div>
    <div class="facts"><span><b>${P.entriesCrates(packEntries(r))}</b> crates</span><span><b>${P.entriesUnits(packEntries(r))}</b> units</span></div>
    <div class="tags"><span class="badge s-monthly">Monthly roll-up</span></div>
    <div class="lines">${Object.entries(sumProductsE(packEntries(r))).sort().map(([p,q])=>`<div><span>${esc(p)}</span><b>${q}</b></div>`).join('')}</div>
    <div class="card-foot"><div class="rowx"><span class="badge s-wtn"><span class="mono">${esc(r.wtn)}</span> · sent ${esc(r.sentAt)}</span></div>
      <div class="rowx"><a class="btn quiet sm" href="/wtn/rollup/${r.id}?print=1" target="_blank">Download pack (PDF)</a><a class="btn quiet sm" href="/wtn/rollup/${r.id}" target="_blank">Reprint</a><button class="lbtn" onclick="rollMark(${r.id},'sent',false)">Not sent — back to Monthly</button></div>
      <div class="field"><label for="nsr${r.id}">NetSuite SO or invoice number</label><input class="in" id="nsr${r.id}" placeholder="e.g. SO-48300"></div>
      <button class="btn primary" onclick="rollProcess(${r.id})">Mark processed on NetSuite</button></div></article>`;
}
function processDialog(code){
  const c=P.findCustomer(STATE.customers,code),R=openRoll(code);if(!c||!R.ready.length)return;
  const es=unbilledOf(R.ready),codes=sumCodesE(es),tot=Object.values(codes).reduce((a,b)=>a+b,0);
  const left=R.pending.length+R.empty.length;
  openDialog(`<h3 id="dTitle">Generate WTN &amp; invoice pack</h3><p class="lead">One season WTN covers every crate counted so far on a confirmed order. The app builds the pack; you send it.</p>
    <dl class="dl"><dt>Customer</dt><dd>${esc(c.name)} <span class="mono">(${esc(c.code)})</span></dd><dt>WTN number</dt><dd>Next in sequence</dd>
    <dt>Covers</dt><dd>${plural(P.entriesCrates(es),'crate')} on ${plural(R.ready.length,'order')}<small>${esc(R.ready.map(o=>o.so).join(', '))}</small></dd></dl>
    <table><thead><tr><th>Charge code</th><th class="num">Units</th></tr></thead><tbody>${Object.keys(codes).sort().map(k=>`<tr><td class="mono">${esc(k)}</td><td class="num">${codes[k]}</td></tr>`).join('')}<tr><td><b>Total</b></td><td class="num"><b>${tot}</b></td></tr></tbody></table>
    <p class="d-note">Prices are applied in NetSuite, so none are shown here. Crates counted on these orders after today go on the next pack.</p>
    ${left?`<div class="warn-box">${plural(left,'order')} waiting for Confirm or with nothing counted ${left===1?'stays':'stay'} on the open roll-up.</div>`:''}
    <div class="d-actions"><button class="btn quiet" onclick="closeDialog()">Cancel</button><button class="btn" onclick="rollupProcess(${jsq(code)})">Generate WTN &amp; invoice pack</button></div>`);
}
async function rollupProcess(code){
  const j=await api('/api/rollup-process',{code,by:adminName()});
  if(j.error){toast(j.error);return;}
  closeDialog();await refresh();packDialog(j.rollup);
}
function packDialog(r){
  openDialog(`<h3 id="dTitle">Pack generated</h3><p class="lead">${esc(r.wtn)} for ${esc(r.name)} is ready. Download the pack, send it yourself, then mark it as sent.</p>
    <div class="d-actions" style="justify-content:flex-start"><a class="btn quiet" href="/wtn/rollup/${r.id}?print=1" target="_blank">Download pack (PDF)</a></div>
    <p class="d-note">The pack opens as a printable page: choose Save as PDF in the print dialog. Marking as sent moves it to WTN sent, where it waits for the NetSuite number.</p>
    <div class="d-actions"><button class="btn quiet" onclick="closeDialog()">Not sent yet</button><button class="btn" onclick="rollMark(${r.id},'sent',true)">Mark as sent</button></div>`);
}
async function rollMark(id,field,value,nsRef){
  if(!value&&field==='processed'&&!confirm('Move this season WTN back to WTN sent? The NetSuite number is cleared.'))return;
  const j=await api('/api/rollup-mark',{id,field,value,nsRef,by:adminName()});
  if(j.error){toast(j.error);return;}
  closeDialog();
  toast(field==='sent'?(value?'Season WTN marked as sent — waiting for the NetSuite number':'Back on Monthly accounts as a pack'):(value?'Season WTN processed on NetSuite':'Back to WTN sent'));
  if(field==='sent'&&value){VIEW='wtn';}
  refresh();
}
function rollProcess(id){const inp=document.getElementById('nsr'+id),v=(inp&&inp.value||'').trim();if(!v){toast('Enter the NetSuite SO or invoice number first');inp&&inp.focus();return;}rollMark(id,'processed',true,v);}
async function rollUndo(id){
  if(!confirm('Void this pack? Its visits go back on the open roll-up. The WTN number is kept on record as void and never reused.'))return;
  const j=await api('/api/rollup-undo',{id,by:adminName()});
  if(j.error){toast(j.error);return;}
  toast(`${j.wtn} voided — visits back on the roll-up`);refresh();
}
async function rollConfirm(id,ok){
  if(!ok&&!confirm('Take this visit off the roll-up? It goes to No SO yet like any unknown drop-off.'))return;
  const j=await api('/api/roll-confirm',{orderId:id,confirm:ok,by:adminName()});
  if(j.error){toast(j.error);return;}
  toast(ok?`${j.so} confirmed and added to the roll-up`:`${j.so} moved to No SO yet`);refresh();
}

/* ============ customers (admin key) ============ */
function billingDialog(code,to){
  const c=P.findCustomer(STATE.customers,code);if(!c)return;
  const mv=P.movesOnToggle(STATE.orders,STATE.customers,code,to),NAME={awaiting:'Awaiting',noso:'No SO yet',counted:'Counted'};
  const parts=Object.entries(mv.by).map(([k,v])=>v+' '+(NAME[k]||k)).join(', ');
  let key='';try{key=sessionStorage.getItem('rrAdminKey')||'';}catch(e){}
  openDialog(`<h3 id="dTitle">${to==='monthly'?'Switch '+esc(c.name)+' to monthly rolling?':'Revert '+esc(c.name)+' to per order?'}</h3>
    <p class="lead">${to==='monthly'
      ?(mv.total?`<b>${plural(mv.total,'order')} will move from ${esc(parts)} into the monthly roll-up.</b> `:'No open orders move now. ')+'Every new order for this customer joins it until you revert. Anything typed on the tablet or matched only by alias waits for Confirm.'
      :(mv.total?`<b>${plural(mv.total,'order')} will go back to their own stages: ${esc(parts)}.</b> `:'Nothing is on the open roll-up. ')+'New orders are billed one by one again. Packs already sent stay as they are.'}</p>
    <label for="bkBy">Your name</label><input class="in" id="bkBy" value="${esc(adminName())}" style="font-family:var(--sans)">
    <label for="bkKey">Admin key</label><input class="in" id="bkKey" type="password" value="${esc(key)}" autocomplete="off">
    <p class="d-note">Recorded in the change history. Nothing is lost — you can switch back at any time.</p>
    <div class="d-actions"><button class="btn quiet" onclick="closeDialog()">Cancel</button><button class="btn" onclick="doBilling(${jsq(code)},'${to}')">${to==='monthly'?'Switch to monthly':'Revert to per order'}</button></div>`);
}
async function doBilling(code,to){
  const by=document.getElementById('bkBy').value.trim(),key=document.getElementById('bkKey').value;
  if(!by){toast('Enter your name');return;}
  const j=await api('/api/customer-billing',{code,billing:to,by},{'X-Admin-Key':key});
  if(j.error){if(/not accepted/i.test(j.error)){try{sessionStorage.removeItem('rrAdminKey');}catch(e){}}toast(j.error);return;}
  try{sessionStorage.setItem('rrAdminKey',key);localStorage.setItem('recAdmin',by);}catch(e){}
  closeDialog();toast(to==='monthly'?`Monthly rolling — ${plural((j.moved||{}).total||0,'order')} moved onto the roll-up`:`Back to per order — ${plural(j.split||0,'order')} back in their own stages`);refresh();
}

/* ============ per-order actions (redesign) ============ */
async function processOrder(id){
  const inp=document.getElementById('ns'+id),v=(inp&&inp.value||'').trim();
  if(!v){toast('Enter the NetSuite SO or invoice number first');inp&&inp.focus();return;}
  const j=await api('/api/process',{orderId:id,nsRef:v,by:adminName()});
  if(j.error){toast(j.error);return;}
  toast(`${j.so} processed on NetSuite (${j.nsRef})`);refresh();
}
function togglePick(kind,key,on){
  const set=kind==='noso'?nosoPicks:wtnPicks,k=kind==='noso'?Number(key):key;
  on?set.add(k):set.delete(k);paintPicks();
}
function clearPicks(kind){(kind==='noso'?nosoPicks:wtnPicks).clear();render();}
function visibleWtnKeys(){
  const f=(Q.wtn||'').toLowerCase();
  return B.wtn.filter(o=>matches(o,f)).map(o=>'o'+o.id).concat(B.rollWtn.filter(r=>!f||(r.name+' '+r.code+' '+r.wtn).toLowerCase().includes(f)).map(r=>'r'+r.id));
}
function pickAllWtn(on){visibleWtnKeys().forEach(k=>on?wtnPicks.add(k):wtnPicks.delete(k));render();}
function paintPicks(){
  if(VIEW==='noso'){
    [...nosoPicks].forEach(id=>{if(!B.noso.some(o=>o.id===id))nosoPicks.delete(id);});
    const bar=document.getElementById('nosoBar');if(!bar)return;
    const picked=[...nosoPicks].map(id=>STATE.orders.find(o=>o.id===id)).filter(Boolean);
    bar.hidden=picked.length<2;bar.classList.toggle('on',picked.length>=2);
    if(picked.length>=2){const k=nosoKeeper(picked);
      document.getElementById('nosoMsg').innerHTML=`<b>${picked.length} collections ticked</b> — ${picked.reduce((a,o)=>a+(o.counted||0),0)} crates, ${picked.reduce((a,o)=>a+units(o),0)} units, keeping ${esc(k.so)}`;}
    document.querySelectorAll('.card[data-key]').forEach(c=>c.classList.toggle('sel-on',nosoPicks.has(Number(c.dataset.key))));
  }
  if(VIEW==='wtn'){
    const valid=new Set(visibleWtnKeys().concat(B.wtn.map(o=>'o'+o.id),B.rollWtn.map(r=>'r'+r.id)));
    [...wtnPicks].forEach(k=>{if(!valid.has(k))wtnPicks.delete(k);});
    const n=wtnPicks.size,b=document.getElementById('wtnBulk');if(!b)return;
    b.disabled=!n;b.textContent=`Download selected WTNs (${n})`;
    document.getElementById('wtnMsg').innerHTML=n?`<b>${n} selected</b> — opens one printable page, one WTN per sheet`:'Tick the WTNs you want, or select all';
    document.getElementById('wtnBar').classList.toggle('on',n>0);
    const vis=visibleWtnKeys();document.getElementById('wtnAll').checked=vis.length>0&&vis.every(k=>wtnPicks.has(k));
    document.querySelectorAll('.card[data-key]').forEach(c=>c.classList.toggle('sel-on',wtnPicks.has(c.dataset.key)));
  }
}
function downloadSelected(){
  const ids=[...wtnPicks].filter(k=>k[0]==='o').map(k=>k.slice(1)),rs=[...wtnPicks].filter(k=>k[0]==='r').map(k=>k.slice(1));
  if(!ids.length&&!rs.length){toast('Tick at least one WTN');return;}
  window.open(`/wtn-batch?ids=${ids.join(',')}&r=${rs.join(',')}&print=1`,'_blank');
}

/* ============ dialog + details ============ */
let lastFocus=null;
function openDialog(html,cls){lastFocus=document.activeElement;const d=document.getElementById('dialog');d.className='dialog '+(cls||'');d.innerHTML=html;
  const s=document.getElementById('scrim');s.classList.add('show');s.setAttribute('aria-hidden','false');
  const f=d.querySelector('input:not([type=checkbox])')||d.querySelector('.btn:not(.quiet)');f&&f.focus();}
function scrimClick(e){if(e.target===e.currentTarget)closeDialog();}
function rowKey(e,id){if(e.key==='Enter'||e.key===' '){e.preventDefault();openEdit(id);}}
function closeDialog(){const s=document.getElementById('scrim');s.classList.remove('show');s.setAttribute('aria-hidden','true');if(lastFocus&&document.contains(lastFocus))lastFocus.focus();}
document.addEventListener('keydown',e=>{
  const open=document.getElementById('scrim').classList.contains('show');
  if(e.key==='Escape'&&open)closeDialog();
  /* Keep Tab inside an open dialog. */
  if(e.key==='Tab'&&open){
    const f=[...document.getElementById('dialog').querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x=>x.offsetParent!==null);
    if(!f.length)return;const first=f[0],last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    else if(!document.getElementById('dialog').contains(document.activeElement)){e.preventDefault();first.focus();}
  }
  /* "/" jumps to the search box on a stage. */
  if(e.key==='/'&&!open&&!/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||'')){const s=document.querySelector('.search');if(s){e.preventDefault();s.focus();}}
});
const STAGE_NAME={awaiting:'Awaiting count',noso:'No SO yet',counted:'Counted',wtn:'WTN sent',processed:'Processed on NetSuite',archive:'Archive',monthly:'Monthly roll-up',rolled:'On a season WTN'};
function openDetails(id){
  const o=STATE.orders.find(x=>x.id===id);if(!o)return;
  openDialog(`<h3 id="dTitle">${esc(o.so)} — ${esc(o.cust)}</h3>
    <p class="lead">${STAGE_NAME[stageOf(o)]||''}${o.wtn?' · '+esc(o.wtn):''}${o.nsRef?' · NetSuite '+esc(o.nsRef):''}${o.dropRef?' · was '+esc(o.dropRef):''}</p>
    <div class="tags" style="padding:12px 0 0">${tagsFor(o,stageOf(o))}</div>
    <div style="margin-top:16px">${detailBlock(o,!!o.invoicedAt)}</div>
    <div class="d-actions">${undoBtn(o)}${o.wtn?`<a class="btn quiet" href="/wtn/${o.id}" target="_blank">Reprint WTN</a>`:''}<button class="btn" onclick="closeDialog()">Close</button></div>`,'wide');
}

/* ============ today lines for the live views ============ */
function reportsToday(){
  const el=document.getElementById('repToday');if(!el||!LAST.rows)return;
  const u=LAST.rows.reduce((a,r)=>a+r.qty,0),n=new Set(LAST.rows.map(r=>r.so)).size;
  const today=(STATE.orders||[]).reduce((a,o)=>a+countsToday(o).reduce((s,c)=>s+c.lines.reduce((x,l)=>x+Number(l.q),0),0),0);
  el.innerHTML=`<b>${u.toLocaleString('en-GB')} units</b> across ${plural(n,'collection')} in this view · <b>${today.toLocaleString('en-GB')} units counted today</b>`;
}
function amendToday(){
  const all=(STATE.orders||[]).filter(o=>o.amended),today=(STATE.orders||[]).reduce((a,o)=>a+(o.amendments||[]).filter(x=>String(x.when||'').split(',')[0]===todayUK()).length,0);
  document.getElementById('amendToday').innerHTML=`<b>${plural(all.length,'order')}</b> amended · <b>${today} today</b>`;
}

/* ============ data ============ */
async function refresh(){
  try{const r=await fetch('/api/state');if(r.status===401){location.reload();return;}STATE=await r.json();}
  catch(e){document.getElementById('syncMsg').textContent='Server unreachable';
    if(!STATE)document.getElementById('viewPipe').innerHTML='<div class="errblock"><b>Couldn’t load the dashboard.</b>The server did not answer. Nothing has been changed. <button class="btn quiet sm" style="margin-left:8px" onclick="refresh()">Try again</button></div>';
    return;}
  PRODMAP={};(STATE.products||[]).forEach(p=>PRODMAP[p.p]={size:p.size,type:p.group,code:p.code,buyback:!!p.buyback});
  ADMIN_PRODS=STATE.products||[];
  MONTHLY=STATE.monthlyCustomers||[];
  buildRecords();
  /* Don't wipe what someone is typing (an SO number, a search) on the 30-second refresh. */
  const a=document.activeElement,typing=a&&/INPUT|TEXTAREA|SELECT/.test(a.tagName)&&a.type!=='search'&&a.type!=='checkbox'&&document.getElementById('viewPipe').contains(a)&&a.value;
  if(!FIRST&&(document.getElementById('scrim').classList.contains('show')||typing)){B=buckets();renderNav();renderChrome();return;}
  render(FIRST);FIRST=false;
}

/* ============ LIVE CODE: reports and amendments (unchanged) ============ */
function parseWhen(when){
  if(!when)return null;
  const d=String(when).split(',')[0].trim();
  let m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(d);
  if(m)return new Date(+m[3],+m[2]-1,+m[1]);
  m=/^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if(m)return new Date(+m[1],+m[2]-1,+m[3]);
  return null;
}
function fmtUK(dt){return dt?('0'+dt.getDate()).slice(-2)+'/'+('0'+(dt.getMonth()+1)).slice(-2)+'/'+dt.getFullYear():'';}
/* Records are built at order x product level — the only level at which "counted",
   "amended" and "billed" all exist, because an amendment replaces the whole counts
   array and there is no line-level lineage to apportion against.
   Each record carries the collection's lifecycle state so the report can tell a
   finished, invoiced collection apart from one that is still part-counted or has
   been amended back to open. `qty` remains the current position, so every existing
   consumer keeps working unchanged. */
function buildRecords(){
  RECORDS=[];
  (STATE.orders||[]).forEach(o=>{
    const amends=Array.isArray(o.amendments)?o.amendments:[];

    // what the rec team originally logged, before any amendment
    const origMap={};
    if(amends.length&&Array.isArray(amends[0].before)){
      amends[0].before.forEach(x=>{origMap[x.p]=(origMap[x.p]||0)+(Number(x.q)||0);});
    }
    // current (post-amendment) state, plus the latest count date
    const curMap={};
    let lastDate=parseWhen(o.date);
    (o.counts||[]).forEach(c=>{
      const dt=parseWhen(c.when);
      if(dt&&(!lastDate||dt>lastDate))lastDate=dt;
      (c.lines||[]).forEach(l=>{curMap[l.p]=(curMap[l.p]||0)+(Number(l.q)||0);});
    });
    if(!amends.length)Object.assign(origMap,curMap);   // never amended -> counted === current

    const invoiced=!!o.invoicedAt,complete=o.status==='done';
    [...new Set([...Object.keys(origMap),...Object.keys(curMap)])].forEach(p=>{
      const pm=PRODMAP[p],known=!!pm;
      const counted=origMap[p]||0,now=curMap[p]||0;
      RECORDS.push({
        date:lastDate,cust:o.cust||'Unknown',acct:(()=>{const c=acctOf(o);return c?c.name+' \u00B7 '+c.code:(o.cust||'Unknown');})(),so:o.so,stage:stageOf(o),product:p,
        size:known?(pm.size||'—'):'—',
        type:known?(pm.type||'Other'):'Other',
        code:known?(pm.code||'UNMAPPED'):'OTHER',
        counted,                      // originally counted
        amended:now-counted,          // net correction (negative = counted down)
        qty:now,                      // current position = counted + amended
        billed:invoiced?now:0,        // only what has actually been invoiced
        status:o.status,complete,invoiced,
        wasAmended:now!==counted||amends.length>0,
        dropOff:!!o.dropOff});
    });
  });
}
/* The account a typed customer name belongs to, if it is on the Customers list. Same matching as pipeline.js rollMatch
   (picked code, exact name or code, alias; Ltd/Limited and punctuation ignored; "Not <code>" respected), for every customer, not only monthly ones. */
function acctOf(o){
  const cs=STATE.customers||[],cn=P.companyNorm(o.cust),n=P.norm(o.cust);
  const rej=o.rollRejectCode||((o.rollOutAt&&/^rejected/.test(o.rollOutWhy||''))?o.rollCode:null);
  for(const c of cs){
    if(!c.code||rej===c.code)continue;
    if((o.custCode===c.code&&o.custMatch==='picked')||(cn&&cn===P.companyNorm(c.name))||n===P.norm(c.code)||(n&&(c.aliases||[]).some(a=>P.norm(a)===n||P.companyNorm(a)===cn)))return c;
  }
  return null;
}
function uniqueSorted(arr){return [...new Set(arr)].filter(Boolean).sort();}
function populateReportFilters(){
  const cust=document.getElementById('fCust');
  uniqueSorted(RECORDS.map(r=>r.acct)).forEach(c=>cust.add(new Option(c,c)));
  const type=document.getElementById('fType');
  uniqueSorted(RECORDS.map(r=>r.type)).forEach(t=>type.add(new Option(t,t)));
  refreshSizeProd();
}
function refreshSizeProd(){
  const t=document.getElementById('fType').value;
  const size=document.getElementById('fSize'),prod=document.getElementById('fProd');
  const curS=size.value,curP=prod.value;
  size.length=1;prod.length=1;
  const pool=RECORDS.filter(r=>!t||r.type===t);
  uniqueSorted(pool.map(r=>r.size)).forEach(s=>size.add(new Option(s,s)));
  uniqueSorted(pool.map(r=>r.product)).forEach(p=>prod.add(new Option(p,p)));
  size.value=[...size.options].some(o=>o.value===curS)?curS:'';
  prod.value=[...prod.options].some(o=>o.value===curP)?curP:'';
}
function onTypeChange(){refreshSizeProd();renderReports();}
function onRangeChange(){
  const c=document.getElementById('fRange').value==='custom';
  document.getElementById('customFrom').style.display=c?'block':'none';
  document.getElementById('customTo').style.display=c?'block':'none';
  renderReports();
}
function quickCust(name){
  const sel=document.getElementById('fCust');
  if(!name){sel.value='';renderReports();return;}
  const match=[...sel.options].find(o=>o.value.toLowerCase().includes(name.toLowerCase()));
  sel.value=match?match.value:'';
  if(!match)toast('No '+name+' account in the current data');
  renderReports();
}
function rangeBounds(){
  const v=document.getElementById('fRange').value;
  const now=new Date();const y=now.getFullYear(),m=now.getMonth();
  let from=null,to=null;
  if(v==='mtd'){from=new Date(y,m,1);to=now;}
  else if(v==='lastmonth'){from=new Date(y,m-1,1);to=new Date(y,m,0,23,59,59);}
  else if(v==='ytd'){from=new Date(y,0,1);to=now;}
  else if(v==='week'){const d=new Date(now);const wd=(d.getDay()+6)%7;d.setDate(d.getDate()-wd);d.setHours(0,0,0,0);from=d;to=now;}
  else if(v==='last7'){from=new Date(now);from.setDate(from.getDate()-6);from.setHours(0,0,0,0);to=now;}
  else if(v==='last30'){from=new Date(now);from.setDate(from.getDate()-29);from.setHours(0,0,0,0);to=now;}
  else if(v==='year'){from=new Date(y-1,m,now.getDate());to=now;}
  else if(v==='custom'){const f=document.getElementById('fFrom').value,t=document.getElementById('fTo').value;
    from=f?new Date(f+'T00:00:00'):null;to=t?new Date(t+'T23:59:59'):null;}
  return {from,to};
}
function currentFilter(){
  const {from,to}=rangeBounds();
  return {from,to,cust:document.getElementById('fCust').value,type:document.getElementById('fType').value,
    size:document.getElementById('fSize').value,prod:document.getElementById('fProd').value,
    stage:document.getElementById('fStage').value};
}
function applyFilter(over){
  const f=Object.assign(currentFilter(),over||{});
  return RECORDS.filter(r=>{
    if(f.from&&(!r.date||r.date<f.from))return false;
    if(f.to&&(!r.date||r.date>f.to))return false;
    if(f.cust&&r.acct!==f.cust)return false;
    if(f.type&&r.type!==f.type)return false;
    if(f.size&&r.size!==f.size)return false;
    if(f.prod&&r.product!==f.prod)return false;
    if(f.stage==='billed'  && !r.invoiced)return false;
    if(f.stage==='unbilled'&&  r.invoiced)return false;
    if(f.stage==='open'    &&  r.complete)return false;
    if(f.stage==='amended' && !r.wasAmended)return false;
    return true;
  });
}
/* Counted / amended / billed rollup — the month-end reconciliation. */
function recon(rows,key){
  const m={};
  rows.forEach(r=>{
    const k=r[key];
    if(!m[k])m[k]={k,counted:0,amended:0,current:0,billed:0,unbilled:0};
    m[k].counted+=r.counted;m[k].amended+=r.amended;m[k].current+=r.qty;
    m[k].billed+=r.billed;if(!r.invoiced)m[k].unbilled+=r.qty;
  });
  return Object.values(m).sort((a,b)=>b.current-a.current);
}
function groupSum(rows,key){const m={};rows.forEach(r=>{m[r[key]]=(m[r[key]]||0)+r.qty;});return Object.entries(m).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v);}
function trendBuckets(rows){
  const {from,to}=rangeBounds();
  const span=(from&&to)?(to-from)/86400000:9999;
  let unit=span<=31?'day':(span<=180?'week':'month');
  const m={};
  rows.forEach(r=>{if(!r.date)return;let key;const d=r.date;
    if(unit==='day')key=fmtUK(d);
    else if(unit==='week'){const t=new Date(d);const wd=(t.getDay()+6)%7;t.setDate(t.getDate()-wd);key='w/c '+fmtUK(t);}
    else key=('0'+(d.getMonth()+1)).slice(-2)+'/'+d.getFullYear();
    m[key]=(m[key]||0)+r.qty;});
  const keys=Object.keys(m).sort((a,b)=>parseSortKey(a,unit)-parseSortKey(b,unit));
  return {unit,labels:keys,data:keys.map(k=>m[k])};
}
function parseSortKey(k,unit){
  if(unit==='month'){const m=/(\d{2})\/(\d{4})/.exec(k);return m?+m[2]*100+ +m[1]:0;}
  const m=/(\d{2})\/(\d{2})\/(\d{4})/.exec(k);return m?new Date(+m[3],+m[2]-1,+m[1]).getTime():0;}
/* =====================================================================
   REPORTS (redesign). Same records, same filters, same totals as before:
   applyFilter(), recon(), groupSum(), trendBuckets() and the exports are untouched.
   What changed is how the answer is shown: headline band, charts, sortable tables.
   ===================================================================== */
const RP_INK='#1d1d1b',RP_SLATE='#6f8aa3';   // billed / not yet billed. Brand ink + one slate: dE 39 (validator), each series labelled and in the legend
let RTAB='recon';const TSORT={},TBL={};
function sgn(n){return n>0?'+':(n<0?'−':'');}
/* The previous equivalent period for the selected range, or null for all time. */
function priorBounds(){
  const v=document.getElementById('fRange').value,{from,to}=rangeBounds();
  if(v==='all'||!from||!to)return null;
  let pf,pt;
  if(v==='mtd'){pf=new Date(from.getFullYear(),from.getMonth()-1,1);const dim=new Date(from.getFullYear(),from.getMonth(),0).getDate();pt=new Date(pf.getFullYear(),pf.getMonth(),Math.min(to.getDate(),dim),23,59,59);}
  else if(v==='lastmonth'){pf=new Date(from.getFullYear(),from.getMonth()-1,1);pt=new Date(from.getFullYear(),from.getMonth(),0,23,59,59);}
  else if(v==='ytd'){pf=new Date(from.getFullYear()-1,0,1);pt=new Date(to.getFullYear()-1,to.getMonth(),to.getDate(),23,59,59);}
  else if(v==='week'){pf=new Date(from.getTime()-7*86400000);pt=new Date(to.getTime()-7*86400000);}
  else{const span=to-from;pt=new Date(from.getTime()-1);pf=new Date(pt.getTime()-span);}
  return {from:pf,to:pt};
}
function repMetrics(rows){
  const s=k=>rows.reduce((a,r)=>a+r[k],0),bb=(PRODMAP);
  return {counted:s('counted'),amended:s('amended'),current:s('qty'),billed:s('billed'),unbilled:rows.filter(r=>!r.invoiced).reduce((a,r)=>a+r.qty,0),
    collections:new Set(rows.map(r=>r.so)).size,customers:new Set(rows.map(r=>r.acct)).size,
    co2:rows.filter(r=>(bb[r.product]||{}).buyback).reduce((a,r)=>a+r.qty,0),drops:new Set(rows.filter(r=>r.dropOff).map(r=>r.so)).size};
}
/* good: 'up' = a rise is good, 'down' = a rise is bad, null = neither */
function deltaHtml(cur,prev,good){
  if(prev===null)return '';
  const d=cur-prev;
  if(!d)return `<span class="dt flat">0 vs previous</span>`;
  const txt=prev?`${d>0?'▲':'▼'} ${sgn(d)}${N(Math.abs(d))} (${sgn(d)}${(Math.abs(d)/prev*100).toFixed(1)}%)`:`${d>0?'▲':'▼'} ${sgn(d)}${N(Math.abs(d))} (new)`;
  const bad=good==='up'?d<0:good==='down'?d>0:null;
  return `<span class="dt ${bad===null?'flat':bad?'bad':'good'}">${txt}</span>`;
}
const UNB_GROUPS=[['Still being counted',['awaiting','archive'],'awaiting'],['No SO yet',['noso'],'noso'],['Counted, WTN not sent',['counted'],'counted'],['WTN sent, waiting for NetSuite',['wtn','rolled'],'wtn'],['Monthly roll-up',['monthly'],'monthly']];
const UNB_SHADE=['#d1d5da','#a9bccd','#6f8aa3','#3a536b','#1d1d1b'];
function paintHero(rows,cur,prior,pb){
  const base=pb?`vs ${fmtUK(pb.from)} to ${fmtUK(pb.to)}`:'';
  const unb=rows.filter(r=>!r.invoiced);
  const parts=UNB_GROUPS.map(([l,st,go],i)=>({l,go,v:unb.filter(r=>st.includes(r.stage)).reduce((a,r)=>a+r.qty,0),c:UNB_SHADE[i]}));
  const known=parts.reduce((a,p)=>a+p.v,0);
  if(known!==cur.unbilled)parts.push({l:'Other',go:'counted',v:cur.unbilled-known,c:'#e5e5e5'});
  const seg=parts.filter(p=>p.v>0);
  document.getElementById('rpNyb').innerHTML=`<div class="nyb-k">Not yet billed</div>
    <div class="nyb-v"><span class="${cur.unbilled?'':'zero'}">${N(cur.unbilled)}</span><small>units</small></div>
    <div class="nyb-d">${deltaHtml(cur.unbilled,prior?prior.unbilled:null,'down')}${base?` <span class="bsl">${base}</span>`:''}</div>
    <p class="nyb-s">Counted by the rec team and not yet invoiced in NetSuite. It leaves this figure when you Mark processed on NetSuite.</p>
    ${cur.unbilled?`<div class="nyb-bar" role="img" aria-label="Where the not yet billed units sit">${seg.map(p=>`<i style="flex:${p.v};background:${p.c}" title="${esc(p.l)}: ${N(p.v)}"></i>`).join('')}</div>
    <ul class="nyb-l">${seg.map(p=>`<li><button type="button" class="nyb-b" onclick="go('${p.go}')"><i style="background:${p.c}"></i><span>${esc(p.l)}</span><b class="mono">${N(p.v)}</b></button></li>`).join('')}</ul>`:'<p class="nyb-s"><b>Nothing waiting.</b> Everything counted in this view has been billed.</p>'}
    <div class="nyb-a"><button type="button" class="btn sm" onclick="go('counted')">Open Counted</button><button type="button" class="btn sm ghost" onclick="go('monthly')">Open Monthly accounts</button></div>`;
  const cell=(k,v,d)=>`<div class="m-c"><div class="m-k">${k}</div><div class="m-v">${N(v)}</div><div class="m-d">${d}</div></div>`;
  const p=prior;
  document.getElementById('kpis').innerHTML=cell('Units counted',cur.counted,deltaHtml(cur.counted,p?p.counted:null,'up'))
    +cell('Units billed',cur.billed,deltaHtml(cur.billed,p?p.billed:null,'up'))
    +cell('CO2 buy-back units',cur.co2,deltaHtml(cur.co2,p?p.co2:null,null))
    +cell('Collections',cur.collections,deltaHtml(cur.collections,p?p.collections:null,null))
    +`<div class="m-also">Also in this view: amended <b>${sgn(cur.amended)}${N(Math.abs(cur.amended))}</b> · current <b>${N(cur.current)}</b> · customers <b>${N(cur.customers)}</b> · drop-offs <b>${N(cur.drops)}</b>${base?` <span class="bsl">(changes ${base})</span>`:' <span class="bsl">(All time: pick a date range to see the change on the previous period)</span>'}</div>`;
}
/* ---- charts: self-drawn SVG, one axis, thin marks, tooltips, a table view for each ---- */
function niceStep(max,n){const raw=max/n,p=Math.pow(10,Math.floor(Math.log10(raw||1))),f=raw/p;return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p;}
function topRound(x,y,w,h,r){r=Math.min(r,w/2,h);return `M${x},${y+h}V${y+r}Q${x},${y} ${x+r},${y}H${x+w-r}Q${x+w},${y} ${x+w},${y+r}V${y+h}Z`;}
function bucketKey(unit,d){
  if(unit==='day')return fmtUK(d);
  if(unit==='week'){const t=new Date(d);t.setDate(t.getDate()-((t.getDay()+6)%7));return 'w/c '+fmtUK(t);}
  return ('0'+(d.getMonth()+1)).slice(-2)+'/'+d.getFullYear();
}
function trendSplit(rows,trend){
  const b={},u={};rows.forEach(r=>{if(!r.date)return;const k=bucketKey(trend.unit,r.date);b[k]=(b[k]||0)+r.billed;u[k]=(u[k]||0)+(r.invoiced?0:r.qty);});
  return trend.labels.map(k=>({k,billed:b[k]||0,unbilled:u[k]||0}));
}
function drawTime(rows,trend){
  const box=document.getElementById('rpTime'),data=trendSplit(rows,trend),n=data.length;
  const tot=data.reduce((a,d)=>a+d.billed+d.unbilled,0);
  document.getElementById('rpTimeLegend').innerHTML=`<span><i style="background:${RP_INK}"></i>Billed <b class="mono">${N(data.reduce((a,d)=>a+d.billed,0))}</b></span><span><i style="background:${RP_SLATE}"></i>Not yet billed <b class="mono">${N(data.reduce((a,d)=>a+d.unbilled,0))}</b></span>`;
  if(!n||!tot){box.innerHTML='<div class="rp-empty">Nothing counted in this view.</div>';document.getElementById('rpTimeTbl').innerHTML='';return;}
  const W=Math.max(320,box.clientWidth||720),H=270,L=46,R=8,T=14,B=28,pw=W-L-R,ph=H-T-B;
  const max=Math.max(...data.map(d=>d.billed+d.unbilled)),step=niceStep(max,4),top=Math.ceil(max/step)*step;
  const y=v=>T+ph-(v/top)*ph,slot=pw/n,bw=Math.max(2,Math.min(34,slot*0.72));
  let g='';for(let v=0;v<=top+1e-9;v+=step){g+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" class="gl${v===0?' base':''}"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end" class="ax">${N(v)}</text>`;}
  const every=Math.max(1,Math.ceil(n/Math.floor(pw/78)));
  let bars='',xl='',hit='';
  data.forEach((d,i)=>{
    const cx=L+slot*i+slot/2,x=cx-bw/2,hb=(d.billed/top)*ph,hu=(d.unbilled/top)*ph;
    if(hb>0)bars+=d.unbilled>0?`<rect x="${x}" y="${T+ph-hb}" width="${bw}" height="${hb}" fill="${RP_INK}"/>`:`<path d="${topRound(x,T+ph-hb,bw,hb,3)}" fill="${RP_INK}"/>`;
    if(hu>0)bars+=`<path d="${topRound(x,T+ph-hb-hu-(hb>0?2:0),bw,hu,3)}" fill="${RP_SLATE}"/>`;
    if(i%every===0&&(n-1-i>=every*0.6||i===n-1))xl+=`<text x="${cx}" y="${H-8}" text-anchor="middle" class="ax">${esc(d.k.replace(/^w\/c /,''))}</text>`;
    hit+=`<rect x="${L+slot*i}" y="${T}" width="${slot}" height="${ph}" fill="transparent" data-i="${i}"/>`;
  });
  const last=data[n-1],lt=last.billed+last.unbilled;
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Units by period, billed and not yet billed. ${n} periods, ${N(tot)} units in total.">${g}${bars}${xl}<text x="${L+slot*(n-1)+slot/2}" y="${y(lt)-6}" text-anchor="end" class="dlabel">${N(lt)}</text><line id="rpXh" y1="${T}" y2="${T+ph}" class="xh" style="display:none"/>${hit}</svg><div class="tip" id="rpTip" hidden></div>`;
  const tip=document.getElementById('rpTip'),xh=document.getElementById('rpXh');
  box.querySelectorAll('rect[data-i]').forEach(r=>{
    r.addEventListener('mousemove',e=>{const d=data[+r.dataset.i],cx=L+slot*(+r.dataset.i)+slot/2;xh.setAttribute('x1',cx);xh.setAttribute('x2',cx);xh.style.display='';
      tip.hidden=false;tip.innerHTML=`<b>${esc(d.k)}</b><span><i style="background:${RP_INK}"></i>Billed ${N(d.billed)}</span><span><i style="background:${RP_SLATE}"></i>Not yet billed ${N(d.unbilled)}</span><span>Total ${N(d.billed+d.unbilled)}</span>`;
      const bx=box.getBoundingClientRect();tip.style.left=Math.min(e.clientX-bx.left+14,bx.width-tip.offsetWidth-4)+'px';tip.style.top=Math.max(0,e.clientY-bx.top-tip.offsetHeight-10)+'px';});
    r.addEventListener('mouseleave',()=>{tip.hidden=true;xh.style.display='none';});
  });
  document.getElementById('rpTimeTbl').innerHTML=`<table class="rep"><thead><tr><th>Period</th><th class="n">Billed</th><th class="n">Not yet billed</th><th class="n">Total</th></tr></thead><tbody>${data.map(d=>`<tr><td>${esc(d.k)}</td><td class="n">${N(d.billed)}</td><td class="n">${N(d.unbilled)}</td><td class="n">${N(d.billed+d.unbilled)}</td></tr>`).join('')}</tbody></table>`;
}
function drawMix(byType,total){
  const box=document.getElementById('rpType');
  if(!byType.length||!total){box.innerHTML='<div class="rp-empty">Nothing counted in this view.</div>';return;}
  const max=byType[0].v;
  box.innerHTML=`<ul class="bl">${byType.map(t=>`<li><button type="button" class="bl-r" onclick="setFilter('fType',${jsq(t.k)})" title="Filter the report to ${esc(t.k)}"><span class="bl-n">${esc(t.k)}</span><span class="bl-t"><i style="width:${Math.max(1,t.v/max*100)}%"></i></span><span class="bl-v mono">${N(t.v)}</span><span class="bl-p mono">${t.v/total<0.01?'<1':Math.round(t.v/total*100)}%</span></button></li>`).join('')}</ul>`;
}
function drawCust(rows){
  const box=document.getElementById('rpCust'),m={};
  rows.forEach(r=>{const o=m[r.acct]||(m[r.acct]={k:r.acct,b:0,u:0});o.b+=r.billed;o.u+=r.invoiced?0:r.qty;});
  const all=Object.values(m).map(o=>Object.assign(o,{t:o.b+o.u})).sort((a,b)=>b.t-a.t);
  if(!all.length){box.innerHTML='<div class="rp-empty">Nothing counted in this view.</div>';return;}
  all.forEach(o=>{o.names=variantsOf(rows,o.k);});
  const top=all.slice(0,10),rest=all.slice(10);
  if(rest.length)top.push({k:`Other (${N(rest.length)} customers)`,b:rest.reduce((a,o)=>a+o.b,0),u:rest.reduce((a,o)=>a+o.u,0),other:true});
  top.forEach(o=>o.t=o.b+o.u);
  const max=Math.max(...top.filter(o=>!o.other).map(o=>o.t));
  box.innerHTML=`<ul class="bl cu">${top.map(o=>`<li>${o.other?'<div class="bl-r">':`<button type="button" class="bl-r" onclick="setFilter('fCust',${jsq(o.k)})" title="Filter the report to ${esc(o.k)}">`}<span class="bl-n"><span class="nm">${esc(o.k)}</span>${o.names?namesHint(o.names):''}</span><span class="bl-t">${o.other?'':`<i class="s1" style="width:${o.b/max*100}%"></i><i class="s2" style="width:${o.u/max*100}%"></i>`}</span><span class="bl-v mono">${N(o.t)}</span><span class="bl-p mono" title="Not yet billed">${o.u?N(o.u)+' open':'billed'}</span>${o.other?'</div>':'</button>'}</li>`).join('')}</ul>`;
}
function toggleTv(id,btn){const e=document.getElementById(id);e.hidden=!e.hidden;btn.setAttribute('aria-pressed',String(!e.hidden));btn.textContent=e.hidden?'View as table':'Hide table';}
/* ---- tables: sortable, sticky header, totals row, tabular right-aligned numbers ---- */
/* typed names behind one account row, with units; shown as "3 names" with a tooltip */
function variantsOf(rows,acct){const m={};rows.filter(r=>r.acct===acct).forEach(r=>{m[r.cust]=(m[r.cust]||0)+r.qty;});
  return Object.entries(m).map(([n,u])=>({n,u})).sort((a,b)=>b.u-a.u);}
function namesHint(names){
  if(!names||names.length<2)return '';
  const tip='Typed as: '+names.map(v=>v.n+' ('+N(v.u)+')').join(', ');
  return ` <span class="vn" tabindex="0" title="${esc(tip)}" aria-label="${esc(tip)}">${names.length} names</span>`;
}
function paintTable(id){
  const t=TBL[id],el=document.getElementById(id);if(!t||!el)return;
  const s=TSORT[id];let rows=t.rows.slice();
  if(s){const c=t.cols.find(c=>c.k===s.k);if(c){rows.sort((a,b)=>{const x=a[c.k],y=b[c.k];const r=(typeof x==='number'&&typeof y==='number')?x-y:String(x||'').localeCompare(String(y||''),'en-GB',{numeric:true});return s.dir==='asc'?r:-r;});}}
  const cell=(c,v,row)=>c.n?`<td class="n${v?'':' z'}">${c.f?c.f(v):N(v)}</td>`:`<td>${esc(v)}${(c.k==='cust'||c.k==='k')?namesHint(row.names):''}</td>`;
  const th=c=>`<th class="${c.n?'n':''}" aria-sort="${s&&s.k===c.k?(s.dir==='asc'?'ascending':'descending'):'none'}"><button type="button" class="sb" onclick="sortBy('${id}',${jsq(c.k)})">${esc(c.l)}<span class="si" aria-hidden="true">${s&&s.k===c.k?(s.dir==='asc'?'▲':'▼'):''}</span></button></th>`;
  el.innerHTML=`<thead><tr>${t.cols.map(th).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${t.cols.map(c=>cell(c,r[c.k],r)).join('')}</tr>`).join('')}</tbody>${t.tot?`<tfoot><tr>${t.cols.map((c,i)=>c.n?`<td class="n">${c.nt?c.nt(t.tot[c.k]):(t.tot[c.k]===''||t.tot[c.k]==null?'':(c.f?c.f(t.tot[c.k]):N(t.tot[c.k])))}</td>`:`<td>${i===0?'Total':''}</td>`).join('')}</tr></tfoot>`:''}`;
}
function sortBy(id,k){const s=TSORT[id];TSORT[id]={k,dir:(s&&s.k===k&&s.dir==='desc')?'asc':'desc'};paintTable(id);}
function setTab(k){RTAB=k;document.querySelectorAll('.rp-tab').forEach(b=>{const on=b.dataset.tab===k;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});
  document.querySelectorAll('.rp-pane').forEach(p=>{p.hidden=p.dataset.pane!==k;});}
function tabKey(e){const tabs=[...document.querySelectorAll('.rp-tab')],i=tabs.indexOf(document.activeElement);if(i<0)return;
  const j=e.key==='ArrowRight'?(i+1)%tabs.length:e.key==='ArrowLeft'?(i-1+tabs.length)%tabs.length:e.key==='Home'?0:e.key==='End'?tabs.length-1:-1;
  if(j>=0){e.preventDefault();tabs[j].focus();setTab(tabs[j].dataset.tab);}}
/* ---- filters ---- */
function setFilter(id,v){const e=document.getElementById(id);if(!e)return;e.value=v;if(id==='fType')refreshSizeProd();renderReports();reportsToday();}
function resetFilters(){document.getElementById('fRange').value='all';['fCust','fType','fSize','fProd','fStage'].forEach(i=>{document.getElementById(i).value='';});
  document.getElementById('fFrom').value='';document.getElementById('fTo').value='';onRangeChange();refreshSizeProd();renderReports();reportsToday();}
function clearFilter(id){if(id==='fRange'){document.getElementById('fRange').value='all';onRangeChange();}else setFilter(id,'');if(id==='fType')refreshSizeProd();reportsToday();}
function activeChips(){
  const L={fRange:'Range',fCust:'Customer',fType:'Type',fSize:'Size',fProd:'Product',fStage:'Stage'},out=[];
  Object.keys(L).forEach(id=>{const e=document.getElementById(id),v=e.value;if(id==='fRange'?v!=='all':v)out.push([id,L[id],e.options[e.selectedIndex].text]);});
  return out;
}
function renderReports(){
  const rows=applyFilter();const f=currentFilter();
  const cur=repMetrics(rows),pb=priorBounds(),prior=pb?repMetrics(applyFilter({from:pb.from,to:pb.to})):null;
  const byCust=groupSum(rows,'acct'),byProd=groupSum(rows,'product'),byType=groupSum(rows,'type');
  const trend=trendBuckets(rows),totalUnits=cur.current;
  LAST={rows,byCust,byProd,byType,trend,f};
  paintHero(rows,cur,prior,pb);
  /* tables (same figures as before) */
  const types=uniqueSorted(rows.map(r=>r.type)),codes=uniqueSorted(rows.map(r=>r.code));
  const sumBy=(cr,key,val)=>cr.filter(r=>r[key]===val).reduce((a,r)=>a+r.qty,0);
  const pivot=(keys,key)=>{const tot={total:0};keys.forEach(k=>{tot['c_'+k]=0;});
    const out=byCust.map(c=>{const cr=rows.filter(r=>r.acct===c.k),o={cust:c.k,total:c.v,names:variantsOf(rows,c.k)};keys.forEach(k=>{o['c_'+k]=sumBy(cr,key,k);tot['c_'+k]+=o['c_'+k];});tot.total+=c.v;return o;});
    return {out,tot};};
  const pc=pivot(types,'type'),pb2=pivot(codes,'code');
  TBL.tblCust={cols:[{k:'cust',l:'Customer'}].concat(types.map(t=>({k:'c_'+t,l:t,n:true})),[{k:'total',l:'Total',n:true}]),rows:pc.out,tot:pc.tot};
  TBL.tblBilling={cols:[{k:'cust',l:'Customer'}].concat(codes.map(c=>({k:'c_'+c,l:c,n:true})),[{k:'total',l:'Total',n:true}]),rows:pb2.out,tot:pb2.tot};
  TBL.tblProd={cols:[{k:'p',l:'Product'},{k:'size',l:'Size'},{k:'v',l:'Units',n:true}],rows:byProd.map(p=>({p:p.k,size:(PRODMAP[p.k]||{}).size||'—',v:p.v})),tot:{v:totalUnits}};
  TBL.tblType={cols:[{k:'t',l:'Type'},{k:'v',l:'Units',n:true},{k:'pc',l:'%',n:true,f:v=>v+'%',nt:()=>totalUnits?'100%':''}],rows:byType.map(t=>({t:t.k,v:t.v,pc:totalUnits?Math.round(t.v/totalUnits*100):0})),tot:{v:totalUnits}};
  const rc=recon(rows,'acct'),tk=k=>rc.reduce((a,r)=>a+r[k],0);
  rc.forEach(x=>{x.names=variantsOf(rows,x.k);});
  TBL.tblRecon={cols:[{k:'k',l:'Customer'},{k:'counted',l:'Counted',n:true},{k:'amended',l:'Amended',n:true,f:v=>(v>0?'+':v<0?'−':'')+N(Math.abs(v))},{k:'current',l:'Current',n:true},{k:'billed',l:'Billed',n:true},{k:'unbilled',l:'Not billed',n:true}],rows:rc,
    tot:{counted:tk('counted'),amended:tk('amended'),current:tk('current'),billed:tk('billed'),unbilled:tk('unbilled')}};
  Object.keys(TBL).forEach(paintTable);
  /* charts */
  drawTime(rows,trend);drawMix(byType,totalUnits);drawCust(rows);
  /* summary + active filter chips */
  const fr=f.from?fmtUK(f.from):'start',to=f.to?fmtUK(f.to):'today';
  document.getElementById('metaLine').innerHTML=`Showing <b>${N(rows.length)}</b> of ${N(RECORDS.length)} collection lines · <b>${N(cur.collections)}</b> collections · ${fr} → ${to}`;
  const ch=activeChips();
  document.getElementById('rpChips').innerHTML=ch.map(([id,l,t])=>`<button type="button" class="rp-chip" onclick="clearFilter('${id}')" aria-label="Remove filter ${esc(l)}: ${esc(t)}">${esc(l)}: ${esc(t)}<span aria-hidden="true">×</span></button>`).join('');
  document.getElementById('rpReset').disabled=!ch.length;
  console.assert(cur.unbilled===totalUnits-cur.billed,'not yet billed must equal current minus billed');
}
let rpRz=null;window.addEventListener('resize',()=>{clearTimeout(rpRz);rpRz=setTimeout(()=>{if(VIEW==='reports'&&LAST.rows){drawTime(LAST.rows,LAST.trend);}},150);});
function rangeLabel(){
  const f=LAST.f||currentFilter();
  return (f.from?fmtUK(f.from):'start')+' to '+(f.to?fmtUK(f.to):'today')+
    (f.cust?' | '+f.cust:'')+(f.type?' | '+f.type:'')+(f.size?' | '+f.size:'')+(f.prod?' | '+f.prod:'');
}
function exportXlsx(){
  if(typeof XLSX==='undefined'){toast('Excel library still loading — try again in a moment');return;}
  const {rows,byCust,byProd,byType}=LAST;
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['CheckFire Recycling — Report'],['Range',rangeLabel()],['Generated',fmtUK(new Date())],[],
    ['Total units',rows.reduce((a,r)=>a+r.qty,0)],['Collections',new Set(rows.map(r=>r.so)).size],['Customers',new Set(rows.map(r=>r.acct)).size]]),'Summary');
  const types=uniqueSorted(rows.map(r=>r.type));
  const custAoa=[['Customer',...types,'Total']];
  byCust.forEach(c=>{const cr=rows.filter(r=>r.acct===c.k);custAoa.push([c.k,...types.map(t=>cr.filter(r=>r.type===t).reduce((a,r)=>a+r.qty,0)),c.v]);});
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(custAoa),'By Customer');
  const codes=uniqueSorted(rows.map(r=>r.code));
  const billAoa=[['Customer',...codes,'Total']];
  byCust.forEach(c=>{const cr=rows.filter(r=>r.acct===c.k);billAoa.push([c.k,...codes.map(code=>cr.filter(r=>r.code===code).reduce((a,r)=>a+r.qty,0)),c.v]);});
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(billAoa),'Billing by Code');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Product','Size','Units'],...byProd.map(p=>[p.k,(PRODMAP[p.k]||{}).size||'',p.v])]),'By Product');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Type','Units'],...byType.map(t=>[t.k,t.v])]),'By Type');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Date','Customer (as typed)','Account','SO','Product','Size','Type','Code','Qty','Drop-off'],
    ...rows.map(r=>[fmtUK(r.date),r.cust,r.acct,r.so,r.product,r.size,r.type,r.code,r.qty,r.dropOff?'Yes':''])]),'Raw');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(
    [['Customer','Counted','Amended','Current','Billed','Not billed'],
     ...recon(rows,'acct').map(r=>[r.k,r.counted,r.amended,r.current,r.billed,r.unbilled])]),'Reconciliation');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(
    [['Date','Customer (as typed)','Account','SO','Product','Size','Type','Code','Counted','Amended','Current','Billed','Status','Invoiced','Drop-off'],
     ...rows.map(r=>[fmtUK(r.date),r.cust,r.acct,r.so,r.product,r.size,r.type,r.code,
                     r.counted,r.amended,r.qty,r.billed,r.status,r.invoiced?'Yes':'',r.dropOff?'Yes':''])]),'Raw detail');
  XLSX.writeFile(wb,'CheckFire-Recycling-Report-'+fmtUK(new Date()).replace(/\//g,'-')+'.xlsx');
}
function exportPptx(){
  if(typeof PptxGenJS==='undefined'){toast('PowerPoint library still loading — try again in a moment');return;}
  const {rows,byCust,byType,trend}=LAST;
  const pptx=new PptxGenJS();pptx.defineLayout({name:'W',width:13.33,height:7.5});pptx.layout='W';
  const RED='D63420',INK='1C1F23';
  let s=pptx.addSlide();s.background={color:'F4F2ED'};
  s.addText('CheckFire Recycling Returns',{x:0.6,y:2.3,w:12,h:0.8,fontSize:34,bold:true,color:INK,fontFace:'Arial'});
  s.addText('Recycling Report',{x:0.6,y:3.1,w:12,h:0.6,fontSize:24,color:RED,fontFace:'Arial'});
  s.addText(rangeLabel(),{x:0.6,y:3.9,w:12,h:0.4,fontSize:14,color:'4D545C',fontFace:'Courier New'});
  s.addText('Generated '+fmtUK(new Date()),{x:0.6,y:6.7,w:12,h:0.4,fontSize:11,color:'8A919A'});
  let k=pptx.addSlide();k.background={color:'FFFFFF'};
  k.addText('Summary',{x:0.6,y:0.4,w:12,h:0.6,fontSize:24,bold:true,color:INK});
  const kpis=[['Total units',rows.reduce((a,r)=>a+r.qty,0)],['Collections',new Set(rows.map(r=>r.so)).size],
    ['Customers',new Set(rows.map(r=>r.acct)).size],['CO2 buy-back',rows.filter(r=>(PRODMAP[r.product]||{}).buyback).reduce((a,r)=>a+r.qty,0)]];
  kpis.forEach((kp,i)=>{const x=0.6+i*3.1;
    k.addShape(pptx.ShapeType.rect,{x,y:1.4,w:2.8,h:1.8,fill:{color:'F4F2ED'},line:{color:'C9C4BA'}});
    k.addText(String(kp[1]),{x,y:1.6,w:2.8,h:0.9,fontSize:40,bold:true,align:'center',color:RED});
    k.addText(kp[0],{x,y:2.6,w:2.8,h:0.5,fontSize:13,align:'center',color:'4D545C'});});
  k.addChart(pptx.ChartType.bar,[{name:'Units',labels:trend.labels,values:trend.data}],
    {x:0.6,y:3.5,w:12,h:3.6,showTitle:true,title:'Trend over time',barDir:'col',chartColors:['2D5B8A']});
  let t=pptx.addSlide();t.background={color:'FFFFFF'};
  t.addText('Units by type',{x:0.6,y:0.4,w:12,h:0.6,fontSize:24,bold:true,color:INK});
  t.addChart(pptx.ChartType.doughnut,[{name:'Type',labels:byType.map(x=>x.k),values:byType.map(x=>x.v)}],
    {x:0.6,y:1.2,w:6,h:5.5,showLegend:true,legendPos:'r'});
  const typeRows=[[{text:'Type',options:{bold:true,color:'FFFFFF',fill:INK}},{text:'Units',options:{bold:true,color:'FFFFFF',fill:INK,align:'right'}}]];
  byType.forEach(x=>typeRows.push([x.k,{text:String(x.v),options:{align:'right'}}]));
  t.addTable(typeRows,{x:7,y:1.2,w:5.7,fontSize:13,border:{type:'solid',color:'E2DED6'}});
  let c=pptx.addSlide();c.background={color:'FFFFFF'};
  c.addText('Top customers',{x:0.6,y:0.4,w:12,h:0.6,fontSize:24,bold:true,color:INK});
  const cRows=[[{text:'Customer',options:{bold:true,color:'FFFFFF',fill:INK}},{text:'Units',options:{bold:true,color:'FFFFFF',fill:INK,align:'right'}}]];
  byCust.slice(0,18).forEach(x=>cRows.push([x.k,{text:String(x.v),options:{align:'right'}}]));
  c.addTable(cRows,{x:0.6,y:1.2,w:12,fontSize:12,border:{type:'solid',color:'E2DED6'}});
  pptx.writeFile({fileName:'CheckFire-Recycling-Report-'+fmtUK(new Date()).replace(/\//g,'-')+'.pptx'});
}

/* ============ amendments ============ */
function orderById(id){return (STATE.orders||[]).find(o=>o.id===id);}
function statusTag(o){
  if(o.status==='done'&&o.invoicedAt)return '<span class="tag inv">Invoiced</span>';
  if(o.status==='done')return '<span class="tag done">Counted</span>';
  return '<span class="tag open">Open</span>';
}
function renderAdminList(){
  const q=document.getElementById('search').value.trim().toLowerCase();
  const list=document.getElementById('list');
  let os=(STATE.orders||[]).slice();
  if(q)os=os.filter(o=>o.so.toLowerCase().includes(q)||(o.cust||'').toLowerCase().includes(q));
  os=os.slice(0,60);
  if(!os.length){list.innerHTML='<div class="empty">No matching orders.</div>';return;}
  list.innerHTML=os.map(o=>`<div class="resrow" tabindex="0" role="button" onkeydown="rowKey(event,${o.id})" onclick="openEdit(${o.id})">
    <span class="so">${esc(o.so)}</span><span class="cust">${esc(o.cust)}</span>
    ${statusTag(o)} ${o.amended?'<span class="tag amd">amended</span>':''}
    <span style="color:var(--ink-faint)">${o.counts&&o.counts.length?o.counts.reduce((a,c)=>a+c.lines.reduce((x,l)=>x+Number(l.q),0),0)+' units':'no count'}</span>
  </div>`).join('');
}
function openEdit(id){
  const o=orderById(id);if(!o)return;
  EDIT=JSON.parse(JSON.stringify({id:o.id,so:o.so,cust:o.cust,crates:o.crates,status:o.status,wtn:o.wtn,
    invoicedAt:o.invoicedAt,creditAt:o.creditAt,finalSo:o.finalSo,counts:o.counts||[],amendments:o.amendments||[]}));
  document.getElementById('eSo').textContent=EDIT.so+(EDIT.wtn?(' · '+EDIT.wtn):'');
  document.getElementById('eCust').textContent=EDIT.cust;
  document.getElementById('eMeta').innerHTML=`Status: ${esc(EDIT.status)} · Created ${esc(ukDate(o.date))} · SO raised: ${esc(EDIT.finalSo||'—')} · Invoiced: ${esc(EDIT.invoicedAt||'—')} · Credit: ${esc(EDIT.creditAt||'—')}`;
  document.getElementById('eWtnLink').href='/wtn/'+EDIT.id;
  document.getElementById('eCrates').value=EDIT.crates;
  document.getElementById('reason').value='';
  document.getElementById('okBox').style.display='none';
  ['optSo','optInv','optCredit'].forEach(i=>document.getElementById(i).checked=false);
  renderEntries();renderHist();
  document.getElementById('editPanel').style.display='block';
  document.getElementById('editPanel').scrollIntoView({behavior:'smooth'});
}
function prodOptions(sel){
  return '<option value="">— pick product —</option>'+ADMIN_PRODS.map(p=>`<option value="${esc(p.p)}" ${sel===p.p?'selected':''}>${esc(p.p)} (${esc(p.size)})</option>`).join('')+'<option value="__other">Other (type below)…</option>';
}
function renderEntries(){
  const wrap=document.getElementById('entries');wrap.innerHTML='';
  EDIT.counts.forEach((c,ci)=>{
    const range=c.crateTo&&c.crateTo!==c.crateFrom?`Crates ${c.crateFrom}–${c.crateTo}`:`Crate ${c.crateFrom||(ci+1)}`;
    const lines=c.lines.map((l,li)=>lineRow(ci,li,l)).join('');
    wrap.insertAdjacentHTML('beforeend',`<div class="entry" data-ci="${ci}" data-from="${c.crateFrom||ci+1}" data-to="${c.crateTo||c.crateFrom||ci+1}" data-by="${esc(c.by||'')}" data-when="${esc(c.when||'')}">
      <div class="entry-head"><b>${range}</b><span style="color:var(--ink-faint)">${esc(c.by||'')} · ${esc(c.when||'')}</span>
        <button class="btn sm ghost" style="margin-left:auto" onclick="rmEntry(${ci})">Remove entry</button></div>
      <div class="lines" id="lines${ci}">${lines}</div>
      <div class="addrow">
        <select id="addProd${ci}">${prodOptions('')}</select>
        <input id="addOther${ci}" placeholder="Other description" style="display:none">
        <input id="addQty${ci}" type="number" min="1" value="1">
        <button class="btn sm" onclick="addLine(${ci})">+ Add line</button>
      </div>
    </div>`);
    const ps=document.getElementById('addProd'+ci);
    ps.onchange=()=>{document.getElementById('addOther'+ci).style.display=ps.value==='__other'?'block':'none';};
  });
  if(!EDIT.counts.length)wrap.innerHTML='<div class="empty">No counts recorded yet. Use “Add crate entry” to record one.</div>';
}
function lineRow(ci,li,l){
  return `<div class="lrow" data-prod="${esc(l.p)}" data-other="${l.other?1:0}">
    <span class="pname">${esc(l.p)}</span>
    <input type="number" min="0" value="${Number(l.q)}" class="qin">
    <button class="rm" onclick="this.closest('.lrow').remove()">&times;</button>
  </div>`;
}
function addLine(ci){
  const ps=document.getElementById('addProd'+ci);
  const qty=parseInt(document.getElementById('addQty'+ci).value,10)||1;
  let p=ps.value,other=false;
  if(p==='__other'){p='Other: '+(document.getElementById('addOther'+ci).value.trim()||'item');other=true;}
  if(!p){toast('Pick a product first');return;}
  document.getElementById('lines'+ci).insertAdjacentHTML('beforeend',lineRow(ci,0,{p,q:qty,other}));
  ps.value='';document.getElementById('addOther'+ci).style.display='none';
  document.getElementById('addOther'+ci).value='';document.getElementById('addQty'+ci).value='1';
}
function rmEntry(ci){EDIT.counts.splice(ci,1);renderEntries();}
function addEntry(){
  const counted=EDIT.counts.reduce((a,c)=>a+((c.crateTo&&c.crateFrom)?(c.crateTo-c.crateFrom+1):1),0);
  EDIT.counts.push({crateFrom:counted+1,crateTo:counted+1,by:'Rec admin',when:'',lines:[]});
  renderEntries();
}
function collectCounts(){
  const out=[];
  document.querySelectorAll('#entries .entry').forEach(en=>{
    const lines=[];
    en.querySelectorAll('.lrow').forEach(row=>{
      const q=parseInt(row.querySelector('.qin').value,10)||0;
      if(q>0)lines.push({p:row.dataset.prod,q,...(row.dataset.other==='1'?{other:true}:{})});
    });
    out.push({crateFrom:+en.dataset.from,crateTo:+en.dataset.to,by:en.dataset.by||'amended',when:en.dataset.when||'',lines});
  });
  return out.filter(c=>c.lines.length);
}
async function saveAmend(){
  const reason=document.getElementById('reason').value.trim();
  if(!reason){toast('Enter a reason for the amendment');return;}
  const by=document.getElementById('adminName').value.trim();
  if(by)localStorage.setItem('recAdmin',by);
  const payload={orderId:EDIT.id,counts:collectCounts(),crates:parseInt(document.getElementById('eCrates').value,10)||EDIT.crates,reason,by,
    clearFinalSo:document.getElementById('optSo').checked,clearInvoiced:document.getElementById('optInv').checked,clearCredit:document.getElementById('optCredit').checked};
  const r=await fetch('/api/amend',{method:'POST',body:JSON.stringify(payload)});
  const j=await r.json();
  if(j.error){toast(j.error);return;}
  const ok=document.getElementById('okBox');ok.style.display='block';
  ok.innerHTML=`<b>Amendment saved.</b> ${j.counted} of ${j.of} crates counted · status now <b>${esc(j.status)}</b>.<br>
    Next steps: <a href="/wtn/${EDIT.id}" target="_blank">reprint the WTN</a> and re-send it`+
    (payload.clearFinalSo?', re-raise the SO in NetSuite':'')+(payload.clearInvoiced?', re-invoice or raise a credit':'')+(payload.clearCredit?', re-check the CO2 credit':'')+'.';
  await refresh();
  const o=orderById(EDIT.id);
  if(o){EDIT.amendments=o.amendments||[];EDIT.status=o.status;EDIT.wtn=o.wtn;renderHist();
    document.getElementById('eMeta').innerHTML=`Status: ${esc(o.status)} · Created ${esc(ukDate(o.date))} · SO raised: ${esc(o.finalSo||'—')} · Invoiced: ${esc(o.invoicedAt||'—')} · Credit: ${esc(o.creditAt||'—')}`;}
}
function renderHist(){
  const w=document.getElementById('histWrap'),h=document.getElementById('hist');
  if(!EDIT.amendments||!EDIT.amendments.length){w.style.display='none';return;}
  w.style.display='block';
  h.innerHTML=EDIT.amendments.slice().reverse().map(a=>{const tot=x=>x.reduce((s,t)=>s+t.q,0);
    return `<div class="h"><b>${esc(a.when)}</b> — ${esc(a.by)}<br>“${esc(a.reason)}”<br><span style="color:var(--ink-faint)">total units ${tot(a.before||[])} → ${tot(a.after||[])}</span></div>`;}).join('');
}
function closeEdit(){document.getElementById('editPanel').style.display='none';EDIT=null;}
/* ============ Defra "Report receipt of waste" ============
   The server fills Defra's own spreadsheet from the waste transfer notes — this
   only picks the dates and fetches it. Both dates blank = every WTN on record.
   Defra's sheet has a fixed number of rows, so a long range comes down as
   several files. */
let ROW_INFO=null;
function rowQuery(){
  const f=document.getElementById('rowFrom').value,t=document.getElementById('rowTo').value;
  return '?from='+encodeURIComponent(f)+'&to='+encodeURIComponent(t);
}
async function rowInfo(){
  const meta=document.getElementById('rowMeta'),warn=document.getElementById('rowWarn');
  ROW_INFO=null;
  try{
    const r=await fetch('/api/receipt-of-waste-info'+rowQuery());const d=await r.json();
    if(d.error){meta.textContent='';warn.textContent=d.error;rowStat('—','');return;}
    ROW_INFO=d;rowStat(d.count?N(d.count):'0',d.count?d.files+(d.files===1?' file':' files')+' of up to '+d.rowsPerFile+' rows':'Nothing to download');
    const uk=s=>s?s.split('-').reverse().join('/'):'';
    meta.textContent=d.count
      ?d.count+' waste transfer note'+(d.count===1?'':'s')+' received '+uk(d.first)+(d.last!==d.first?' to '+uk(d.last):'')
        +' · '+d.files+' file'+(d.files===1?'':'s')+(d.files>1?' ('+d.rowsPerFile+' rows each — Defra\'s sheet holds no more)':'')
      :'No waste transfer notes in that date range.';
    warn.innerHTML=d.missing.length?'<b>Left blank in the file until set up (not on the WTN)</b><span class="dm">'+d.missing.map(m=>'<i>'+esc(m)+'</i>').join('')+'</span>':'';
  }catch(e){meta.textContent='';warn.textContent='Could not reach the server.';rowStat('—','');}
}
function rowStat(n,s){const a=document.getElementById('rowCount'),b=document.getElementById('rowFiles');if(a)a.textContent=n;if(b)b.textContent=s;}
function rowAll(){document.getElementById('rowFrom').value='';document.getElementById('rowTo').value='';rowInfo();}
async function rowDownload(){
  if(!ROW_INFO)await rowInfo();
  if(!ROW_INFO)return;
  if(!ROW_INFO.count){toast('No waste transfer notes in that date range');return;}
  for(let part=1;part<=ROW_INFO.files;part++){
    const a=document.createElement('a');
    a.href='/api/receipt-of-waste'+rowQuery()+'&part='+part;
    document.body.appendChild(a);a.click();a.remove();
    if(part<ROW_INFO.files)await new Promise(s=>setTimeout(s,1200));
  }
  toast(ROW_INFO.files>1?'Downloading '+ROW_INFO.files+' files':'Downloading spreadsheet');
}
/* ============ start ============ */
try{const v=location.hash.slice(1)||localStorage.getItem('rrView');if(v&&(VIEWS[v]||v==='reports'||v==='amend'))VIEW=v;}catch(e){}
refresh();probeGuide();
setInterval(refresh,30000);
