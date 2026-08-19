let STATE=null, activeTab='await';
const openCards=new Set(),openRows=new Set();
let RECORDS=[], PRODMAP={}, chartTypeRef=null, chartTrendRef=null, reportsReady=false, LAST={};
let MONTHLY=[];
function monthlyInfo(o){return MONTHLY.find(m=>{const k=String(m.match||m.name||'').toLowerCase();return k&&o.cust&&o.cust.toLowerCase().includes(k);});}
let ADMIN_PRODS=[], EDIT=null;

function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function ukDate(iso){const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(iso||'');return m?`${m[3]}/${m[2]}/${m[1]}`:(iso||'');}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',2800);}

/* ============ tab switching ============ */
function switchTab(t){
  activeTab=t;
  const map={await:'Await',counted:'Counted',inv:'Inv',reports:'Reports',admin:'Admin'};
  Object.entries(map).forEach(([k,v])=>{
    document.getElementById('view'+v).style.display=k===t?'block':'none';
    document.getElementById('tab'+v).classList.toggle('active',k===t);
  });
  document.getElementById('orderToolbar').style.display=(t==='await'||t==='counted'||t==='inv')?'flex':'none';
  if(t==='reports'){ if(!reportsReady){populateReportFilters();reportsReady=true;} renderReports(); }
  if(t==='admin'){ renderAdminList(); }
}

/* ============ data ============ */
async function refresh(){
  try{
    const r=await fetch('/api/state');STATE=await r.json();
    PRODMAP={};(STATE.products||[]).forEach(p=>PRODMAP[p.p]={size:p.size,type:p.group,code:p.code,buyback:!!p.buyback});
    ADMIN_PRODS=STATE.products||[];
    MONTHLY=STATE.monthlyCustomers||[];
    buildRecords();
    renderOrders();
    if(activeTab==='reports'&&reportsReady)renderReports();
    if(activeTab==='admin')renderAdminList();
  }catch(e){document.getElementById('syncMsg').textContent='Server unreachable';}
}

/* ============ order views ============ */
function crateLabel(c){
  if(c.crateTo&&c.crateTo!==c.crateFrom)return`Crates ${c.crateFrom}–${c.crateTo}`;
  return`Crate ${c.crateFrom||c.crate}`;
}
function ageDays(iso){const d=new Date(iso+'T00:00:00');return Math.max(0,Math.floor((Date.now()-d.getTime())/86400000));}
function ageBadge(o){const n=ageDays(o.date);const cls=n<=5?'g':(n<=10?'a':'r');return {cls,html:`<span class="age ${cls}">${n} day${n===1?'':'s'}</span>`};}
function lastCountDate(o){return o.counts.length?o.counts[o.counts.length-1].when.split(',')[0]:'';}
function counterNames(o){return [...new Set(o.counts.map(c=>c.by))].join(', ');}
function matchesFilter(o,f){if(!f)return true;return o.so.toLowerCase().includes(f)||o.cust.toLowerCase().includes(f);}

