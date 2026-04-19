// ============================================================
// POLYMARKET DUTCH BOOK SCANNER
// Detecta arbitraje lógico: mercados donde la suma de
// probabilidades ≠ 1.00 → beneficio garantizado
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================
const SCAN_INTERVAL_MS = 30_000; // Escaneo cada 30s
const MIN_PROFIT_PCT = 0.5; // Beneficio mínimo para alertar (0.5%)
const MIN_VOLUME = 10_000; // Volumen mínimo del evento ($)
const BET_SIZE = 100; // Apuesta simulada por oportunidad (€)
const LOG_FILE = "dutch-book-trades.json";

// ============================================================
// STATE
// ============================================================
let totalScans = 0;
let opportunities = [];
let allOpportunities = [];
let totalPnL = 0;
let startTime = Date.now();
let eventsScanned = 0;
let marketsScanned = 0;

// ============================================================
// POLYMARKET API
// ============================================================

async function fetchAllEvents() {
  const allEvents = [];
  let offset = 0;
  const limit = 50;

  // Paginate through all active events
  while (true) {
    try {
      const url = `https://gamma-api.polymarket.com/events?closed=false&order=volume24hr&ascending=false&limit=${limit}&offset=${offset}`;
      const res = await fetch(url);
      const events = await res.json();

      if (!events || events.length === 0) break;

      allEvents.push(...events);
      offset += limit;

      // Safety limit
      if (offset > 500) break;
    } catch (err) {
      log("ERROR", `Fetch events offset=${offset}: ${err.message}`);
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

    let bestAsk = null;
    let askSize = 0;
    let bestBid = null;
    let bidSize = 0;

    if (data.asks && data.asks.length > 0) {
      bestAsk = parseFloat(data.asks[0].price);
      askSize = parseFloat(data.asks[0].size);
    }
    if (data.bids && data.bids.length > 0) {
      bestBid = parseFloat(data.bids[0].price);
      bidSize = parseFloat(data.bids[0].size);
    }

    return { bestAsk, askSize, bestBid, bidSize };
  } catch {
    return null;
  }
}

// ============================================================
// DUTCH BOOK DETECTION
// ============================================================

async function analyzeEvent(event) {
  if (!event.markets || event.markets.length < 2) return null;

  // Only analyze events with multiple mutually exclusive outcomes
  const activeMarkets = event.markets.filter(
    (m) => m.active && !m.closed && m.clobTokenIds && m.enableOrderBook
  );

  if (activeMarkets.length < 2) return null;

  // Get prices for all YES tokens (cost to buy each outcome)
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

    // Get both price and order book
    const [price, book] = await Promise.all([
      getMarketPrice(yesTokenId),
      getOrderBook(yesTokenId),
    ]);

    if (price === null) continue;

    // The actual cost to BUY YES is the ask price (what you'd pay)
    const buyCost = book && book.bestAsk !== null ? book.bestAsk : price;
    const liquidity = book ? book.askSize : 0;

    outcomes.push({
      question: market.question || "?",
      yesPrice: price,
      buyCost,
      liquidity,
      tokenId: yesTokenId,
      outcomePrices: market.outcomePrices,
    });

    // Rate limiting - small delay between requests
    await sleep(100);
  }

  if (outcomes.length < 2) return null;

  // -------------------------------------------------------
  // DUTCH BOOK CHECK #1: Sum of YES prices < 1.00
  // If you can buy ALL outcomes for less than $1 total,
  // one of them MUST win → guaranteed profit
  // -------------------------------------------------------

  const sumYesPrices = outcomes.reduce((s, o) => s + o.yesPrice, 0);
  const sumBuyCosts = outcomes.reduce((s, o) => s + o.buyCost, 0);
  const minLiquidity = Math.min(...outcomes.map((o) => o.liquidity));

  // For mutually exclusive events, sum should be ~1.00
  // If < 1.00 → buy all, guaranteed profit
  // If > 1.00 → sell all (but we can't easily short on Polymarket)

  const dutchBookProfit = 1.0 - sumBuyCosts;
  const dutchBookProfitPct = (dutchBookProfit / sumBuyCosts) * 100;

  // -------------------------------------------------------
  // DUTCH BOOK CHECK #2: Sum of YES prices > 1.00
  // This means you can SELL all outcomes (buy NO on all)
  // and guarantee profit since only one can win
  // -------------------------------------------------------
  // On Polymarket: buying NO at price X = paying (1 - YES_bid)
  // Sum of NO costs = outcomes.length - sum(YES_bids)
  // If sum(YES_bids) > 1.0, then NO costs < (n-1), and since
  // (n-1) outcomes resolve YES → you collect (n-1) × $1

  let reverseDutchProfit = null;
  let reverseDutchProfitPct = null;

  if (outcomes.length >= 2) {
    // Cost to buy NO on every outcome
    const sumNoCosts = outcomes.reduce((s, o) => s + (1 - o.yesPrice), 0);
    // Payout: (n-1) outcomes will resolve NO → each pays $1
    const noPayout = outcomes.length - 1;
    reverseDutchProfit = noPayout - sumNoCosts;
    reverseDutchProfitPct = (reverseDutchProfit / sumNoCosts) * 100;
  }

  return {
    event: event.title,
    slug: event.slug,
    volume: parseFloat(event.volume) || 0,
    numOutcomes: outcomes.length,
    outcomes,
    sumYesPrices: sumYesPrices,
    sumBuyCosts: sumBuyCosts,
    dutchBookProfit,
    dutchBookProfitPct,
    reverseDutchProfit,
    reverseDutchProfitPct,
    minLiquidity,
    deviation: Math.abs(1.0 - sumYesPrices),
  };
}

