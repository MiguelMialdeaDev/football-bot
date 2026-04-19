// ============================================================
// POLYMARKET DUTCH BOOK SCANNER v2
// Solo detecta VERDADERO arbitraje lógico:
// - Mercados mutuamente excluyentes (solo 1 puede ganar)
// - Excluye: fechas anidadas, props independientes, over/under
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================
const SCAN_INTERVAL_MS = 60_000;
const MIN_PROFIT_PCT = 0.3; // 0.3% mínimo
const MIN_VOLUME = 5_000;
const MIN_LIQUIDITY = 100; // $100 mínimo de liquidez
const BET_SIZE = 100;
const LOG_FILE = "dutch-book-v2-trades.json";

// ============================================================
// STATE
// ============================================================
let totalScans = 0;
let allOpportunities = [];
let totalPnL = 0;
let startTime = Date.now();
let stats = { events: 0, eligible: 0, markets: 0, falsePositives: 0 };

// ============================================================
// POLYMARKET API
// ============================================================

async function fetchAllEvents() {
  const allEvents = [];
  let offset = 0;

  while (offset < 600) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/events?closed=false&order=volume24hr&ascending=false&limit=50&offset=${offset}`
      );
      const events = await res.json();
      if (!events || events.length === 0) break;
      allEvents.push(...events);
      offset += 50;
    } catch {
      break;
    }
  }
  return allEvents;
}

async function getMarketPrice(tokenId) {
  try {
    const res = await fetch(
      `https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`
    );
    const data = await res.json();
    return parseFloat(data.price) || null;
  } catch {
    return null;
  }
}

async function getOrderBook(tokenId) {
  try {
    const res = await fetch(
      `https://clob.polymarket.com/book?token_id=${tokenId}`
    );
    const data = await res.json();
    const bestAsk =
      data.asks && data.asks.length > 0 ? parseFloat(data.asks[0].price) : null;
    const askSize =
      data.asks && data.asks.length > 0 ? parseFloat(data.asks[0].size) : 0;
    const bestBid =
      data.bids && data.bids.length > 0 ? parseFloat(data.bids[0].price) : null;
    const bidSize =
      data.bids && data.bids.length > 0 ? parseFloat(data.bids[0].size) : 0;
    return { bestAsk, askSize, bestBid, bidSize };
  } catch {
    return null;
  }
}

// ============================================================
// MUTUAL EXCLUSIVITY DETECTION
// Critical: only flag opportunities where outcomes are truly
// mutually exclusive (exactly 1 wins)
// ============================================================

function isMutuallyExclusive(event, markets) {
  const title = (event.title || "").toLowerCase();
  const questions = markets.map((m) =>
    (m.question || "").toLowerCase()
  );

  // REJECT: Nested date markets ("by April" ⊂ "by June" ⊂ "by December")
  // These are NOT mutually exclusive — if it happens by April, it also happens by June
  const datePatterns = /\b(by|before|on)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i;
  const hasDateMarkets = questions.filter((q) => datePatterns.test(q)).length;
  if (hasDateMarkets >= 2) {
    // Check if dates are nested (by X, by Y, by Z)
    const byPattern = /\bby\b/i;
    const byCount = questions.filter((q) => byPattern.test(q)).length;
    if (byCount >= 2) return { eligible: false, reason: "nested_dates" };
  }

  // REJECT: "above $X" price threshold markets (BTC above 60K, 65K, 70K...)
  // NOT exclusive — BTC can be above 60K AND 65K simultaneously
  const abovePattern = /\b(above|below|over|under|hit|reach|dip)\b.*\$[\d,]+/i;
  const priceMarkets = questions.filter((q) => abovePattern.test(q)).length;
  if (priceMarkets >= 2) return { eligible: false, reason: "price_thresholds" };

  // REJECT: Independent props from same sports match
  // (spread, over/under, totals, odd/even — these are independent)
  const propPatterns = [
    /\bo\/u\b/i, /\bover\/under\b/i, /\bspread\b/i,
    /\bodd\/even\b/i, /\btotal\s+(sets|games|kills|rounds|points)/i,
    /\bhandicap\b/i, /\bmap\s*\d/i, /\bgame\s*\d/i, /\bset\s*\d/i,
  ];
  const propCount = questions.filter((q) =>
    propPatterns.some((p) => p.test(q))
  ).length;
  if (propCount >= 1 && markets.length > 2) {
    return { eligible: false, reason: "independent_props" };
  }

  // ACCEPT: "Who will win X?" — classic mutually exclusive
  // Multiple candidates, exactly 1 wins
  const winnerPatterns = [
    /who will win/i, /winner/i, /win the/i,
    /next president/i, /next prime minister/i,
    /which.*will/i, /nominated/i,
  ];
  if (winnerPatterns.some((p) => p.test(title))) {
    return { eligible: true, reason: "winner_market" };
  }

  // ACCEPT: Markets where each outcome is a different entity/person/team
  // and the event implies only one can win
  const entityMarkets = questions.filter((q) => {
    // Questions that name a specific entity as the subject
    return /^will\s/i.test(q) || /^does\s/i.test(q);
  });

  // ACCEPT: Multi-choice markets where groupTag indicates exclusivity
  if (event.groupItemTitle && markets.length >= 3) {
    // Check that questions follow a pattern like "Entity A", "Entity B", etc.
    // and don't contain date/price modifiers
    const clean = questions.filter(
      (q) => !datePatterns.test(q) && !abovePattern.test(q)
    );
    if (clean.length === questions.length) {
      return { eligible: true, reason: "multi_choice" };
    }
  }

  // ACCEPT: Binary markets (just YES/NO on one question) — always exclusive
  if (markets.length === 2) {
    // Two outcomes of one question — check they're complements
    const q0 = questions[0];
    const q1 = questions[1];
    // If they're the same question, YES/NO are exclusive by definition
    if (q0 === q1) return { eligible: true, reason: "binary" };
  }

  // DEFAULT: If we can't determine exclusivity, skip
  return { eligible: false, reason: "unknown_structure" };
}

