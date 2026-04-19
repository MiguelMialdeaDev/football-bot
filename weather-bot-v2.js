// ============================================================
// POLYMARKET WEATHER BOT v2 — Paper Trading
// Fixed: proper temperature parsing + verbose edge logging
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================
const BANKROLL = 5000;
const MAX_BET = 100;
const KELLY_FRACTION = 0.15;
const MIN_EDGE = 0.10; // 10% mínimo (post-calibración)
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 min (respetar rate limits)
const LOG_FILE = "weather-v2-trades.json";

const CITIES = [
  { name: "Hong Kong", slug: "hong-kong", lat: 22.28, lon: 114.15, usesF: false },
  { name: "Moscow", slug: "moscow", lat: 55.76, lon: 37.62, usesF: false },
  { name: "Istanbul", slug: "istanbul", lat: 41.01, lon: 28.98, usesF: false },
  { name: "Tel Aviv", slug: "tel-aviv", lat: 32.08, lon: 34.78, usesF: false },
  { name: "New York", slug: "new-york", lat: 40.71, lon: -74.01, usesF: true },
  { name: "Los Angeles", slug: "los-angeles", lat: 34.05, lon: -118.24, usesF: true },
  { name: "Chicago", slug: "chicago", lat: 41.88, lon: -87.63, usesF: true },
  { name: "Miami", slug: "miami", lat: 25.76, lon: -80.19, usesF: true },
  { name: "London", slug: "london", lat: 51.51, lon: -0.13, usesF: false },
  { name: "Tokyo", slug: "tokyo", lat: 35.68, lon: 139.69, usesF: false },
  { name: "Seoul", slug: "seoul", lat: 37.57, lon: 126.98, usesF: false },
  { name: "Sydney", slug: "sydney", lat: -33.87, lon: 151.21, usesF: false },
  { name: "Berlin", slug: "berlin", lat: 52.52, lon: 13.41, usesF: false },
  { name: "Paris", slug: "paris", lat: 48.86, lon: 2.35, usesF: false },
  { name: "Dubai", slug: "dubai", lat: 25.20, lon: 55.27, usesF: false },
  { name: "Singapore", slug: "singapore", lat: 1.35, lon: 103.82, usesF: false },
  { name: "Denver", slug: "denver", lat: 39.74, lon: -104.99, usesF: true },
  { name: "São Paulo", slug: "sao-paulo", lat: -23.55, lon: -46.63, usesF: false },
  { name: "Mexico City", slug: "mexico-city", lat: 19.43, lon: -99.13, usesF: false },
  { name: "Mumbai", slug: "mumbai", lat: 19.08, lon: 72.88, usesF: false },
];

// ============================================================
// STATE
// ============================================================
let balance = BANKROLL;
let totalScans = 0;
let trades = [];
let totalPnL = 0;
let startTime = Date.now();
let lastScan = { markets: 0, opportunities: 0, cities: [] };

// ============================================================
// POLYMARKET — Find weather markets
// ============================================================

