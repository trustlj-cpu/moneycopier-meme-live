import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RPC_URL, fetchLiveSnapshot, type LiveSnapshot, type RpcCaller } from "./live.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ASSETS = resolve(projectRoot, "assets/desk");
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
} as const;
interface ApiKeys { accessKey: string; secretKey: string }
interface GenericExchange { id:string; name:string; markets?:Record<string,{symbol:string,base:string,quote:string,active?:boolean,spot?:boolean}>; has?:Record<string,unknown>; loadMarkets:()=>Promise<unknown>; fetchBalance:()=>Promise<unknown>; createMarketBuyOrderWithCost?:(symbol:string,cost:number,params?:Record<string,unknown>)=>Promise<unknown>; createOrder:(symbol:string,type:string,side:string,amount:number,price?:number,params?:Record<string,unknown>)=>Promise<unknown>; fetchTicker:(symbol:string)=>Promise<Record<string,unknown>>; }
const exchangeKeys=new Map<string,ApiKeys>();
for(const id of ["binance","bybit","bitget","kraken","coinbase","okx","kucoin","bingx"]){const accessKey=process.env[`${id.toUpperCase()}_API_KEY`],secretKey=process.env[`${id.toUpperCase()}_API_SECRET`];if(accessKey&&secretKey)exchangeKeys.set(id,{accessKey,secretKey});}
let xBearerToken=process.env.X_BEARER_TOKEN??"";
type AutoState={running:boolean;exchange:string;symbol:string;query:string;quoteAmount:number;dailyCap:number;maxDrawdownPct:number;targetMultiple:number;baseline:number;spent:number;day:string;seenIds:Set<string>;positionAmount:number;status:string;timer?:ReturnType<typeof setInterval>};
let autoState:AutoState|null=null;
const EXCHANGE_LABELS:Record<string,string>={binance:"Binance Global",bybit:"Bybit Global",bitget:"Bitget Global",kraken:"Kraken",coinbase:"Coinbase Advanced (자격 확인 필요)",okx:"OKX (현물 자격 확인 필요)",kucoin:"KuCoin (현물 자격 확인 필요)",bingx:"BingX Global"};
async function makeExchange(id:string,keys?:ApiKeys):Promise<GenericExchange>{
  if(!Object.hasOwn(EXCHANGE_LABELS,id))throw new Error("지원하지 않는 거래소입니다.");
  const module=await import("ccxt");const ctor=(module as unknown as Record<string,unknown>)[id];if(typeof ctor!=="function")throw new Error("거래소 어댑터를 찾지 못했습니다.");
  const instance=new (ctor as new(o:Record<string,unknown>)=>GenericExchange)({enableRateLimit:true,timeout:12000,...(keys?{apiKey:keys.accessKey,secret:keys.secretKey}:{}),options:{defaultType:"spot"}});
  await instance.loadMarkets();return instance;
}
function autoStop(message:string):void{if(autoState?.timer)clearInterval(autoState.timer);if(autoState){autoState.running=false;autoState.status=message;}}
async function autoTick():Promise<void>{
  const state=autoState;if(!state?.running)return;
  try{
    const keys=exchangeKeys.get(state.exchange);if(!keys||!xBearerToken)throw new Error("거래소 또는 X 연결이 끊겼습니다.");
    const ex=await makeExchange(state.exchange,keys);const market=ex.markets?.[state.symbol];if(!market||market.active===false||market.spot===false)throw new Error("선택한 현물 거래쌍을 찾지 못했습니다.");
    const bal=await ex.fetchBalance() as {total?:Record<string,number|string>};const quote=market.quote,base=market.base;const quoteTotal=Number(bal.total?.[quote]??0),baseTotal=Number(bal.total?.[base]??0);const ticker=await ex.fetchTicker(state.symbol);const equity=quoteTotal+baseTotal*Number(ticker.last??0);
    if(equity>=state.baseline*state.targetMultiple){if(state.positionAmount>0)await ex.createOrder(state.symbol,"market","sell",state.positionAmount);autoStop(`목표 도달 · ${state.targetMultiple.toLocaleString()}x · 보유분 매도 요청`);return;}
    if(equity<=state.baseline*(1-state.maxDrawdownPct/100)){if(state.positionAmount>0)await ex.createOrder(state.symbol,"market","sell",state.positionAmount);autoStop(`손실 제한 정지 · 보유분 매도 요청 · equity ${equity.toFixed(4)} ${quote}`);return;}
    const day=new Date().toISOString().slice(0,10);if(state.day!==day){state.day=day;state.spent=0;}
    if(state.spent>=state.dailyCap){autoStop(`일일 주문 한도 도달 · ${state.spent} ${quote}`);return;}
    const q=`(${state.query}) ($${base} OR ${base}) -is:retweet`;
    const url=new URL("https://api.x.com/2/tweets/search/recent");url.searchParams.set("query",q);url.searchParams.set("max_results","25");url.searchParams.set("tweet.fields","created_at,public_metrics,entities");
    const response=await fetch(url,{headers:{authorization:`Bearer ${xBearerToken}`,accept:"application/json"},signal:AbortSignal.timeout(10_000)});if(!response.ok)throw new Error(`X API ${response.status}`);const payload=await response.json() as {data?:Array<{id:string,text:string,public_metrics?:{like_count?:number,retweet_count?:number,reply_count?:number,quote_count?:number}}>};const mentions=payload.data??[];const symbolMention=mentions.filter(t=>new RegExp(`(^|[^A-Z0-9])\\$?${base.toUpperCase()}([^A-Z0-9]|$)`,`i`).test(t.text));
    const fresh=symbolMention.filter(t=>!state.seenIds.has(t.id));if(!fresh.length){state.status=`감시 중 · 새 X 신호 없음 · ${state.symbol} · equity ${equity.toFixed(4)} ${quote}`;return;}fresh.forEach(t=>state.seenIds.add(t.id));
    const orderAmount=Math.min(state.quoteAmount,state.dailyCap-state.spent);if(orderAmount<=0){autoStop("일일 주문 한도 소진");return;}
    if(!ex.createMarketBuyOrderWithCost||ex.has?.createMarketBuyOrderWithCost===false)throw new Error("선택 거래소가 quote 금액 시장가 매수를 지원하지 않아 자동매매를 정지했습니다.");
    const order=await ex.createMarketBuyOrderWithCost(state.symbol,orderAmount);state.positionAmount+=Number((order as {filled?:number|string}).filled??0);state.spent+=orderAmount;state.status=`실제 자동 매수 제출 · ${state.symbol} · ${orderAmount} ${quote} · 신규 X 언급 ${fresh.length}건 · ${(order as {id?:string}).id??"주문 응답"}`;
  }catch(error){autoStop(`자동매매 중지 · ${error instanceof Error?error.message.slice(0,130):"실패"}`);}
}
async function readBody(request:import("node:http").IncomingMessage,max=8192):Promise<Record<string,unknown>>{let raw="";for await(const chunk of request){raw+=chunk.toString();if(raw.length>max)throw new Error("요청이 너무 큽니다.")}const value:unknown=JSON.parse(raw);if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("요청 형식이 잘못되었습니다.");return value as Record<string,unknown>}