// ============================================================
// ANALYSIS
// ============================================================

async function analyzeEvent(event) {
  if (!event.markets || event.markets.length < 2) return null;

  const activeMarkets = event.markets.filter(
    (m) => m.active && !m.closed && m.clobTokenIds && m.enableOrderBook
  );
  if (activeMarkets.length < 2) return null;

  // Check mutual exclusivity
  const exclusivity = isMutuallyExclusive(event, activeMarkets);
  if (!exclusivity.eligible) {
    stats.falsePositives++;
    return { skipped: true, reason: exclusivity.reason, event: event.title };
  }

  // Get prices for all outcomes
  const outcomes = [];
  for (const market of activeMarkets) {
    let tokenIds;
    try {
      tokenIds =
        typeof market.clobTokenIds === "string"
          ? JSON.parse(market.clobTokenIds)
          : market.clobTokenIds;
    } catch {
      continue;
    }

    const yesTokenId = tokenIds[0];
    const [price, book] = await Promise.all([
      getMarketPrice(yesTokenId),
      getOrderBook(yesTokenId),
    ]);

    if (price === null) continue;

    outcomes.push({
      question: market.question || "?",
      yesPrice: price,
      bestAsk: book?.bestAsk ?? price,
      bestBid: book?.bestBid ?? 0,
      askLiquidity: book?.askSize ?? 0,
      bidLiquidity: book?.bidSize ?? 0,
      tokenId: yesTokenId,
    });

    await sleep(80);
  }

  if (outcomes.length < 2) return null;
  stats.markets += outcomes.length;

  const sumYes = outcomes.reduce((s, o) => s + o.yesPrice, 0);
  const sumAsk = outcomes.reduce((s, o) => s + o.bestAsk, 0);
  const minLiq = Math.min(...outcomes.map((o) => Math.max(o.askLiquidity, o.bidLiquidity)));

  // DUTCH BOOK (buy all YES): if sum of ask prices < 1.0
  const buyAllProfit = 1.0 - sumAsk;
  const buyAllProfitPct = sumAsk > 0 ? (buyAllProfit / sumAsk) * 100 : 0;

  // REVERSE DUTCH BOOK (buy all NO / sell all YES):
  // Cost to buy NO on each = (1 - bid_price) for each outcome
  // Payout = (n-1) since only 1 outcome wins (so n-1 NO's pay $1 each)
  const sumBids = outcomes.reduce((s, o) => s + o.bestBid, 0);
  const noCost = outcomes.length - sumBids; // sum of (1 - bid)
  const noPayout = outcomes.length - 1;
  const sellAllProfit = noPayout - noCost;
  const sellAllProfitPct = noCost > 0 ? (sellAllProfit / noCost) * 100 : 0;

  return {
    event: event.title,
    slug: event.slug,
    volume: parseFloat(event.volume) || 0,
    exclusivityType: exclusivity.reason,
    numOutcomes: outcomes.length,
    outcomes,
    sumYes,
    sumAsk,
    buyAllProfit,
    buyAllProfitPct,
    sellAllProfit,
    sellAllProfitPct,
    minLiquidity: minLiq,
  };
}

