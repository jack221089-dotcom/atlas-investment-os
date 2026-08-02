const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json; charset=utf-8",
};

const symbols = {
  sp500: "spy.us",
  world: "iwda.uk",
  nasdaq: "qqq.us",
  berkshire: "brk-b.us",
};

async function readStooq(symbol: string) {
  const response = await fetch(
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`,
    { headers: { "User-Agent": "ATLAS-Investment-OS/3.0" } },
  );

  if (!response.ok) throw new Error(`${symbol}: ${response.status}`);

  const text = await response.text();
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [date, , , , close] = line.split(",");
      return { date, close: Number(close) };
    })
    .filter((row) => row.date && Number.isFinite(row.close) && row.close > 0);

  if (!rows.length) return [];

  const first = rows[0].close;
  return rows.map((row) => ({
    date: row.date,
    value: Math.round((row.close / first) * 10000) / 100,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const entries = await Promise.all(
    Object.entries(symbols).map(async ([key, symbol]) => {
      try {
        return [key, await readStooq(symbol)];
      } catch (error) {
        console.error(key, error);
        return [key, []];
      }
    }),
  );

  return new Response(
    JSON.stringify({
      generated_at: new Date().toISOString(),
      series: Object.fromEntries(entries),
    }),
    { headers: corsHeaders },
  );
});