// Quick verification: check yesterday's actual temps vs forecasts

async function main() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  console.log(`Verificando temperaturas reales de ${dateStr}\n`);

  const cities = [
    { name: "Hong Kong", lat: 22.28, lon: 114.15 },
    { name: "London", lat: 51.51, lon: -0.13 },
    { name: "Seoul", lat: 37.57, lon: 126.98 },
    { name: "Tel Aviv", lat: 32.08, lon: 34.78 },
    { name: "Tokyo", lat: 35.68, lon: 139.69 },
    { name: "Paris", lat: 48.86, lon: 2.35 },
    { name: "Istanbul", lat: 41.01, lon: 28.98 },
    { name: "Moscow", lat: 55.76, lon: 37.62 },
  ];

  console.log("Ciudad".padEnd(14) + "Actual".padStart(8) + "GFS".padStart(8) + "Error".padStart(8));
  console.log("-".repeat(38));

  const errors = [];

  for (const city of cities) {
    try {
      // Actual observed temp
      const obsRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&start_date=${dateStr}&end_date=${dateStr}&temperature_unit=celsius`
      );
      const obs = await obsRes.json();
      const actual = obs?.daily?.temperature_2m_max?.[0];

      // GFS forecast
      const fRes = await fetch(
        `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&models=gfs_seamless&start_date=${dateStr}&end_date=${dateStr}&temperature_unit=celsius`
      );
      const fData = await fRes.json();
      const members = [];
      for (const key of Object.keys(fData.daily || {})) {
        if (key.startsWith("temperature_2m_max_member")) {
          const v = fData.daily[key]?.[0];
          if (v !== null) members.push(v);
        }
      }
      const mean = members.length > 0
        ? members.reduce((a, b) => a + b, 0) / members.length
        : null;

      if (actual !== null && mean !== null) {
        const err = Math.abs(actual - mean);
        errors.push(err);

        // Which rounded temp did it actually land on?
        const actualR = Math.round(actual);
        const membersAtActual = members.filter(m => Math.round(m) === actualR).length;
        const pctAtActual = ((membersAtActual / members.length) * 100).toFixed(0);

        console.log(
          city.name.padEnd(14) +
          `${actual.toFixed(1)}°C`.padStart(8) +
          `${mean.toFixed(1)}°C`.padStart(8) +
          `${err.toFixed(1)}°C`.padStart(8) +
          `  (${membersAtActual}/${members.length} members = ${pctAtActual}% at ${actualR}°C)`
        );
      }
    } catch (e) {
      console.log(`${city.name}: error - ${e.message}`);
    }
  }

  if (errors.length > 0) {
    const avgErr = errors.reduce((a, b) => a + b, 0) / errors.length;
    console.log("\n" + "-".repeat(38));
    console.log(`Error medio del GFS: ${avgErr.toFixed(2)}°C`);
    console.log(`Máx error: ${Math.max(...errors).toFixed(1)}°C`);
    console.log(`Min error: ${Math.min(...errors).toFixed(1)}°C`);
  }

  // Now check what our bot predicted for today
  console.log("\n\n=== Predicciones del bot para HOY ===\n");
  const today = new Date().toISOString().slice(0, 10);

  for (const city of cities) {
    try {
      const fRes = await fetch(
        `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&models=gfs_seamless&start_date=${today}&end_date=${today}&temperature_unit=celsius`
      );
      const fData = await fRes.json();
      const members = [];
      for (const key of Object.keys(fData.daily || {})) {
        if (key.startsWith("temperature_2m_max_member")) {
          const v = fData.daily[key]?.[0];
          if (v !== null) members.push(v);
        }
      }

      if (members.length === 0) continue;

      const mean = members.reduce((a, b) => a + b, 0) / members.length;
      const distribution = {};
      for (const m of members) {
        const r = Math.round(m);
        distribution[r] = (distribution[r] || 0) + 1;
      }

      // Find the most likely temp
      const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
      const mostLikely = sorted[0];

      console.log(
        `${city.name.padEnd(14)} Mean: ${mean.toFixed(1)}°C | Most likely: ${mostLikely[0]}°C (${((mostLikely[1] / members.length) * 100).toFixed(0)}%) | Spread: ${sorted.map(([t, c]) => `${t}°C:${c}`).join(", ")}`
      );
    } catch {}
  }
}

main().catch(console.error);