// ============================================================
// SCANNER
// ============================================================

async function scan() {
  totalScans++;
  const t0 = Date.now();
  stats = { events: 0, eligible: 0, markets: 0, falsePositives: 0 };

  log("SCAN", `#${totalScans} iniciando...`);

  const events = await fetchAllEvents();
  stats.events = events.length;

  const multiMarket = events.filter(
    (e) =>
      e.markets &&
      e.markets.length >= 2 &&
      (parseFloat(e.volume) || 0) >= MIN_VOLUME
  );

  log("SCAN", `${events.length} eventos, ${multiMarket.length} con 2+ mercados`);

  const results = [];
  const currentOpps = [];

  for (const event of multiMarket) {
    const analysis = await analyzeEvent(event);
    if (!analysis || analysis.skipped) continue;

    stats.eligible++;
    results.push(analysis);

    // Check BUY ALL YES opportunity
    if (
      analysis.buyAllProfitPct > MIN_PROFIT_PCT &&
      analysis.minLiquidity >= MIN_LIQUIDITY
    ) {
      const opp = makeOpportunity("BUY_ALL_YES", analysis);
      currentOpps.push(opp);
      allOpportunities.push(opp);
      totalPnL += BET_SIZE * analysis.buyAllProfit;
      logOpportunity(opp);
    }

    // Check SELL ALL YES / BUY ALL NO opportunity
    if (
      analysis.sellAllProfitPct > MIN_PROFIT_PCT &&
      analysis.minLiquidity >= MIN_LIQUIDITY
    ) {
      const opp = makeOpportunity("BUY_ALL_NO", analysis);
      currentOpps.push(opp);
      allOpportunities.push(opp);
      totalPnL += BET_SIZE * analysis.sellAllProfit;
      logOpportunity(opp);
    }
  }

  printDashboard(results, currentOpps);
  saveTrades();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(
    "SCAN",
    `#${totalScans} completado en ${elapsed}s | ${stats.eligible} elegibles | ${currentOpps.length} oportunidades`
  );
}

function makeOpportunity(type, analysis) {
  const profit =
    type === "BUY_ALL_YES" ? analysis.buyAllProfit : analysis.sellAllProfit;
  const profitPct =
    type === "BUY_ALL_YES"
      ? analysis.buyAllProfitPct
      : analysis.sellAllProfitPct;

  return {
    timestamp: new Date().toISOString(),
    type,
    event: analysis.event,
    exclusivityType: analysis.exclusivityType,
    numOutcomes: analysis.numOutcomes,
    sumYes: analysis.sumYes.toFixed(4),
    profitPct: profitPct.toFixed(2) + "%",
    profitPerDollar: profit.toFixed(4),
    profitOnBet: (BET_SIZE * profit).toFixed(2),
    minLiquidity: analysis.minLiquidity.toFixed(0),
    outcomes: analysis.outcomes.map((o) => ({
      q: o.question.slice(0, 65),
      yes: o.yesPrice,
      ask: o.bestAsk,
      bid: o.bestBid,
      liq: Math.max(o.askLiquidity, o.bidLiquidity).toFixed(0),
    })),
  };
}

// ============================================================
// OUTPUT
// ============================================================

function logOpportunity(opp) {
  console.log("");
  console.log("$".repeat(70));
  console.log(`   ARBITRAJE REAL — ${opp.type}`);
  console.log("$".repeat(70));
  console.log(`   Evento:      ${opp.event}`);
  console.log(`   Tipo:        ${opp.exclusivityType}`);
  console.log(`   Outcomes:    ${opp.numOutcomes} (mutuamente excluyentes)`);
  console.log(`   Sum YES:     ${opp.sumYes}`);
  console.log(
    `   Beneficio:   ${opp.profitPct} (€${opp.profitOnBet} por €${BET_SIZE})`
  );
  console.log(`   Liquidez min: $${opp.minLiquidity}`);
  console.log("");
  console.log("   Desglose:");
  for (const o of opp.outcomes) {
    console.log(
      `     YES: ${(o.yes * 100).toFixed(1).padStart(5)}% | Ask: ${(o.ask * 100).toFixed(1).padStart(5)}% | Liq: $${o.liq.padStart(8)} | ${o.q}`
    );
  }
  console.log("$".repeat(70));
}

