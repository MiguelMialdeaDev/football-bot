// ============================================================
// OPPORTUNITY SCANNER — Multi-source money opportunity finder
// Scans: DeFi yields, prediction market arbitrage,
//        sports odds, crypto trends
// All FREE APIs, no capital needed
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================
const LOG_FILE = "opportunities.json";
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // Every 30 min
const MIN_DEFI_APY = 10; // Minimum APY to show
const MIN_DEFI_TVL = 500_000; // Minimum TVL $500K (safety)
const MIN_PREDICTION_ARB = 0.05; // 5% difference between platforms
const MIN_SPORTS_ARB_PCT = 0.5; // 0.5% guaranteed profit
const ODDS_API_KEY = ""; // Get free key at the-odds-api.com

// ============================================================
// STATE
// ============================================================
let totalScans = 0;
let startTime = Date.now();
let allOpportunities = [];
let lastScan = {
  defi: [],
  predictionArb: [],
  sportsArb: [],
  cryptoTrending: [],
};

// ============================================================
// 1. DEFI YIELDS — DeFiLlama (no auth, unlimited)
// ============================================================

async function scanDeFiYields() {
  log("DEFI", "Scanning DeFi yields...");

  try {
    const res = await fetch("https://yields.llama.fi/pools");
    const data = await res.json();

    if (!data.data) return [];

    // Filter: high APY, decent TVL, stable or single-exposure
    const opportunities = data.data
      .filter(
        (p) =>
          p.apy >= MIN_DEFI_APY &&
          p.tvlUsd >= MIN_DEFI_TVL &&
          p.apy < 300 && // Filter out scams/bugs/temporary incentives
          p.ilRisk !== "yes" // No impermanent loss
      )
      .sort((a, b) => b.apy - a.apy)
      .slice(0, 20)
      .map((p) => ({
        type: "DEFI_YIELD",
        source: "DeFiLlama",
        protocol: p.project,
        chain: p.chain,
        symbol: p.symbol,
        apy: p.apy.toFixed(2) + "%",
        apyNum: p.apy,
        tvl: "$" + formatNum(p.tvlUsd),
        stablecoin: p.stablecoin ? "YES" : "no",
        ilRisk: p.ilRisk || "no",
        prediction: p.predictions?.predictedClass || "?",
        url: `https://defillama.com/yields/pool/${p.pool}`,
        riskScore: calculateDeFiRisk(p),
      }));

    // Also find EUR-relevant pools
    const eurPools = data.data
      .filter(
        (p) =>
          p.symbol &&
          (p.symbol.includes("EUR") || p.symbol.includes("EURS")) &&
          p.apy >= 3 &&
          p.tvlUsd >= 100_000
      )
      .sort((a, b) => b.apy - a.apy)
      .slice(0, 5)
      .map((p) => {
        // Detect IL risk: if paired with volatile asset (ETH, BTC, etc.)
        const hasVolatile = /WETH|ETH|BTC|WBTC|CBBTC/.test(p.symbol || "");
        return {
          type: "DEFI_YIELD_EUR",
          source: "DeFiLlama",
          protocol: p.project,
          chain: p.chain,
          symbol: p.symbol,
          apy: p.apy.toFixed(2) + "%",
          apyNum: p.apy,
          tvl: "$" + formatNum(p.tvlUsd),
          stablecoin: !hasVolatile,
          ilWarning: hasVolatile ? "IL RISK (volatile pair)" : "Safe (stable pair)",
          note: hasVolatile
            ? "EUR pool pero con IL risk — el APY compensa?"
            : "EUR stablecoin — sin riesgo divisa ni IL",
        };
      });

    log("DEFI", `${opportunities.length} yields + ${eurPools.length} EUR pools found`);
    return [...opportunities, ...eurPools];
  } catch (err) {
    log("DEFI", `Error: ${err.message}`);
    return [];
  }
}