function renderOrders(){
  if(!STATE)return;
  const f=document.getElementById('filter').value.trim().toLowerCase();
  const awaitAll=STATE.orders.filter(o=>o.status==='open');
  const countedAll=STATE.orders.filter(o=>o.status==='done'&&!o.invoicedAt);
  const invAll=STATE.orders.filter(o=>o.status==='done'&&o.invoicedAt);
  const awaiting=awaitAll.filter(o=>matchesFilter(o,f));
  const counted=countedAll.filter(o=>matchesFilter(o,f));
  const inv=invAll.filter(o=>matchesFilter(o,f));

  stAwait.textContent=awaitAll.length;
  stCrates.textContent=awaitAll.reduce((a,o)=>a+(o.crates-o.counted),0);
  stCounted.textContent=countedAll.length;
  stInv.textContent=invAll.length;
  pillAwait.textContent=awaitAll.length;pillCounted.textContent=countedAll.length;pillInv.textContent=invAll.length;
  stCredit.textContent=STATE.orders.filter(o=>o.status==='done'&&o.co2>0&&!o.creditAt).length;
  stDrop.textContent=countedAll.filter(o=>o.dropOff).length;
  stMonthly.textContent=STATE.orders.filter(o=>monthlyInfo(o)&&!o.invoicedAt).length;

  const ls=STATE.lastSync;
  document.getElementById('syncDot').className='sync-dot '+(ls?(ls.ok?'ok':'bad'):'');
  document.getElementById('syncMsg').textContent=ls?`Auto-sync — last ${ls.when} (${ls.msg})`:'Waiting for first sync…';

  const grid=document.getElementById('awaitGrid');grid.innerHTML='';
  awaitEmpty.style.display=awaiting.length?'none':'block';
  awaiting.forEach(o=>{
    const rec=o.counted,pct=Math.round(rec/o.crates*100);
    const mInfo=monthlyInfo(o);
    const tag=(rec===0?'<span class="status-tag awaiting">Awaiting first crate</span>':'<span class="status-tag partial">Partially counted</span>')
      +(o.dropOff?' <span class="status-tag drop">Dropped off by customer</span>':'')
      +(mInfo?' <span class="status-tag monthly">MONTHLY • '+esc(mInfo.code)+'</span>':'');
    const ticks=Array.from({length:o.crates},(_,i)=>`<div class="tick ${i<rec?'in':''}"></div>`).join('');
    const tbl=o.totals.length?`<table>${o.totals.map(t=>`<tr><td>${esc(t.p)}</td><td>${t.q}</td></tr>`).join('')}</table>`
      :'<div class="nocounts">No crates counted yet</div>';
    const age=ageBadge(o);
    grid.insertAdjacentHTML('beforeend',`
      <div class="so-card age-${age.cls} ${o.dropOff?'drop':''}">
        <div class="so-top">
          <div>
            <div class="so-num">${esc(o.so)}</div>
            <div class="so-cust">${esc(o.cust)}</div>
            <div class="so-meta">Created ${esc(ukDate(o.date))} &middot; ${esc(o.by)}</div>
          </div>
          <div class="crate-frac">
            <div style="margin-bottom:6px;text-align:right">${age.html}</div>
            <div class="big">${rec}<span class="of"> / ${o.crates}</span></div><div class="sub">crates counted</div>
          </div>
        </div>
        <div class="prog"><div class="fill ${pct===100?'full':''}" style="width:${pct}%"></div></div>
        <div class="ticks">${ticks}</div>
        <div class="so-body">${tbl}</div>
        <div class="so-body" style="padding-top:0;display:flex;align-items:center;gap:8px">${tag}
          ${rec>0?`<button class="btn small ghost" style="margin-left:auto" onclick="closeShort(${o.id},${o.crates},${rec})">Close Short</button>`:''}
        </div>
      </div>`);
  });

  const list=document.getElementById('countedList');list.innerHTML='';
  countedEmpty.style.display=counted.length?'none':'block';
  counted.forEach(o=>{
    const totalUnits=o.totals.reduce((a,t)=>a+t.q,0);
    const isOpen=openCards.has(o.id)?'open':'';
    const mInfo=monthlyInfo(o);
    list.insertAdjacentHTML('beforeend',`
      <div class="comp-card ${isOpen} ${o.dropOff?'drop':''} ${o.amended?'amended-c':''}" id="comp${o.id}">
        <div class="comp-head" onclick="toggleCard(${o.id})">
          <span class="chev">&#9656;</span>
          <div>
            <div class="so-num">${esc(o.so)}</div>
            <div class="so-cust" style="font-size:15px">${esc(o.cust)}</div>
          </div>
          <span class="status-tag complete">${o.crates} of ${o.crates} counted &middot; ${totalUnits} units</span>
          ${o.dropOff?'<span class="status-tag drop">Dropped off by customer</span>':''}
          ${mInfo?`<span class="status-tag monthly">MONTHLY • ${esc(mInfo.code)}</span>`:''}
          ${o.amended?`<span class="status-tag amended" title="${esc(o.amendments&&o.amendments.length?o.amendments[o.amendments.length-1].reason:'')}">Amended — resend WTN</span>`:''}
          ${o.short?`<span class="status-tag short" title="${esc(o.short.reason||'')}">Short — ${o.short.received} of ${o.short.expected} returned (${esc(o.short.when)})</span>`:''}
          ${o.co2>0?`<span class="status-tag co2">CO2 buy-back — ${o.co2} unit${o.co2===1?'':'s'}</span>`:''}
          <div class="head-right" onclick="event.stopPropagation()">
            <a class="btn small wtn" href="/wtn/${o.id}" target="_blank">View WTN</a>
            <label class="tickbox">
              <input type="checkbox" ${o.wtnSentAt?'checked':''} onchange="mark(${o.id},'wtnSent',this.checked)">
              WTN sent ${o.wtnSentAt?`<span class="stamp">${esc(o.wtnSentAt)}</span>`:''}
            </label>
            ${o.co2>0?`<label class="tickbox">
              <input type="checkbox" ${o.creditAt?'checked':''} onchange="mark(${o.id},'credit',this.checked)">
              Credit issued ${o.creditAt?`<span class="stamp">${esc(o.creditAt)}</span>`:''}
            </label>`:''}
            <label class="tickbox">
              <input type="checkbox" onchange="mark(${o.id},'invoiced',this.checked)">
              Invoiced
            </label>
            <div class="ref-block">
              WTN: <span class="set">${esc(o.wtn||'')}</span><br>
              SO: <span class="${o.finalSo?'set':'pending'}">${esc(o.finalSo||'pending API')}</span>
            </div>
          </div>
        </div>
        <div class="comp-detail">${detailBlock(o)}</div>
      </div>`);
  });

  const body=document.getElementById('invBody');body.innerHTML='';
  document.getElementById('invTable').style.display=inv.length?'table':'none';
  invEmpty.style.display=inv.length?'none':'block';
  inv.forEach(o=>{
    const isOpen=openRows.has(o.id);
    body.insertAdjacentHTML('beforeend',`
      <tr class="main ${isOpen?'open':''}" id="invrow${o.id}" onclick="toggleRow(${o.id})">
        <td><span class="chev">&#9656;</span></td>
        <td class="so-cell">${esc(o.so)}${o.short?' <span class="status-tag short" title="'+esc(o.short.reason||'')+'">short '+o.short.received+'/'+o.short.expected+'</span>':''}${o.dropOff?' <span class="status-tag drop">drop-off</span>':''}${o.amended?' <span class="status-tag amended">amended</span>':''}${monthlyInfo(o)?' <span class="status-tag monthly">monthly</span>':''}</td>
        <td>${esc(o.cust)}</td>
        <td>${esc(o.by)}</td>
        <td>${esc(lastCountDate(o))}</td>
        <td>${esc(counterNames(o))}</td>
        <td>${esc(o.wtnSentAt||'—')}</td>
        <td>${esc(o.invoicedAt||'')}</td>
        <td onclick="event.stopPropagation()">${o.co2>0?(o.creditAt?esc(o.creditAt):`<label class="tickbox" style="padding:4px 8px"><input type="checkbox" onchange="mark(${o.id},'credit',this.checked)">due — ${o.co2}</label>`):'n/a'}</td>
        <td onclick="event.stopPropagation()"><a class="btn small wtn" href="/wtn/${o.id}" target="_blank">WTN</a></td>
      </tr>
      <tr class="detail ${isOpen?'show':''}" id="invdet${o.id}"><td colspan="10">${detailBlock(o,true)}</td></tr>`);
  });
}
function detailBlock(o,inv){
  return `
    <div class="detail-grid">
      <div><h4>Total counted</h4><table>${o.totals.map(t=>`<tr><td>${esc(t.p)}</td><td>${t.q}</td></tr>`).join('')}</table></div>
      <div><h4>NetSuite lines (Phase 3 SO)</h4><table>${(o.nsLines||[]).map(l=>`<tr><td>${esc(l.code)}</td><td>${l.q}</td></tr>`).join('')}</table></div>
      <div><h4>Crate log</h4><div class="crate-log">${o.counts.map(c=>`<div class="entry-l">${crateLabel(c)} — ${esc(c.by)} — ${esc(c.when)}<br>${c.lines.map(l=>esc(l.p)+' ×'+l.q).join(', ')}</div>`).join('')}</div></div>
    </div>
    <div class="actions">
      <div><label>SO created against count (manual until API)</label>
        <input value="${esc(o.finalSo||'')}" placeholder="pending API" onchange="setFinalSO(${o.id},this.value)"></div>
      ${inv?`<label class="tickbox"><input type="checkbox" checked onchange="mark(${o.id},'invoiced',this.checked)">Invoiced <span class="stamp">${esc(o.invoicedAt||'')}</span></label>`:''}
    </div>`;
}
function toggleCard(id){openCards.has(id)?openCards.delete(id):openCards.add(id);document.getElementById('comp'+id).classList.toggle('open');}
function toggleRow(id){openRows.has(id)?openRows.delete(id):openRows.add(id);document.getElementById('invrow'+id).classList.toggle('open');document.getElementById('invdet'+id).classList.toggle('show');}
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

