// ============================================================
// POLYMARKET WEATHER BOT — Paper Trading
// Edge: pronósticos meteorológicos GFS ensemble (31 modelos)
// vs. odds de Polymarket en mercados de temperatura
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================
const BANKROLL = 5000;
const MAX_BET = 100;
const KELLY_FRACTION = 0.15; // Quarter-Kelly (conservador)
const MIN_EDGE = 0.08; // 8% mínimo para apostar
const MIN_CONFIDENCE = 0.55;
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // Cada 5 min
const LOG_FILE = "weather-trades.json";

// Cities Polymarket uses (slug format + coordinates)
const CITIES = [
  { name: "Hong Kong", slug: "hong-kong", lat: 22.28, lon: 114.15 },
  { name: "Moscow", slug: "moscow", lat: 55.76, lon: 37.62 },
  { name: "Istanbul", slug: "istanbul", lat: 41.01, lon: 28.98 },
  { name: "Tel Aviv", slug: "tel-aviv", lat: 32.08, lon: 34.78 },
  { name: "New York", slug: "new-york", lat: 40.71, lon: -74.01 },
  { name: "Los Angeles", slug: "los-angeles", lat: 34.05, lon: -118.24 },
  { name: "Chicago", slug: "chicago", lat: 41.88, lon: -87.63 },
  { name: "Miami", slug: "miami", lat: 25.76, lon: -80.19 },
  { name: "London", slug: "london", lat: 51.51, lon: -0.13 },
  { name: "Tokyo", slug: "tokyo", lat: 35.68, lon: 139.69 },
  { name: "Seoul", slug: "seoul", lat: 37.57, lon: 126.98 },
  { name: "Sydney", slug: "sydney", lat: -33.87, lon: 151.21 },
  { name: "Berlin", slug: "berlin", lat: 52.52, lon: 13.41 },
  { name: "Paris", slug: "paris", lat: 48.86, lon: 2.35 },
  { name: "Dubai", slug: "dubai", lat: 25.20, lon: 55.27 },
  { name: "Singapore", slug: "singapore", lat: 1.35, lon: 103.82 },
  { name: "Denver", slug: "denver", lat: 39.74, lon: -104.99 },
  { name: "São Paulo", slug: "sao-paulo", lat: -23.55, lon: -46.63 },
  { name: "Mexico City", slug: "mexico-city", lat: 19.43, lon: -99.13 },
  { name: "Mumbai", slug: "mumbai", lat: 19.08, lon: 72.88 },
];

// ============================================================
// STATE
// ============================================================
let balance = BANKROLL;
let totalScans = 0;
let trades = [];
let activeBets = [];
let startTime = Date.now();
let lastScanResults = { marketsFound: 0, opportunities: 0, cities: [] };

// ============================================================
// POLYMARKET API — Find weather markets
// ============================================================