function calculateDeFiRisk(pool) {
  let risk = 0;
  if (pool.tvlUsd < 1_000_000) risk += 2;
  else if (pool.tvlUsd < 10_000_000) risk += 1;

  if (pool.apy > 100) risk += 3;
  else if (pool.apy > 50) risk += 2;
  else if (pool.apy > 20) risk += 1;

  if (pool.ilRisk === "yes") risk += 2;
  if (!pool.stablecoin) risk += 1;
  if (!pool.audits || pool.audits === "0") risk += 1;

  return Math.min(10, risk); // 0 = safe, 10 = very risky
}

// ============================================================
// 2. PREDICTION MARKET ARBITRAGE — Polymarket vs Manifold
// ============================================================

async function scanPredictionArbitrage() {
  log("PREDICT", "Scanning prediction market arbitrage...");

  try {
    // Get top Polymarket events (not individual markets)
    const pmRes = await fetch(
      "https://gamma-api.polymarket.com/events?closed=false&order=volume24hr&ascending=false&limit=30"
    );
    const pmEvents = await pmRes.json();

    const arbOpportunities = [];

    // For each PM event, search Manifold for similar market
    for (const event of pmEvents) {
      if (!event.markets || event.markets.length === 0) continue;

      // Get the main binary market from this event
      for (const pm of event.markets) {
        if (!pm.question || !pm.outcomePrices || !pm.active || pm.closed) continue;

        let pmYes;
        try {
          const prices = typeof pm.outcomePrices === "string"
            ? JSON.parse(pm.outcomePrices) : pm.outcomePrices;
          pmYes = parseFloat(prices[0]);
        } catch { continue; }

        if (!pmYes || pmYes <= 0.01 || pmYes >= 0.99) continue;

        // Extract 2-3 key search terms from the question
        const searchTerms = extractSearchTerms(pm.question);
        if (!searchTerms) continue;

        // Search Manifold for this specific topic
        await sleep(500);
        try {
          const mfRes = await fetch(
            `https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(searchTerms)}&sort=score&limit=5`
          );
          const mfResults = await mfRes.json();

          for (const mf of mfResults) {
            if (!mf.question || mf.isResolved || mf.outcomeType !== "BINARY") continue;

            const mfYes = mf.probability;
            if (!mfYes || mfYes <= 0.01 || mfYes >= 0.99) continue;

            // Verify match quality — must share >50% of keywords
            const pmKeywords = extractKeywords(pm.question);
            const mfKeywords = extractKeywords(mf.question);
            const overlap = pmKeywords.filter(k => mfKeywords.includes(k));
            const overlapRatio = overlap.length / Math.min(pmKeywords.length, mfKeywords.length);
            if (overlap.length < 3 || overlapRatio < 0.4) continue;

            const diff = Math.abs(pmYes - mfYes);
            if (diff >= MIN_PREDICTION_ARB) {
              // Skip if diff is suspiciously large (>60%) — likely different questions
              if (diff > 0.60) continue;

              // Avoid duplicates
              const exists = arbOpportunities.some(
                a => a.question === pm.question.slice(0, 80)
              );
              if (exists) continue;

              arbOpportunities.push({
                type: "PREDICTION_ARB",
                source: "Polymarket vs Manifold",
                question: pm.question.slice(0, 80),
                manifoldQ: mf.question.slice(0, 60),
                polymarketYes: (pmYes * 100).toFixed(1) + "%",
                manifoldYes: (mfYes * 100).toFixed(1) + "%",
                diff: (diff * 100).toFixed(1) + "%",
                diffNum: diff,
                action: pmYes < mfYes
                  ? "BUY YES on Polymarket, NO on Manifold"
                  : "BUY YES on Manifold, NO on Polymarket",
                pmUrl: `https://polymarket.com`,
                mfUrl: mf.url || "",
                pmVolume: pm.volume || "0",
                mfBettors: mf.uniqueBettorCount || 0,
              });
            }
          }
        } catch {}
      }

      // Limit API calls per scan
      if (arbOpportunities.length >= 15) break;
    }

    arbOpportunities.sort((a, b) => b.diffNum - a.diffNum);
    log("PREDICT", `${arbOpportunities.length} arbitrage opportunities found`);
    return arbOpportunities.slice(0, 15);
  } catch (err) {
    log("PREDICT", `Error: ${err.message}`);
    return [];
  }
}

