// ============================================================
// VERIFICATION: Check bot predictions against actual weather
// Fetches real observed temperatures and compares to what
// the bot predicted and what the market said
// ============================================================

async function main() {
  console.log("=".repeat(70));
  console.log("   VERIFICADOR DE PREDICCIONES");
  console.log("   Compara modelo vs mercado vs realidad");
  console.log("=".repeat(70));
  console.log("");

  // Check today and yesterday
  const dates = [];
  for (let i = 0; i <= 1; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d);
  }

  const cities = [
    { name: "Hong Kong", slug: "hong-kong", lat: 22.28, lon: 114.15 },
    { name: "Moscow", slug: "moscow", lat: 55.76, lon: 37.62 },
    { name: "Istanbul", slug: "istanbul", lat: 41.01, lon: 28.98 },
    { name: "Tel Aviv", slug: "tel-aviv", lat: 32.08, lon: 34.78 },
    { name: "London", slug: "london", lat: 51.51, lon: -0.13 },
    { name: "Tokyo", slug: "tokyo", lat: 35.68, lon: 139.69 },
    { name: "Seoul", slug: "seoul", lat: 37.57, lon: 126.98 },
    { name: "Paris", slug: "paris", lat: 48.86, lon: 2.35 },
    { name: "Singapore", slug: "singapore", lat: 1.35, lon: 103.82 },
    { name: "São Paulo", slug: "sao-paulo", lat: -23.55, lon: -46.63 },
    { name: "Mexico City", slug: "mexico-city", lat: 19.43, lon: -99.13 },
    { name: "Miami", slug: "miami", lat: 25.76, lon: -80.19, usesF: true },
    { name: "Chicago", slug: "chicago", lat: 41.88, lon: -87.63, usesF: true },
    { name: "Denver", slug: "denver", lat: 39.74, lon: -104.99, usesF: true },
    { name: "Los Angeles", slug: "los-angeles", lat: 34.05, lon: -118.24, usesF: true },
  ];

  const months = [
    "january","february","march","april","may","june",
    "july","august","september","october","november","december",
  ];

  const results = [];

  for (const date of dates) {
    const dateStr = date.toISOString().slice(0, 10);
    const month = months[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();

    console.log(`\n--- ${dateStr} ---\n`);

    for (const city of cities) {
      // 1. Get actual observed temperature from Open-Meteo historical
      let actualTemp = null;
      try {
        const obsUrl =
          `https://api.open-meteo.com/v1/forecast` +
          `?latitude=${city.lat}&longitude=${city.lon}` +
          `&daily=temperature_2m_max` +
          `&start_date=${dateStr}&end_date=${dateStr}` +
          `&temperature_unit=celsius`;
        const obsRes = await fetch(obsUrl);
        const obsData = await obsRes.json();
        actualTemp = obsData?.daily?.temperature_2m_max?.[0];
      } catch {}

      if (actualTemp === null) continue;

      // 2. Get what Polymarket resolved to
      const slug = `highest-temperature-in-${city.slug}-on-${month}-${day}-${year}`;
      let marketData = null;
      try {
        const res = await fetch(
          `https://gamma-api.polymarket.com/events?slug=${slug}`
        );
        const events = await res.json();
        if (events && events.length > 0) {
          marketData = events[0];
        }
      } catch {}

      if (!marketData || !marketData.markets) continue;

      // 3. Get current GFS forecast (for comparison)
      let forecastMembers = [];
      try {
        const fUrl =
          `https://ensemble-api.open-meteo.com/v1/ensemble` +
          `?latitude=${city.lat}&longitude=${city.lon}` +
          `&daily=temperature_2m_max` +
          `&models=gfs_seamless` +
          `&start_date=${dateStr}&end_date=${dateStr}` +
          `&temperature_unit=celsius`;
        const fRes = await fetch(fUrl);
        const fData = await fRes.json();
        if (fData.daily) {
          for (const key of Object.keys(fData.daily)) {
            if (key.startsWith("temperature_2m_max_member")) {
              const val = fData.daily[key];
              if (Array.isArray(val) && val[0] !== null) forecastMembers.push(val[0]);
            }
          }
        }
      } catch {}

      const forecastMean = forecastMembers.length > 0
        ? forecastMembers.reduce((a, b) => a + b, 0) / forecastMembers.length
        : null;

      // 4. Find which market outcome won
      const actualRounded = Math.round(actualTemp);
      const actualF = Math.round(actualTemp * 9/5 + 32);

      let winningOutcome = null;
      let marketWasRight = false;
      let modelWouldHaveWon = false;

      for (const m of marketData.markets) {
        let prices;
        try { prices = JSON.parse(m.outcomePrices); } catch { continue; }
        const yesPrice = parseFloat(prices[0]) || 0;
        const question = m.question || "";

        // Check if this outcome matches actual temp
        const tempMatch = question.match(/(\d+)/);
        if (!tempMatch) continue;
        const marketTemp = parseInt(tempMatch[1]);

        let isWinner = false;
        const qLower = question.toLowerCase();

        if (city.usesF) {
          if (qLower.includes("or higher") || qLower.includes("or above")) {
            isWinner = actualF >= marketTemp;
          } else if (qLower.includes("or below") || qLower.includes("or lower")) {
            isWinner = actualF <= marketTemp;
          } else if (qLower.includes("between")) {
            const rangeMatch = question.match(/(\d+)\s*[-–]\s*(\d+)/);
            if (rangeMatch) {
              isWinner = actualF >= parseInt(rangeMatch[1]) && actualF <= parseInt(rangeMatch[2]);
            }
          } else {
            isWinner = actualF === marketTemp;
          }
        } else {
          if (qLower.includes("or higher") || qLower.includes("or above")) {
            isWinner = actualRounded >= marketTemp;
          } else if (qLower.includes("or below") || qLower.includes("or lower")) {
            isWinner = actualRounded <= marketTemp;
          } else {
            isWinner = actualRounded === marketTemp;
          }
        }

        if (isWinner && yesPrice > 0.5) marketWasRight = true;

        // Check if model forecast (rounded) matches
        if (forecastMembers.length > 0 && isWinner) {
          const modelCount = city.usesF
            ? forecastMembers.filter(m => Math.round(m * 9/5 + 32) === actualF).length
            : forecastMembers.filter(m => Math.round(m) === actualRounded).length;
          const modelProb = modelCount / forecastMembers.length;
          if (modelProb > yesPrice) modelWouldHaveWon = true;

          winningOutcome = {
            question,
            actual: city.usesF ? `${actualF}°F (${actualTemp.toFixed(1)}°C)` : `${actualRounded}°C`,
            marketYes: (yesPrice * 100).toFixed(1) + "%",
            modelProb: (modelProb * 100).toFixed(1) + "%",
            modelBetterThanMarket: modelProb > yesPrice,
            edge: ((modelProb - yesPrice) * 100).toFixed(1) + "%",
          };
        }
      }

      const forecastError = forecastMean !== null
        ? Math.abs(forecastMean - actualTemp).toFixed(1)
        : "?";

      const line = {
        city: city.name,
        date: dateStr,
        actual: actualTemp.toFixed(1) + "°C",
        forecast: forecastMean ? forecastMean.toFixed(1) + "°C" : "?",
        error: forecastError + "°C",
        winning: winningOutcome,
      };

      results.push(line);

      const icon = winningOutcome?.modelBetterThanMarket ? "✓" : "✗";
      console.log(
        `${icon} ${city.name.padEnd(14)} | Actual: ${line.actual.padEnd(8)} | Forecast: ${(line.forecast).padEnd(8)} | Error: ${line.error.padEnd(6)} | ${winningOutcome ? `Market: ${winningOutcome.marketYes} vs Model: ${winningOutcome.modelProb} (edge ${winningOutcome.edge})` : "no match"}`
      );

      await sleep(200);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("   RESUMEN");
  console.log("=".repeat(70));

  const withWinners = results.filter(r => r.winning);
  const modelBetter = withWinners.filter(r => r.winning.modelBetterThanMarket);
  const errors = results.filter(r => r.error !== "?").map(r => parseFloat(r.error));
  const avgError = errors.length > 0
    ? (errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(2)
    : "?";

  console.log(`   Ciudades verificadas:    ${results.length}`);
  console.log(`   Con outcome ganador:     ${withWinners.length}`);
  console.log(`   Modelo > Mercado:        ${modelBetter.length}/${withWinners.length} (${withWinners.length > 0 ? ((modelBetter.length / withWinners.length) * 100).toFixed(0) : 0}%)`);
  console.log(`   Error medio pronóstico:  ${avgError}°C`);
  console.log("");

  if (modelBetter.length > withWinners.length * 0.6) {
    console.log("   >>> MODELO TIENE EDGE: supera al mercado en >60% de los casos");
  } else if (modelBetter.length > withWinners.length * 0.4) {
    console.log("   >>> MODELO NEUTRAL: similar al mercado, edge marginal");
  } else {
    console.log("   >>> MERCADO GANA: el modelo no aporta edge consistente");
  }

  console.log("=".repeat(70));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(console.error);
