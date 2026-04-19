// Minimal verification with rate limit respect

async function main() {
  const yesterday = "2026-04-06";

  const cities = [
    { name: "London", lat: 51.51, lon: -0.13 },
    { name: "Hong Kong", lat: 22.28, lon: 114.15 },
    { name: "Seoul", lat: 37.57, lon: 126.98 },
    { name: "Tel Aviv", lat: 32.08, lon: 34.78 },
    { name: "Tokyo", lat: 35.68, lon: 139.69 },
    { name: "Paris", lat: 48.86, lon: 2.35 },
    { name: "Moscow", lat: 55.76, lon: 37.62 },
    { name: "Istanbul", lat: 41.01, lon: 28.98 },
  ];

  console.log(`Temperaturas reales ${yesterday} vs GFS forecast\n`);
  console.log("Ciudad".padEnd(14) + "Real".padStart(7) + "  GFS".padStart(7) + "  Error".padStart(7) + "  Members@real");
  console.log("-".repeat(58));

  for (const city of cities) {
    await sleep(3000); // Rate limit

    try {
      // Actual temp
      const obsRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&start_date=${yesterday}&end_date=${yesterday}&temperature_unit=celsius`
      );
      const obs = await obsRes.json();
      const actual = obs?.daily?.temperature_2m_max?.[0];
      if (actual === null || actual === undefined) { console.log(`${city.name}: no data`); continue; }

      await sleep(3000);

      // GFS ensemble
      const fRes = await fetch(
        `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&models=gfs_seamless&start_date=${yesterday}&end_date=${yesterday}&temperature_unit=celsius`
      );
      const fData = await fRes.json();
      if (fData.error) { console.log(`${city.name}: API error`); continue; }

      const members = [];
      for (const key of Object.keys(fData.daily || {})) {
        if (key.startsWith("temperature_2m_max_member")) {
          const v = fData.daily[key]?.[0];
          if (v !== null && v !== undefined) members.push(v);
        }
      }

      if (members.length === 0) { console.log(`${city.name}: no ensemble`); continue; }

      const mean = members.reduce((a, b) => a + b, 0) / members.length;
      const err = Math.abs(actual - mean);
      const actualR = Math.round(actual);
      const atActual = members.filter(m => Math.round(m) === actualR).length;
      const pct = ((atActual / members.length) * 100).toFixed(0);

      console.log(
        city.name.padEnd(14) +
        `${actual.toFixed(1)}°`.padStart(7) +
        `${mean.toFixed(1)}°`.padStart(7) +
        `${err.toFixed(1)}°`.padStart(7) +
        `  ${atActual}/${members.length} (${pct}%)`
      );
    } catch (e) {
      console.log(`${city.name}: ${e.message}`);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(console.error);