function extractSearchTerms(question) {
  // Extract the most distinctive 2-3 words for searching
  const words = extractKeywords(question);
  // Prioritize proper nouns (capitalized in original), names, specific terms
  const original = question.split(/\s+/);
  const properNouns = original.filter(
    w => w.length > 2 && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase()
  ).map(w => w.replace(/[^a-zA-Z]/g, "")).filter(w => w.length > 2);

  if (properNouns.length >= 2) return properNouns.slice(0, 3).join(" ");
  if (words.length >= 2) return words.slice(0, 3).join(" ");
  return null;
}

function extractKeywords(question) {
  const stopwords = new Set([
    "will", "the", "be", "in", "on", "by", "a", "an", "of", "to",
    "is", "for", "and", "or", "this", "that", "with", "from", "at",
    "has", "have", "had", "do", "does", "did", "not", "no", "yes",
    "before", "after", "above", "below", "than", "more", "less",
    "what", "when", "where", "who", "how", "which", "would", "could",
    "should", "can", "may", "might", "shall", "its", "it", "was",
  ]);

  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w));
}

// ============================================================
// 3. SPORTS ARBITRAGE — The Odds API (500 free req/month)
// ============================================================

async function scanSportsArbitrage() {
  if (!ODDS_API_KEY) {
    log("SPORTS", "No API key — get one free at the-odds-api.com");
    return [];
  }

  log("SPORTS", "Scanning sports odds...");

  try {
    // Get available sports
    const sportsRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`
    );
    const sports = await sportsRes.json();

    // Focus on popular sports with most arbitrage
    const targetSports = sports
      .filter((s) => s.active && !s.has_outrights)
      .map((s) => s.key)
      .slice(0, 5); // Limit to save API calls

    const arbOpps = [];

    for (const sport of targetSports) {
      await sleep(1000);

      const oddsRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`
      );
      const events = await oddsRes.json();

      if (!Array.isArray(events)) continue;

      for (const event of events) {
        if (!event.bookmakers || event.bookmakers.length < 2) continue;

        // Find best odds for each outcome across all bookmakers
        const outcomes = {};

        for (const bm of event.bookmakers) {
          for (const market of bm.markets) {
            if (market.key !== "h2h") continue;

            for (const outcome of market.outcomes) {
              if (
                !outcomes[outcome.name] ||
                outcome.price > outcomes[outcome.name].price
              ) {
                outcomes[outcome.name] = {
                  price: outcome.price,
                  bookmaker: bm.key,
                };
              }
            }
          }
        }

        // Calculate arbitrage percentage
        const outcomeList = Object.entries(outcomes);
        if (outcomeList.length < 2) continue;

        const sumInverse = outcomeList.reduce(
          (sum, [, data]) => sum + 1 / data.price,
          0
        );
        const arbPct = (1 - sumInverse) * 100;

        if (arbPct > MIN_SPORTS_ARB_PCT) {
          const profit = arbPct.toFixed(2);
          arbOpps.push({
            type: "SPORTS_ARB",
            source: "The Odds API",
            sport: sport,
            event: `${event.home_team} vs ${event.away_team}`,
            date: event.commence_time,
            profitPct: profit + "%",
            profitNum: arbPct,
            bets: outcomeList.map(([name, data]) => ({
              outcome: name,
              odds: data.price,
              bookmaker: data.bookmaker,
              stake:
                ((1 / data.price / sumInverse) * 100).toFixed(1) + "%",
            })),
          });
        }
      }
    }

    arbOpps.sort((a, b) => b.profitNum - a.profitNum);
    log("SPORTS", `${arbOpps.length} arbitrage opportunities found`);
    return arbOpps.slice(0, 10);
  } catch (err) {
    log("SPORTS", `Error: ${err.message}`);
    return [];
  }
}

