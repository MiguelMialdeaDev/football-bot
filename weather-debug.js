// Quick debug: check ONE city to see forecast vs market odds detail

async function main() {
  // 1. Check if ensemble API returns individual members
  console.log("=== TEST: Open-Meteo Ensemble API ===\n");

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().slice(0, 10);

  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble` +
    `?latitude=51.51&longitude=-0.13` + // London
    `&daily=temperature_2m_max` +
    `&models=gfs_seamless` +
    `&start_date=${dateStr}&end_date=${dateStr}` +
    `&temperature_unit=celsius`;

  console.log("URL:", url, "\n");

  const res = await fetch(url);
  const data = await res.json();

  console.log("Keys in daily:", Object.keys(data.daily || {}));
  const members = [];
  for (const key of Object.keys(data.daily || {})) {
    if (key.includes("member")) {
      const val = data.daily[key][0];
      members.push(val);
      console.log(`  ${key}: ${val}°C`);
    }
  }

  if (members.length === 0) {
    console.log("\n  NO individual members returned! Only mean.");
    console.log("  Mean:", data.daily?.temperature_2m_max?.[0]);
    console.log("\n  Trying with explicit member parameter...\n");

    // Try requesting members explicitly
    const url2 =
      `https://ensemble-api.open-meteo.com/v1/ensemble` +
      `?latitude=51.51&longitude=-0.13` +
      `&hourly=temperature_2m` +
      `&models=gfs_seamless` +
      `&start_date=${dateStr}&end_date=${dateStr}` +
      `&temperature_unit=celsius`;

    const res2 = await fetch(url2);
    const data2 = await res2.json();
    const hourlyKeys = Object.keys(data2.hourly || {}).filter(k => k.includes("member"));
    console.log("Hourly member keys count:", hourlyKeys.length);
    if (hourlyKeys.length > 0) {
      console.log("First member sample (24h):", data2.hourly[hourlyKeys[0]]);
      console.log("\n  Members available via HOURLY endpoint!");
      console.log("  Strategy: get hourly temps for all members, take max per member\n");

      // Calculate max temp for each member
      const memberMaxes = [];
      for (const key of hourlyKeys) {
        const hourlyTemps = data2.hourly[key];
        const maxTemp = Math.max(...hourlyTemps.filter(v => v !== null));
        memberMaxes.push(maxTemp);
      }
      console.log(`  ${memberMaxes.length} member max temperatures:`);
      console.log("  ", memberMaxes.map(m => m.toFixed(1)).join(", "));
      console.log(`  Mean max: ${(memberMaxes.reduce((a,b) => a+b, 0) / memberMaxes.length).toFixed(1)}°C`);
      console.log(`  Min: ${Math.min(...memberMaxes).toFixed(1)}°C, Max: ${Math.max(...memberMaxes).toFixed(1)}°C`);

      // Show distribution
      const buckets = {};
      for (const m of memberMaxes) {
        const rounded = Math.round(m);
        buckets[rounded] = (buckets[rounded] || 0) + 1;
      }
      console.log("\n  Distribution (rounded to °C):");
      for (const [temp, count] of Object.entries(buckets).sort((a,b) => a[0] - b[0])) {
        const pct = ((count / memberMaxes.length) * 100).toFixed(0);
        const bar = "#".repeat(count * 2);
        console.log(`    ${temp}°C: ${bar} ${count}/${memberMaxes.length} (${pct}%)`);
      }
    }
  } else {
    console.log(`\n  ${members.length} members found via daily endpoint`);
    const buckets = {};
    for (const m of members) {
      const rounded = Math.round(m);
      buckets[rounded] = (buckets[rounded] || 0) + 1;
    }
    console.log("\n  Distribution:");
    for (const [temp, count] of Object.entries(buckets).sort((a,b) => a[0] - b[0])) {
      console.log(`    ${temp}°C: ${"#".repeat(count * 2)} ${count}/${members.length}`);
    }
  }

  // 2. Check Polymarket odds for London
  console.log("\n\n=== TEST: Polymarket London Weather Markets ===\n");

  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const month = monthNames[tomorrow.getMonth()];
  const day = tomorrow.getDate();
  const year = tomorrow.getFullYear();

  const slugs = [
    `highest-temperature-in-london-on-${month}-${day}-${year}`,
    `high-temperature-in-london-on-${month}-${day}-${year}`,
  ];

  for (const slug of slugs) {
    const res = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${slug}&closed=false`
    );
    const events = await res.json();

    if (events && events.length > 0) {
      console.log(`Found: ${slug}`);
      const event = events[0];
      console.log(`Title: ${event.title}`);
      console.log(`Markets: ${event.markets?.length || 0}\n`);

      if (event.markets) {
        for (const m of event.markets) {
          let prices;
          try { prices = JSON.parse(m.outcomePrices); } catch { prices = ["?","?"]; }
          console.log(`  ${(parseFloat(prices[0]) * 100).toFixed(1).padStart(5)}% YES | ${m.question}`);
        }
      }
      break;
    }
  }
}

main().catch(console.error);