// ============================================================
// CROSS-MARKET LOGICAL INCONSISTENCY
// ============================================================

function detectLogicalInconsistencies(analyses) {
  const inconsistencies = [];

  // Check: if event A implies event B, then P(A) <= P(B)
  // Example: "Trump wins presidency" <= "Republican wins presidency"
  // We look for keywords that suggest subset relationships

  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      const a = analyses[i];
      const b = analyses[j];
      if (!a || !b) continue;

      // Check if any outcome in event A matches an outcome in event B
      for (const outA of a.outcomes) {
        for (const outB of b.outcomes) {
          const qA = (outA.question || "").toLowerCase();
          const qB = (outB.question || "").toLowerCase();

          // Simple similarity check - same entity mentioned
          if (qA.length > 10 && qB.length > 10) {
            const wordsA = new Set(qA.split(/\s+/).filter((w) => w.length > 4));
            const wordsB = new Set(qB.split(/\s+/).filter((w) => w.length > 4));
            const overlap = [...wordsA].filter((w) => wordsB.has(w));

            if (overlap.length >= 3) {
              const priceDiff = Math.abs(outA.yesPrice - outB.yesPrice);
              if (priceDiff > 0.05) {
                inconsistencies.push({
                  type: "PRICE_DIVERGENCE",
                  marketA: `${a.event}: ${outA.question}`,
                  marketB: `${b.event}: ${outB.question}`,
                  priceA: outA.yesPrice,
                  priceB: outB.yesPrice,
                  diff: priceDiff,
                  diffPct: (priceDiff * 100).toFixed(1) + "%",
                  overlap: overlap.join(", "),
                });
              }
            }
          }
        }
      }
    }
  }

  return inconsistencies;
}

// ============================================================
// MAIN SCANNER
// ============================================================