// ============================================================
// 4. CRYPTO TRENDS — CoinGecko (no auth)
// ============================================================

async function scanCryptoTrends() {
  log("CRYPTO", "Scanning crypto trends...");

  try {
    // Trending coins
    const trendRes = await fetch(
      "https://api.coingecko.com/api/v3/search/trending"
    );
    const trending = await trendRes.json();

    await sleep(3000);

    // Categories for sector rotation
    const catRes = await fetch(
      "https://api.coingecko.com/api/v3/coins/categories"
    );
    const categories = await catRes.json();

    const opportunities = [];

    // Top trending coins
    if (trending.coins) {
      for (const coin of trending.coins.slice(0, 10)) {
        const c = coin.item;
        opportunities.push({
          type: "CRYPTO_TRENDING",
          source: "CoinGecko",
          name: c.name,
          symbol: c.symbol,
          rank: c.market_cap_rank,
          price_btc: c.price_btc?.toFixed(10) || "?",
          change24h: c.data?.price_change_percentage_24h?.eur
            ? c.data.price_change_percentage_24h.eur.toFixed(1) + "%"
            : "?",
          marketCap: c.data?.market_cap || "?",
          note: "Trending — high attention, possible momentum play",
        });
      }
    }

    // Hot categories (sector rotation)
    if (Array.isArray(categories)) {
      const hotCats = categories
        .filter(
          (c) =>
            c.market_cap_change_24h !== null &&
            Math.abs(c.market_cap_change_24h) > 5
        )
        .sort(
          (a, b) =>
            Math.abs(b.market_cap_change_24h) -
            Math.abs(a.market_cap_change_24h)
        )
        .slice(0, 10);

      for (const cat of hotCats) {
        opportunities.push({
          type: "CRYPTO_SECTOR",
          source: "CoinGecko",
          category: cat.name,
          change24h: (cat.market_cap_change_24h || 0).toFixed(1) + "%",
          volume24h: "$" + formatNum(cat.total_volume || 0),
          topCoins: (cat.top_3_coins || []).length + " coins",
          direction:
            cat.market_cap_change_24h > 0 ? "PUMP" : "DUMP",
          note:
            cat.market_cap_change_24h > 10
              ? "Strong momentum — possible entry"
              : cat.market_cap_change_24h < -10
                ? "Crash — possible bottom play"
                : "Moving — watch closely",
        });
      }
    }

    log("CRYPTO", `${opportunities.length} crypto signals found`);
    return opportunities;
  } catch (err) {
    log("CRYPTO", `Error: ${err.message}`);
    return [];
  }
}

// ============================================================
// MAIN SCANNER
// ============================================================

async function scan() {
  totalScans++;
  const t0 = Date.now();

  console.clear();
  console.log("=".repeat(75));
  console.log("   OPPORTUNITY SCANNER — Multi-source money finder");
  console.log("=".repeat(75));
  console.log(`   Scan #${totalScans} | ${new Date().toISOString().slice(0, 19)}`);
  console.log("");

  // Run all scanners with delays to respect rate limits
  const defi = await scanDeFiYields();
  await sleep(2000);
  const predictions = await scanPredictionArbitrage();
  await sleep(2000);
  const sports = await scanSportsArbitrage();
  await sleep(3000);
  const crypto = await scanCryptoTrends();

  lastScan = {
    defi,
    predictionArb: predictions,
    sportsArb: sports,
    cryptoTrending: crypto,
  };

  // Store new opportunities
  const newOpps = [...defi, ...predictions, ...sports, ...crypto].map(
    (o) => ({
      ...o,
      timestamp: new Date().toISOString(),
      scanNum: totalScans,
    })
  );
  allOpportunities.push(...newOpps);

  // Print dashboard
  printDashboard();
  saveResults();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log("SCAN", `#${totalScans} completado en ${elapsed}s | ${newOpps.length} oportunidades`);
}

