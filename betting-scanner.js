// ============================================================
// BETTING SCANNER — Surebets, Value Bets & Prediction Arb
// Focused purely on betting opportunities
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG — Pon tu API key de the-odds-api.com aquí
// ============================================================
const ODDS_API_KEY = process.env.ODDS_API_KEY || "400df6d994cce4079380c2bcdf229ae5"; // Free: 500 req/month
const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const LOG_FILE = "betting-opportunities.json";

// Surebet: beneficio garantizado apostando en todas las casas
const MIN_SUREBET_PCT = 0; // Show all surebets (even 0.1%)

// Value bet: cuota inflada en una casa vs el consenso
const MIN_VALUE_EDGE = 3; // 3%+ edge sobre el consenso

// Prediction markets
const MIN_PREDICTION_DIFF = 0.05; // 5% diff entre plataformas

// Sports to scan (each costs 1 API request)
const TARGET_SPORTS = [
  "soccer_spain_la_liga",
  "soccer_uefa_champs_league",
  "soccer_epl",
  "soccer_germany_bundesliga",
  "soccer_italy_serie_a",
  "soccer_france_ligue_one",
  "tennis_atp_french_open",
  "basketball_euroleague",
  "basketball_nba",
  "mma_mixed_martial_arts",
];

// ============================================================
// STATE
// ============================================================
let totalScans = 0;
let startTime = Date.now();
let results = { surebets: [], valueBets: [], predictionArb: [] };
let apiCallsUsed = 0;
let apiCallsRemaining = 500;

// ============================================================
// 1. SPORTS SUREBETS — Guaranteed profit
// ============================================================