async function scan() {
  totalScans++;
  const scanStart = Date.now();

  log("SCAN", `Iniciando scan #${totalScans}...`);

  // 1. Fetch all events
  const events = await fetchAllEvents();
  eventsScanned = events.length;
  log("SCAN", `${events.length} eventos activos encontrados`);

  // 2. Filter events with multiple markets and decent volume
  const multiMarketEvents = events.filter(
    (e) =>
      e.markets &&
      e.markets.length >= 2 &&
      (parseFloat(e.volume) || 0) >= MIN_VOLUME
  );

  log(
    "SCAN",
    `${multiMarketEvents.length} eventos con 2+ mercados y volumen >$${MIN_VOLUME.toLocaleString()}`
  );

  // 3. Analyze each event
  const analyses = [];
  opportunities = [];
  marketsScanned = 0;

  for (const event of multiMarketEvents) {
    const analysis = await analyzeEvent(event);
    if (!analysis) continue;

    analyses.push(analysis);
    marketsScanned += analysis.numOutcomes;

    // Check for Dutch Book opportunity (buy all YES)
    if (analysis.dutchBookProfitPct > MIN_PROFIT_PCT) {
      const opp = {
        timestamp: new Date().toISOString(),
        type: "DUTCH_BOOK_BUY_ALL",
        event: analysis.event,
        numOutcomes: analysis.numOutcomes,
        sumPrices: analysis.sumBuyCosts.toFixed(4),
        profitPct: analysis.dutchBookProfitPct.toFixed(2) + "%",
        profitPerDollar: analysis.dutchBookProfit.toFixed(4),
        profitOnBet: (BET_SIZE * analysis.dutchBookProfit).toFixed(2),
        minLiquidity: analysis.minLiquidity,
        outcomes: analysis.outcomes.map((o) => ({
          q: o.question.slice(0, 60),
          price: o.yesPrice,
          cost: o.buyCost,
        })),
      };
      opportunities.push(opp);
      allOpportunities.push(opp);
      totalPnL += BET_SIZE * analysis.dutchBookProfit;

      logOpportunity(opp);
    }

    // Check for reverse Dutch Book (sell all / buy all NO)
    if (
      analysis.reverseDutchProfitPct !== null &&
      analysis.reverseDutchProfitPct > MIN_PROFIT_PCT
    ) {
      const opp = {
        timestamp: new Date().toISOString(),
        type: "DUTCH_BOOK_BUY_ALL_NO",
        event: analysis.event,
        numOutcomes: analysis.numOutcomes,
        sumYesPrices: analysis.sumYesPrices.toFixed(4),
        profitPct: analysis.reverseDutchProfitPct.toFixed(2) + "%",
        profitPerDollar: analysis.reverseDutchProfit.toFixed(4),
        profitOnBet: (BET_SIZE * analysis.reverseDutchProfit).toFixed(2),
        minLiquidity: analysis.minLiquidity,
        outcomes: analysis.outcomes.map((o) => ({
          q: o.question.slice(0, 60),
          yesPrice: o.yesPrice,
        })),
      };
      opportunities.push(opp);
      allOpportunities.push(opp);
      totalPnL += BET_SIZE * analysis.reverseDutchProfit;

      logOpportunity(opp);
    }
  }

  // 4. Cross-market inconsistencies
  const inconsistencies = detectLogicalInconsistencies(analyses);
  for (const inc of inconsistencies) {
    const opp = {
      timestamp: new Date().toISOString(),
      type: "LOGICAL_INCONSISTENCY",
      ...inc,
    };
    opportunities.push(opp);
    allOpportunities.push(opp);
  }

  // 5. Print dashboard
  printDashboard(analyses);

  // 6. Save
  saveTrades();

  const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
  log("SCAN", `Scan #${totalScans} completado en ${elapsed}s — ${opportunities.length} oportunidades encontradas`);
}

// ============================================================
// OUTPUT
// ============================================================

function logOpportunity(opp) {
  console.log("");
  console.log("!".repeat(65));
  console.log(`   OPORTUNIDAD DETECTADA — ${opp.type}`);
  console.log("!".repeat(65));
  console.log(`   Evento:     ${opp.event}`);
  console.log(`   Outcomes:   ${opp.numOutcomes}`);
  console.log(
    `   Sum precios: ${opp.sumPrices || opp.sumYesPrices}`
  );
  console.log(`   Beneficio:  ${opp.profitPct} (€${opp.profitOnBet} por €${BET_SIZE} apostados)`);
  console.log(`   Liquidez min: $${opp.minLiquidity?.toFixed(0) || "?"}`);
  console.log("");

  if (opp.outcomes) {
    console.log("   Desglose:");
    for (const o of opp.outcomes) {
      const price = o.cost || o.price || o.yesPrice;
      console.log(
        `     ${(price * 100).toFixed(1).padStart(5)}%  ${o.q}`
      );
    }
  }
  console.log("!".repeat(65));
  console.log("");
}

