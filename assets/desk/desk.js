const $ = (id) => document.getElementById(id);
const names = ["TOKYO","BERLIN","RIO","DENVER","LISBON","STOCKHOLM","NAIROBI","HELSINKI","PALERMO","PROFESSOR"];
const roles = ["SCOUT","CRITERIA","CHAIN PROOF","SOCIAL PROOF","VALIDATION","PAIR POLICY","BRIEF","AUDIT","VETO GATE","FINAL"];
let selected = null;
let timer = null;
let latestSnapshot = null;
let activeFilter = "ALL";
let socialRequest = 0;
let connectedExchanges=new Set(), exchangeId='', marketRows=[], xItems=[];
function traderReady(){const symbol=$('trade-market')?.value;const ok=Boolean(exchangeId&&connectedExchanges.has(exchangeId)&&symbol&&marketRows.some(m=>m.symbol===symbol));$('live-buy').disabled=!ok;$('live-sell').disabled=!ok;if($('auto-start'))$('auto-start').disabled=!ok;$('trade-token').textContent=symbol?`${symbol} · ${exchangeId}`:'X 포착 코인 선택';$('exchange-state').textContent=connectedExchanges.has(exchangeId)?`${exchangeId} API 연결`:'API 키 미연결';}
async function initExchanges(){const response=await fetch('/api/exchanges'),data=await response.json();const select=$('exchange-select');select.replaceChildren(...data.exchanges.map(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=`${x.name}${x.status==='candidate'?' · 계정 확인':''}`;return o}));exchangeId=select.value;await syncExchangeMarkets();}
async function syncExchangeMarkets(){exchangeId=$('exchange-select').value;try{const response=await fetch(`/api/exchanges/markets?exchange=${encodeURIComponent(exchangeId)}`),data=await response.json();if(!response.ok)throw new Error(data.error||'현물 종목 조회 실패');marketRows=data.markets;$('market-status').textContent=`${exchangeId} · ${marketRows.length} spot pairs`;$('ticker-status').textContent='상장 심볼 동기화 완료';const select=$('trade-market');select.replaceChildren(...marketRows.map(m=>{const o=document.createElement('option');o.value=m.symbol;o.textContent=`${m.symbol}`;return o}));const root=$('ticker-feed');root.replaceChildren();for(const m of marketRows.slice(0,120)){const row=document.createElement('div');row.className='ticker-row';row.textContent=`${m.symbol} · SPOT`;root.append(row)}traderReady();if(xItems.length)renderX(xItems);}catch(e){$('market-status').textContent=String(e.message||e).slice(0,100)}}
async function connectWallet(){exchangeId=$('exchange-select').value;const response=await fetch('/api/exchanges/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({exchange:exchangeId,accessKey:$('exchange-key').value,secretKey:$('exchange-secret').value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'거래소 연결 실패');connectedExchanges.add(exchangeId);$('exchange-key').value='';$('exchange-secret').value='';$('trade-status').textContent=`${exchangeId} 잔고 확인 완료 · 각 주문은 확인창 후 제출`;traderReady();}
async function executeTrade(side){const symbol=$('trade-market').value,raw=$(side==='buy'?'trade-buy':'trade-sell').value.trim();if(!connectedExchanges.has(exchangeId))throw new Error('먼저 거래소 API를 연결하세요.');if(!symbol||!marketRows.some(m=>m.symbol===symbol))throw new Error('현재 선택 거래소에서 거래 가능한 spot pair를 선택하세요.');if(!/^\d+(\.\d{1,12})?$/.test(raw)||Number(raw)<=0)throw new Error('주문 금액 또는 수량을 확인하세요.');const cost=side==='buy'?raw:`${raw} ${symbol.split('/')[0]}`;if(!confirm(`${exchangeId} 현물 시장가 ${side==='buy'?'매수':'매도'} · ${symbol} · ${cost}\n실제 주문을 거래소에 제출합니다.`))return;const response=await fetch('/api/exchanges/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({exchange:exchangeId,symbol,side,amount:raw})});const data=await response.json();if(!response.ok)throw new Error(data.error||'주문 제출 실패');$('trade-status').textContent=`실제 주문 응답 · ${JSON.stringify(data.order).slice(0,180)}`;const li=document.createElement('li');li.textContent=`${new Date().toLocaleTimeString()} · ${exchangeId} ${side} ${symbol} ${raw}`;$('trade-log').prepend(li);}
function renderX(items){xItems=items;const root=$('x-feed');root.replaceChildren();for(const item of items){const card=document.createElement('article');card.className='market-card';const text=document.createElement('p');text.textContent=item.text;const author=document.createElement('small');author.textContent=`@${item.author?.username||'unknown'} · ${item.createdAt||''}`;const blob=`${item.text} ${item.urls.join(' ')} ${item.hashtags.join(' ')}`.toUpperCase();const matches=marketRows.filter(m=>{const base=m.base.toUpperCase();return new RegExp(`(^|[^A-Z0-9])\\$?${base}([^A-Z0-9]|$)`).test(blob)});const matched=document.createElement('strong');matched.textContent=matches.length?`상장쌍 발견 (${exchangeId}): ${matches.slice(0,4).map(x=>x.symbol).join(', ')}`:'이 거래소 미상장 · 감시만';const select=document.createElement('select');const empty=document.createElement('option');empty.value='';empty.textContent=matches.length?'거래쌍 선택':'미상장';select.append(empty);matches.forEach(m=>{const o=document.createElement('option');o.value=m.symbol;o.textContent=m.symbol;select.append(o)});select.addEventListener('change',()=>{if(select.value)$('trade-market').value=select.value;traderReady()});const link=document.createElement('a');link.href=`https://x.com/${item.author?.username||'i'}/status/${item.id}`;link.target='_blank';link.rel='noopener noreferrer';link.textContent='X ↗';card.append(text,author,matched,select,link);root.append(card)}}
async function searchX(){const status=$('x-status');status.textContent='X 최근 게시물 검색 중';const response=await fetch('/api/x/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:$('x-query').value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'X 검색 실패');renderX(data.items||[]);status.textContent=`${data.items?.length||0}개 게시글 · ${data.source}`;}
const short = (value, size=6) => `${value.slice(0,size+2)}…${value.slice(-4)}`;
const explorer = (hash) => `https://robinhoodchain.blockscout.com/tx/${hash}`;
const tokenExplorer = (address) => `https://robinhoodchain.blockscout.com/address/${address}`;
const pons = (address) => `https://www.ponsfamily.com/launchpad/${address}`;
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const formatWei = (value) => {
  try { const n=BigInt(value), whole=n/1000000000000000000n, fraction=(n%1000000000000000000n).toString().padStart(18,"0").slice(0,4).replace(/0+$/,"");return `${whole}${fraction?`.${fraction}`:""} ETH` } catch { return "—" }
};
const socialHosts = {twitter:new Set(["x.com","www.x.com","twitter.com","www.twitter.com"]),telegram:new Set(["t.me","www.t.me"]),discord:new Set(["discord.gg","discord.com","www.discord.com"]),farcaster:new Set(["warpcast.com","www.warpcast.com"])};
function safeSocialUrl(raw,type){try{const url=new URL(raw);if(!["http:","https:"].includes(url.protocol))return null;const allowed=socialHosts[type];if(allowed&&!allowed.has(url.hostname.toLowerCase()))return null;return url.href}catch{return null}}
function xHandle(raw){const url=safeSocialUrl(raw,"twitter");if(!url)return null;const handle=new URL(url).pathname.split("/").filter(Boolean)[0]||"";return /^[A-Za-z0-9_]{1,15}$/.test(handle)?handle:null}

async function researchX(raw){
  const request=++socialRequest,handle=xHandle(raw);if(!handle)return;
  $("social-proof").textContent=`X / @${handle} · CHECKING PUBLIC PROFILE…`;
  try{const response=await fetch(`/api/social?handle=${encodeURIComponent(handle)}`,{headers:{accept:"application/json"}});if(!response.ok)throw new Error(`HTTP ${response.status}`);const profile=await response.json();if(request!==socialRequest)return;const year=new Date(profile.joined).getUTCFullYear();$("social-proof").textContent=`X / @${profile.handle} · ${profile.followers.toLocaleString()} FOLLOWERS · JOINED ${year}${profile.verified?" · VERIFIED":""} · PUBLIC MIRROR`}
  catch{if(request===socialRequest)$("social-proof").textContent=`X / @${handle} DECLARED · PUBLIC PROFILE UNAVAILABLE · NOT SCORED`}
}

function renderDossier(launch){
  const market=launch.market,meta=launch.metadata,history=launch.deployerResearch;
  $("dossier-status").textContent=`BLOCK #${launch.blockNumber.toLocaleString()} · ${launch.verdict}`;
  $("token-identity").textContent=meta.status==="DECLARED"?`${meta.name||"UNNAMED"} / $${meta.symbol||"—"}`:short(launch.token,8);
  $("factory-proof").textContent=market.status==="VERIFIED"?"PONS V2 / VERIFIED":"UNAVAILABLE";
  $("deployer-address").textContent=short(launch.deployer,8);
  $("fee-route").textContent=market.status==="VERIFIED"?(market.creatorFeeRecipient.toLowerCase()===launch.deployer.toLowerCase()?"DEPLOYER":"THIRD PARTY"):"UNAVAILABLE";
  $("liquidity-verdict").textContent=market.status==="VERIFIED"?`${market.phase} / ${pct(market.progressBps)}`:"UNAVAILABLE";
  $("real-quote").textContent=market.status==="VERIFIED"?formatWei(market.realQuoteReserve):"—";
  if(market.status==="VERIFIED"){const left=BigInt(market.graduationThreshold)>BigInt(market.realQuoteReserve)?BigInt(market.graduationThreshold)-BigInt(market.realQuoteReserve):0n;$("graduation-left").textContent=formatWei(left);$("curve-reserves").textContent=`${formatWei(market.quoteReserve)} / TOKEN ${short(market.tokenReserve,6)}`}
  else{$("graduation-left").textContent="—";$("curve-reserves").textContent="—"}
  $("deployer-verdict").textContent=history.priorLaunches===0?"FRESH IN WINDOW":history.priorLaunches>=5?"SERIAL LAUNCHER":"RETURNING";
  $("prior-launches").textContent=String(history.priorLaunches);$("prior-graduated").textContent=String(history.priorGraduations);$("history-window").textContent=`${history.windowBlocks.toLocaleString()} BLOCKS`;
  const socialRoot=$("social-links");socialRoot.replaceChildren();const declared=[];
  if(meta.status==="DECLARED")Object.entries(meta.socials).forEach(([type,raw])=>{const url=safeSocialUrl(raw,type);if(!url)return;const a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener noreferrer";a.textContent=`${type.toUpperCase()} ↗`;socialRoot.append(a);declared.push(type)});
  if(!declared.length){const empty=document.createElement("span");empty.textContent="NO VALID DECLARED LINKS";socialRoot.append(empty)}
  $("social-verdict").textContent=declared.length?`${declared.length} DECLARED / NOT ENDORSED`:"NO FOOTPRINT";
  $("social-proof").textContent=declared.length?"Declared on chain · external reputation not yet scored":"No valid social URLs declared in token metadata.";
  socialRequest++;if(meta.status==="DECLARED"&&meta.socials.twitter)researchX(meta.socials.twitter);
  const flags=[...launch.assessment.blockers];if(market.status==="VERIFIED"&&market.currentSnipeTaxBps>500)flags.push(`Snipe tax ${pct(market.currentSnipeTaxBps)}`);if(history.priorLaunches>=5)flags.push(`${history.priorLaunches} prior launches in window`);if(!declared.length)flags.push("No valid declared social links");flags.push(...launch.assessment.unknowns);
  const riskRoot=$("risk-flags");riskRoot.replaceChildren();flags.forEach(flag=>{const li=document.createElement("li");li.textContent=flag;riskRoot.append(li)});$("risk-verdict").textContent=flags.length?`${flags.length} FLAGS / GAPS`:"NO FLAGS IN CURRENT RULESET";
}

function buildRoute(){
  const root=$("route"); root.replaceChildren();
  names.forEach((name,i)=>{const el=document.createElement("div");el.className="agent";el.dataset.index=String(i);const role=document.createElement("span");role.textContent=`0${i+1}`.slice(-2)+" / "+roles[i];const title=document.createElement("strong");title.textContent=name;const status=document.createElement("small");status.textContent="STANDBY";el.append(role,title,status);root.append(el)});
}

function animate(decision){
  if(timer) clearInterval(timer); let i=0; const cards=[...document.querySelectorAll(".agent")];
  cards.forEach((card,index)=>{card.className="agent";card.querySelector("small").textContent="STANDBY";if(index===0)card.classList.add("active")});
  timer=setInterval(()=>{if(i>=cards.length){clearInterval(timer);return}const h=decision.handoffs[i];const card=cards[i];card.classList.remove("active");card.classList.add("done",h.outcome.toLowerCase());card.querySelector("small").textContent=h.outcome;i++;cards[i]?.classList.add("active")},120);
}

function selectLaunch(launch){
  selected=launch;
  traderReady();
  document.querySelectorAll(".intercept").forEach(el=>el.classList.toggle("selected",el.dataset.tx===launch.transactionHash));
  $("selected-token").textContent=short(launch.token,8);$("trace-id").textContent=short(launch.transactionHash,8);
  $("pons-link").href=pons(launch.token);$("token-link").href=tokenExplorer(launch.token);$("tx-link").href=explorer(launch.transactionHash);
  const card=$("decision-card");card.className=`decision-card ${launch.verdict.toLowerCase()}`;$("decision").textContent=launch.verdict;$("decision-copy").textContent=launch.handoffs[9].message;
  const market=launch.market;
  $("score").textContent=String(launch.assessment.score).padStart(2,"0");
  $("progress").textContent=market.status==="VERIFIED"?pct(market.progressBps):"UNKNOWN";
  $("phase").textContent=market.status==="VERIFIED"?market.phase:market.status;
  $("taxes").textContent=market.status==="VERIFIED"?`${pct(market.creatorTaxBps)} / ${pct(market.currentSnipeTaxBps)}`:"—";
  const assessment=launch.assessment;
  const evidence=[];
  if(assessment.blockers.length)evidence.push(`BLOCKERS — ${assessment.blockers.join(" · ")}`);
  evidence.push(`SCORE — ${assessment.reasons.join(" · ")}`);
  evidence.push(`UNRESOLVED — ${assessment.unknowns.join(" · ")}`);
  $("evidence").textContent=evidence.join("  /  ");
  renderDossier(launch);
  const trace=$("trace");trace.replaceChildren();launch.handoffs.forEach(h=>{const li=document.createElement("li");li.className=h.outcome.toLowerCase();const seq=document.createElement("span");seq.textContent=`${String(h.sequence).padStart(2,"0")} / ${h.outcome}`;const title=document.createElement("strong");title.textContent=h.agent;const copy=document.createElement("p");copy.textContent=h.message;li.append(seq,title,copy);trace.append(li)});animate(launch);
}

function renderFeed(snapshot){
  const feed=$("feed");feed.replaceChildren();
  const launches=activeFilter==="ALL"?snapshot.launches:snapshot.launches.filter(x=>x.verdict===activeFilter);
  if(!launches.length){const empty=document.createElement("p");empty.className="empty";empty.textContent=`No ${activeFilter.toLowerCase()} launches in the current block window.`;feed.append(empty);return}
  launches.forEach((launch,i)=>{const button=document.createElement("button");button.type="button";button.className="intercept";button.dataset.tx=launch.transactionHash;const n=document.createElement("span");n.className="ordinal";n.textContent=String(i+1).padStart(2,"0");const body=document.createElement("div");const title=document.createElement("strong");title.textContent=short(launch.token,8);const meta=document.createElement("small");const progress=launch.market.status==="VERIFIED"?pct(launch.market.progressBps):"UNKNOWN";meta.textContent=`${launch.assessment.score}/100 · ${progress} CURVE · ${launch.pairLabel}`;body.append(title,meta);const badge=document.createElement("span");badge.className=`badge ${launch.verdict.toLowerCase()}`;badge.textContent=launch.verdict;button.append(n,body,badge);button.addEventListener("click",()=>selectLaunch(launch));feed.append(button)});
  const stillPresent=selected&&launches.find(x=>x.transactionHash===selected.transactionHash);selectLaunch(stillPresent||launches[0]);
}

function render(snapshot){
  latestSnapshot=snapshot;$("pulse").classList.add("online");$("block").textContent=`#${snapshot.headBlock.toLocaleString()}`;$("sync").textContent="LIVE";
  $("launch-count").textContent=String(snapshot.launches.length).padStart(2,"0");$("watch-count").textContent=String(snapshot.launches.filter(x=>x.verdict==="WATCH").length).padStart(2,"0");$("veto-count").textContent=String(snapshot.launches.filter(x=>x.verdict==="VETO").length).padStart(2,"0");
  $("updated").textContent=`SYNC ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`;
  renderFeed(snapshot);
}

async function sync(){try{const response=await fetch("/api/snapshot",{headers:{accept:"application/json"}});if(!response.ok)throw new Error(`HTTP ${response.status}`);render(await response.json())}catch(error){$("pulse").classList.remove("online");$("sync").textContent="RETRYING";$("block").textContent="OFFLINE";$("updated").textContent=String(error.message||error).slice(0,70)}}

document.querySelectorAll("[data-filter]").forEach(button=>button.addEventListener("click",()=>{activeFilter=button.dataset.filter;document.querySelectorAll("[data-filter]").forEach(item=>item.classList.toggle("active",item===button));if(latestSnapshot)renderFeed(latestSnapshot)}));
if($('wallet-connect'))$('wallet-connect').addEventListener('click',()=>connectWallet().catch(e=>{$('trade-status').textContent=String(e.message||e)}));
if($('disconnect'))$('disconnect').addEventListener('click',async()=>{await fetch('/api/exchanges/disconnect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({exchange:exchangeId})});connectedExchanges.delete(exchangeId);traderReady()});
if($('exchange-select'))$('exchange-select').addEventListener('change',()=>syncExchangeMarkets());
if($('trade-market'))$('trade-market').addEventListener('change',traderReady);
if($('live-buy'))$('live-buy').addEventListener('click',()=>executeTrade('buy').catch(e=>{$('trade-status').textContent=String(e.message||e)}));
if($('live-sell'))$('live-sell').addEventListener('click',()=>executeTrade('sell').catch(e=>{$('trade-status').textContent=String(e.message||e)}));
if($('x-search'))$('x-search').addEventListener('click',()=>searchX().catch(e=>{$('x-status').textContent=String(e.message||e)}));
if($('x-connect'))$('x-connect').addEventListener('click',async()=>{const r=await fetch('/api/x/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:$('x-token').value})});const d=await r.json();$('x-token').value='';$('x-status').textContent=r.ok?'X API 연결 확인 완료':(d.error||'X 연결 실패')});
if($('x-disconnect'))$('x-disconnect').addEventListener('click',async()=>{await fetch('/api/x/disconnect',{method:'POST'});$('x-status').textContent='X API 연결 해제'});
if($('auto-start'))$('auto-start').addEventListener('click',async()=>{try{const data={exchange:exchangeId,symbol:$('trade-market').value,query:$('x-query').value,quoteAmount:$('auto-order-size').value,dailyCap:$('auto-daily-cap').value,maxDrawdownPct:$('auto-drawdown').value};const r=await fetch('/api/auto/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),j=await r.json();if(!r.ok)throw new Error(j.error||'자동매매 시작 실패');$('auto-status').textContent='실행 중 · 100,000× 목표';$('auto-log').textContent=`기준 자산 ${j.baseline} · X 신호 15초 간격 감시`;}catch(e){$('auto-log').textContent=String(e.message||e)}});
if($('auto-stop'))$('auto-stop').addEventListener('click',async()=>{const r=await fetch('/api/auto/stop',{method:'POST'}),j=await r.json();$('auto-status').textContent='중지';$('auto-log').textContent=j.status||'중지됨'});
if($('exchange-select'))initExchanges();
if($('auto-start'))setInterval(async()=>{const r=await fetch('/api/auto/status'),j=await r.json();$('auto-status').textContent=j.running?'실행 중 · 100,000× 목표':'중지';if(j.status)$('auto-log').textContent=j.status;},5000);
buildRoute();sync();setInterval(sync,10000);
