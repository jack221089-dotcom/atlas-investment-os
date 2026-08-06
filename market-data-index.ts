const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json; charset=utf-8",
};

type AnyRecord = Record<string, any>;

const SYMBOL_ALIASES: Record<string, { yahoo: string; stooq?: string }> = {
  SXR8: { yahoo: "SXR8.DE", stooq: "sxr8.de" },
  QDVE: { yahoo: "QDVE.DE", stooq: "qdve.de" },
  EUNL: { yahoo: "EUNL.DE", stooq: "eunl.de" },
  SGLN: { yahoo: "SGLN.L", stooq: "sgln.uk" },
  JOBY: { yahoo: "JOBY", stooq: "joby.us" },
};

const POSITIVE_WORDS = [
  "beat","growth","profit","profitable","contract","approval","bullish","buy",
  "breakthrough","revenue","partnership","upgrade","strong","surge","expansion","record"
];

const NEGATIVE_WORDS = [
  "loss","debt","dilution","offering","bankruptcy","lawsuit","bearish","sell",
  "downgrade","fraud","risk","delay","weak","decline","miss","investigation"
];

function timeoutSignal(ms:number){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),ms);
  return{signal:controller.signal,clear:()=>clearTimeout(timer)};
}

async function fetchResponse(url:string,options:RequestInit={},ms=15000){
  const timeout=timeoutSignal(ms);
  try{
    return await fetch(url,{
      ...options,
      signal:timeout.signal,
      headers:{
        "Accept":"application/json,text/plain,*/*",
        "User-Agent":Deno.env.get("SEC_USER_AGENT")||
          "ATLAS-Investment-OS/3.0 contact@example.com",
        ...(options.headers||{})
      }
    });
  }finally{timeout.clear()}
}

async function fetchJson(url:string,options:RequestInit={},ms=15000){
  const response=await fetchResponse(url,options,ms);
  if(!response.ok)throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return await response.json();
}

function isoDate(date:Date){return date.toISOString().slice(0,10)}
function addDays(date:Date,days:number){const r=new Date(date);r.setUTCDate(r.getUTCDate()+days);return r}
function numberOrNull(value:unknown){
  if(value===null||value===undefined||value==="")return null;
  const cleaned=typeof value==="string"?value.replace(/[,$€£%\s]/g,""):value;
  const n=Number(cleaned);return Number.isFinite(n)?n:null;
}
function normalizeCurrency(raw:unknown){
  const c=String(raw??"").trim();
  if(/^(GBp|GBX)$/i.test(c))return"GBp";
  return c.toUpperCase();
}
function normalizeGroup(industryRaw:unknown){
  const i=String(industryRaw??"").toLowerCase();
  if(/software|semiconductor|technology|electronic|computer|internet|artificial intelligence|\bai\b/.test(i))return"Tecnologia";
  if(/biotech|pharma|health|medical|diagnostic/.test(i))return"Saúde e Biotecnologia";
  if(/energy|oil|gas|solar|renewable|uranium|battery/.test(i))return"Energia";
  if(/aerospace|aviation|automotive|transport|mobility/.test(i))return"Mobilidade e Aeroespacial";
  if(/bank|financial|fintech|insurance|capital market/.test(i))return"Financeiro e Fintech";
  if(/defense|security|industrial|machinery|robot/.test(i))return"Indústria e Defesa";
  if(/consumer|retail|food|beverage|apparel/.test(i))return"Consumo";
  if(/real estate|reit/.test(i))return"Imobiliário";
  if(/crypto|blockchain/.test(i))return"Cripto e Blockchain";
  return"Outros";
}
function normalizeMarket(exchangeRaw:unknown,countryRaw:unknown){
  const value=`${exchangeRaw??""} ${countryRaw??""}`.toUpperCase();
  if(/NASDAQ|NYSE|AMEX|UNITED STATES|\bUS\b/.test(value))return"EUA";
  if(/LONDON|LSE|XETRA|FRANKFURT|EURONEXT|EUROPE|GERMANY|FRANCE|\bUK\b/.test(value))return"Europa";
  return"Global";
}

async function getEcbRates(){
  const rates:Record<string,number>={EUR:1};
  try{
    const response=await fetchResponse("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",{},10000);
    if(!response.ok)throw new Error(`ECB ${response.status}`);
    const xml=await response.text();
    const regex=/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g;
    let match:RegExpExecArray|null;
    while((match=regex.exec(xml)))rates[match[1]]=Number(match[2]);
  }catch(error){console.error("ECB rates:",error)}
  return rates;
}
function toEuro(price:number,currencyRaw:unknown,rates:Record<string,number>){
  const currency=normalizeCurrency(currencyRaw);
  if(currency==="EUR")return price;
  if(currency==="GBp")return rates.GBP?(price/100)/rates.GBP:null;
  return rates[currency]?price/rates[currency]:null;
}