function printDashboard(analyses) {
  console.log("");
  console.log("=".repeat(70));
  console.log("   POLYMARKET DUTCH BOOK SCANNER");
  console.log("=".repeat(70));

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = elapsed % 60;

  console.log(`   Tiempo:           ${hrs}h ${mins}m ${secs}s`);
  console.log(`   Scans:            ${totalScans}`);
  console.log(`   Eventos:          ${eventsScanned}`);
  console.log(`   Mercados:         ${marketsScanned}`);
  console.log("-".repeat(70));
  console.log(
    `   Oportunidades:    ${allOpportunities.length} total (${opportunities.length} este scan)`
  );
  console.log(`   P&L paper:        €${totalPnL.toFixed(2)}`);
  console.log("-".repeat(70));

  // Show top deviations (closest to having an opportunity)
  if (analyses.length > 0) {
    // Sort by how close sum is to exploitable
    const sorted = [...analyses].sort((a, b) => {
      const aScore = Math.max(
        a.dutchBookProfitPct || -999,
        a.reverseDutchProfitPct || -999
      );
      const bScore = Math.max(
        b.dutchBookProfitPct || -999,
        b.reverseDutchProfitPct || -999
      );
      return bScore - aScore;
    });

    console.log("");
    console.log(
      "   Top 15 eventos por cercanía a arbitraje:"
    );
    console.log(
      "   " +
        "Evento".padEnd(35) +
        "Out".padStart(4) +
        "SumYES".padStart(8) +
        "Dutch%".padStart(8) +
        "Rev%".padStart(8) +
        "Liq$".padStart(8)
    );
    console.log("   " + "-".repeat(71));

    for (const a of sorted.slice(0, 15)) {
      const name = a.event.slice(0, 33).padEnd(35);
      const out = String(a.numOutcomes).padStart(4);
      const sum = a.sumYesPrices.toFixed(3).padStart(8);
      const dutch = (
        (a.dutchBookProfitPct || 0).toFixed(1) + "%"
      ).padStart(8);
      const rev = (
        (a.reverseDutchProfitPct || 0).toFixed(1) + "%"
      ).padStart(8);
      const liq = (
        "$" + (a.minLiquidity || 0).toFixed(0)
      ).padStart(8);

      const marker =
        (a.dutchBookProfitPct || 0) > MIN_PROFIT_PCT ||
        (a.reverseDutchProfitPct || 0) > MIN_PROFIT_PCT
          ? " >>>"
          : "";

      console.log(`   ${name}${out}${sum}${dutch}${rev}${liq}${marker}`);
    }
  }

  console.log("");
  console.log("=".repeat(70));
  console.log(`   Proximo scan en ${SCAN_INTERVAL_MS / 1000}s | Ctrl+C para parar`);
  console.log("=".repeat(70));
  console.log("");
}

// ============================================================
// PERSISTENCE
// ============================================================

function saveTrades() {
  const data = {
    startTime: new Date(startTime).toISOString(),
    lastUpdate: new Date().toISOString(),
    totalScans,
    eventsScanned,
    marketsScanned,
    totalOpportunities: allOpportunities.length,
    totalPnL,
    config: {
      minProfitPct: MIN_PROFIT_PCT,
      minVolume: MIN_VOLUME,
      betSize: BET_SIZE,
      scanInterval: SCAN_INTERVAL_MS,
    },
    opportunities: allOpportunities,
  };
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// UTILS
// ============================================================

function log(source, msg) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] [${source}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");
  console.log("=".repeat(70));
  console.log("   POLYMARKET DUTCH BOOK SCANNER");
  console.log("   Buscando arbitraje logico garantizado");
  console.log("=".repeat(70));
  console.log("");
  console.log(`   Config:`);
  console.log(`     Beneficio minimo: ${MIN_PROFIT_PCT}%`);
  console.log(`     Volumen minimo:   $${MIN_VOLUME.toLocaleString()}`);
  console.log(`     Apuesta paper:    €${BET_SIZE}`);
  console.log(`     Intervalo scan:   ${SCAN_INTERVAL_MS / 1000}s`);
  console.log("");

  // First scan
  await scan();

  // Continuous scanning
  setInterval(scan, SCAN_INTERVAL_MS);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nGuardando datos...");
  saveTrades();

  console.log("\n" + "=".repeat(50));
  console.log("   RESUMEN FINAL — DUTCH BOOK SCANNER");
  console.log("=".repeat(50));
  console.log(`   Tiempo total:     ${Math.floor((Date.now() - startTime) / 60000)} min`);
  console.log(`   Scans:            ${totalScans}`);
  console.log(`   Eventos:          ${eventsScanned}`);
  console.log(`   Mercados:         ${marketsScanned}`);
  console.log(`   Oportunidades:    ${allOpportunities.length}`);
  console.log(`   P&L paper:        €${totalPnL.toFixed(2)}`);
  console.log(`   Datos en:         ${LOG_FILE}`);
  console.log("=".repeat(50));
  console.log("");
  process.exit(0);
});

main().catch(console.error);
