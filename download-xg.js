// Download xG data from Understat for our target leagues

async function main() {
  const leagues = [
    { name: "Serie_A", seasons: [2022, 2023, 2024] },
    { name: "Bundesliga", seasons: [2022, 2023, 2024] },
    { name: "La_Liga", seasons: [2022, 2023, 2024] },
    { name: "EPL", seasons: [2022, 2023, 2024] },
    { name: "Ligue_1", seasons: [2022, 2023, 2024] },
    { name: "Eredivisie", seasons: [2022, 2023, 2024] },
  ];

  const allXG = {};

  for (const league of leagues) {
    for (const season of league.seasons) {
      const url = `https://understat.com/league/${league.name}/${season}`;
      console.log(`Fetching ${league.name} ${season}...`);

      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        });
        const html = await res.text();

        // Extract datesData JSON from script tags
        const match = html.match(/datesData\s*=\s*JSON\.parse\('(.+?)'\)/);
        if (!match) {
          console.log(`  No datesData found`);
          continue;
        }

        // Decode hex escapes
        const decoded = match[1].replace(/\\x([0-9a-fA-F]{2})/g,
          (_, hex) => String.fromCharCode(parseInt(hex, 16))
        );
        const data = JSON.parse(decoded);

        // Flatten all matches from all matchdays
        let matchCount = 0;
        for (const [dateKey, matches] of Object.entries(data)) {
          for (const m of matches) {
            if (!m.isResult) continue;
            const key = `${m.h.title}_${m.a.title}_${m.datetime?.split(" ")[0]}`;
            allXG[key] = {
              home: m.h.title,
              away: m.a.title,
              date: m.datetime?.split(" ")[0],
              homeXG: parseFloat(m.xG?.h) || 0,
              awayXG: parseFloat(m.xG?.a) || 0,
              homeGoals: parseInt(m.goals?.h) || 0,
              awayGoals: parseInt(m.goals?.a) || 0,
              league: league.name,
              season,
            };
            matchCount++;
          }
        }
        console.log(`  ${matchCount} matches with xG`);
      } catch (err) {
        console.log(`  Error: ${err.message}`);
      }

      await sleep(2000); // Be respectful
    }
  }

  // Save
  const fs = require("fs");
  fs.writeFileSync("data/xg_data.json", JSON.stringify(allXG, null, 2));
  console.log(`\nTotal: ${Object.keys(allXG).length} matches saved to data/xg_data.json`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(console.error);