// ============================================================
// DASHBOARD
// ============================================================

function printDashboard() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  console.log("-".repeat(75));
  console.log(`   Tiempo: ${hrs}h ${mins}m | Scans: ${totalScans}`);
  console.log("-".repeat(75));

  // === DeFi Yields ===
  if (lastScan.defi.length > 0) {
    console.log("\n   TOP DEFI YIELDS (>10% APY, >$500K TVL)");
    console.log(
      "   " +
        "Protocol".padEnd(16) +
        "Chain".padEnd(12) +
        "Token".padEnd(14) +
        "APY".padStart(8) +
        "TVL".padStart(12) +
        "Stable".padStart(7) +
        "Risk".padStart(6)
    );
    console.log("   " + "-".repeat(73));

    const eurPools = lastScan.defi.filter((d) => d.type === "DEFI_YIELD_EUR");
    const regularPools = lastScan.defi.filter((d) => d.type === "DEFI_YIELD");

    if (eurPools.length > 0) {
      console.log("   --- EUR POOLS ---");
      for (const d of eurPools) {
        const warn = d.ilWarning || "";
        console.log(
          "   " +
            d.protocol.slice(0, 14).padEnd(16) +
            d.chain.slice(0, 10).padEnd(12) +
            d.symbol.slice(0, 12).padEnd(14) +
            d.apy.padStart(8) +
            d.tvl.padStart(12) +
            "  " + (warn.includes("IL") ? "⚠IL" : "OK")
        );
      }
      console.log("   --- USD/GENERAL POOLS ---");
    }

    for (const d of regularPools.slice(0, 10)) {
      console.log(
        "   " +
          d.protocol.slice(0, 14).padEnd(16) +
          d.chain.slice(0, 10).padEnd(12) +
          d.symbol.slice(0, 12).padEnd(14) +
          d.apy.padStart(8) +
          d.tvl.padStart(12) +
          (d.stablecoin === "YES" ? "YES" : "no").padStart(7) +
          String(d.riskScore || "?").padStart(6)
      );
    }
  }

  // === Prediction Market Arbitrage ===
  if (lastScan.predictionArb.length > 0) {
    console.log("\n   PREDICTION MARKET ARBITRAGE (Polymarket vs Manifold)");
    console.log(
      "   " +
        "Question".padEnd(45) +
        "PM%".padStart(6) +
        "MF%".padStart(6) +
        "Diff".padStart(7)
    );
    console.log("   " + "-".repeat(64));

    for (const p of lastScan.predictionArb.slice(0, 8)) {
      console.log(
        "   " +
          p.question.slice(0, 43).padEnd(45) +
          p.polymarketYes.padStart(6) +
          p.manifoldYes.padStart(6) +
          p.diff.padStart(7) +
          " <<<"
      );
      console.log(
        "   " +
          ("   MF: " + (p.manifoldQ || "")).slice(0, 70)
      );
    }
  }

  // === Sports Arbitrage ===
  if (lastScan.sportsArb.length > 0) {
    console.log("\n   SPORTS ARBITRAGE (guaranteed profit)");
    console.log(
      "   " +
        "Event".padEnd(35) +
        "Sport".padEnd(15) +
        "Profit".padStart(8)
    );
    console.log("   " + "-".repeat(58));

    for (const s of lastScan.sportsArb.slice(0, 10)) {
      console.log(
        "   " +
          s.event.slice(0, 33).padEnd(35) +
          s.sport.slice(0, 13).padEnd(15) +
          s.profitPct.padStart(8)
      );
      for (const bet of s.bets) {
        console.log(
          `      ${bet.outcome.padEnd(20)} @ ${bet.odds.toFixed(2)} (${bet.bookmaker}) — stake ${bet.stake}`
        );
      }
    }
  } else if (ODDS_API_KEY) {
    console.log("\n   SPORTS: No arbitrage found this scan");
  } else {
    console.log(
      "\n   SPORTS: Sin API key — obten una gratis en the-odds-api.com"
    );
    console.log(
      "   Editala en opportunity-scanner.js linea 8 (ODDS_API_KEY)"
    );
  }

  // === Crypto Trends ===
  if (lastScan.cryptoTrending.length > 0) {
    const trending = lastScan.cryptoTrending.filter(
      (c) => c.type === "CRYPTO_TRENDING"
    );
    const sectors = lastScan.cryptoTrending.filter(
      (c) => c.type === "CRYPTO_SECTOR"
    );

    if (trending.length > 0) {
      console.log("\n   CRYPTO TRENDING (momentum plays)");
      console.log(
        "   " +
          "Coin".padEnd(20) +
          "Symbol".padEnd(8) +
          "Rank".padStart(6) +
          "24h".padStart(8)
      );
      console.log("   " + "-".repeat(42));

      for (const c of trending) {
        console.log(
          "   " +
            c.name.slice(0, 18).padEnd(20) +
            c.symbol.padEnd(8) +
            (c.rank ? "#" + c.rank : "?").padStart(6) +
            (c.change24h || "?").padStart(8)
        );
      }
    }

    if (sectors.length > 0) {
      console.log("\n   CRYPTO SECTORS (rotation signals)");
      console.log(
        "   " +
          "Sector".padEnd(30) +
          "24h".padStart(8) +
          "Dir".padStart(6) +
          "  Signal"
      );
      console.log("   " + "-".repeat(60));

      for (const s of sectors) {
        console.log(
          "   " +
            s.category.slice(0, 28).padEnd(30) +
            s.change24h.padStart(8) +
            s.direction.padStart(6) +
            "  " +
            (s.note || "")
        );
      }
    }
  }

  // === TOP PICKS — Actionable ranking ===
  console.log("\n" + "*".repeat(75));
  console.log("   TOP PICKS — Mejores oportunidades ahora mismo");
  console.log("*".repeat(75));

  let pickNum = 0;

  // Best EUR stablecoin yield (safe)
  const safeEur = lastScan.defi.filter(
    (d) => d.type === "DEFI_YIELD_EUR" && d.stablecoin && d.apyNum >= 10
  );
  if (safeEur.length > 0) {
    pickNum++;
    const best = safeEur[0];
    console.log(`   ${pickNum}. DEFI EUR SAFE: ${best.symbol} en ${best.protocol} (${best.chain})`);
    console.log(`      APY: ${best.apy} | TVL: ${best.tvl} | ${best.ilWarning || "Safe"}`);
    console.log(`      Con €5000: ~€${((best.apyNum / 100) * 5000 / 12).toFixed(0)}/mes estimado`);
  }

  // Best stablecoin yield overall
  const safeStable = lastScan.defi.filter(
    (d) => d.type === "DEFI_YIELD" && d.stablecoin === "YES" && d.riskScore <= 5 && d.apyNum <= 100
  );
  if (safeStable.length > 0) {
    pickNum++;
    const best = safeStable[0];
    console.log(`   ${pickNum}. DEFI STABLE: ${best.symbol} en ${best.protocol} (${best.chain})`);
    console.log(`      APY: ${best.apy} | TVL: ${best.tvl} | Risk: ${best.riskScore}/10`);
    console.log(`      Con €5000: ~€${((best.apyNum / 100) * 5000 / 12).toFixed(0)}/mes estimado`);
  }

  // Best prediction arb
  if (lastScan.predictionArb.length > 0) {
    pickNum++;
    const best = lastScan.predictionArb[0];
    console.log(`   ${pickNum}. PREDICTION ARB: ${best.question}`);
    console.log(`      PM: ${best.polymarketYes} vs MF: ${best.manifoldYes} = ${best.diff} gap`);
    console.log(`      ${best.action}`);
  }

  // Best sports arb
  if (lastScan.sportsArb.length > 0) {
    pickNum++;
    const best = lastScan.sportsArb[0];
    console.log(`   ${pickNum}. SPORTS ARB: ${best.event} — ${best.profitPct} profit garantizado`);
    for (const bet of best.bets) {
      console.log(`      ${bet.outcome} @ ${bet.odds} (${bet.bookmaker}) — stake ${bet.stake}`);
    }
  }

  // Hottest crypto momentum
  const hotCrypto = lastScan.cryptoTrending.filter(
    (c) => c.type === "CRYPTO_TRENDING" && c.change24h && parseFloat(c.change24h) > 10
  );
  if (hotCrypto.length > 0) {
    pickNum++;
    const best = hotCrypto[0];
    console.log(`   ${pickNum}. CRYPTO MOMENTUM: ${best.name} (${best.symbol}) ${best.change24h}`);
    console.log(`      Rank: ${best.rank || "?"} — Trending + subiendo fuerte`);
    console.log(`      CUIDADO: puede ser pump-and-dump si es lowcap`);
  }

  if (pickNum === 0) {
    console.log("   Ninguna oportunidad destacable en este scan");
  }

  console.log("*".repeat(75));

  // === Summary ===
  console.log("");
  const total =
    lastScan.defi.length +
    lastScan.predictionArb.length +
    lastScan.sportsArb.length +
    lastScan.cryptoTrending.length;
  console.log(
    `   Total: ${total} | DeFi: ${lastScan.defi.length} | Prediction: ${lastScan.predictionArb.length} | Sports: ${lastScan.sportsArb.length} | Crypto: ${lastScan.cryptoTrending.length}`
  );
  console.log(
    `   Proximo scan: ${SCAN_INTERVAL_MS / 60000} min | Ctrl+C = salir | Datos: ${LOG_FILE}`
  );
  console.log("=".repeat(75));
}