async function findWeatherMarkets() {
  const allMarkets = [];

  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);

    const year = date.getFullYear();
    const months = [
      "january","february","march","april","may","june",
      "july","august","september","october","november","december",
    ];
    const month = months[date.getMonth()];
    const day = date.getDate();

    for (const city of CITIES) {
      const slug = `highest-temperature-in-${city.slug}-on-${month}-${day}-${year}`;

      try {
        const res = await fetch(
          `https://gamma-api.polymarket.com/events?slug=${slug}&closed=false`
        );
        const events = await res.json();
        if (!events || events.length === 0) continue;

        const event = events[0];
        if (!event.markets || event.markets.length === 0) continue;

        const outcomes = [];
        for (const market of event.markets) {
          if (!market.active || market.closed) continue;
          if (!market.clobTokenIds || !market.enableOrderBook) continue;

          const temp = parseTemp(market.question);
          if (temp === null) continue;

          let tokenIds, prices;
          try {
            tokenIds = typeof market.clobTokenIds === "string"
              ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
            prices = typeof market.outcomePrices === "string"
              ? JSON.parse(market.outcomePrices) : market.outcomePrices;
          } catch { continue; }

          // Use city's known unit instead of regex detection
          const usesF = city.usesF;

          outcomes.push({
            question: market.question,
            temp: temp.value,
            type: temp.type,
            fahrenheit: usesF,
            yesPrice: parseFloat(prices[0]) || 0,
            noPrice: parseFloat(prices[1]) || 0,
            yesTokenId: tokenIds[0],
          });
        }

        if (outcomes.length > 0) {
          allMarkets.push({
            event: event.title,
            city: city.name,
            cityData: city,
            date: `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            daysOut: dayOffset,
            outcomes: outcomes.sort((a, b) => a.temp - b.temp),
          });
        }
      } catch {}
      await sleep(1500);
    }
  }
  return allMarkets;
}

function parseTemp(question) {
  if (!question) return null;

  // Detect unit — handle various degree symbols (°, º, ˚, deg)
  // Check for F after any degree-like symbol or "deg"
  const isFahrenheit = /[°ºo˚]\s*F/i.test(question) || /degF/i.test(question);
  const isCelsius = /[°ºo˚]\s*C/i.test(question) || /degC/i.test(question);

  // "24°C or higher" / "or above"
  let m = question.match(/(\d+)\s*[°ºo˚]\s*[CF]\s+or\s+(higher|above)/i);
  if (m) return { value: parseInt(m[1]), type: "or_above", fahrenheit: isFahrenheit };

  // "14°C or below" / "or lower"
  m = question.match(/(\d+)\s*[°ºo˚]\s*[CF]\s+or\s+(below|lower)/i);
  if (m) return { value: parseInt(m[1]), type: "or_below", fahrenheit: isFahrenheit };

  // "be 21°C on"
  m = question.match(/be\s+(\d+)\s*[°ºo˚]\s*[CF]/i);
  if (m) return { value: parseInt(m[1]), type: "exact", fahrenheit: isFahrenheit };

  // Fallback: any number before degree symbol
  m = question.match(/(\d+)\s*[°ºo˚]\s*[CF]/i);
  if (m) return { value: parseInt(m[1]), type: "exact", fahrenheit: isFahrenheit };

  // "between 70-71°F" — range format, use upper bound
  m = question.match(/between\s+(\d+)\s*[-–]\s*(\d+)/i);
  if (m) return { value: parseInt(m[2]), type: "exact", fahrenheit: false };

  // Last resort: just a number
  m = question.match(/be\s+(\d+)\b/);
  if (m) return { value: parseInt(m[1]), type: "exact", fahrenheit: false };

  return null;
}

function fToC(f) { return (f - 32) * 5 / 9; }
function cToF(c) { return c * 9 / 5 + 32; }

// ============================================================
// BIAS CORRECTION
// Based on verification data: GFS has a cold bias of ~2°C
// Verified against actual temps on 2026-04-06:
//   London: -2.0°C, HK: -0.8°C, Tel Aviv: -2.8°C,
//   Paris: -0.3°C, Moscow: -1.9°C, Istanbul: -2.6°C
// We add a warm correction to each ensemble member
// ============================================================
const GFS_BIAS_CORRECTION = 1.0; // °C warm bias correction (conservative)
const ECMWF_BIAS_CORRECTION = 0.5; // ECMWF is typically more accurate

// Wider probability bands to account for model uncertainty
// Instead of exact rounding, use a gaussian-like spread
function probWithUncertainty(members, targetTemp, isFahrenheit) {
  const total = members.length;
  if (total === 0) return 0;

  // For exact matches: count members within ±0.5°C of target (after rounding)
  // Plus a small base probability for adjacent temps to account for model error
  let count = 0;
  for (const m of members) {
    const val = isFahrenheit ? cToF(m) : m;
    const diff = Math.abs(val - targetTemp);
    if (diff < 0.5) {
      count += 1.0; // Direct hit
    } else if (diff < 1.5) {
      count += 0.3; // Adjacent temp - partial credit for model uncertainty
    } else if (diff < 2.5) {
      count += 0.05; // 2 degrees off - tiny credit
    }
  }

  return Math.max(0.02, Math.min(0.95, count / total));
}

// ============================================================
// OPEN-METEO — Ensemble Forecasts
// ============================================================

async function getForecast(lat, lon, date, model) {
  try {
    const url =
      `https://ensemble-api.open-meteo.com/v1/ensemble` +
      `?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max` +
      `&models=${model}` +
      `&start_date=${date}&end_date=${date}` +
      `&temperature_unit=celsius`;

    const res = await fetch(url);
    const data = await res.json();
    if (!data.daily) return null;

    const members = [];
    for (const key of Object.keys(data.daily)) {
      if (key.startsWith("temperature_2m_max_member")) {
        const val = data.daily[key];
        if (Array.isArray(val) && val[0] !== null) members.push(val[0]);
      }
    }

    const mean = data.daily.temperature_2m_max?.[0];
    if (members.length === 0) return null;

    // Apply bias correction
    const correction = model.includes("ecmwf") ? ECMWF_BIAS_CORRECTION : GFS_BIAS_CORRECTION;
    const correctedMembers = members.map(m => m + correction);
    const correctedMean = (mean || avg(members)) + correction;

    return { members: correctedMembers, mean: correctedMean, source: model };
  } catch {
    return null;
  }
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ============================================================
// PROBABILITY + EDGE CALCULATION
// ============================================================

function analyzeMarket(membersInCelsius, outcomes) {
  const total = membersInCelsius.length;
  const results = [];

  for (const o of outcomes) {
    // Convert threshold to Celsius if market uses Fahrenheit
    // (our forecast data is always in Celsius)
    const thresholdC = o.fahrenheit ? fToC(o.temp) : o.temp;

    let count = 0;

    if (o.type === "exact") {
      // Use uncertainty-aware probability for exact matches
      const prob = probWithUncertainty(membersInCelsius, o.temp, o.fahrenheit);
      const modelProb = Math.max(0.02, Math.min(0.95, prob));
      const edge = modelProb - o.yesPrice;
      results.push({
        ...o, modelProb, memberCount: Math.round(prob * total),
        totalMembers: total, edge, absEdge: Math.abs(edge),
        thresholdC: (o.fahrenheit ? fToC(o.temp) : o.temp).toFixed(1),
      });
      continue;
    } else if (o.type === "or_above") {
      if (o.fahrenheit) {
        count = membersInCelsius.filter((m) => Math.round(cToF(m)) >= o.temp).length;
      } else {
        count = membersInCelsius.filter((m) => Math.round(m) >= o.temp).length;
      }
    } else if (o.type === "or_below") {
      if (o.fahrenheit) {
        count = membersInCelsius.filter((m) => Math.round(cToF(m)) <= o.temp).length;
      } else {
        count = membersInCelsius.filter((m) => Math.round(m) <= o.temp).length;
      }
    }

    const modelProb = Math.max(0.02, Math.min(0.95, count / total));
    const edge = modelProb - o.yesPrice;

    results.push({
      ...o,
      modelProb,
      memberCount: count,
      totalMembers: total,
      edge,
      absEdge: Math.abs(edge),
      thresholdC: thresholdC.toFixed(1),
    });
  }

  return results;
}

function kellyBet(modelProb, marketPrice, bal) {
  // Kelly criterion: f = (b*p - q) / b
  // p = model probability of winning
  // q = 1 - p
  // b = net odds from market price (what you win per $1 bet)
  if (marketPrice <= 0 || marketPrice >= 1) return 0;

  const p = modelProb;
  const q = 1 - p;
  const b = (1 - marketPrice) / marketPrice; // e.g., buy at 0.30 → win 0.70 per 0.30 = 2.33

  const kellyFull = (b * p - q) / b;
  if (kellyFull <= 0) return 0;

  return Math.min(
    kellyFull * KELLY_FRACTION * bal,
    MAX_BET,
    bal * 0.05
  );
}

// ============================================================
// MAIN SCAN
// ============================================================

async function scan() {
  totalScans++;
  const t0 = Date.now();
  log("SCAN", `#${totalScans} iniciando...`);

  const markets = await findWeatherMarkets();
  lastScan.markets = markets.length;
  lastScan.cities = [...new Set(markets.map((m) => m.city))];
  lastScan.opportunities = 0;

  if (markets.length === 0) {
    log("SCAN", "No weather markets found");
    printDashboard([]);
    return;
  }

  log("SCAN", `${markets.length} mercados en ${lastScan.cities.length} ciudades`);

  const allAnalyzed = [];

  for (const market of markets) {
    // Get GFS + ECMWF forecasts
    const [gfs, ecmwf] = await Promise.all([
      getForecast(market.cityData.lat, market.cityData.lon, market.date, "gfs_seamless"),
      getForecast(market.cityData.lat, market.cityData.lon, market.date, "ecmwf_ifs025"),
    ]);

    if (!gfs) continue;

    // Blend members
    const members = ecmwf
      ? [...gfs.members, ...ecmwf.members]
      : gfs.members;

    // Analyze
    const analyzed = analyzeMarket(members, market.outcomes);

    allAnalyzed.push({
      city: market.city,
      date: market.date,
      daysOut: market.daysOut,
      forecastMean: avg(members).toFixed(1),
      memberCount: members.length,
      sources: [gfs.source, ecmwf?.source].filter(Boolean).join("+"),
      outcomes: analyzed,
    });

    // Find opportunities
    for (const a of analyzed) {
      if (a.absEdge < MIN_EDGE) continue;

      const action = a.edge > 0 ? "BUY YES" : "BUY NO";
      // For BUY YES: we believe modelProb, buying at yesPrice
      // For BUY NO: we believe (1-modelProb) for NO, buying at noPrice
      const betProb = a.edge > 0 ? a.modelProb : 1 - a.modelProb;
      const betPrice = a.edge > 0 ? a.yesPrice : a.noPrice;
      const bet = kellyBet(betProb, betPrice, balance);
      if (bet < 1) continue;

      lastScan.opportunities++;

      const trade = {
        timestamp: new Date().toISOString(),
        city: market.city,
        date: market.date,
        daysOut: market.daysOut,
        question: a.question,
        temp: a.temp,
        type: a.type,
        action,
        marketYes: (a.yesPrice * 100).toFixed(1) + "%",
        modelProb: (a.modelProb * 100).toFixed(1) + "%",
        edge: (a.edge * 100).toFixed(1) + "%",
        absEdge: (a.absEdge * 100).toFixed(1) + "%",
        members: `${a.memberCount}/${a.totalMembers}`,
        betSize: Math.round(bet * 100) / 100,
        expectedProfit: (bet * a.absEdge).toFixed(2),
        forecastMean: avg(members).toFixed(1) + "°C",
        sources: [gfs.source, ecmwf?.source].filter(Boolean).join("+"),
      };

      trades.push(trade);
      balance -= bet;
      totalPnL += bet * a.absEdge;

      logTrade(trade);
    }

    await sleep(2000);
  }

  printDashboard(allAnalyzed);
  saveTrades();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log("SCAN", `#${totalScans} completado en ${elapsed}s | ${lastScan.opportunities} oportunidades`);
}

// ============================================================
// OUTPUT
// ============================================================

function logTrade(t) {
  console.log("");
  console.log("$".repeat(70));
  console.log(`   TRADE — ${t.action} @ ${t.city}`);
  console.log("$".repeat(70));
  console.log(`   Pregunta:    ${t.question}`);
  console.log(`   Fecha:       ${t.date} (${t.daysOut}d)`);
  console.log(`   Pronostico:  ${t.forecastMean} media (${t.sources})`);
  console.log(`   Modelos:     ${t.members} dicen ${t.temp}°C (${t.type})`);
  console.log(`   Mercado:     ${t.marketYes} YES`);
  console.log(`   Modelo:      ${t.modelProb}`);
  console.log(`   EDGE:        ${t.edge}`);
  console.log(`   Apuesta:     €${t.betSize}`);
  console.log(`   Profit est:  €${t.expectedProfit}`);
  console.log("$".repeat(70));
}

function printDashboard(allAnalyzed) {
  console.log("");
  console.log("=".repeat(75));
  console.log("   WEATHER BOT v2 — Polymarket Paper Trader");
  console.log("=".repeat(75));

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  console.log(`   Tiempo:       ${hrs}h ${mins}m | Scans: ${totalScans}`);
  console.log(`   Mercados:     ${lastScan.markets} en ${lastScan.cities.length} ciudades`);
  console.log("-".repeat(75));
  console.log(`   Balance:      €${balance.toFixed(2)} / €${BANKROLL}`);
  console.log(`   Trades:       ${trades.length}`);
  console.log(`   P&L esperado: €${totalPnL.toFixed(2)}`);
  console.log("-".repeat(75));

  // Show ALL edges (not just >8%) for visibility
  if (allAnalyzed.length > 0) {
    console.log("");
    console.log("   Mejores edges detectados:");
    console.log(
      "   " +
        "Ciudad".padEnd(14) +
        "Fecha".padEnd(12) +
        "Temp".padEnd(10) +
        "Tipo".padEnd(10) +
        "Mkt%".padStart(6) +
        "Mod%".padStart(6) +
        "Edge%".padStart(7) +
        " Signal"
    );
    console.log("   " + "-".repeat(71));

    // Collect all edges and sort
    const allEdges = [];
    for (const a of allAnalyzed) {
      for (const o of a.outcomes) {
        if (o.absEdge > 0.03) { // Show edges > 3%
          allEdges.push({ city: a.city, date: a.date, ...o });
        }
      }
    }

    allEdges.sort((a, b) => b.absEdge - a.absEdge);

    for (const e of allEdges.slice(0, 25)) {
      const signal = e.absEdge >= MIN_EDGE
        ? (e.edge > 0 ? " >>> BUY YES" : " >>> BUY NO")
        : "";
      const unit = e.fahrenheit ? "°F" : "°C";
      console.log(
        "   " +
          e.city.slice(0, 12).padEnd(14) +
          e.date.padEnd(12) +
          `${e.temp}${unit}`.padEnd(10) +
          e.type.padEnd(10) +
          (e.yesPrice * 100).toFixed(1).padStart(5) + "%" +
          (e.modelProb * 100).toFixed(1).padStart(5) + "%" +
          (e.edge * 100).toFixed(1).padStart(6) + "%" +
          signal
      );
    }
  }

  // Recent trades
  if (trades.length > 0) {
    console.log("");
    console.log("   Trades realizados:");
    for (const t of trades.slice(-8)) {
      console.log(
        `     ${t.timestamp.slice(11, 19)} | ${t.city.padEnd(12)} | ${t.temp}°C ${t.type.padEnd(8)} | ${t.action.padEnd(8)} | edge ${t.absEdge} | €${t.betSize}`
      );
    }
  }

  console.log("");
  console.log("=".repeat(75));
  console.log(`   Proximo scan: ${SCAN_INTERVAL_MS / 60000} min | Ctrl+C = resumen`);
  console.log("=".repeat(75));
}

// ============================================================
// PERSISTENCE
// ============================================================

function saveTrades() {
  fs.writeFileSync(
    LOG_FILE,
    JSON.stringify({
      startTime: new Date(startTime).toISOString(),
      lastUpdate: new Date().toISOString(),
      totalScans, balance, totalPnL,
      config: { BANKROLL, MAX_BET, KELLY_FRACTION, MIN_EDGE },
      trades,
    }, null, 2)
  );
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
  saveTrades();
  console.log("\n" + "=".repeat(55));
  console.log("   RESUMEN FINAL — WEATHER BOT v2");
  console.log("=".repeat(55));
  console.log(`   Scans:         ${totalScans}`);
  console.log(`   Trades:        ${trades.length}`);
  console.log(`   Apostado:      €${(BANKROLL - balance).toFixed(2)}`);
  console.log(`   P&L esperado:  €${totalPnL.toFixed(2)}`);
  if (trades.length > 0) {
    const avgE = trades.reduce((s, t) => s + parseFloat(t.absEdge), 0) / trades.length;
    console.log(`   Edge medio:    ${avgE.toFixed(1)}%`);
  }
  console.log(`   Datos:         ${LOG_FILE}`);
  console.log("=".repeat(55));
  process.exit(0);
});

async function main() {
  console.log("=".repeat(75));
  console.log("   POLYMARKET WEATHER BOT v2");
  console.log("   GFS (31) + ECMWF (51) ensemble vs market odds");
  console.log("=".repeat(75));
  console.log(`   Bankroll: €${BANKROLL} | Max bet: €${MAX_BET} | Min edge: ${MIN_EDGE * 100}%`);
  console.log(`   Kelly: ${KELLY_FRACTION} | Ciudades: ${CITIES.length} | Scan: ${SCAN_INTERVAL_MS / 60000}min`);
  console.log("");

  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}

main().catch(console.error);