async function yahooChart(symbol:string){
  const json=await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`
  );
  const result=json?.chart?.result?.[0];
  if(!result)throw new Error(json?.chart?.error?.description||`Yahoo sem dados: ${symbol}`);
  return result;
}

async function yahooQuote(requestedSymbol:string,yahooSymbol:string,rates:Record<string,number>){
  const result=await yahooChart(yahooSymbol);
  const meta=result.meta??{};
  const closes=result?.indicators?.quote?.[0]?.close??[];
  const lastClose=[...closes].reverse().find((v:unknown)=>Number.isFinite(Number(v)));
  const price=Number(meta.regularMarketPrice??meta.previousClose??lastClose);
  if(!(Number.isFinite(price)&&price>0))throw new Error(`Yahoo ${yahooSymbol}: preço inválido`);
  const currency=normalizeCurrency(meta.currency);
  const priceEur=toEuro(price,currency,rates);
  if(!(Number.isFinite(priceEur)&&Number(priceEur)>0))throw new Error(`Conversão ${currency}/EUR indisponível`);
  return{
    requested_symbol:requestedSymbol,provider_symbol:yahooSymbol,price,currency,
    price_eur:Number(priceEur),provider:"Yahoo Finance",
    updated_at:meta.regularMarketTime?new Date(Number(meta.regularMarketTime)*1000).toISOString():new Date().toISOString(),
    delayed:true
  };
}

async function stooqQuote(requestedSymbol:string,stooqSymbol:string,rates:Record<string,number>){
  const response=await fetchResponse(
    `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&h&e=csv`
  );
  if(!response.ok)throw new Error(`Stooq ${stooqSymbol}: ${response.status}`);
  const lines=(await response.text()).trim().split(/\r?\n/);
  if(lines.length<2)throw new Error(`Stooq ${stooqSymbol}: sem dados`);
  const headers=lines[0].split(","),values=lines[1].split(",");
  const row=Object.fromEntries(headers.map((h,i)=>[h.trim(),values[i]?.trim()]));
  const price=Number(row.Close);
  if(!(Number.isFinite(price)&&price>0))throw new Error(`Stooq ${stooqSymbol}: preço inválido`);
  let currency="EUR";
  if(stooqSymbol.endsWith(".us"))currency="USD";
  if(stooqSymbol.endsWith(".uk"))currency="GBp";
  const priceEur=toEuro(price,currency,rates);
  if(!(Number.isFinite(priceEur)&&Number(priceEur)>0))throw new Error(`Stooq ${stooqSymbol}: conversão indisponível`);
  return{
    requested_symbol:requestedSymbol,provider_symbol:stooqSymbol,price,currency,
    price_eur:Number(priceEur),provider:"Stooq",updated_at:new Date().toISOString(),delayed:true
  };
}

function defaultAliases(symbol:string){
  return{yahoo:symbol,stooq:/^[A-Z]+$/.test(symbol)?`${symbol.toLowerCase()}.us`:undefined};
}
async function bestQuote(requestedSymbol:string,rates:Record<string,number>){
  const symbol=requestedSymbol.trim().toUpperCase();
  const aliases=SYMBOL_ALIASES[symbol]??defaultAliases(symbol);
  const errors:string[]=[];
  try{return{quote:await yahooQuote(symbol,aliases.yahoo,rates),errors}}
  catch(error){errors.push(error instanceof Error?error.message:String(error))}
  if(aliases.stooq){
    try{return{quote:await stooqQuote(symbol,aliases.stooq,rates),errors}}
    catch(error){errors.push(error instanceof Error?error.message:String(error))}
  }
  return{quote:null,errors};
}

async function handleQuotes(body:AnyRecord){
  const symbols=Array.isArray(body?.symbols)?
    [...new Set(body.symbols.map((v:unknown)=>String(v??"").trim().toUpperCase()).filter(Boolean))]:[];
  if(!symbols.length)return{quotes:{},diagnostics:{},message:"Nenhum símbolo recebido."};
  const rates=await getEcbRates();
  const entries=await Promise.all(symbols.map(async symbol=>[symbol,await bestQuote(symbol,rates)] as const));
  const quotes:Record<string,any>={},diagnostics:Record<string,any>={};
  for(const[symbol,result]of entries){
    if(result.quote)quotes[symbol]=result.quote;
    diagnostics[symbol]={
      status:result.quote?"ok":"failed",
      provider:result.quote?.provider??null,
      provider_symbol:result.quote?.provider_symbol??null,
      native_price:result.quote?.price??null,
      native_currency:result.quote?.currency??null,
      price_eur:result.quote?.price_eur??null,
      updated_at:result.quote?.updated_at??null,
      errors:result.errors
    };
  }
  return{
    generated_at:new Date().toISOString(),quotes,diagnostics,
    exchange_rates:{source:"ECB",EUR:1,USD:rates.USD??null,GBP:rates.GBP??null}
  };
}

async function getNasdaqIpos(from:string,to:string){
  const endpoints=[
    `https://api.nasdaq.com/api/ipo/calendar?date=${from}`,
    `https://api.nasdaq.com/api/ipo/calendar?date=${to}`
  ];
  const collected:AnyRecord[]=[],errors:string[]=[];
  for(const url of endpoints){
    try{
      const json=await fetchJson(url,{headers:{
        "Accept":"application/json, text/plain, */*",
        "Accept-Language":"en-US,en;q=0.9",
        "Origin":"https://www.nasdaq.com",
        "Referer":"https://www.nasdaq.com/"
      }},12000);
      const data=json?.data??{};
      for(const rows of [data?.priced?.rows,data?.upcoming?.rows,data?.withdrawn?.rows]){
        if(Array.isArray(rows))collected.push(...rows);
      }
    }catch(error){errors.push(error instanceof Error?error.message:String(error))}
  }
  const unique=new Map<string,AnyRecord>();
  for(const item of collected){
    const symbol=String(item?.symbol??item?.proposedTickerSymbol??"").trim().toUpperCase();
    if(!symbol)continue;
    const date=String(item?.pricedDate??item?.expectedPriceDate??item?.date??"").slice(0,10);
    unique.set(symbol,{
      symbol,name:item?.companyName??item?.company??item?.name??symbol,
      ipo_date:date||null,exchange:item?.exchange??"NASDAQ/NYSE",
      offer_price:numberOrNull(item?.proposedSharePrice)??numberOrNull(item?.price),
      status:item?.status??(item?.pricedDate?"IPO realizado":"IPO previsto"),
      source:"Nasdaq IPO Calendar"
    });
  }
  return{items:[...unique.values()],errors};
}