/* ============ reports ============ */
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
        date:lastDate,cust:o.cust||'Unknown',so:o.so,product:p,
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
function uniqueSorted(arr){return [...new Set(arr)].filter(Boolean).sort();}
function populateReportFilters(){
  const cust=document.getElementById('fCust');
  uniqueSorted(RECORDS.map(r=>r.cust)).forEach(c=>cust.add(new Option(c,c)));
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
function applyFilter(){
  const f=currentFilter();
  return RECORDS.filter(r=>{
    if(f.from&&(!r.date||r.date<f.from))return false;
    if(f.to&&(!r.date||r.date>f.to))return false;
    if(f.cust&&r.cust!==f.cust)return false;
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
function renderReports(){
  const rows=applyFilter();const f=currentFilter();
  const totalUnits=rows.reduce((a,r)=>a+r.qty,0);
  const sos=new Set(rows.map(r=>r.so));
  const co2=rows.filter(r=>(PRODMAP[r.product]||{}).buyback).reduce((a,r)=>a+r.qty,0);
  const drops=new Set(rows.filter(r=>r.dropOff).map(r=>r.so));
  const tCounted=rows.reduce((a,r)=>a+r.counted,0);
  const tAmended=rows.reduce((a,r)=>a+r.amended,0);
  const tBilled =rows.reduce((a,r)=>a+r.billed,0);
  document.getElementById('kpis').innerHTML=[
    ['Counted',tCounted],['Amended',(tAmended>0?'+':'')+tAmended],['Current',totalUnits],
    ['Billed',tBilled],['Not yet billed',totalUnits-tBilled],
    ['Collections',sos.size],['Customers',new Set(rows.map(r=>r.cust)).size],
    ['CO2 buy-back units',co2],['Drop-offs',drops.size]
  ].map(([l,n])=>`<div class="kpi"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join('');
  const byCust=groupSum(rows,'cust'),byProd=groupSum(rows,'product'),byType=groupSum(rows,'type');
  const trend=trendBuckets(rows);
  LAST={rows,byCust,byProd,byType,trend,f};
  const types=uniqueSorted(rows.map(r=>r.type));
  let ch='<tr><th>Customer</th>'+types.map(t=>`<th class="n">${esc(t)}</th>`).join('')+'<th class="n">Total</th></tr>';
  byCust.forEach(c=>{const cr=rows.filter(r=>r.cust===c.k);
    ch+=`<tr><td>${esc(c.k)}</td>`+types.map(t=>`<td class="n">${cr.filter(r=>r.type===t).reduce((a,r)=>a+r.qty,0)||''}</td>`).join('')+`<td class="n"><b>${c.v}</b></td></tr>`;});
  document.getElementById('tblCust').innerHTML=ch;
  document.getElementById('tblProd').innerHTML='<tr><th>Product</th><th>Size</th><th class="n">Units</th></tr>'+
    byProd.map(p=>{const sz=(PRODMAP[p.k]||{}).size||'—';return `<tr><td>${esc(p.k)}</td><td>${esc(sz)}</td><td class="n">${p.v}</td></tr>`;}).join('');
  document.getElementById('tblType').innerHTML='<tr><th>Type</th><th class="n">Units</th><th class="n">%</th></tr>'+
    byType.map(t=>`<tr><td>${esc(t.k)}</td><td class="n">${t.v}</td><td class="n">${totalUnits?Math.round(t.v/totalUnits*100):0}%</td></tr>`).join('');
  const codes=uniqueSorted(rows.map(r=>r.code));
  let bh='<tr><th>Customer</th>'+codes.map(c=>`<th class="n">${esc(c)}</th>`).join('')+'<th class="n">Total</th></tr>';
  byCust.forEach(c=>{const cr=rows.filter(r=>r.cust===c.k);
    bh+=`<tr><td>${esc(c.k)}</td>`+codes.map(code=>`<td class="n">${cr.filter(r=>r.code===code).reduce((a,r)=>a+r.qty,0)||''}</td>`).join('')+`<td class="n"><b>${c.v}</b></td></tr>`;});
  document.getElementById('tblBilling').innerHTML=bh;
  const rc=recon(rows,'cust');
  const tot=k=>rc.reduce((a,r)=>a+r[k],0);
  document.getElementById('tblRecon').innerHTML=
    '<tr><th>Customer</th><th class="n">Counted</th><th class="n">Amended</th>'+
    '<th class="n">Current</th><th class="n">Billed</th><th class="n">Not billed</th></tr>'+
    rc.map(r=>`<tr><td>${esc(r.k)}</td><td class="n">${r.counted}</td>`+
      `<td class="n">${r.amended?(r.amended>0?'+':'')+r.amended:''}</td>`+
      `<td class="n"><b>${r.current}</b></td><td class="n">${r.billed}</td>`+
      `<td class="n">${r.unbilled||''}</td></tr>`).join('')+
    `<tr><td><b>Total</b></td><td class="n"><b>${tot('counted')}</b></td>`+
    `<td class="n"><b>${tot('amended')||''}</b></td><td class="n"><b>${tot('current')}</b></td>`+
    `<td class="n"><b>${tot('billed')}</b></td><td class="n"><b>${tot('unbilled')||''}</b></td></tr>`;
  const fr=f.from?fmtUK(f.from):'start',to=f.to?fmtUK(f.to):'today';
  document.getElementById('metaLine').textContent=`Showing ${rows.length} collection line(s) · ${fr} → ${to}`+
    (f.cust?` · ${f.cust}`:'')+(f.type?` · ${f.type}`:'')+(f.size?` · ${f.size}`:'')+(f.prod?` · ${f.prod}`:'');
  drawCharts(byType,trend);
}
function drawCharts(byType,trend){
  const pal=['#d63420','#b29a6b','#3a536b','#1c1f23','#5e6670','#8a4fc4','#1e7d4f','#e8930c'];
  if(chartTypeRef)chartTypeRef.destroy();
  chartTypeRef=new Chart(document.getElementById('chartTypeCanvas'),{type:'doughnut',
    data:{labels:byType.map(t=>t.k),datasets:[{data:byType.map(t=>t.v),backgroundColor:pal}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right'}}}});
  if(chartTrendRef)chartTrendRef.destroy();
  chartTrendRef=new Chart(document.getElementById('chartTrendCanvas'),{type:'bar',
    data:{labels:trend.labels,datasets:[{label:'Units',data:trend.data,backgroundColor:'#2d5b8a'}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{maxRotation:60,minRotation:0}}}}});
}
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
    ['Total units',rows.reduce((a,r)=>a+r.qty,0)],['Collections',new Set(rows.map(r=>r.so)).size],['Customers',new Set(rows.map(r=>r.cust)).size]]),'Summary');
  const types=uniqueSorted(rows.map(r=>r.type));
  const custAoa=[['Customer',...types,'Total']];
  byCust.forEach(c=>{const cr=rows.filter(r=>r.cust===c.k);custAoa.push([c.k,...types.map(t=>cr.filter(r=>r.type===t).reduce((a,r)=>a+r.qty,0)),c.v]);});
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(custAoa),'By Customer');
  const codes=uniqueSorted(rows.map(r=>r.code));
  const billAoa=[['Customer',...codes,'Total']];
  byCust.forEach(c=>{const cr=rows.filter(r=>r.cust===c.k);billAoa.push([c.k,...codes.map(code=>cr.filter(r=>r.code===code).reduce((a,r)=>a+r.qty,0)),c.v]);});
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(billAoa),'Billing by Code');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Product','Size','Units'],...byProd.map(p=>[p.k,(PRODMAP[p.k]||{}).size||'',p.v])]),'By Product');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Type','Units'],...byType.map(t=>[t.k,t.v])]),'By Type');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Date','Customer','SO','Product','Size','Type','Code','Qty','Drop-off'],
    ...rows.map(r=>[fmtUK(r.date),r.cust,r.so,r.product,r.size,r.type,r.code,r.qty,r.dropOff?'Yes':''])]),'Raw');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(
    [['Customer','Counted','Amended','Current','Billed','Not billed'],
     ...recon(rows,'cust').map(r=>[r.k,r.counted,r.amended,r.current,r.billed,r.unbilled])]),'Reconciliation');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(
    [['Date','Customer','SO','Product','Size','Type','Code','Counted','Amended','Current','Billed','Status','Invoiced','Drop-off'],
     ...rows.map(r=>[fmtUK(r.date),r.cust,r.so,r.product,r.size,r.type,r.code,
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
    ['Customers',new Set(rows.map(r=>r.cust)).size],['CO2 buy-back',rows.filter(r=>(PRODMAP[r.product]||{}).buyback).reduce((a,r)=>a+r.qty,0)]];
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
  list.innerHTML=os.map(o=>`<div class="resrow" onclick="openEdit(${o.id})">
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

refresh();
setInterval(refresh,30000);