function printDashboard(results, currentOpps) {
  console.log("");
  console.log("=".repeat(70));
  console.log("   DUTCH BOOK SCANNER v2 — Solo arbitraje REAL");
  console.log("=".repeat(70));

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = elapsed % 60;

  console.log(`   Tiempo:             ${hrs}h ${mins}m ${secs}s`);
  console.log(`   Scans:              ${totalScans}`);
  console.log(`   Eventos total:      ${stats.events}`);
  console.log(`   Elegibles (excl.):  ${stats.eligible}`);
  console.log(`   Descartados:        ${stats.falsePositives} (no excluyentes)`);
  console.log(`   Mercados analizados: ${stats.markets}`);
  console.log("-".repeat(70));
  console.log(`   Oportunidades:      ${allOpportunities.length} total`);
  console.log(`   P&L paper:          €${totalPnL.toFixed(2)}`);
  console.log("-".repeat(70));

  if (results.length > 0) {
    // Sort by closest to profitable
    const sorted = [...results].sort((a, b) => {
      const aMax = Math.max(a.buyAllProfitPct, a.sellAllProfitPct);
      const bMax = Math.max(b.buyAllProfitPct, b.sellAllProfitPct);
      return bMax - aMax;
    });

    console.log("");
    console.log("   Top mercados excluyentes (cercanos a arbitraje):");
    console.log(
      "   " +
        "Evento".padEnd(32) +
        "Tipo".padEnd(14) +
        "Out".padStart(4) +
        "SumYES".padStart(8) +
        "BuyAll%".padStart(9) +
        "SellAll%".padStart(10) +
        "Liq$".padStart(8)
    );
    console.log("   " + "-".repeat(85));

    for (const r of sorted.slice(0, 20)) {
      const flag =
        r.buyAllProfitPct > MIN_PROFIT_PCT ||
        r.sellAllProfitPct > MIN_PROFIT_PCT
          ? " $$$"
          : "";
      console.log(
        "   " +
          r.event.slice(0, 30).padEnd(32) +
          r.exclusivityType.padEnd(14) +
          String(r.numOutcomes).padStart(4) +
          r.sumYes.toFixed(3).padStart(8) +
          (r.buyAllProfitPct.toFixed(1) + "%").padStart(9) +
          (r.sellAllProfitPct.toFixed(1) + "%").padStart(10) +
          ("$" + (r.minLiquidity || 0).toFixed(0)).padStart(8) +
          flag
      );
    }
  }

  if (allOpportunities.length > 0) {
    console.log("");
    console.log("   Ultimas oportunidades:");
    for (const o of allOpportunities.slice(-5)) {
      console.log(
        `     ${o.timestamp.slice(11, 19)} | ${o.type.padEnd(14)} | ${o.profitPct.padStart(7)} | €${o.profitOnBet.padStart(7)} | ${o.event.slice(0, 35)}`
      );
    }
  }

  console.log("");
  console.log("=".repeat(70));
  console.log(
    `   Proximo scan en ${SCAN_INTERVAL_MS / 1000}s | Ctrl+C para parar | Datos: ${LOG_FILE}`
  );
  console.log("=".repeat(70));
}

// ============================================================
// PERSISTENCE
// ============================================================

function saveTrades() {
  const data = {
    startTime: new Date(startTime).toISOString(),
    lastUpdate: new Date().toISOString(),
    totalScans,
    totalPnL,
    stats,
    config: { MIN_PROFIT_PCT, MIN_VOLUME, MIN_LIQUIDITY, BET_SIZE },
    opportunities: allOpportunities,
  };
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// UTILS
// ============================================================

function log(src, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${src}] ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on("SIGINT", () => {
  console.log("\n\nGuardando...");
  saveTrades();
  console.log("\n" + "=".repeat(55));
  console.log("   RESUMEN FINAL — DUTCH BOOK v2");
  console.log("=".repeat(55));
  console.log(`   Scans:           ${totalScans}`);
  console.log(`   Oportunidades:   ${allOpportunities.length}`);
  console.log(`   P&L paper:       €${totalPnL.toFixed(2)}`);
  console.log(`   Datos:           ${LOG_FILE}`);
  console.log("=".repeat(55));
  process.exit(0);
});

async function main() {
  console.log("");
  console.log("=".repeat(70));
  console.log("   DUTCH BOOK SCANNER v2");
  console.log("   Solo mercados MUTUAMENTE EXCLUYENTES");
  console.log("   Filtra: fechas anidadas, price thresholds, props independientes");
  console.log("=".repeat(70));
  console.log(`   Min profit: ${MIN_PROFIT_PCT}% | Min liq: $${MIN_LIQUIDITY} | Bet: €${BET_SIZE}`);
  console.log("");

  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}

main().catch(console.error);