async function yahooSummary(symbol:string){
  const modules=["price","summaryProfile","defaultKeyStatistics","financialData","assetProfile"].join(",");
  const urls=[
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`
  ];
  const errors:string[]=[];
  for(const url of urls){
    try{
      const json=await fetchJson(url);
      const result=json?.quoteSummary?.result?.[0];
      if(result)return{result,errors};
      errors.push(json?.quoteSummary?.error?.description||"Yahoo sem resumo");
    }catch(error){errors.push(error instanceof Error?error.message:String(error))}
  }
  return{result:{},errors};
}
function rawValue(value:any){return numberOrNull(value?.raw??value)}

let secTickerCache:{loaded_at:number;map:Record<string,AnyRecord>}|null=null;
async function getSecTickerMap(){
  const maxAge=6*60*60*1000;
  if(secTickerCache&&Date.now()-secTickerCache.loaded_at<maxAge)return secTickerCache.map;
  const json=await fetchJson("https://www.sec.gov/files/company_tickers.json",{},15000);
  const map:Record<string,AnyRecord>={};
  for(const value of Object.values(json||{}) as AnyRecord[]){
    const ticker=String(value?.ticker??"").toUpperCase();
    if(ticker)map[ticker]={cik:String(value?.cik_str??"").padStart(10,"0"),title:value?.title??null};
  }
  secTickerCache={loaded_at:Date.now(),map};
  return map;
}
async function getSecProfile(symbol:string){
  const sources:string[]=[],errors:string[]=[];
  try{
    const company=(await getSecTickerMap())[symbol];
    if(!company?.cik)return{official:null,sources,errors:["Ticker não encontrado no mapa SEC."]};
    const submissions=await fetchJson(`https://data.sec.gov/submissions/CIK${company.cik}.json`,{},15000);
    sources.push("SEC EDGAR");
    const recent=submissions?.filings?.recent??{};
    const forms=Array.isArray(recent?.form)?recent.form:[];
    const dates=Array.isArray(recent?.filingDate)?recent.filingDate:[];
    const accessions=Array.isArray(recent?.accessionNumber)?recent.accessionNumber:[];
    const primaryDocs=Array.isArray(recent?.primaryDocument)?recent.primaryDocument:[];
    const important=new Set(["10-K","10-Q","8-K","S-1","S-1/A","20-F","6-K"]);
    const filings=forms.map((form:string,index:number)=>({
      form,filing_date:dates[index]??null,accession:accessions[index]??null,document:primaryDocs[index]??null
    })).filter((f:AnyRecord)=>important.has(f.form)).slice(0,8);
    return{official:{
      cik:company.cik,legal_name:submissions?.name??company.title??null,
      sic_description:submissions?.sicDescription??null,
      state:submissions?.stateOfIncorporation??null,
      fiscal_year_end:submissions?.fiscalYearEnd??null,filings
    },sources,errors};
  }catch(error){errors.push(error instanceof Error?error.message:String(error));return{official:null,sources,errors}}
}

