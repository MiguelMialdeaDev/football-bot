// Test a single city end-to-end with full debug output

async function main() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().slice(0, 10);
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const month = months[tomorrow.getMonth()];
  const day = tomorrow.getDate();
  const year = tomorrow.getFullYear();

  console.log(`Testing London for ${dateStr}\n`);

  // 1. Get Polymarket market
  const slug = `highest-temperature-in-london-on-${month}-${day}-${year}`;
  console.log(`Slug: ${slug}`);

  const mRes = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}&closed=false`);
  const events = await mRes.json();

  if (!events || events.length === 0) {
    console.log("No Polymarket market found");
    return;
  }

  console.log(`\nMarket: ${events[0].title}`);
  console.log(`Markets: ${events[0].markets?.length}\n`);

  // Parse market outcomes
  const outcomes = [];
  for (const m of events[0].markets) {
    if (!m.active || m.closed) continue;
    let prices;
    try { prices = JSON.parse(m.outcomePrices); } catch { continue; }
    const yesPrice = parseFloat(prices[0]) || 0;
    console.log(`  ${(yesPrice * 100).toFixed(1).padStart(5)}% | ${m.question}`);
    outcomes.push({ question: m.question, yesPrice, noPrice: parseFloat(prices[1]) || 0 });
  }

  // 2. Get GFS ensemble
  console.log(`\nFetching GFS forecast...`);
  await sleep(2000);

  const fRes = await fetch(
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=51.51&longitude=-0.13&daily=temperature_2m_max&models=gfs_seamless&start_date=${dateStr}&end_date=${dateStr}&temperature_unit=celsius`
  );
  const fData = await fRes.json();

  if (fData.error) {
    console.log(`API Error: ${JSON.stringify(fData)}`);
    return;
  }

  const members = [];
  for (const key of Object.keys(fData.daily || {})) {
    if (key.startsWith("temperature_2m_max_member")) {
      const v = fData.daily[key]?.[0];
      if (v !== null && v !== undefined) members.push(v);
    }
  }

  console.log(`\nGFS Members (${members.length}):`);
  console.log(`  Raw: ${members.map(m => m.toFixed(1)).join(", ")}`);

  // Apply bias correction
  const corrected = members.map(m => m + 1.0);
  const mean = corrected.reduce((a, b) => a + b, 0) / corrected.length;
  console.log(`  Corrected (+1.0°C): ${corrected.map(m => m.toFixed(1)).join(", ")}`);
  console.log(`  Mean: ${mean.toFixed(1)}°C`);

  // Distribution
  const dist = {};
  for (const m of corrected) {
    const r = Math.round(m);
    dist[r] = (dist[r] || 0) + 1;
  }
  console.log(`\nDistribution:`);
  for (const [temp, count] of Object.entries(dist).sort((a, b) => a[0] - b[0])) {
    const pct = ((count / corrected.length) * 100).toFixed(0);
    console.log(`  ${temp}°C: ${"█".repeat(count)} ${count}/${corrected.length} (${pct}%)`);
  }

  // Compare to market
  console.log(`\n${"=".repeat(60)}`);
  console.log(`EDGE ANALYSIS:`);
  console.log(`${"=".repeat(60)}`);
  console.log(`${"Temp".padEnd(8)} ${"Market".padStart(8)} ${"Model".padStart(8)} ${"Edge".padStart(8)} ${"Signal".padStart(12)}`);

  for (const o of outcomes) {
    // Extract temp from question
    const tempMatch = o.question.match(/(\d+)/);
    if (!tempMatch) continue;
    const temp = parseInt(tempMatch[1]);

    let modelProb;
    const qLower = o.question.toLowerCase();

    if (qLower.includes("or higher") || qLower.includes("or above")) {
      const count = corrected.filter(m => Math.round(m) >= temp).length;
      modelProb = Math.max(0.02, Math.min(0.95, count / corrected.length));
    } else if (qLower.includes("or below") || qLower.includes("or lower")) {
      const count = corrected.filter(m => Math.round(m) <= temp).length;
      modelProb = Math.max(0.02, Math.min(0.95, count / corrected.length));
    } else {
      // Exact - with uncertainty
      let count = 0;
      for (const m of corrected) {
        const diff = Math.abs(m - temp);
        if (diff < 0.5) count += 1.0;
        else if (diff < 1.5) count += 0.3;
        else if (diff < 2.5) count += 0.05;
      }
      modelProb = Math.max(0.02, Math.min(0.95, count / corrected.length));
    }

    const edge = modelProb - o.yesPrice;
    const signal = Math.abs(edge) >= 0.10
      ? (edge > 0 ? ">>> BUY YES" : ">>> BUY NO")
      : "";

    console.log(
      `${temp}°C`.padEnd(8) +
      `${(o.yesPrice * 100).toFixed(1)}%`.padStart(8) +
      `${(modelProb * 100).toFixed(1)}%`.padStart(8) +
      `${(edge * 100).toFixed(1)}%`.padStart(8) +
      signal.padStart(12)
    );
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(console.error);
