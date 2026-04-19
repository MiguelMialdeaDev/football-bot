// Use the London forecast data we already captured in debug session
// GFS members for London April 8 (from earlier successful fetch):
const gfsMembers = [22.7,20.3,19.5,22.3,23.1,22.3,18.9,22.3,23.1,20.5,21.2,21.2,19.6,18.7,19.4,20.7,23.1,24.4,23.9,21,21.1,21.2,21.1,24.1,20.5,22.6,20,21,21.2,22.2];

// Apply bias correction (+1.0°C)
const corrected = gfsMembers.map(m => m + 1.0);
const mean = corrected.reduce((a,b) => a+b,0) / corrected.length;

console.log(`London April 8 — GFS Corrected (+1.0°C)`);
console.log(`Mean: ${mean.toFixed(1)}°C | Members: ${corrected.length}\n`);

// Distribution
const dist = {};
for (const m of corrected) {
  const r = Math.round(m);
  dist[r] = (dist[r] || 0) + 1;
}
console.log("Distribution:");
for (const [temp, count] of Object.entries(dist).sort((a,b) => a[0]-b[0])) {
  const pct = ((count/corrected.length)*100).toFixed(0);
  console.log(`  ${temp}°C: ${"█".repeat(count)} ${count}/30 (${pct}%)`);
}

// Polymarket odds (from scan)
const markets = [
  { temp: 14, type: "or_below", market: 0.003 },
  { temp: 15, type: "exact", market: 0.001 },
  { temp: 16, type: "exact", market: 0.003 },
  { temp: 17, type: "exact", market: 0.002 },
  { temp: 18, type: "exact", market: 0.003 },
  { temp: 19, type: "exact", market: 0.002 },
  { temp: 20, type: "exact", market: 0.011 },
  { temp: 21, type: "exact", market: 0.016 },
  { temp: 22, type: "exact", market: 0.095 },
  { temp: 23, type: "exact", market: 0.155 },
  { temp: 24, type: "or_above", market: 0.705 },
];

console.log(`\n${"=".repeat(65)}`);
console.log(`EDGE ANALYSIS — London April 8 (with bias correction)`);
console.log(`${"=".repeat(65)}`);
console.log(`${"Temp".padEnd(10)} ${"Type".padEnd(10)} ${"Market".padStart(8)} ${"Model".padStart(8)} ${"Edge".padStart(8)} ${"Signal"}`);
console.log("-".repeat(65));

for (const m of markets) {
  let modelProb;

  if (m.type === "or_below") {
    const count = corrected.filter(v => Math.round(v) <= m.temp).length;
    modelProb = Math.max(0.02, Math.min(0.95, count / corrected.length));
  } else if (m.type === "or_above") {
    const count = corrected.filter(v => Math.round(v) >= m.temp).length;
    modelProb = Math.max(0.02, Math.min(0.95, count / corrected.length));
  } else {
    // Exact with uncertainty spread
    let count = 0;
    for (const v of corrected) {
      const diff = Math.abs(v - m.temp);
      if (diff < 0.5) count += 1.0;
      else if (diff < 1.5) count += 0.3;
      else if (diff < 2.5) count += 0.05;
    }
    modelProb = Math.max(0.02, Math.min(0.95, count / corrected.length));
  }

  const edge = modelProb - m.market;
  const absEdge = Math.abs(edge);
  const signal = absEdge >= 0.10
    ? (edge > 0 ? " >>> BUY YES" : " >>> BUY NO")
    : (absEdge >= 0.05 ? " ~~ weak" : "");

  console.log(
    `${m.temp}°C`.padEnd(10) +
    m.type.padEnd(10) +
    `${(m.market*100).toFixed(1)}%`.padStart(8) +
    `${(modelProb*100).toFixed(1)}%`.padStart(8) +
    `${(edge*100).toFixed(1)}%`.padStart(8) +
    signal
  );
}

// Yesterday verification
console.log(`\n\nYesterday verification (April 6):`);
console.log(`London actual: 16.3°C, GFS raw mean: 14.3°C`);
console.log(`Corrected mean would be: ${(14.3+1.0).toFixed(1)}°C → Error: ${Math.abs(16.3 - 15.3).toFixed(1)}°C`);
console.log(`Still 1.0°C off. Correction helps but doesn't fully fix.`);

console.log(`\nKey insight: GFS bias varies by city. A flat correction is crude.`);
console.log(`Better approach: per-city bias learned from recent observations.`);