async function redditToken(){
  const clientId=Deno.env.get("REDDIT_CLIENT_ID");
  const clientSecret=Deno.env.get("REDDIT_CLIENT_SECRET");
  if(!clientId||!clientSecret)return null;
  const response=await fetchResponse("https://www.reddit.com/api/v1/access_token",{
    method:"POST",
    headers:{
      "Authorization":`Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type":"application/x-www-form-urlencoded",
      "User-Agent":Deno.env.get("REDDIT_USER_AGENT")||"ATLAS-Investment-OS/3.0 by atlas-beta"
    },
    body:"grant_type=client_credentials"
  },12000);
  if(!response.ok)throw new Error(`Reddit OAuth ${response.status}`);
  const json=await response.json();
  return String(json?.access_token??"")||null;
}

function socialSentiment(posts:AnyRecord[]){
  let positive=0,negative=0;
  const themeCounts=new Map<string,number>();
  const themes:Record<string,string[]>={
    "Resultados":["earnings","revenue","profit","quarter"],
    "Crescimento":["growth","expansion","market share"],
    "Contratos":["contract","partnership","deal"],
    "Avaliação":["valuation","overvalued","undervalued","price target"],
    "Diluição":["dilution","offering","shares"],
    "Dívida":["debt","cash burn","bankruptcy"],
    "Tecnologia":["ai","technology","product","patent"],
    "Hype":["moon","squeeze","yolo","pump"]
  };
  for(const post of posts){
    const text=`${post?.title??""} ${post?.selftext??""}`.toLowerCase();
    for(const word of POSITIVE_WORDS)if(text.includes(word))positive++;
    for(const word of NEGATIVE_WORDS)if(text.includes(word))negative++;
    for(const[theme,words]of Object.entries(themes)){
      if(words.some(word=>text.includes(word)))themeCounts.set(theme,(themeCounts.get(theme)??0)+1);
    }
  }
  const score=positive-negative;
  return{
    score,sentiment_label:score>=3?"Positivo":score<=-3?"Negativo":"Neutro",
    positive_signals:positive,negative_signals:negative,
    themes:[...themeCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([theme])=>theme)
  };
}

async function getRedditSentiment(symbol:string,companyName:string,token:string|null){
  if(!token)return{
    available:false,mentions:0,sentiment_label:"Indisponível",themes:[],source:null,
    reason:"REDDIT_CLIENT_ID e REDDIT_CLIENT_SECRET não configurados."
  };
  try{
    const query=[`$${symbol}`,symbol,`"${companyName}"`].join(" OR ");
    const url=`https://oauth.reddit.com/search?${new URLSearchParams({
      q:query,sort:"new",t:"month",limit:"50",type:"link",restrict_sr:"false"
    }).toString()}`;
    const json=await fetchJson(url,{headers:{
      "Authorization":`Bearer ${token}`,
      "User-Agent":Deno.env.get("REDDIT_USER_AGENT")||"ATLAS-Investment-OS/3.0 by atlas-beta"
    }},12000);
    const posts=Array.isArray(json?.data?.children)?json.data.children.map((c:AnyRecord)=>c?.data||{}):[];
    return{
      available:true,mentions:posts.length,...socialSentiment(posts),
      subreddits:[...new Set(posts.map((p:AnyRecord)=>p?.subreddit_name_prefixed).filter(Boolean))].slice(0,8),
      source:"Reddit API"
    };
  }catch(error){
    return{available:false,mentions:0,sentiment_label:"Indisponível",themes:[],source:null,
      reason:error instanceof Error?error.message:String(error)};
  }
}

function assessRisk(marketCap:number|null,price:number|null,debtToEquity:number|null,reddit:AnyRecord,hasOfficial:boolean){
  let score=0;
  if(marketCap===null||marketCap<300_000_000)score+=3;
  else if(marketCap<1_000_000_000)score+=2;
  else if(marketCap<5_000_000_000)score+=1;
  if(price===null||price<5)score+=2;else if(price<15)score+=1;
  if(debtToEquity!==null&&debtToEquity>150)score+=2;else if(debtToEquity!==null&&debtToEquity>80)score+=1;
  if(!hasOfficial)score+=1;
  if(reddit?.mentions>=20&&reddit?.themes?.includes("Hype"))score+=2;
  return score>=7?"Especulativo":score>=5?"Elevado":score>=3?"Médio":"Baixo";
}

function buildPositiveFactors(yahoo:AnyRecord,official:AnyRecord){
  const values:string[]=[];
  const financial=yahoo?.financialData??{},statistics=yahoo?.defaultKeyStatistics??{};
  const revenueGrowth=rawValue(financial?.revenueGrowth);
  const earningsGrowth=rawValue(financial?.earningsGrowth);
  const currentRatio=rawValue(financial?.currentRatio);
  const cash=rawValue(financial?.totalCash),debt=rawValue(financial?.totalDebt);
  if(revenueGrowth!==null&&revenueGrowth>0.1)values.push("Crescimento de receitas superior a 10% nos dados disponíveis.");
  if(earningsGrowth!==null&&earningsGrowth>0.1)values.push("Crescimento de resultados superior a 10% nos dados disponíveis.");
  if(currentRatio!==null&&currentRatio>=1.5)values.push("Liquidez corrente confortável nos dados disponíveis.");
  if(cash!==null&&debt!==null&&cash>debt)values.push("Caixa reportado superior à dívida total.");
  if(official?.filings?.length)values.push("Existem documentos oficiais recentes na SEC EDGAR.");
  const held=rawValue(statistics?.heldPercentInstitutions);
  if(held!==null&&held>0.2)values.push("Participação institucional relevante nos dados disponíveis.");
  if(!values.length)values.push("Empresa recente; são necessários mais resultados para avaliar a tendência.");
  return values.slice(0,4);
}
function buildRiskFactors(yahoo:AnyRecord,official:AnyRecord,reddit:AnyRecord){
  const values:string[]=[];
  const financial=yahoo?.financialData??{},statistics=yahoo?.defaultKeyStatistics??{},price=yahoo?.price??{};
  const marketCap=rawValue(price?.marketCap),debtToEquity=rawValue(financial?.debtToEquity);
  const profitMargins=rawValue(financial?.profitMargins),sharesShort=rawValue(statistics?.shortPercentOfFloat);
  if(marketCap===null||marketCap<1_000_000_000)values.push("Capitalização pequena, com maior risco de volatilidade e liquidez.");
  if(debtToEquity!==null&&debtToEquity>100)values.push("Relação dívida/capital próprio elevada.");
  if(profitMargins!==null&&profitMargins<0)values.push("Margem de lucro negativa nos dados disponíveis.");
  if(sharesShort!==null&&sharesShort>0.1)values.push("Percentagem relevante de posições curtas.");
  if(!official)values.push("Não foram encontrados documentos SEC para este ticker.");
  if(reddit?.mentions>=20&&reddit?.themes?.includes("Hype"))values.push("Aumento de atenção social associado a linguagem especulativa.");
  if(!values.length)values.push("Histórico curto; os riscos podem ainda não estar totalmente refletidos.");
  return values.slice(0,4);
}

async function enrichOpportunity(candidate:AnyRecord,redditAccessToken:string|null,includeReddit:boolean){
  const symbol=String(candidate?.symbol??"").toUpperCase();
  const[chartResult,summaryResult,secResult]=await Promise.allSettled([
    yahooChart(symbol),yahooSummary(symbol),getSecProfile(symbol)
  ]);
  const chart=chartResult.status==="fulfilled"?chartResult.value:null;
  const summaryEnvelope=summaryResult.status==="fulfilled"?summaryResult.value:{result:{},errors:["Yahoo summary failed"]};
  const yahoo=summaryEnvelope.result??{};
  const sec=secResult.status==="fulfilled"?secResult.value:{official:null,sources:[],errors:["SEC failed"]};
  const meta=chart?.meta??{};
  const companyName=yahoo?.price?.longName??yahoo?.price?.shortName??sec?.official?.legal_name??candidate?.name??symbol;
  const reddit=includeReddit?await getRedditSentiment(symbol,companyName,redditAccessToken):
    {available:false,mentions:0,sentiment_label:"Não solicitado",themes:[],source:null};
  const currentPrice=numberOrNull(meta?.regularMarketPrice)??rawValue(yahoo?.price?.regularMarketPrice);
  const currency=normalizeCurrency(meta?.currency??yahoo?.price?.currency??"USD");
  const marketCap=rawValue(yahoo?.price?.marketCap);
  const financial=yahoo?.financialData??{};
  const targetLow=rawValue(financial?.targetLowPrice),targetMean=rawValue(financial?.targetMeanPrice),targetHigh=rawValue(financial?.targetHighPrice);
  const potential=currentPrice!==null&&currentPrice>0&&targetMean!==null&&targetMean>0?((targetMean-currentPrice)/currentPrice)*100:null;
  const profile=yahoo?.summaryProfile??yahoo?.assetProfile??{};
  const industry=profile?.industry??sec?.official?.sic_description??"Setor não indicado";
  const exchange=meta?.exchangeName??yahoo?.price?.exchangeName??candidate?.exchange??null;
  const country=profile?.country??null;
  const debtToEquity=rawValue(financial?.debtToEquity);
  const risk=assessRisk(marketCap,currentPrice,debtToEquity,reddit,Boolean(sec?.official));
  const sources=["Nasdaq IPO Calendar",chart?"Yahoo Finance":null,sec?.official?"SEC EDGAR":null,reddit?.available?"Reddit API":null].filter(Boolean);
  return{
    symbol,name:companyName,logo:null,exchange,country,currency,
    market:normalizeMarket(exchange,country),industry,group:normalizeGroup(industry),
    ipo_date:candidate?.ipo_date??sec?.official?.filings?.find((f:AnyRecord)=>f.form==="S-1"||f.form==="S-1/A")?.filing_date??null,
    status:candidate?.status??"IPO / recém-cotada",offer_price:candidate?.offer_price??null,
    price:currentPrice,market_cap_million:marketCap!==null?marketCap/1_000_000:null,
    target_low:targetLow,target_mean:targetMean,target_high:targetHigh,
    analyst_count:rawValue(financial?.numberOfAnalystOpinions)??0,potential_percent:potential,
    risk,positive_factors:buildPositiveFactors(yahoo,sec?.official),
    risk_factors:buildRiskFactors(yahoo,sec?.official,reddit),
    official:sec?.official,social:reddit,sources,
    source_errors:[
      ...(summaryEnvelope.errors??[]),...(sec?.errors??[]),
      ...(chartResult.status==="rejected"?[String(chartResult.reason)]:[])
    ].slice(0,8)
  };
}

async function mapWithConcurrency<T,R>(items:T[],concurrency:number,worker:(item:T,index:number)=>Promise<R>){
  const results=new Array<R>(items.length);let nextIndex=0;
  async function runner(){
    while(true){const index=nextIndex++;if(index>=items.length)return;results[index]=await worker(items[index],index)}
  }
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},()=>runner()));
  return results;
}

async function handleOpportunities(body:AnyRecord){
  const daysBack=Math.min(Math.max(Number(body?.days_back??180),30),365);
  const daysForward=Math.min(Math.max(Number(body?.days_forward??45),0),180);
  const limit=Math.min(Math.max(Number(body?.limit??20),5),30);
  const includeReddit=body?.include_reddit!==false;
  const today=new Date(),from=isoDate(addDays(today,-daysBack)),to=isoDate(addDays(today,daysForward));
  const nasdaq=await getNasdaqIpos(from,to);
  const candidates=nasdaq.items.filter((item:AnyRecord)=>item?.symbol).slice(0,limit);
  let redditAccessToken:string|null=null;const redditErrors:string[]=[];
  if(includeReddit){
    try{redditAccessToken=await redditToken()}
    catch(error){redditErrors.push(error instanceof Error?error.message:String(error))}
  }
  const items=(await mapWithConcurrency(candidates,3,async candidate=>
    await enrichOpportunity(candidate,redditAccessToken,includeReddit)
  )).filter(Boolean).sort((a:AnyRecord,b:AnyRecord)=>String(b?.ipo_date??"").localeCompare(String(a?.ipo_date??"")));
  const withTargets=items.filter((item:AnyRecord)=>Number.isFinite(Number(item?.potential_percent))).length;
  return{
    generated_at:new Date().toISOString(),
    source:"Nasdaq public calendar + Yahoo Finance + SEC EDGAR"+(redditAccessToken?" + Reddit API":""),
    coverage:items.length&&withTargets===items.length?"full":"partial",
    period:{from,to},count:items.length,with_analyst_targets:withTargets,items,
    diagnostics:{
      nasdaq_errors:nasdaq.errors,reddit_errors:redditErrors,
      reddit_configured:Boolean(redditAccessToken),
      sec_user_agent_configured:Boolean(Deno.env.get("SEC_USER_AGENT"))
    },
    disclaimer:"Os dados sociais são opinião da comunidade. Preços-alvo, quando disponíveis, não constituem garantia de retorno nem recomendação de investimento."
  };
}


const RADAR_UNIVERSE=[
 {symbol:"RKLB",name:"Rocket Lab USA",group:"Espaço",industry:"Aeroespacial",market:"EUA"},
 {symbol:"JOBY",name:"Joby Aviation",group:"Mobilidade Aérea",industry:"eVTOL",market:"EUA"},
 {symbol:"ACHR",name:"Archer Aviation",group:"Mobilidade Aérea",industry:"eVTOL",market:"EUA"},
 {symbol:"PLTR",name:"Palantir Technologies",group:"Inteligência Artificial",industry:"Software e dados",market:"EUA"},
 {symbol:"SOUN",name:"SoundHound AI",group:"Inteligência Artificial",industry:"IA de voz",market:"EUA"},
 {symbol:"BBAI",name:"BigBear.ai",group:"Inteligência Artificial",industry:"IA e defesa",market:"EUA"},
 {symbol:"IONQ",name:"IonQ",group:"Computação Quântica",industry:"Computação quântica",market:"EUA"},
 {symbol:"RGTI",name:"Rigetti Computing",group:"Computação Quântica",industry:"Computação quântica",market:"EUA"},
 {symbol:"QBTS",name:"D-Wave Quantum",group:"Computação Quântica",industry:"Computação quântica",market:"EUA"},
 {symbol:"RXRX",name:"Recursion Pharmaceuticals",group:"Saúde e Biotecnologia",industry:"IA aplicada à saúde",market:"EUA"},
 {symbol:"CRSP",name:"CRISPR Therapeutics",group:"Saúde e Biotecnologia",industry:"Edição genética",market:"EUA"},
 {symbol:"NTLA",name:"Intellia Therapeutics",group:"Saúde e Biotecnologia",industry:"Edição genética",market:"EUA"},
 {symbol:"SMR",name:"NuScale Power",group:"Energia Nuclear",industry:"Reatores modulares",market:"EUA"},
 {symbol:"OKLO",name:"Oklo",group:"Energia Nuclear",industry:"Energia nuclear avançada",market:"EUA"},
 {symbol:"UUUU",name:"Energy Fuels",group:"Urânio",industry:"Urânio e minerais críticos",market:"EUA"},
 {symbol:"LEU",name:"Centrus Energy",group:"Urânio",industry:"Combustível nuclear",market:"EUA"},
 {symbol:"ASTS",name:"AST SpaceMobile",group:"Espaço",industry:"Telecomunicações por satélite",market:"EUA"},
 {symbol:"RDW",name:"Redwire",group:"Espaço",industry:"Infraestrutura espacial",market:"EUA"},
 {symbol:"LUNR",name:"Intuitive Machines",group:"Espaço",industry:"Exploração lunar",market:"EUA"},
 {symbol:"AVAV",name:"AeroVironment",group:"Defesa",industry:"Drones e defesa",market:"EUA"},
 {symbol:"KTOS",name:"Kratos Defense",group:"Defesa",industry:"Sistemas de defesa",market:"EUA"},
 {symbol:"SYM",name:"Symbotic",group:"Robótica",industry:"Automação logística",market:"EUA"},
 {symbol:"PATH",name:"UiPath",group:"Robótica",industry:"Automação de software",market:"EUA"},
 {symbol:"HIMS",name:"Hims & Hers Health",group:"Saúde Digital",industry:"Telemedicina",market:"EUA"},
 {symbol:"SOFI",name:"SoFi Technologies",group:"FinTech",industry:"Serviços financeiros digitais",market:"EUA"},
 {symbol:"NU",name:"Nu Holdings",group:"FinTech",industry:"Banco digital",market:"EUA"},
 {symbol:"HOOD",name:"Robinhood Markets",group:"FinTech",industry:"Corretagem digital",market:"EUA"},
 {symbol:"CRWD",name:"CrowdStrike",group:"Cibersegurança",industry:"Segurança cloud",market:"EUA"},
 {symbol:"NET",name:"Cloudflare",group:"Cloud e Cibersegurança",industry:"Infraestrutura cloud",market:"EUA"},
 {symbol:"CELH",name:"Celsius Holdings",group:"Consumo",industry:"Bebidas energéticas",market:"EUA"}
];

function radarSignals(dayChange:number|null,monthChange:number|null,volumeRatio:number|null,price:number|null){
 const signals:string[]=[];
 if(monthChange!==null&&monthChange>=15)signals.push("forte tendência positiva em 30 dias");
 else if(monthChange!==null&&monthChange>=5)signals.push("tendência positiva em 30 dias");
 else if(monthChange!==null&&monthChange<=-15)signals.push("queda acentuada em 30 dias");
 if(dayChange!==null&&Math.abs(dayChange)>=5)signals.push("movimento diário fora do normal");
 if(volumeRatio!==null&&volumeRatio>=2)signals.push("volume superior ao dobro da média");
 else if(volumeRatio!==null&&volumeRatio>=1.5)signals.push("volume acima da média");
 if(price!==null&&price<10)signals.push("preço unitário abaixo de 10 — não significa avaliação barata");
 return signals.slice(0,4);
}

function clampScore(value:number){return Math.max(0,Math.min(100,Math.round(value)))}

function average(values:number[]){
 return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
}

function standardDeviation(values:number[]){
 if(values.length<2)return null;
 const mean=average(values);
 if(mean===null)return null;
 const variance=values.reduce((sum,value)=>sum+Math.pow(value-mean,2),0)/(values.length-1);
 return Math.sqrt(variance);
}

function calculateAtlasScore(input:AnyRecord){
 const positives:string[]=[],negatives:string[]=[];
 const componentValues:Record<string,number|null>={
  market:null,growth:null,fundamentals:null,risk:null
 };

 const month=numberOrNull(input.month_change_percent);
 const day=numberOrNull(input.change_percent);
 const volumeRatio=numberOrNull(input.volume_ratio);
 const above50=numberOrNull(input.above_50d_percent);
 const volatility=numberOrNull(input.volatility_30d);
 const drawdown=numberOrNull(input.drawdown_3m);
 const avgVolume=numberOrNull(input.average_volume);
 const marketCap=numberOrNull(input.market_cap);
 const revenueGrowth=numberOrNull(input.revenue_growth);
 const earningsGrowth=numberOrNull(input.earnings_growth);
 const currentRatio=numberOrNull(input.current_ratio);
 const debtToEquity=numberOrNull(input.debt_to_equity);
 const profitMargin=numberOrNull(input.profit_margin);
 const price=numberOrNull(input.price);

 // Mercado: tendência, confirmação por volume e posição face à média.
 let market=50;
 if(month!==null){
  market+=Math.max(-25,Math.min(25,month*1.2));
  if(month>=10)positives.push("Tendência de 30 dias positiva.");
  if(month<=-10)negatives.push("Tendência de 30 dias negativa.");
 }
 if(volumeRatio!==null){
  market+=Math.max(-8,Math.min(15,(volumeRatio-1)*12));
  if(volumeRatio>=1.5)positives.push("Volume acima da média.");
 }
 if(above50!==null)market+=Math.max(-15,Math.min(15,above50*.8));
 if(day!==null&&Math.abs(day)>12){
  market-=8;negatives.push("Movimento diário extremamente volátil.");
 }
 componentValues.market=clampScore(market);

 // Crescimento: momentum médio e dados empresariais quando disponíveis.
 let growthParts:number[]=[];
 if(month!==null)growthParts.push(clampScore(50+month*1.5));
 if(revenueGrowth!==null){
  growthParts.push(clampScore(50+revenueGrowth*180));
  if(revenueGrowth>.15)positives.push("Crescimento de receitas superior a 15%.");
  if(revenueGrowth<0)negatives.push("Receitas em contração.");
 }
 if(earningsGrowth!==null){
  growthParts.push(clampScore(50+earningsGrowth*140));
  if(earningsGrowth>.15)positives.push("Crescimento de resultados positivo.");
  if(earningsGrowth<0)negatives.push("Resultados em deterioração.");
 }
 componentValues.growth=growthParts.length?clampScore(average(growthParts)!):null;

 // Fundamentais.
 let fundamentalParts:number[]=[];
 if(currentRatio!==null){
  fundamentalParts.push(clampScore(currentRatio>=2?85:currentRatio>=1.5?75:currentRatio>=1?55:30));
  if(currentRatio>=1.5)positives.push("Liquidez corrente confortável.");
  if(currentRatio<1)negatives.push("Liquidez corrente reduzida.");
 }
 if(debtToEquity!==null){
  fundamentalParts.push(clampScore(debtToEquity<=30?90:debtToEquity<=70?75:debtToEquity<=120?55:30));
  if(debtToEquity>120)negatives.push("Endividamento elevado.");
 }
 if(profitMargin!==null){
  fundamentalParts.push(clampScore(50+profitMargin*180));
  if(profitMargin>0.12)positives.push("Margem de lucro positiva.");
  if(profitMargin<0)negatives.push("Empresa ainda apresenta margem negativa.");
 }
 if(marketCap!==null){
  fundamentalParts.push(clampScore(marketCap>=10_000_000_000?80:marketCap>=2_000_000_000?70:marketCap>=500_000_000?58:42));
  if(marketCap<500_000_000)negatives.push("Capitalização reduzida aumenta o risco.");
 }
 componentValues.fundamentals=fundamentalParts.length?clampScore(average(fundamentalParts)!):null;

 // Risco: pontuação alta = risco mais controlado.
 let risk=75;
 if(volatility!==null){
  risk-=Math.max(0,(volatility-2)*5);
  if(volatility>5)negatives.push("Volatilidade diária elevada.");
 }
 if(drawdown!==null){
  risk-=Math.max(0,Math.abs(Math.min(0,drawdown))*.9);
  if(drawdown<-20)negatives.push("Queda relevante face ao máximo de três meses.");
 }
 if(price!==null&&price<5){
  risk-=12;negatives.push("Preço unitário abaixo de 5; perfil especulativo.");
 }
 if(avgVolume!==null){
  if(avgVolume>=1_000_000)risk+=8;
  else if(avgVolume<100_000){risk-=15;negatives.push("Liquidez de negociação reduzida.");}
 }
 if(marketCap!==null&&marketCap<300_000_000)risk-=12;
 componentValues.risk=clampScore(risk);

 const weights:Record<string,number>={market:.30,growth:.25,fundamentals:.25,risk:.20};
 let weighted=0,totalWeight=0,available=0;
 for(const[key,value]of Object.entries(componentValues)){
  if(value!==null&&Number.isFinite(value)){
   weighted+=value*weights[key];
   totalWeight+=weights[key];
   available++;
  }
 }
 const score=totalWeight?clampScore(weighted/totalWeight):50;
 const dataQuality=clampScore((available/4)*100);

 if(dataQuality<75)negatives.push("Alguns dados fundamentais não estão disponíveis; score adaptado.");

 return{
  atlas_score:score,
  data_quality:dataQuality,
  score_components:componentValues,
  score_positive:[...new Set(positives)].slice(0,5),
  score_negative:[...new Set(negatives)].slice(0,5)
 };
}

async function radarMarketData(entry:AnyRecord){
 const symbol=String(entry.symbol).toUpperCase();
 try{
  const[chartEnvelope,summaryEnvelope]=await Promise.allSettled([
   fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`),
   yahooSummary(symbol)
  ]);

  if(chartEnvelope.status!=="fulfilled")throw chartEnvelope.reason;
  const result=chartEnvelope.value?.chart?.result?.[0];
  if(!result)throw new Error("Sem dados de mercado");

  const meta=result.meta??{};
  const closes=(result?.indicators?.quote?.[0]?.close??[]).map((v:unknown)=>numberOrNull(v));
  const volumes=(result?.indicators?.quote?.[0]?.volume??[]).map((v:unknown)=>numberOrNull(v));
  const validCloses=closes.filter((v:number|null)=>v!==null) as number[];
  const validVolumes=volumes.filter((v:number|null)=>v!==null) as number[];

  const price=numberOrNull(meta.regularMarketPrice)??(validCloses.length?validCloses.at(-1)!:null);
  const previous=numberOrNull(meta.previousClose)??(validCloses.length>1?validCloses.at(-2)!:null);
  const monthBase=validCloses.length>=22?validCloses[validCloses.length-22]:(validCloses.length?validCloses[0]:null);
  const dayChange=price!==null&&previous!==null&&previous>0?((price-previous)/previous)*100:null;
  const monthChange=price!==null&&monthBase!==null&&monthBase>0?((price-monthBase)/monthBase)*100:null;

  const currentVolume=validVolumes.length?validVolumes.at(-1)!:null;
  const sample=validVolumes.slice(-21,-1);
  const avgVolume=sample.length?sample.reduce((sum,v)=>sum+v,0)/sample.length:null;
  const volumeRatio=currentVolume!==null&&avgVolume&&avgVolume>0?currentVolume/avgVolume:null;

  const sma50Sample=validCloses.slice(-50);
  const sma50=sma50Sample.length?average(sma50Sample):null;
  const above50=price!==null&&sma50&&sma50>0?((price-sma50)/sma50)*100:null;
  const high3m=validCloses.length?Math.max(...validCloses):null;
  const drawdown=price!==null&&high3m&&high3m>0?((price-high3m)/high3m)*100:null;

  const returns:number[]=[];
  for(let index=Math.max(1,validCloses.length-31);index<validCloses.length;index++){
   const prior=validCloses[index-1],current=validCloses[index];
   if(prior>0)returns.push(((current-prior)/prior)*100);
  }
  const volatility=standardDeviation(returns);

  const summary=summaryEnvelope.status==="fulfilled"
   ?summaryEnvelope.value?.result??{}
   :{};
  const financial=summary?.financialData??{};
  const priceInfo=summary?.price??{};
  const profile=summary?.summaryProfile??summary?.assetProfile??{};

  const enriched={
   ...entry,
   symbol,
   name:priceInfo?.longName??priceInfo?.shortName??entry.name,
   industry:profile?.industry??entry.industry,
   price,
   currency:normalizeCurrency(meta.currency||priceInfo?.currency||"USD"),
   exchange:meta.exchangeName||meta.fullExchangeName||priceInfo?.exchangeName||"Mercado não indicado",
   change_percent:dayChange,
   month_change_percent:monthChange,
   volume_ratio:volumeRatio,
   average_volume:avgVolume,
   above_50d_percent:above50,
   volatility_30d:volatility,
   drawdown_3m:drawdown,
   market_cap:rawValue(priceInfo?.marketCap),
   revenue_growth:rawValue(financial?.revenueGrowth),
   earnings_growth:rawValue(financial?.earningsGrowth),
   current_ratio:rawValue(financial?.currentRatio),
   debt_to_equity:rawValue(financial?.debtToEquity),
   profit_margin:rawValue(financial?.profitMargins),
   signals:radarSignals(dayChange,monthChange,volumeRatio,price),
   provider:"Yahoo Finance",
   updated_at:meta.regularMarketTime?new Date(Number(meta.regularMarketTime)*1000).toISOString():new Date().toISOString()
  };

  return{...enriched,...calculateAtlasScore(enriched)};
 }catch(error){
  const fallback={...entry,symbol,price:null,currency:"USD",exchange:"Mercado não indicado",
   change_percent:null,month_change_percent:null,volume_ratio:null,signals:[],
   provider:"Yahoo Finance",updated_at:new Date().toISOString(),
   error:error instanceof Error?error.message:String(error)};
  return{...fallback,...calculateAtlasScore(fallback)};
 }
}