// ============================================================
// PERSISTENCE & UTILS
// ============================================================

function saveResults() {
  const data = {
    lastUpdate: new Date().toISOString(),
    totalScans,
    lastScan: {
      defiCount: lastScan.defi.length,
      predictionCount: lastScan.predictionArb.length,
      sportsCount: lastScan.sportsArb.length,
      cryptoCount: lastScan.cryptoTrending.length,
    },
    opportunities: lastScan,
  };
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

function log(src, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${src}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatNum(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

process.on("SIGINT", () => {
  saveResults();
  console.log("\n" + "=".repeat(55));
  console.log("   RESUMEN — OPPORTUNITY SCANNER");
  console.log("=".repeat(55));
  console.log(`   Scans: ${totalScans}`);
  console.log(`   Total oportunidades: ${allOpportunities.length}`);
  console.log(`   Datos: ${LOG_FILE}`);
  console.log("=".repeat(55));
  process.exit(0);
});

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("=".repeat(75));
  console.log("   OPPORTUNITY SCANNER");
  console.log("   Fuentes: DeFi Yields + Prediction Markets + Sports + Crypto");
  console.log("=".repeat(75));
  console.log(`   APIs: DeFiLlama, Polymarket, Manifold, CoinGecko${ODDS_API_KEY ? ", The Odds API" : ""}`);
  console.log(`   Scan interval: ${SCAN_INTERVAL_MS / 60000} min`);
  console.log(`   Sports arbitrage: ${ODDS_API_KEY ? "ENABLED" : "DISABLED (no API key)"}`);
  console.log("");

  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}

main().catch(console.error);