export interface DeskServerOptions {
  rpc?: RpcCaller;
  rpcUrl?: string;
  assetsRoot?: string;
  cacheMs?: number;
  failureCacheMs?: number;
  socialFetch?: typeof fetch;
}

export interface RpcCallerOptions { fetch?: typeof fetch; retryDelayMs?: number }
export function createHttpRpcCaller(url?: string, options: RpcCallerOptions = {}): RpcCaller {
  let requestId=0,lastRequestAt=0,lastLogsAt=0;const fetcher=options.fetch??fetch,retryDelayMs=options.retryDelayMs??400;
  const endpoints=(url?url.split(",").map(x=>x.trim()).filter(Boolean):["https://robinhood-rpc.publicnode.com#nologs",DEFAULT_RPC_URL]).map(value=>({url:value.replace(/#nologs$/,""),logs:!value.endsWith("#nologs")}));
  const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
  return async(method,params=[])=>{const candidates=endpoints.filter(e=>method!=="eth_getLogs"||e.logs);if(!candidates.length)throw new Error("No configured RPC endpoint supports eth_getLogs");let last="RPC request failed";
    for(let attempt=0;attempt<5;attempt++){const endpoint=candidates[attempt%candidates.length];if(!endpoint)break;const now=Date.now(),start=Math.max(lastRequestAt+80,method==="eth_getLogs"?lastLogsAt+500:0);if(start>now)await sleep(start-now);lastRequestAt=Date.now();if(method==="eth_getLogs")lastLogsAt=lastRequestAt;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
      try{const response=await fetcher(endpoint.url,{method:"POST",headers:{"content-type":"application/json","user-agent":"gptheist/1.1 read-only"},body:JSON.stringify({jsonrpc:"2.0",id:++requestId,method,params}),signal:controller.signal});const text=await response.text();if(response.status===429||response.status===503){last=`RPC HTTP ${response.status}`;await sleep(retryDelayMs*2**attempt);continue;}if(!response.ok)throw new Error(`RPC HTTP ${response.status}`);let value:{result?:unknown;error?:{message?:string}};try{value=JSON.parse(text)}catch{throw new Error("RPC returned invalid JSON");}if(value.error)throw new Error(value.error.message??"RPC request failed");if(!("result"in value))throw new Error("RPC response is missing result");return value.result;
      }catch(error){last=error instanceof Error?error.message:last;if(attempt<4)await sleep(retryDelayMs*2**attempt);}finally{clearTimeout(timer);}}
    throw new Error(`${method} failed after bounded retries: ${last}`);
  };
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "cache-control": type.includes("html") ? "no-store" : "no-cache" });
  response.end(body);
}

export function createDeskServer(options: DeskServerOptions = {}): Server {
  const rpc=options.rpc??createHttpRpcCaller(options.rpcUrl);
  const root = resolve(options.assetsRoot ?? DEFAULT_ASSETS);
  const cacheMs=options.cacheMs??4000,failureCacheMs=options.failureCacheMs??15000;
  const socialFetch = options.socialFetch ?? fetch;
  const socialCache = new Map<string, { at: number; value: string }>();
  let cached:{at:number;value:LiveSnapshot}|null=null,cachedFailure:{at:number;message:string}|null=null,pending:Promise<LiveSnapshot>|null=null;
  const snapshot=async():Promise<LiveSnapshot>=>{if(cached&&Date.now()-cached.at<cacheMs)return cached.value;if(cachedFailure&&Date.now()-cachedFailure.at<failureCacheMs)throw new Error(cachedFailure.message);if(!pending)pending=fetchLiveSnapshot(rpc).then(value=>{cached={at:Date.now(),value};cachedFailure=null;return value;}).catch((error:unknown)=>{const message=error instanceof Error?error.message:"upstream unavailable";cachedFailure={at:Date.now(),message};throw error;}).finally(()=>{pending=null;});return pending;};
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/trace": ["room.html", "text/html; charset=utf-8"],
    "/crew": ["room.html", "text/html; charset=utf-8"],
    "/method": ["room.html", "text/html; charset=utf-8"],
    "/vault": ["room.html", "text/html; charset=utf-8"],
    "/desk.css": ["desk.css", "text/css; charset=utf-8"],
    "/desk.js": ["desk.js", "text/javascript; charset=utf-8"],
    "/rooms.js": ["rooms.js", "text/javascript; charset=utf-8"]
  };

  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const path = requestUrl.pathname;
      if(request.method==="GET"&&path==="/api/exchanges"){send(response,200,"application/json; charset=utf-8",JSON.stringify({exchanges:Object.entries(EXCHANGE_LABELS).map(([id,name])=>({id,name,scope:["spot"],status:["okx","kucoin"].includes(id)?"verify_account_eligibility":"candidate"}))}));return;}
      if(request.method==="POST"&&["/api/exchanges/connect","/api/exchanges/disconnect","/api/exchanges/order","/api/x/connect","/api/x/disconnect","/api/auto/start","/api/auto/stop"].includes(path)){
        const origin=request.headers.origin;if(origin&&origin!==`http://${request.headers.host}`){send(response,403,"application/json; charset=utf-8",JSON.stringify({error:"cross-origin blocked"}));return;}
        try{
          const body=await readBody(request);
          if(path==="/api/auto/stop"){autoStop("사용자가 자동매매를 중지했습니다. 보유 포지션은 유지됩니다.");send(response,200,"application/json; charset=utf-8",JSON.stringify({running:false,status:autoState?.status}));return;}
          if(path==="/api/auto/start"){
            const id=body.exchange,symbol=body.symbol,query=body.query,quoteAmount=Number(body.quoteAmount),dailyCap=Number(body.dailyCap),maxDrawdownPct=Number(body.maxDrawdownPct);
            if(typeof id!=="string"||!exchangeKeys.has(id)||!xBearerToken)throw new Error("X와 선택 거래소 API를 먼저 연결하세요.");
            if(typeof symbol!=="string"||typeof query!=="string"||query.length<2||query.length>100||!Number.isFinite(quoteAmount)||quoteAmount<=0||!Number.isFinite(dailyCap)||dailyCap<quoteAmount||!Number.isFinite(maxDrawdownPct)||maxDrawdownPct<1||maxDrawdownPct>95)throw new Error("현물 종목, 주문액, 일일 한도, 손실 정지값을 확인하세요.");
            const ex=await makeExchange(id,exchangeKeys.get(id)),m=ex.markets?.[symbol];if(!m||m.active===false||m.spot===false)throw new Error("선택된 현물 거래쌍을 사용할 수 없습니다.");const bal=await ex.fetchBalance() as {total?:Record<string,number|string>};const ticker=await ex.fetchTicker(symbol);const baseline=Number(bal.total?.[m.quote]??0)+Number(bal.total?.[m.base]??0)*Number(ticker.last??0);if(!Number.isFinite(baseline)||baseline<=0)throw new Error(`기준자산 ${m.quote} 잔고가 없어 목표 배수를 계산할 수 없습니다.`);
            autoStop("이전 자동매매 세션 교체");autoState={running:true,exchange:id,symbol,query,quoteAmount,dailyCap,maxDrawdownPct,targetMultiple:100000,baseline,spent:0,day:new Date().toISOString().slice(0,10),seenIds:new Set(),positionAmount:0,status:"자동 감시 시작"};autoState.timer=setInterval(()=>void autoTick(),15000);void autoTick();send(response,200,"application/json; charset=utf-8",JSON.stringify({running:true,targetMultiple:100000,baseline,status:autoState.status}));return;
          }
          if(path==="/api/x/connect"){if(typeof body.token!=="string"||body.token.length<20||body.token.length>2000)throw new Error("X API bearer token 형식을 확인하세요.");xBearerToken=body.token;const resp=await fetch("https://api.x.com/2/tweets/search/recent?query=bitcoin&max_results=10",{headers:{authorization:`Bearer ${xBearerToken}`,accept:"application/json"},signal:AbortSignal.timeout(10_000)});if(!resp.ok)throw new Error(`X API 접근 확인 실패 (${resp.status})`);send(response,200,"application/json; charset=utf-8",JSON.stringify({connected:true}));return;}
          if(path==="/api/x/disconnect"){xBearerToken="";send(response,200,"application/json; charset=utf-8",JSON.stringify({connected:false}));return;}
          if(path==="/api/exchanges/disconnect"){const id=body.exchange;if(typeof id==="string")exchangeKeys.delete(id);send(response,200,"application/json; charset=utf-8",JSON.stringify({connected:false}));return;}
          if(path==="/api/exchanges/connect"){
            const id=body.exchange,accessKey=body.accessKey,secretKey=body.secretKey;if(typeof id!=="string"||!Object.hasOwn(EXCHANGE_LABELS,id)||typeof accessKey!=="string"||accessKey.length<8||typeof secretKey!=="string"||secretKey.length<8)throw new Error("거래소/API 키 형식을 확인하세요.");
            const keys={accessKey,secretKey};const ex=await makeExchange(id,keys);const balance=await ex.fetchBalance();exchangeKeys.set(id,keys);send(response,200,"application/json; charset=utf-8",JSON.stringify({connected:true,exchange:id,balance}));return;
          }
          const id=body.exchange,symbol=body.symbol,side=body.side,amount=body.amount;if(typeof id!=="string"||!exchangeKeys.has(id))throw new Error("주문 거래소 API를 먼저 연결하세요.");if(typeof symbol!=="string"||symbol.length>40||!(side==="buy"||side==="sell")||typeof amount!=="string"||!/^\d+(\.\d{1,12})?$/.test(amount)||Number(amount)<=0)throw new Error("현물 거래쌍, 방향, 금액/수량을 확인하세요.");
          const ex=await makeExchange(id,exchangeKeys.get(id));const m=ex.markets?.[symbol];if(!m||m.active===false||m.spot===false)throw new Error("거래소의 활성 현물 거래쌍이 아닙니다.");let order:unknown;
          if(side==="buy"){if(!ex.createMarketBuyOrderWithCost||ex.has?.createMarketBuyOrderWithCost===false)throw new Error("이 거래소 어댑터는 quote 금액 시장가 매수를 지원하지 않습니다. 주문은 보내지 않았습니다.");order=await ex.createMarketBuyOrderWithCost(symbol,Number(amount));}
          else order=await ex.createOrder(symbol,"market","sell",Number(amount));
          send(response,200,"application/json; charset=utf-8",JSON.stringify({exchange:id,order}));return;
        }catch(e){send(response,422,"application/json; charset=utf-8",JSON.stringify({error:e instanceof Error?e.message.slice(0,200):"거래소 API 오류"}));return;}
      }
      if(request.method==="POST"&&path==="/api/x/search"){
        try{
          const body=await readBody(request),query=body.query;
          if(typeof query!=="string"||query.trim().length<2||query.length>120)throw new Error("검색어를 2~120자로 입력하세요.");
          const url=new URL("https://api.x.com/2/tweets/search/recent");url.searchParams.set("query",`${query} -is:retweet lang:en`);url.searchParams.set("max_results","50");url.searchParams.set("tweet.fields","created_at,public_metrics,entities,author_id,conversation_id");url.searchParams.set("expansions","author_id,attachments.media_keys");url.searchParams.set("user.fields","name,username,verified,public_metrics,created_at");
          if(!xBearerToken)throw new Error("X API bearer token을 먼저 연결하세요.");
          const upstream=await fetch(url,{headers:{accept:"application/json",authorization:`Bearer ${xBearerToken}`},signal:AbortSignal.timeout(12_000)});
          const raw=await upstream.json() as Record<string,unknown>;
          if(upstream.status===401||upstream.status===403)throw new Error("X API 인증/권한이 필요합니다. X_BEARER_TOKEN 환경변수를 설정하세요.");
          if(!upstream.ok)throw new Error(`X API HTTP ${upstream.status}`);
          const tweets=Array.isArray(raw.data)?raw.data:[];const users=Array.isArray((raw.includes as Record<string,unknown>|undefined)?.users)?(raw.includes as {users:Array<Record<string,unknown>>}).users:[];const userMap=new Map(users.map((u)=>[String(u.id),u]));
          const items=tweets.map((item)=>{const t=item as Record<string,unknown>,entities=t.entities as Record<string,unknown>|undefined,urls=Array.isArray(entities?.urls)?entities.urls as Array<Record<string,unknown>>:[],tags=Array.isArray(entities?.hashtags)?entities.hashtags as Array<Record<string,unknown>>:[],author=userMap.get(String(t.author_id));return {id:t.id,text:typeof t.text==="string"?t.text.slice(0,1600):"",createdAt:t.created_at,author:author?{username:author.username,name:author.name,verified:author.verified,followers:(author.public_metrics as Record<string,unknown>|undefined)?.followers_count}:null,metrics:t.public_metrics,urls:urls.slice(0,12).map((x)=>x.expanded_url).filter((x)=>typeof x==="string"),hashtags:tags.slice(0,20).map((x)=>x.tag).filter((x)=>typeof x==="string")};});
          send(response,200,"application/json; charset=utf-8",JSON.stringify({source:"X API v2 recent search",fetchedAt:new Date().toISOString(),items}));return;
        }catch(error){send(response,422,"application/json; charset=utf-8",JSON.stringify({error:error instanceof Error?error.message.slice(0,200):"X 검색 실패"}));return;}
      }
      if(request.method!=="GET"){
        send(response,405,"application/json; charset=utf-8",JSON.stringify({error:"method not allowed"}));return;
      }
      if(path==="/api/auto/status"){send(response,200,"application/json; charset=utf-8",JSON.stringify({running:Boolean(autoState?.running),targetMultiple:autoState?.targetMultiple??100000,status:autoState?.status??"중지",symbol:autoState?.symbol??null,spent:autoState?.spent??0,dailyCap:autoState?.dailyCap??0}));return;}
      if(path==="/api/exchanges/markets"){
        try{const id=requestUrl.searchParams.get("exchange")??"binance";const ex=await makeExchange(id);const markets=Object.values(ex.markets??{}).filter(m=>m.active!==false&&m.spot!==false&&["USDT","USDC","USD","BTC"].includes(m.quote)).map(m=>({symbol:m.symbol,base:m.base,quote:m.quote,active:m.active!==false}));send(response,200,"application/json; charset=utf-8",JSON.stringify({exchange:id,markets}));}catch(e){send(response,422,"application/json; charset=utf-8",JSON.stringify({error:e instanceof Error?e.message:"마켓 조회 실패"}));}return;
      }
      if (path === "/api/snapshot") {
        try { send(response,200,"application/json; charset=utf-8",JSON.stringify(await snapshot())); }
        catch (error) { send(response,502,"application/json; charset=utf-8",JSON.stringify({error:error instanceof Error?error.message.slice(0,200):"upstream unavailable",mode:"read-only"})); }
        return;
      }
      if (path === "/health") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ status: "ok", marketData: "public exchange APIs", execution: "exchange API keys in memory" }));
        return;
      }
      if (path === "/api/social") {
        const handle = requestUrl.searchParams.get("handle") ?? "";
        if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "invalid X handle" }));
          return;
        }
        const key = handle.toLowerCase();
        const hit = socialCache.get(key);
        if (hit && Date.now() - hit.at < 300_000) {
          send(response, 200, "application/json; charset=utf-8", hit.value);
          return;
        }
        const controller = new AbortController();
        const socialTimer = setTimeout(() => controller.abort(), 8_000);
        try {
          const upstream = await socialFetch(`https://api.fxtwitter.com/${key}`, {
            headers: { accept: "application/json", "user-agent": "gptheist/1.2 read-only" },
            signal: controller.signal
          });
          if (!upstream.ok) throw new Error(`profile HTTP ${upstream.status}`);
          const payload = await upstream.json() as { user?: Record<string, unknown> };
          const user = payload.user;
          if (!user || typeof user.screen_name !== "string" || typeof user.name !== "string" ||
              typeof user.followers !== "number" || typeof user.joined !== "string" || typeof user.protected !== "boolean") {
            throw new Error("invalid public profile response");
          }
          const value = JSON.stringify({
            status: "PUBLIC_PROFILE",
            handle: user.screen_name.slice(0, 15),
            name: user.name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80),
            followers: Math.max(0, Math.floor(user.followers)),
            joined: user.joined.slice(0, 80),
            protected: user.protected,
            verified: Boolean((user.verification as { verified?: unknown } | undefined)?.verified),
            source: "FxTwitter public profile mirror"
          });
          socialCache.set(key, { at: Date.now(), value });
          send(response, 200, "application/json; charset=utf-8", value);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message.slice(0, 120) : "profile unavailable";
          send(response, 502, "application/json; charset=utf-8", JSON.stringify({ status: "UNAVAILABLE", error: message }));
        } finally {
          clearTimeout(socialTimer);
        }
        return;
      }
      const asset = assets[path];
      if (!asset) {
        send(response, 404, "text/plain; charset=utf-8", "Not found\n");
        return;
      }
      send(response, 200, asset[1], await readFile(resolve(root, asset[0]), "utf8"));
      return;
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "Internal error\n");
    }
  });
}

export async function startDeskServer(options: DeskServerOptions & { host?: string; port?: number } = {}): Promise<Server> {
  const server = createDeskServer(options);
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 4173;
  server.listen(port, host);
  await new Promise<void>((resolveReady, reject) => {
    server.once("listening", resolveReady);
    server.once("error", reject);
  });
  return server;
}