async function handleRadar(body:AnyRecord){
 const limit=Math.min(Math.max(Number(body?.limit??30),5),RADAR_UNIVERSE.length);
 const items=await mapWithConcurrency(RADAR_UNIVERSE.slice(0,limit),4,async entry=>await radarMarketData(entry));
 const available=items
  .filter((item:AnyRecord)=>Number.isFinite(Number(item.price)))
  .sort((a:AnyRecord,b:AnyRecord)=>Number(b.atlas_score)-Number(a.atlas_score))
  .map((item:AnyRecord,index:number)=>({...item,rank:index+1}));

 return{
  generated_at:new Date().toISOString(),
  source:"Yahoo Finance — mercado e fundamentais disponíveis",
  coverage:available.length===items.length?"full":"partial",
  count:available.length,
  items:available,
  score_method:{
   market:30,
   growth:25,
   fundamentals:25,
   risk:20,
   missing_data:"pesos redistribuídos apenas pelos componentes disponíveis"
  },
  disclaimer:"O ATLAS Score é uma classificação comparativa e não uma previsão de retorno ou recomendação."
 };
}

async function yahooSearch(query:string,limit:number){
 const json=await fetchJson(`https://query1.finance.yahoo.com/v1/finance/search?${new URLSearchParams({
  q:query,quotesCount:String(limit),newsCount:"0",enableFuzzyQuery:"true"
 }).toString()}`);
 return Array.isArray(json?.quotes)?json.quotes:[];
}
async function handleCompanySearch(body:AnyRecord){
 const query=String(body?.query??"").trim(),limit=Math.min(Math.max(Number(body?.limit??8),1),12);
 if(!query)return{generated_at:new Date().toISOString(),items:[]};
 const found=await yahooSearch(query,limit);
 const candidates=found.filter((item:AnyRecord)=>["EQUITY","ETF"].includes(String(item?.quoteType||"").toUpperCase()))
  .slice(0,limit).map((item:AnyRecord)=>({
   symbol:String(item?.symbol??"").toUpperCase(),name:item?.longname??item?.shortname??item?.symbol,
   group:item?.quoteType==="ETF"?"ETF":"Empresa pesquisada",industry:item?.industry??item?.sector??"Setor não indicado",
   market:normalizeMarket(item?.exchange,item?.exchDisp)
  })).filter((item:AnyRecord)=>item.symbol);
 const items=await mapWithConcurrency(candidates,3,async entry=>await radarMarketData(entry));
 const available=items.filter((item:AnyRecord)=>Number.isFinite(Number(item.price)))
  .sort((a:AnyRecord,b:AnyRecord)=>Number(b.atlas_score)-Number(a.atlas_score))
  .map((item:AnyRecord,index:number)=>({...item,rank:index+1}));
 return{generated_at:new Date().toISOString(),source:"Yahoo Finance Search + score comparativo",
  count:available.length,items:available};
}


Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
  try{
    const body=await req.json().catch(()=>({}));
    const action=String(body?.action??"quotes").toLowerCase();
    const result=
      action==="radar"?await handleRadar(body):
      action==="search"?await handleCompanySearch(body):
      action==="opportunities"?await handleOpportunities(body):
      await handleQuotes(body);
    return new Response(JSON.stringify(result),{headers:corsHeaders});
  }catch(error){
    console.error("market-data:",error);
    return new Response(JSON.stringify({
      error:"MARKET_DATA_ERROR",
      message:error instanceof Error?error.message:String(error)
    }),{status:500,headers:corsHeaders});
  }
});