async function findWeatherMarkets() {
  const allMarkets = [];

  // Search next 7 days
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);

    const year = date.getFullYear();
    const monthNames = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ];
    const month = monthNames[date.getMonth()];
    const day = date.getDate();

    for (const city of CITIES) {
      // Try different slug patterns
      const slugs = [
        `highest-temperature-in-${city.slug}-on-${month}-${day}-${year}`,
        `high-temperature-in-${city.slug}-on-${month}-${day}-${year}`,
        `temperature-in-${city.slug}-on-${month}-${day}-${year}`,
      ];

      for (const slug of slugs) {
        try {
          const res = await fetch(
            `https://gamma-api.polymarket.com/events?slug=${slug}&closed=false`
          );
          const events = await res.json();

          if (events && events.length > 0) {
            const event = events[0];
            if (!event.markets || event.markets.length === 0) continue;

            const outcomes = [];
            for (const market of event.markets) {
              if (!market.active || market.closed) continue;
              if (!market.clobTokenIds || !market.enableOrderBook) continue;

              const temp = extractTemperature(market.question);
              if (temp === null) continue;

              let tokenIds;
              try {
                tokenIds =
                  typeof market.clobTokenIds === "string"
                    ? JSON.parse(market.clobTokenIds)
                    : market.clobTokenIds;
              } catch {
                continue;
              }

              let prices;
              try {
                prices =
                  typeof market.outcomePrices === "string"
                    ? JSON.parse(market.outcomePrices)
                    : market.outcomePrices;
              } catch {
                prices = [0, 0];
              }

              outcomes.push({
                question: market.question,
                temperature: temp.value,
                unit: temp.unit,
                type: temp.type, // "exact", "above", "below", "or_above", "or_below"
                yesPrice: parseFloat(prices[0]) || 0,
                noPrice: parseFloat(prices[1]) || 0,
                yesTokenId: tokenIds[0],
                noTokenId: tokenIds[1],
              });
            }

            if (outcomes.length > 0) {
              allMarkets.push({
                event: event.title,
                slug,
                city: city.name,
                cityData: city,
                date: `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
                outcomes: outcomes.sort((a, b) => a.temperature - b.temperature),
              });
            }
            break; // Found this city+date, skip other slug patterns
          }
        } catch {
          // Skip failed requests
        }
        await sleep(100);
      }
    }
  }

  return allMarkets;
}

function extractTemperature(question) {
  if (!question) return null;

  // "Will the highest temperature in X be 26°C on date?"
  // "Will the highest temperature be above 80°F?"
  // "29°C or above" / "19°C or below"
  const q = question.toLowerCase();

  let unit = "C";
  if (q.includes("°f") || q.includes("°f")) unit = "F";

  // "X°C or above" / "X°C or below"
  let match = question.match(/(\d+)\s*°[CF]\s+or\s+(above|below)/i);
  if (match) {
    return {
      value: parseInt(match[1]),
      unit,
      type: match[2].toLowerCase() === "above" ? "or_above" : "or_below",
    };
  }

  // "above X°C" / "below X°C"
  match = question.match(/(above|below|over|under)\s+(\d+)\s*°/i);
  if (match) {
    return {
      value: parseInt(match[2]),
      unit,
      type: match[1].toLowerCase().startsWith("a") ? "above" : "below",
    };
  }

  // Exact: "be 26°C" or just "26°C"
  match = question.match(/\b(\d+)\s*°[CF]/i);
  if (match) {
    return { value: parseInt(match[1]), unit, type: "exact" };
  }

  // Fallback: any standalone temperature-like number
  match = question.match(/be\s+(\d+)\s*deg/i);
  if (match) {
    return { value: parseInt(match[1]), unit, type: "exact" };
  }

  return null;
}

// ============================================================
// OPEN-METEO — GFS Ensemble Forecast (31 members, FREE)
// ============================================================

async function getEnsembleForecast(lat, lon, date) {
  try {
    // Build member list for daily max temperature
    const memberParams = Array.from(
      { length: 31 },
      (_, i) => `temperature_2m_max_member${String(i).padStart(2, "0")}`
    ).join(",");

    const url =
      `https://ensemble-api.open-meteo.com/v1/ensemble` +
      `?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max` +
      `&models=gfs_seamless` +
      `&start_date=${date}&end_date=${date}` +
      `&temperature_unit=celsius`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.daily) return null;

    // Extract all ensemble member values
    const members = [];
    for (const key of Object.keys(data.daily)) {
      if (key.startsWith("temperature_2m_max_member")) {
        const val = data.daily[key];
        if (Array.isArray(val) && val[0] !== null) {
          members.push(val[0]);
        }
      }
    }

    // Also get the mean
    const mean = data.daily.temperature_2m_max
      ? data.daily.temperature_2m_max[0]
      : null;

    if (members.length === 0 && mean !== null) {
      // Fallback: use mean with synthetic spread
      return { members: [mean], mean, count: 1, source: "gfs_mean" };
    }

    return {
      members,
      mean: mean || members.reduce((a, b) => a + b, 0) / members.length,
      count: members.length,
      source: "gfs_ensemble",
    };
  } catch (err) {
    log("METEO", `Error fetching forecast: ${err.message}`);
    return null;
  }
}

// Also try ECMWF for a second opinion (51 members)
async function getEcmwfForecast(lat, lon, date) {
  try {
    const url =
      `https://ensemble-api.open-meteo.com/v1/ensemble` +
      `?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max` +
      `&models=ecmwf_ifs025` +
      `&start_date=${date}&end_date=${date}` +
      `&temperature_unit=celsius`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.daily) return null;

    const members = [];
    for (const key of Object.keys(data.daily)) {
      if (key.startsWith("temperature_2m_max_member")) {
        const val = data.daily[key];
        if (Array.isArray(val) && val[0] !== null) {
          members.push(val[0]);
        }
      }
    }

    const mean = data.daily.temperature_2m_max
      ? data.daily.temperature_2m_max[0]
      : null;

    if (members.length === 0) return null;

    return {
      members,
      mean: mean || members.reduce((a, b) => a + b, 0) / members.length,
      count: members.length,
      source: "ecmwf_ensemble",
    };
  } catch {
    return null;
  }
}

// ============================================================
// PROBABILITY CALCULATION
// ============================================================

function calculateProbabilities(members, outcomes) {
  const total = members.length;
  if (total === 0) return [];

  return outcomes.map((outcome) => {
    let count = 0;

    if (outcome.type === "exact") {
      // Count members that round to this temperature
      count = members.filter((m) => Math.round(m) === outcome.temperature).length;
    } else if (outcome.type === "above" || outcome.type === "or_above") {
      count = members.filter((m) =>
        outcome.type === "or_above"
          ? Math.round(m) >= outcome.temperature
          : m > outcome.temperature
      ).length;
    } else if (outcome.type === "below" || outcome.type === "or_below") {
      count = members.filter((m) =>
        outcome.type === "or_below"
          ? Math.round(m) <= outcome.temperature
          : m < outcome.temperature
      ).length;
    }

    let modelProb = count / total;
    // Clip to avoid extreme confidence
    modelProb = Math.max(0.02, Math.min(0.95, modelProb));

    return {
      ...outcome,
      modelProb,
      memberCount: count,
      totalMembers: total,
    };
  });
}

// Blend GFS + ECMWF forecasts based on how far out the date is
function blendForecasts(gfs, ecmwf, daysOut) {
  if (!ecmwf || ecmwf.members.length === 0) return gfs.members;
  if (!gfs || gfs.members.length === 0) return ecmwf.members;

  // Weight ECMWF more for further-out forecasts
  let gfsWeight, ecmwfWeight;
  if (daysOut <= 1) {
    gfsWeight = 0.6;
    ecmwfWeight = 0.4;
  } else if (daysOut <= 3) {
    gfsWeight = 0.45;
    ecmwfWeight = 0.55;
  } else {
    gfsWeight = 0.35;
    ecmwfWeight = 0.65;
  }

  // Combine both member arrays (weighted sampling isn't needed — just merge)
  // Use all members from both, the probability calc handles it
  return [...gfs.members, ...ecmwf.members];
}

// ============================================================
// TRADING LOGIC
// ============================================================

function calculateKellyBet(edge, modelProb, currentBalance) {
  if (edge <= 0) return 0;

  // Kelly criterion: f = (bp - q) / b
  // where b = net odds, p = win prob, q = 1-p
  const b = (1 / modelProb) - 1; // decimal odds minus 1
  const p = modelProb;
  const q = 1 - p;
  const kellyFull = (b * p - q) / b;

  if (kellyFull <= 0) return 0;

  // Apply fraction and caps
  const betSize = Math.min(
    kellyFull * KELLY_FRACTION * currentBalance,
    MAX_BET,
    currentBalance * 0.05 // Never bet more than 5% of bankroll
  );

  return Math.max(0, Math.round(betSize * 100) / 100);
}

// ============================================================
// MAIN SCAN
// ============================================================

async function scan() {
  totalScans++;
  const t0 = Date.now();

  log("SCAN", `#${totalScans} iniciando...`);

  // 1. Find weather markets
  const markets = await findWeatherMarkets();
  lastScanResults.marketsFound = markets.length;
  lastScanResults.cities = markets.map((m) => m.city);
  lastScanResults.opportunities = 0;

  if (markets.length === 0) {
    log("SCAN", "No se encontraron mercados de temperatura activos");
    printDashboard();
    return;
  }

  log(
    "SCAN",
    `${markets.length} mercados encontrados: ${[...new Set(markets.map((m) => m.city))].join(", ")}`
  );

  // 2. For each market, get forecast and compare
  for (const market of markets) {
    const daysOut = Math.ceil(
      (new Date(market.date) - new Date()) / (1000 * 60 * 60 * 24)
    );

    // Get forecasts
    const [gfs, ecmwf] = await Promise.all([
      getEnsembleForecast(market.cityData.lat, market.cityData.lon, market.date),
      getEcmwfForecast(market.cityData.lat, market.cityData.lon, market.date),
    ]);

    if (!gfs) {
      log("METEO", `No forecast data for ${market.city} ${market.date}`);
      continue;
    }

    // Blend forecasts
    const blendedMembers = blendForecasts(gfs, ecmwf, daysOut);

    // Calculate model probabilities
    const analyzed = calculateProbabilities(blendedMembers, market.outcomes);

    // Find opportunities
    for (const outcome of analyzed) {
      const edge = outcome.modelProb - outcome.yesPrice;
      const absEdge = Math.abs(edge);

      if (absEdge < MIN_EDGE) continue;
      if (outcome.modelProb < MIN_CONFIDENCE && edge > 0) continue;

      const betSize = calculateKellyBet(absEdge, edge > 0 ? outcome.modelProb : 1 - outcome.modelProb, balance);
      if (betSize < 1) continue;

      lastScanResults.opportunities++;

      const action = edge > 0 ? "BUY YES" : "BUY NO";
      const entryPrice = edge > 0 ? outcome.yesPrice : outcome.noPrice;

      const trade = {
        timestamp: new Date().toISOString(),
        city: market.city,
        date: market.date,
        daysOut,
        question: outcome.question,
        temperature: outcome.temperature,
        type: outcome.type,
        action,
        marketPrice: outcome.yesPrice,
        modelProb: outcome.modelProb,
        edge: edge,
        edgePct: (absEdge * 100).toFixed(1) + "%",
        betSize,
        entryPrice,
        potentialProfit: (betSize * absEdge).toFixed(2),
        forecastMean: gfs.mean.toFixed(1),
        forecastMembers: blendedMembers.length,
        memberCount: outcome.memberCount,
        sources: [gfs.source, ecmwf?.source].filter(Boolean).join("+"),
      };

      trades.push(trade);
      balance -= betSize; // Reserve bet amount
      totalPnL_potential += betSize * absEdge;

      logTrade(trade);
    }

    await sleep(200);
  }

  printDashboard();
  saveTrades();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(
    "SCAN",
    `#${totalScans} completado en ${elapsed}s | ${lastScanResults.opportunities} oportunidades`
  );
}

let totalPnL_potential = 0;

// ============================================================
// OUTPUT
// ============================================================

function logTrade(trade) {
  console.log("");
  console.log("*".repeat(70));
  console.log(`   OPORTUNIDAD — ${trade.action}`);
  console.log("*".repeat(70));
  console.log(`   Ciudad:      ${trade.city}`);
  console.log(`   Fecha:       ${trade.date} (en ${trade.daysOut} dias)`);
  console.log(`   Pregunta:    ${trade.question}`);
  console.log(`   Temp:        ${trade.temperature}°C (${trade.type})`);
  console.log(`   Pronostico:  media ${trade.forecastMean}°C (${trade.forecastMembers} modelos)`);
  console.log(
    `   Modelos OK:  ${trade.memberCount}/${trade.forecastMembers} (${(trade.modelProb * 100).toFixed(1)}%)`
  );
  console.log(
    `   Mercado:     ${(trade.marketPrice * 100).toFixed(1)}% YES`
  );
  console.log(`   Edge:        ${trade.edgePct}`);
  console.log(`   Apuesta:     €${trade.betSize.toFixed(2)} (Kelly ${KELLY_FRACTION})`);
  console.log(
    `   Beneficio est: €${trade.potentialProfit}`
  );
  console.log(`   Fuentes:     ${trade.sources}`);
  console.log("*".repeat(70));
}

function printDashboard() {
  console.log("");
  console.log("=".repeat(70));
  console.log("   WEATHER BOT — Polymarket Paper Trader");
  console.log("=".repeat(70));

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  console.log(`   Tiempo:          ${hrs}h ${mins}m`);
  console.log(`   Scans:           ${totalScans}`);
  console.log(`   Mercados:        ${lastScanResults.marketsFound}`);
  console.log(
    `   Ciudades:        ${[...new Set(lastScanResults.cities)].join(", ") || "ninguna"}`
  );
  console.log("-".repeat(70));
  console.log(`   Balance:         €${balance.toFixed(2)} / €${BANKROLL}`);
  console.log(`   Apostado:        €${(BANKROLL - balance).toFixed(2)}`);
  console.log(`   Trades:          ${trades.length}`);
  console.log(
    `   P&L potencial:   €${totalPnL_potential.toFixed(2)}`
  );
  console.log("-".repeat(70));

  if (trades.length > 0) {
    console.log("");
    console.log("   Ultimos trades:");
    console.log(
      "   " +
        "Hora".padEnd(10) +
        "Ciudad".padEnd(14) +
        "Temp".padEnd(8) +
        "Accion".padEnd(10) +
        "Mkt%".padStart(6) +
        "Mod%".padStart(6) +
        "Edge".padStart(6) +
        "Bet€".padStart(7)
    );
    console.log("   " + "-".repeat(67));

    for (const t of trades.slice(-10)) {
      console.log(
        "   " +
          t.timestamp.slice(11, 19).padEnd(10) +
          t.city.slice(0, 12).padEnd(14) +
          `${t.temperature}°C`.padEnd(8) +
          t.action.padEnd(10) +
          (t.marketPrice * 100).toFixed(1).padStart(5) + "%" +
          (t.modelProb * 100).toFixed(1).padStart(5) + "%" +
          t.edgePct.padStart(6) +
          ("€" + t.betSize.toFixed(0)).padStart(7)
      );
    }

    // Stats
    console.log("");
    const byCity = {};
    for (const t of trades) {
      byCity[t.city] = (byCity[t.city] || 0) + 1;
    }
    console.log("   Trades por ciudad:");
    for (const [city, count] of Object.entries(byCity).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`     ${city}: ${count}`);
    }
  }

  console.log("");
  console.log("=".repeat(70));
  console.log(
    `   Config: edge>${MIN_EDGE * 100}% | Kelly ${KELLY_FRACTION} | max €${MAX_BET}/trade`
  );
  console.log(
    `   Proximo scan en ${SCAN_INTERVAL_MS / 60000} min | Ctrl+C para parar`
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
    balance,
    bankroll: BANKROLL,
    totalBet: BANKROLL - balance,
    totalPnL_potential,
    trades,
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
  console.log("   RESUMEN FINAL — WEATHER BOT");
  console.log("=".repeat(55));
  console.log(`   Scans:           ${totalScans}`);
  console.log(`   Trades:          ${trades.length}`);
  console.log(`   Apostado:        €${(BANKROLL - balance).toFixed(2)}`);
  console.log(`   P&L potencial:   €${totalPnL_potential.toFixed(2)}`);
  console.log(`   Datos:           ${LOG_FILE}`);

  if (trades.length > 0) {
    const avgEdge =
      trades.reduce((s, t) => s + parseFloat(t.edgePct), 0) / trades.length;
    console.log(`   Edge medio:      ${avgEdge.toFixed(1)}%`);
  }

  console.log("=".repeat(55));
  process.exit(0);
});

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");
  console.log("=".repeat(70));
  console.log("   POLYMARKET WEATHER BOT");
  console.log("   Edge: GFS+ECMWF ensemble vs market odds");
  console.log("=".repeat(70));
  console.log(`   Bankroll:     €${BANKROLL}`);
  console.log(`   Max bet:      €${MAX_BET}`);
  console.log(`   Min edge:     ${MIN_EDGE * 100}%`);
  console.log(`   Kelly:        ${KELLY_FRACTION} (quarter-Kelly)`);
  console.log(`   Ciudades:     ${CITIES.length}`);
  console.log(`   Scan:         cada ${SCAN_INTERVAL_MS / 60000} min`);
  console.log(`   Fuentes:      GFS (31 members) + ECMWF (51 members)`);
  console.log("");

  // First scan immediately
  await scan();

  // Continue scanning
  setInterval(scan, SCAN_INTERVAL_MS);
}

main().catch(console.error);