async function scanSurebets() {
  if (!ODDS_API_KEY) {
    log("SPORTS", "Sin API key. Obten una gratis en the-odds-api.com");
    log("SPORTS", "Luego: ODDS_API_KEY=tu_key node betting-scanner.js");
    return { surebets: [], valueBets: [] };
  }

  log("SPORTS", "Scanning sports odds...");

  // First get available sports
  const sportsRes = await fetch(
    `https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`
  );
  const allSports = await sportsRes.json();
  trackApiUsage(sportsRes);

  if (!Array.isArray(allSports)) {
    log("SPORTS", `API error: ${JSON.stringify(allSports).slice(0, 100)}`);
    return { surebets: [], valueBets: [] };
  }

  const activeSports = allSports
    .filter((s) => s.active)
    .map((s) => s.key);

  // Filter to target sports that are currently active
  const toScan = TARGET_SPORTS.filter((s) => activeSports.includes(s));

  // Also add any active sports not in our list (discover new opportunities)
  const extra = activeSports
    .filter((s) => !TARGET_SPORTS.includes(s) && !s.includes("winner"))
    .slice(0, 3);

  const scanList = [...toScan, ...extra];
  log("SPORTS", `${scanList.length} deportes activos para escanear`);

  const surebets = [];
  const valueBets = [];

  for (const sport of scanList) {
    await sleep(500);

    try {
      const res = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h,spreads,totals&oddsFormat=decimal`
      );
      trackApiUsage(res);

      const events = await res.json();
      if (!Array.isArray(events)) continue;

      for (const event of events) {
        if (!event.bookmakers || event.bookmakers.length < 2) continue;

        // Process each market type (h2h, spreads, totals)
        for (const marketType of ["h2h", "spreads", "totals"]) {
          const analysis = analyzeMarket(event, marketType);

          if (analysis.surebet) {
            surebets.push({
              type: "SUREBET",
              sport: formatSport(sport),
              event: `${event.home_team} vs ${event.away_team}`,
              market: marketType,
              date: formatDate(event.commence_time),
              profitPct: analysis.surebet.profitPct,
              profitNum: analysis.surebet.profitNum,
              bets: analysis.surebet.bets,
              bookmakers: analysis.surebet.bets.map((b) => b.bookmaker).join(" + "),
            });
          }

          for (const vb of analysis.valueBets) {
            valueBets.push({
              type: "VALUE_BET",
              sport: formatSport(sport),
              event: `${event.home_team} vs ${event.away_team}`,
              market: marketType,
              date: formatDate(event.commence_time),
              ...vb,
            });
          }
        }
      }
    } catch (err) {
      log("SPORTS", `Error ${sport}: ${err.message}`);
    }
  }

  surebets.sort((a, b) => b.profitNum - a.profitNum);
  valueBets.sort((a, b) => b.edgeNum - a.edgeNum);

  log("SPORTS", `${surebets.length} surebets + ${valueBets.length} value bets`);
  return { surebets: surebets.slice(0, 20), valueBets: valueBets.slice(0, 30) };
}

function analyzeMarket(event, marketType) {
  const result = { surebet: null, valueBets: [] };
  const allOutcomes = {}; // outcome -> [{price, bookmaker, point}]

  for (const bm of event.bookmakers) {
    const market = bm.markets.find((m) => m.key === marketType);
    if (!market) continue;

    for (const outcome of market.outcomes) {
      const key = outcome.point !== undefined
        ? `${outcome.name}|${outcome.point}`
        : outcome.name;

      if (!allOutcomes[key]) allOutcomes[key] = [];
      allOutcomes[key].push({
        price: outcome.price,
        bookmaker: bm.key,
        title: bm.title,
        point: outcome.point,
      });
    }
  }

  // Find best odds per outcome
  const bestOdds = {};
  const avgOdds = {};

  for (const [key, entries] of Object.entries(allOutcomes)) {
    entries.sort((a, b) => b.price - a.price);
    bestOdds[key] = entries[0]; // Best odds
    avgOdds[key] = entries.reduce((s, e) => s + e.price, 0) / entries.length;
  }

  const outcomeKeys = Object.keys(bestOdds);
  if (outcomeKeys.length < 2) return result;

  // Check for surebet
  const sumInverse = outcomeKeys.reduce(
    (sum, key) => sum + 1 / bestOdds[key].price,
    0
  );

  if (sumInverse < 1) {
    const profit = ((1 - sumInverse) * 100);
    if (profit >= MIN_SUREBET_PCT) {
      result.surebet = {
        profitPct: profit.toFixed(2) + "%",
        profitNum: profit,
        sumInverse: sumInverse.toFixed(4),
        bets: outcomeKeys.map((key) => {
          const stakePercent = (1 / bestOdds[key].price / sumInverse) * 100;
          return {
            outcome: key.split("|")[0],
            point: bestOdds[key].point,
            odds: bestOdds[key].price,
            bookmaker: bestOdds[key].title || bestOdds[key].bookmaker,
            stakePct: stakePercent.toFixed(1) + "%",
          };
        }),
      };
    }
  }

  // Check for value bets (odds significantly above average)
  for (const [key, best] of Object.entries(bestOdds)) {
    const avg = avgOdds[key];
    if (!avg || avg <= 1) continue;

    // Calculate implied probabilities
    const bestImplied = 1 / best.price;
    const avgImplied = 1 / avg;

    // Edge = how much better than average
    const edge = ((avgImplied - bestImplied) / avgImplied) * 100;

    if (edge >= MIN_VALUE_EDGE) {
      result.valueBets.push({
        outcome: key.split("|")[0],
        point: best.point,
        bestOdds: best.price,
        bestBook: best.title || best.bookmaker,
        avgOdds: avg.toFixed(2),
        edge: edge.toFixed(1) + "%",
        edgeNum: edge,
        numBooks: allOutcomes[key].length,
      });
    }
  }

  return result;
}

// ============================================================
// 2. PREDICTION MARKET ARBITRAGE
// ============================================================

async function scanPredictionArb() {
  log("PREDICT", "Scanning prediction markets...");

  try {
    // Get top Polymarket events
    const pmRes = await fetch(
      "https://gamma-api.polymarket.com/events?closed=false&order=volume24hr&ascending=false&limit=25"
    );
    const pmEvents = await pmRes.json();

    const arbs = [];

    for (const event of pmEvents) {
      if (!event.markets) continue;

      for (const pm of event.markets) {
        if (!pm.question || !pm.outcomePrices || !pm.active || pm.closed) continue;

        let pmYes;
        try {
          const prices = typeof pm.outcomePrices === "string"
            ? JSON.parse(pm.outcomePrices) : pm.outcomePrices;
          pmYes = parseFloat(prices[0]);
        } catch { continue; }

        if (!pmYes || pmYes <= 0.02 || pmYes >= 0.98) continue;

        // Search Manifold
        const terms = extractSearchTerms(pm.question);
        if (!terms) continue;

        await sleep(400);
        try {
          const mfRes = await fetch(
            `https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(terms)}&sort=score&limit=3`
          );
          const mfResults = await mfRes.json();

          for (const mf of mfResults) {
            if (!mf.question || mf.isResolved || mf.outcomeType !== "BINARY") continue;

            const mfYes = mf.probability;
            if (!mfYes || mfYes <= 0.02 || mfYes >= 0.98) continue;

            // Verify match
            const pmK = extractKeywords(pm.question);
            const mfK = extractKeywords(mf.question);
            const overlap = pmK.filter((k) => mfK.includes(k));
            const ratio = overlap.length / Math.min(pmK.length, mfK.length);
            if (overlap.length < 3 || ratio < 0.4) continue;

            const diff = Math.abs(pmYes - mfYes);
            if (diff < MIN_PREDICTION_DIFF || diff > 0.55) continue;

            const exists = arbs.some((a) => a.pmQuestion === pm.question.slice(0, 80));
            if (exists) continue;

            arbs.push({
              type: "PREDICTION_ARB",
              pmQuestion: pm.question.slice(0, 80),
              mfQuestion: mf.question.slice(0, 80),
              pmYes: (pmYes * 100).toFixed(1) + "%",
              mfYes: (mfYes * 100).toFixed(1) + "%",
              diff: (diff * 100).toFixed(1) + "%",
              diffNum: diff,
              action: pmYes < mfYes
                ? "BUY YES en Polymarket (barato), BUY NO en Manifold"
                : "BUY YES en Manifold (barato), BUY NO en Polymarket",
              mfUrl: mf.url || "",
              mfBettors: mf.uniqueBettorCount || 0,
              pmVolume: pm.volume || "?",
              matchQuality: overlap.length >= 4 && ratio >= 0.6 ? "ALTO" : "MEDIO",
            });
          }
        } catch {}
      }

      if (arbs.length >= 15) break;
    }

    arbs.sort((a, b) => b.diffNum - a.diffNum);
    log("PREDICT", `${arbs.length} opportunities found`);
    return arbs.slice(0, 15);
  } catch (err) {
    log("PREDICT", `Error: ${err.message}`);
    return [];
  }
}

function extractKeywords(q) {
  const stop = new Set([
    "will","the","be","in","on","by","a","an","of","to","is","for",
    "and","or","this","that","with","from","at","has","have","had",
    "do","does","did","not","no","yes","before","after","above",
    "below","than","more","less","what","when","where","who","how",
    "which","would","could","should","can","may","its","it","was","win",
  ]);
  return q.toLowerCase().replace(/[^a-z0-9\s]/g,"").split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

function extractSearchTerms(q) {
  const words = q.split(/\s+/);
  const proper = words
    .filter((w) => w.length > 2 && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase())
    .map((w) => w.replace(/[^a-zA-Z]/g,""))
    .filter((w) => w.length > 2);
  if (proper.length >= 2) return proper.slice(0, 3).join(" ");
  const kw = extractKeywords(q);
  return kw.length >= 2 ? kw.slice(0, 3).join(" ") : null;
}

// ============================================================
// API TRACKING
// ============================================================

function trackApiUsage(response) {
  apiCallsUsed++;
  const remaining = response.headers?.get("x-requests-remaining");
  if (remaining) apiCallsRemaining = parseInt(remaining);
}

// ============================================================
// DASHBOARD
// ============================================================

function printDashboard() {
  console.clear();
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  console.log("=".repeat(80));
  console.log("   BETTING SCANNER — Surebets, Value Bets & Prediction Arb");
  console.log("=".repeat(80));
  console.log(`   Scan #${totalScans} | ${hrs}h ${mins}m | API calls: ${apiCallsUsed} used, ~${apiCallsRemaining} remaining`);
  console.log("-".repeat(80));

  // === SUREBETS ===
  if (results.surebets.length > 0) {
    console.log("\n   SUREBETS — Beneficio GARANTIZADO");
    console.log("   " + "-".repeat(76));

    for (const sb of results.surebets) {
      console.log(`\n   ${sb.profitPct} profit | ${sb.event}`);
      console.log(`   ${sb.sport} | ${sb.market} | ${sb.date}`);
      for (const bet of sb.bets) {
        const pointStr = bet.point !== undefined ? ` (${bet.point > 0 ? "+" : ""}${bet.point})` : "";
        console.log(
          `      ${bet.outcome.padEnd(20)}${pointStr.padEnd(8)} @ ${String(bet.odds).padEnd(6)} en ${bet.bookmaker.padEnd(15)} stake: ${bet.stakePct}`
        );
      }
    }
  } else {
    console.log("\n   SUREBETS: Ninguna encontrada este scan");
    if (!ODDS_API_KEY) {
      console.log("   >>> Necesitas API key: ODDS_API_KEY=xxx node betting-scanner.js");
    }
  }

  // === VALUE BETS ===
  if (results.valueBets.length > 0) {
    console.log("\n   VALUE BETS — Cuotas por encima del consenso");
    console.log(
      "   " +
        "Evento".padEnd(30) +
        "Resultado".padEnd(18) +
        "Mejor".padStart(7) +
        "Media".padStart(7) +
        "Edge".padStart(7) +
        "  Casa"
    );
    console.log("   " + "-".repeat(76));

    for (const vb of results.valueBets.slice(0, 15)) {
      const pointStr = vb.point !== undefined ? ` (${vb.point > 0 ? "+" : ""}${vb.point})` : "";
      console.log(
        "   " +
          vb.event.slice(0, 28).padEnd(30) +
          (vb.outcome + pointStr).slice(0, 16).padEnd(18) +
          String(vb.bestOdds).padStart(7) +
          vb.avgOdds.padStart(7) +
          vb.edge.padStart(7) +
          "  " + (vb.bestBook || "?")
      );
    }
  }

  // === PREDICTION MARKET ARB ===
  if (results.predictionArb.length > 0) {
    console.log("\n   PREDICTION MARKET ARBITRAGE");
    console.log("   " + "-".repeat(76));

    for (const p of results.predictionArb.slice(0, 8)) {
      console.log(`\n   ${p.diff} gap | Match: ${p.matchQuality}`);
      console.log(`   PM: ${p.pmYes} — ${p.pmQuestion}`);
      console.log(`   MF: ${p.mfYes} — ${p.mfQuestion}`);
      console.log(`   >>> ${p.action}`);
    }
  } else {
    console.log("\n   PREDICTION ARB: Ninguna encontrada");
  }

  // === SUMMARY ===
  console.log("\n" + "=".repeat(80));
  console.log(
    `   Surebets: ${results.surebets.length} | Value bets: ${results.valueBets.length} | Prediction: ${results.predictionArb.length}`
  );
  console.log(
    `   Proximo scan: ${SCAN_INTERVAL_MS / 60000} min | Ctrl+C = salir | Datos: ${LOG_FILE}`
  );
  console.log("=".repeat(80));
}

// ============================================================
// UTILS
// ============================================================

function formatSport(key) {
  const names = {
    soccer_spain_la_liga: "La Liga",
    soccer_uefa_champs_league: "Champions",
    soccer_epl: "Premier League",
    soccer_germany_bundesliga: "Bundesliga",
    soccer_italy_serie_a: "Serie A",
    soccer_france_ligue_one: "Ligue 1",
    basketball_nba: "NBA",
    basketball_euroleague: "Euroleague",
    tennis_atp_french_open: "Tennis ATP",
    mma_mixed_martial_arts: "MMA/UFC",
  };
  return names[key] || key.replace(/_/g, " ").slice(0, 20);
}

function formatDate(iso) {
  if (!iso) return "?";
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function log(src, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${src}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function saveResults() {
  fs.writeFileSync(
    LOG_FILE,
    JSON.stringify({
      lastUpdate: new Date().toISOString(),
      totalScans,
      apiCallsUsed,
      apiCallsRemaining,
      results,
    }, null, 2)
  );
}

process.on("SIGINT", () => {
  saveResults();
  console.log("\n\n" + "=".repeat(50));
  console.log("   RESUMEN — BETTING SCANNER");
  console.log("=".repeat(50));
  console.log(`   Scans: ${totalScans}`);
  console.log(`   Surebets: ${results.surebets.length}`);
  console.log(`   Value bets: ${results.valueBets.length}`);
  console.log(`   Prediction arb: ${results.predictionArb.length}`);
  console.log(`   API calls used: ${apiCallsUsed}`);
  console.log(`   Datos: ${LOG_FILE}`);
  console.log("=".repeat(50));
  process.exit(0);
});

// ============================================================
// MAIN
// ============================================================

async function scan() {
  totalScans++;
  const t0 = Date.now();

  log("SCAN", `#${totalScans} iniciando...`);

  const sports = await scanSurebets();
  await sleep(2000);
  const predictions = await scanPredictionArb();

  results = {
    surebets: sports.surebets,
    valueBets: sports.valueBets,
    predictionArb: predictions,
  };

  printDashboard();
  saveResults();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log("SCAN", `#${totalScans} completado en ${elapsed}s`);
}

async function main() {
  console.log("=".repeat(80));
  console.log("   BETTING SCANNER");
  console.log("   Surebets + Value Bets + Prediction Market Arbitrage");
  console.log("=".repeat(80));
  console.log(`   Sports API: ${ODDS_API_KEY ? "ACTIVA" : "DESACTIVADA — pon ODDS_API_KEY"}`);
  console.log(`   Prediction: Polymarket + Manifold`);
  console.log(`   Scan: cada ${SCAN_INTERVAL_MS / 60000} min`);
  console.log("");

  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}

main().catch(console.error);
