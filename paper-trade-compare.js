// ============================================================
// PAPER TRADE COMPARE — Ejecuta BASELINE y EXTEND-UP en paralelo
// con sus propios portfolios. Permite comparar ambas estrategias
// con apuestas reales (paper) en lugar de solo backtest.
//
// Uso:
//   node paper-trade-compare.js --scan      Detecta y guarda señales nuevas
//   node paper-trade-compare.js --results   Verifica resultados de partidos
//   node paper-trade-compare.js --report    Muestra comparativa
//   node paper-trade-compare.js --reset     Borra ambos portfolios (cuidado)
// ============================================================

const fs = require("fs");
const path = require("path");

// ============================================================
// LOAD .env FILE (si existe) — compatible con Windows y Unix
// ============================================================
(function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (e) {
    console.error("Error cargando .env:", e.message);
  }
})();

// ============================================================
// CONFIG
// ============================================================
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";

if (!ODDS_API_KEY) {
  console.error("ERROR: falta ODDS_API_KEY (define la variable de entorno o ponla en .env)");
  process.exit(1);
}
const DATA_DIR = path.join(__dirname, "data");

// Enable/disable Telegram notifications (auto-disabled if no token)
const TELEGRAM_ENABLED = TELEGRAM_BOT_TOKEN && TELEGRAM_CHANNEL_ID;
const DRY_RUN = process.argv.includes("--dry-run") || !TELEGRAM_ENABLED;

const BANKROLL = 5000;
const KELLY_FRACTION = 0.33;
const MIN_EDGE = 0.06;
const MAX_EDGE = 0.15;
const MAX_BET_PCT = 0.03;
const MIN_TEAM_MATCHES = 8;
const BET_TYPES = ["H"];

// Definicion de variantes
const VARIANTS = {
  baseline: {
    name: "BASELINE",
    description: "2.30-2.60 + 3.00-3.50 (zonas estrechas, mas calidad)",
    zones: [[2.30, 2.60], [3.00, 3.50]],
    stateFile: path.join(__dirname, "paper-baseline.json"),
  },
  "extend-up": {
    name: "EXTEND-UP",
    description: "2.30-2.60 + 3.00-4.00 (zona alta ampliada, mas volumen)",
    zones: [[2.30, 2.60], [3.00, 4.00]],
    stateFile: path.join(__dirname, "paper-extend-up.json"),
  },
};

// Leagues updated 2026-04-11: removed SC0 (-32% ROI), added D2 (+19.6% ROI)
const ODDS_API_SPORTS = {
  soccer_spain_segunda_division: "SP2",
  soccer_france_ligue_two: "F2",
  soccer_greece_super_league: "G1",
  soccer_germany_bundesliga2: "D2",
  soccer_spain_la_liga_2: "SP2",
  soccer_france_ligue_2: "F2",
  soccer_greece_super_league_2: "G1",
  soccer_germany_bundesliga_2: "D2",
};

const TARGET_LEAGUES = {
  SP2: "Segunda Division",
  F2: "Ligue 2",
  G1: "Greek Super",
  D2: "2. Bundesliga",
};

const ALL_LEAGUES = {
  SP1: "La Liga", E0: "Premier League", D1: "Bundesliga", I1: "Serie A",
  F1: "Ligue 1", D2: "2. Bundesliga", I2: "Serie B", T1: "Turquia",
  N1: "Eredivisie", P1: "Portugal", SP2: "Segunda",
  E1: "Championship", F2: "Ligue 2", SC0: "Scottish Prem",
  B1: "Belgian Pro", G1: "Greek Super",
  EC: "English League 1", E2: "English League 2", SC1: "Scottish Championship",
};
const SEASONS = ["2223", "2324", "2425"];

// Aliases (copia del telegram-bot.js, solo los necesarios para nuestras ligas)
const TEAM_ALIASES = {
  "Cádiz CF": "Cadiz", "Cadiz CF": "Cadiz",
  "Sporting Gijón": "Sp Gijon", "Sporting Gijon": "Sp Gijon",
  "Deportivo La Coruña": "La Coruna", "Deportivo La Coruna": "La Coruna", "RC Deportivo": "La Coruna",
  "SD Huesca": "Huesca",
  "CD Mirandés": "Mirandes", "CD Mirandes": "Mirandes",
  "CD Castellón": "Castellon", "CD Castellon": "Castellon",
  "Real Racing Club de Santander": "Santander", "Racing Santander": "Santander",
  "AD Ceuta FC": "Ceuta", "Ceuta": "Ceuta",
  "Real Sociedad B": "Real Sociedad B",
  "Granada CF": "Granada",
  "Córdoba": "Cordoba", "Cordoba CF": "Cordoba",
  "Cultural Leonesa": "Leonesa",
  "Málaga": "Malaga", "Malaga CF": "Malaga",
  "Leganés": "Leganes",
  "Andorra CF": "Andorra",
  "Real Valladolid CF": "Valladolid", "Valladolid": "Valladolid",
  "SD Eibar": "Eibar",
  "UD Almería": "Almeria", "UD Almeria": "Almeria", "Almería": "Almeria",
  "Burgos CF": "Burgos",
  "Elche CF": "Elche",
  "FC Cartagena": "Cartagena",
  "CD Eldense": "Eldense",
  "Racing de Ferrol": "Ferrol", "Racing Ferrol": "Ferrol",
  "CD Tenerife": "Tenerife",
  "Levante UD": "Levante",
  "Real Oviedo": "Oviedo",
  "Real Zaragoza": "Zaragoza",
  "AC Ajaccio": "Ajaccio",
  "Amiens SC": "Amiens",
  "Annecy FC": "Annecy",
  "SC Bastia": "Bastia",
  "SM Caen": "Caen", "Stade Malherbe Caen": "Caen",
  "Clermont Foot": "Clermont",
  "USL Dunkerque": "Dunkerque",
  "Grenoble Foot": "Grenoble", "Grenoble Foot 38": "Grenoble",
  "EA Guingamp": "Guingamp", "En Avant Guingamp": "Guingamp",
  "Stade Lavallois": "Laval",
  "FC Lorient": "Lorient",
  "FC Martigues": "Martigues",
  "FC Metz": "Metz",
  "Paris FC": "Paris FC",
  "Pau FC": "Pau FC",
  "Red Star FC": "Red Star",
  "Rodez AF": "Rodez",
  "ESTAC Troyes": "Troyes",
  "Nancy": "Nancy",
  "Boulogne": "Boulogne",
  "Le Mans FC": "Le Mans",
  "Saint Etienne": "St Etienne", "AS Saint-Etienne": "St Etienne", "AS Saint-Étienne": "St Etienne",
  "Stade de Reims": "Reims",
  "Montpellier": "Montpellier", "Montpellier HSC": "Montpellier",
  "AEK Athens": "AEK", "AEK Athens FC": "AEK",
  "Aris Thessaloniki": "Aris", "Aris Thessaloniki FC": "Aris",
  "Asteras Tripolis": "Asteras Tripolis",
  "Athens Kallithea FC": "Athens Kallithea",
  "Atromitos Athens": "Atromitos", "Atromitos FC": "Atromitos",
  "Lamia": "Lamia",
  "Levadiakos": "Levadeiakos",
  "OFI Crete": "OFI Crete", "OFI Crete FC": "OFI Crete",
  "Olympiakos Piraeus": "Olympiakos", "Olympiacos": "Olympiakos",
  "PAOK Thessaloniki": "PAOK", "PAOK FC": "PAOK",
  "Panathinaikos": "Panathinaikos", "Panathinaikos FC": "Panathinaikos",
  "Panetolikos Agrinio": "Panetolikos", "Panetolikos": "Panetolikos",
  "Panserraikos FC": "Panserraikos",
  "Volos FC": "Volos NFC", "Volos NFC": "Volos NFC",
  "AE Kifisia FC": "Kifisia", "AE Kifisias": "Kifisia",
  "AEL": "AEL", "AEL Larissa": "AEL",
  // 2. Bundesliga (nombres exactos del CSV)
  "Hamburger SV": "Hamburg",
  "FC Schalke 04": "Schalke 04",
  "FC St. Pauli": "St Pauli", "FC St Pauli": "St Pauli",
  "1. FC Kaiserslautern": "Kaiserslautern",
  "Hannover 96": "Hannover",
  "Karlsruher SC": "Karlsruhe",
  "SC Paderborn 07": "Paderborn", "SC Paderborn": "Paderborn",
  "1. FC Nurnberg": "Nurnberg", "1. FC Nürnberg": "Nurnberg",
  "Fortuna Dusseldorf": "Fortuna Dusseldorf", "Fortuna Düsseldorf": "Fortuna Dusseldorf",
  "Eintracht Braunschweig": "Braunschweig",
  "Greuther Furth": "Greuther Furth", "SpVgg Greuther Fürth": "Greuther Furth",
  "Hertha BSC": "Hertha", "Hertha Berlin": "Hertha",
  "SV Elversberg": "Elversberg",
  "1. FC Magdeburg": "Magdeburg",
  "SSV Ulm 1846": "Ulm", "SSV Ulm": "Ulm",
  "Preussen Munster": "Preußen Münster", "SC Preußen Münster": "Preußen Münster", "Preußen Münster": "Preußen Münster",
  "SV Darmstadt 98": "Darmstadt",
  "SSV Jahn Regensburg": "Regensburg", "Jahn Regensburg": "Regensburg",
  "Arminia Bielefeld": "Bielefeld",
  "FC Koln": "FC Koln", "1. FC Köln": "FC Koln", "1. FC Koln": "FC Koln",
  "SV Sandhausen": "Sandhausen",
  "Holstein Kiel": "Holstein Kiel",
  "Hansa Rostock": "Hansa Rostock",
  "SV Wehen Wiesbaden": "Wehen",
};

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegram(text) {
  if (DRY_RUN) {
    console.log("\n--- TELEGRAM (dry-run) ---");
    console.log(text);
    console.log("--- END ---\n");
    return { ok: true, dry_run: true };
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHANNEL_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("Telegram API error:", data.description);
    }
    return data;
  } catch (err) {
    console.error("Failed to send Telegram message:", err.message);
    return { ok: false, error: err.message };
  }
}

function formatMatchDate(iso) {
  const d = new Date(iso);
  const days = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${hh}:${mm}`;
}

function buildNewBetMessage(variantName, signal, state) {
  return [
    `🟢 <b>NUEVA APUESTA — ${variantName}</b>`,
    ``,
    `⚽ ${signal.homeTeam} vs ${signal.awayTeam}`,
    `🏆 ${signal.leagueName}`,
    `📅 ${formatMatchDate(signal.commenceTime)}`,
    ``,
    `✅ Apuesta: ${signal.sideLabel}`,
    `📊 Odds: ${signal.odds.toFixed(2)}`,
    `💰 Edge: ${(signal.edge * 100).toFixed(1)}%`,
    `🎯 Prob modelo: ${(signal.prob * 100).toFixed(1)}%`,
    ``,
    `💵 Stake: €${signal.stake.toFixed(2)}`,
    `🏦 Bankroll: €${state.bankroll.toFixed(2)}`,
    ``,
    `🎰 Si gana: +€${(signal.stake * (signal.odds - 1)).toFixed(2)}`,
    `❌ Si pierde: -€${signal.stake.toFixed(2)}`,
  ].join("\n");
}

function buildWinMessage(variantName, signal, state) {
  const profit = signal.profit;
  const pnl = state.bankroll - BANKROLL;
  return [
    `✅ <b>GANADA — ${variantName}</b>`,
    ``,
    `⚽ ${signal.homeTeam} ${signal.homeScore} - ${signal.awayScore} ${signal.awayTeam}`,
    `🏆 ${signal.leagueName}`,
    ``,
    `Apostamos: ${signal.sideLabel} @ ${signal.odds.toFixed(2)}`,
    `Stake: €${signal.stake.toFixed(2)}`,
    `<b>Ganancia: +€${profit.toFixed(2)}</b>`,
    ``,
    `🏦 Bankroll: €${state.bankroll.toFixed(2)} (${pnl >= 0 ? "+" : ""}€${pnl.toFixed(2)})`,
    `📈 Record: ${state.wins}W / ${state.losses}L`,
  ].join("\n");
}

function buildLossMessage(variantName, signal, state) {
  const loss = Math.abs(signal.profit);
  const pnl = state.bankroll - BANKROLL;
  return [
    `❌ <b>PERDIDA — ${variantName}</b>`,
    ``,
    `⚽ ${signal.homeTeam} ${signal.homeScore} - ${signal.awayScore} ${signal.awayTeam}`,
    `🏆 ${signal.leagueName}`,
    ``,
    `Apostamos: ${signal.sideLabel} @ ${signal.odds.toFixed(2)}`,
    `Stake: €${signal.stake.toFixed(2)}`,
    `<b>Perdida: -€${loss.toFixed(2)}</b>`,
    ``,
    `🏦 Bankroll: €${state.bankroll.toFixed(2)} (${pnl >= 0 ? "+" : ""}€${pnl.toFixed(2)})`,
    `📉 Record: ${state.wins}W / ${state.losses}L`,
  ].join("\n");
}

// ============================================================
// STATE
// ============================================================
function loadState(stateFile) {
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    }
  } catch (e) {
    console.error(`Error loading ${stateFile}:`, e.message);
  }
  return {
    bankroll: BANKROLL,
    signals: [],
    results: [],
    totalBets: 0,
    wins: 0,
    losses: 0,
    totalStaked: 0,
    totalProfit: 0,
    startedAt: new Date().toISOString(),
  };
}

function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ============================================================
// DATA + MODELO (mismas funciones que predictor-v3 / telegram-bot)
// ============================================================
function loadAllData() {
  const all = [];
  for (const league of Object.keys(ALL_LEAGUES)) {
    for (const season of SEASONS) {
      const file = path.join(DATA_DIR, `${league}_${season}.csv`);
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      const lines = raw.split("\n").filter(l => l.trim());
      if (lines.length < 2) continue;
      const h = lines[0].split(",");
      const g = (n) => h.indexOf(n);

      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(",");
        if (c.length < 10) continue;
        const fthg = parseInt(c[g("FTHG")]), ftag = parseInt(c[g("FTAG")]);
        if (isNaN(fthg) || isNaN(ftag)) continue;

        const dp = (c[g("Date")] || "").split("/");
        let date = null;
        if (dp.length === 3) {
          let y = parseInt(dp[2]);
          if (y < 100) y += 2000;
          date = new Date(y, parseInt(dp[1]) - 1, parseInt(dp[0]));
        }
        if (!date || isNaN(date.getTime())) continue;

        all.push({
          league, date,
          home: c[g("HomeTeam")], away: c[g("AwayTeam")],
          hg: fthg, ag: ftag,
          result: c[g("FTR")],
          totalGoals: fthg + ftag,
          hst: parseInt(c[g("HST")]) || 0, ast: parseInt(c[g("AST")]) || 0,
        });
      }
    }
  }
  all.sort((a, b) => a.date - b.date);
  return all;
}

function buildTeamStats(matches) {
  const stats = {};
  for (const m of matches) {
    for (const side of ["home", "away"]) {
      const team = side === "home" ? m.home : m.away;
      if (!stats[team]) stats[team] = { matches: [], league: m.league };
      const isHome = side === "home";
      stats[team].matches.push({
        date: m.date, isHome,
        goalsFor: isHome ? m.hg : m.ag,
        goalsAgainst: isHome ? m.ag : m.hg,
        shotsOnTarget: isHome ? m.hst : m.ast,
        shotsOnTargetAgainst: isHome ? m.ast : m.hst,
        result: m.result === "D" ? "D"
          : ((isHome && m.result === "H") || (!isHome && m.result === "A")) ? "W" : "L",
      });
    }
  }
  return stats;
}

function getFeatures(teamStats, teamName) {
  const ts = teamStats[teamName];
  if (!ts || ts.matches.length < MIN_TEAM_MATCHES) return null;
  const recent = ts.matches.slice(-10);
  const homeMatches = ts.matches.filter(m => m.isHome).slice(-10);
  const awayMatches = ts.matches.filter(m => !m.isHome).slice(-10);

  const points = recent.reduce((s, m) =>
    s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const formPctLong = points / (recent.length * 3);
  const recent4 = ts.matches.slice(-4);
  const points4 = recent4.reduce((s, m) =>
    s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const recentFormPct = points4 / (recent4.length * 3);
  const formPct = formPctLong * 0.4 + recentFormPct * 0.6;

  const goalsFor = avg(recent.map(m => m.goalsFor));
  const goalsAgainst = avg(recent.map(m => m.goalsAgainst));
  const goalsRatio = goalsAgainst > 0
    ? Math.min(3.0, goalsFor / goalsAgainst)
    : goalsFor > 0 ? 3.0 : 1.0;

  const homeWinPct = homeMatches.length >= 3
    ? homeMatches.filter(m => m.result === "W").length / homeMatches.length
    : 0.45;
  const awayWinPct = awayMatches.length >= 3
    ? awayMatches.filter(m => m.result === "W").length / awayMatches.length
    : 0.30;

  const sotFor = avg(recent.map(m => m.shotsOnTarget || 0));
  const sotAgainst = avg(recent.map(m => m.shotsOnTargetAgainst || 0));
  const sotRatio = sotAgainst > 0
    ? Math.min(3.0, sotFor / sotAgainst)
    : sotFor > 0 ? 3.0 : 1.0;
  const shotRatio = sotFor > 0.1 ? Math.min(3.0, sotFor / Math.max(0.1, sotAgainst)) : 1.0;
  const performanceRatio = goalsRatio * 0.5 + shotRatio * 0.5;

  return {
    formPct, goalsFor, goalsAgainst, goalsRatio, performanceRatio,
    homeWinPct, awayWinPct, sotFor, sotAgainst, sotRatio,
    totalMatches: ts.matches.length,
  };
}

function predict(homeFeatures, awayFeatures, leagueAvg, motivation) {
  if (!homeFeatures || !awayFeatures) return null;
  const baseHome = leagueAvg.homeGoals || 1.45;
  const baseAway = leagueAvg.awayGoals || 1.10;
  const avgGoals = (baseHome + baseAway) / 2;

  let homeAttack = homeFeatures.goalsFor / avgGoals;
  let awayAttack = awayFeatures.goalsFor / avgGoals;
  let homeDefense = homeFeatures.goalsAgainst / avgGoals;
  let awayDefense = awayFeatures.goalsAgainst / avgGoals;

  if (homeFeatures.performanceRatio > 0 && homeFeatures.goalsRatio > 0) {
    const perfAdj = homeFeatures.performanceRatio / homeFeatures.goalsRatio;
    homeAttack *= Math.max(0.92, Math.min(1.08, perfAdj));
  }
  if (awayFeatures.performanceRatio > 0 && awayFeatures.goalsRatio > 0) {
    const perfAdj = awayFeatures.performanceRatio / awayFeatures.goalsRatio;
    awayAttack *= Math.max(0.92, Math.min(1.08, perfAdj));
  }

  const homeFormAdj = 0.95 + homeFeatures.formPct * 0.10;
  const awayFormAdj = 0.95 + awayFeatures.formPct * 0.10;
  const homeAdv = homeFeatures.homeWinPct > 0.1
    ? Math.max(0.95, Math.min(1.08, homeFeatures.homeWinPct / 0.45))
    : 1.0;

  let lambdaHome = homeAttack * awayDefense * baseHome * homeFormAdj * homeAdv;
  let lambdaAway = awayAttack * homeDefense * baseAway * awayFormAdj;

  if (motivation) {
    if (motivation.homeInTop3 || motivation.homeInBottom3) lambdaHome *= 1.03;
    if (motivation.homeInDeadZone) lambdaHome *= 0.97;
    if (motivation.awayInTop3) lambdaHome *= 0.98;
  }

  const homeShrink = Math.min(1, homeFeatures.totalMatches / 20);
  const awayShrink = Math.min(1, awayFeatures.totalMatches / 20);
  lambdaHome = lambdaHome * homeShrink + baseHome * (1 - homeShrink);
  lambdaAway = lambdaAway * awayShrink + baseAway * (1 - awayShrink);

  lambdaHome = Math.max(0.4, Math.min(3.5, lambdaHome));
  lambdaAway = Math.max(0.3, Math.min(3.0, lambdaAway));

  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = poisson(i, lambdaHome) * poisson(j, lambdaAway);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
    }
  }
  const total = pH + pD + pA;
  pH /= total; pD /= total; pA /= total;

  const baseH = 0.45, baseD = 0.27, baseA = 0.28;
  function variableShrink(rawP, baseP) {
    let shrink;
    if (rawP < 0.45) shrink = 0.40;
    else if (rawP < 0.55) shrink = 0.55;
    else shrink = 0.65;
    return rawP * (1 - shrink) + baseP * shrink;
  }
  pH = variableShrink(pH, baseH);
  pD = variableShrink(pD, baseD);
  pA = variableShrink(pA, baseA);
  pH = Math.min(pH, 0.48);
  pA = Math.min(pA, 0.40);
  const total2 = pH + pD + pA;
  pH /= total2; pD /= total2; pA /= total2;

  return { pH, pD, pA };
}

function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

function buildStandings(matches, league) {
  const table = {};
  const leagueMatches = matches.filter(m => m.league === league);
  for (const m of leagueMatches) {
    if (!table[m.home]) table[m.home] = { team: m.home, pts: 0, gd: 0, played: 0 };
    if (!table[m.away]) table[m.away] = { team: m.away, pts: 0, gd: 0, played: 0 };
    table[m.home].played++;
    table[m.away].played++;
    table[m.home].gd += m.hg - m.ag;
    table[m.away].gd += m.ag - m.hg;
    if (m.result === "H") table[m.home].pts += 3;
    else if (m.result === "D") { table[m.home].pts += 1; table[m.away].pts += 1; }
    else table[m.away].pts += 3;
  }
  const sorted = Object.values(table).sort((a, b) => b.pts - a.pts || b.gd - a.gd);
  const positions = {};
  sorted.forEach((t, i) => { positions[t.team] = i + 1; });
  return { positions, totalTeams: sorted.length };
}

function isDeadZone(position, totalTeams) {
  if (totalTeams < 12) return false;
  const thirdSize = Math.floor(totalTeams / 3);
  return position >= thirdSize + 1 && position <= totalTeams - thirdSize;
}

function computeLeagueStats(matches) {
  const stats = {};
  for (const m of matches) {
    if (!stats[m.league]) stats[m.league] = { totalH: 0, totalA: 0, n: 0 };
    stats[m.league].totalH += m.hg;
    stats[m.league].totalA += m.ag;
    stats[m.league].n++;
  }
  for (const ls of Object.values(stats)) {
    ls.homeGoals = ls.n > 0 ? ls.totalH / ls.n : 1.45;
    ls.awayGoals = ls.n > 0 ? ls.totalA / ls.n : 1.10;
  }
  return stats;
}

// ============================================================
// API CLIENTS
// ============================================================
async function fetchUpcomingFixtures() {
  const fixtures = [];
  let availableSports = new Set();

  try {
    const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
    const sportsData = await sportsRes.json();
    if (Array.isArray(sportsData)) {
      for (const s of sportsData) availableSports.add(s.key);
    }
  } catch (e) {
    console.log(`  Could not fetch sports list: ${e.message}`);
  }

  const seenLeagues = new Set();
  for (const [sportKey, leagueCode] of Object.entries(ODDS_API_SPORTS)) {
    if (seenLeagues.has(leagueCode)) continue;
    if (availableSports.size > 0 && !availableSports.has(sportKey)) continue;

    console.log(`  Fetching ${TARGET_LEAGUES[leagueCode]}...`);
    seenLeagues.add(leagueCode);

    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
      const res = await fetch(url);
      if (!res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data)) continue;

      for (const event of data) {
        let bestHomeOdds = 0, bestDrawOdds = 0, bestAwayOdds = 0;
        let avgHomeOdds = 0, avgDrawOdds = 0, avgAwayOdds = 0;
        let bookCount = 0;

        for (const bm of (event.bookmakers || [])) {
          const market = bm.markets?.find(m => m.key === "h2h");
          if (!market) continue;
          const homeOutcome = market.outcomes?.find(o => o.name === event.home_team);
          const awayOutcome = market.outcomes?.find(o => o.name === event.away_team);
          const drawOutcome = market.outcomes?.find(o => o.name === "Draw");

          if (homeOutcome) { bestHomeOdds = Math.max(bestHomeOdds, homeOutcome.price); avgHomeOdds += homeOutcome.price; }
          if (drawOutcome) { bestDrawOdds = Math.max(bestDrawOdds, drawOutcome.price); avgDrawOdds += drawOutcome.price; }
          if (awayOutcome) { bestAwayOdds = Math.max(bestAwayOdds, awayOutcome.price); avgAwayOdds += awayOutcome.price; }
          bookCount++;
        }

        if (bookCount > 0) {
          avgHomeOdds /= bookCount;
          avgDrawOdds /= bookCount;
          avgAwayOdds /= bookCount;
        }

        fixtures.push({
          id: event.id,
          sportKey, leagueCode,
          leagueName: TARGET_LEAGUES[leagueCode],
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          commenceTime: new Date(event.commence_time),
          oddsH: avgHomeOdds || bestHomeOdds,
          oddsD: avgDrawOdds || bestDrawOdds,
          oddsA: avgAwayOdds || bestAwayOdds,
        });
      }
      await sleep(600);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }
  return fixtures;
}

async function fetchScores() {
  const scores = [];
  let availableSports = new Set();
  try {
    const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
    const sportsData = await sportsRes.json();
    if (Array.isArray(sportsData)) {
      for (const s of sportsData) availableSports.add(s.key);
    }
  } catch (e) { /* ignore */ }

  const seenLeagues = new Set();
  for (const [sportKey, leagueCode] of Object.entries(ODDS_API_SPORTS)) {
    if (seenLeagues.has(leagueCode)) continue;
    if (availableSports.size > 0 && !availableSports.has(sportKey)) continue;
    seenLeagues.add(leagueCode);

    try {
      // daysFrom=3 es el máximo que permite The Odds API en el endpoint de scores.
      // Con el workflow corriendo --results cada noche (cron 23:00 UTC) basta para
      // que ningún partido se nos pase. Si el workflow falla más de 3 días seguidos
      // hay que resolver los pendientes a mano (ver scripts/resolve-orphans.js).
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3&dateFormat=iso`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;

      for (const event of data) {
        if (!event.completed) continue;
        const homeScore = parseInt(event.scores?.find(s => s.name === event.home_team)?.score || "0");
        const awayScore = parseInt(event.scores?.find(s => s.name === event.away_team)?.score || "0");
        let result;
        if (homeScore > awayScore) result = "H";
        else if (awayScore > homeScore) result = "A";
        else result = "D";
        scores.push({
          id: event.id,
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          homeScore, awayScore, result,
        });
      }
      await sleep(600);
    } catch (err) { /* ignore */ }
  }
  return scores;
}

// ============================================================
// TEAM NAME MATCHING
// ============================================================
function normalizeTeamName(name) {
  return name
    .toLowerCase()
    .normalize("NFD")                     // descomponer acentos
    .replace(/[\u0300-\u036f]/g, "")      // eliminar diacriticos
    .replace(/ß/g, "ss")                  // eszett aleman
    .replace(/\./g, "")
    .replace(/\bfc |\bcf |\bcd |\bud |\brc |\breal |\bsd |\bad |\bss |\bas |\bus |\bac |\bssc |\bafc |\bsc |\bsv |\bsssv /gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findTeamInStats(apiName, teamStats) {
  if (teamStats[apiName]) return apiName;
  const alias = TEAM_ALIASES[apiName];
  if (alias && teamStats[alias]) return alias;
  const normalized = normalizeTeamName(apiName);
  for (const csvName of Object.keys(teamStats)) {
    if (normalizeTeamName(csvName) === normalized) return csvName;
  }
  for (const csvName of Object.keys(teamStats)) {
    const normCSV = normalizeTeamName(csvName);
    if (normCSV.length >= 4 && normalized.length >= 4) {
      if (normCSV.includes(normalized) || normalized.includes(normCSV)) {
        return csvName;
      }
    }
  }
  return null;
}

function inAnyZone(odds, zones) {
  for (const [min, max] of zones) {
    if (odds >= min && odds <= max) return true;
  }
  return false;
}

// ============================================================
// SCAN — genera senales para TODAS las variantes
// ============================================================
async function scanForSignals() {
  console.log("\n=== SCAN PAPER TRADING (BASELINE + EXTEND-UP) ===\n");

  console.log("Cargando datos historicos...");
  const allMatches = loadAllData();
  console.log(`${allMatches.length} partidos cargados`);

  const teamStats = buildTeamStats(allMatches);
  const leagueStats = computeLeagueStats(allMatches);
  const standingsByLeague = {};
  for (const lg of Object.keys(TARGET_LEAGUES)) {
    standingsByLeague[lg] = buildStandings(allMatches, lg);
  }

  console.log("\nObteniendo fixtures de la API...");
  const fixtures = await fetchUpcomingFixtures();
  console.log(`${fixtures.length} fixtures encontrados\n`);

  if (fixtures.length === 0) {
    console.log("No hay fixtures. Aborto.");
    return;
  }

  // Cargar estados de ambas variantes
  const states = {};
  for (const [key, variant] of Object.entries(VARIANTS)) {
    states[key] = loadState(variant.stateFile);
  }

  let totalNew = { baseline: 0, "extend-up": 0 };

  for (const fixture of fixtures) {
    const homeCSV = findTeamInStats(fixture.homeTeam, teamStats);
    const awayCSV = findTeamInStats(fixture.awayTeam, teamStats);

    if (!homeCSV || !awayCSV) {
      const miss = [];
      if (!homeCSV) miss.push(`home=${fixture.homeTeam}`);
      if (!awayCSV) miss.push(`away=${fixture.awayTeam}`);
      console.log(`  SKIP (no data): ${fixture.homeTeam} vs ${fixture.awayTeam} [${miss.join(", ")}]`);
      continue;
    }

    const homeF = getFeatures(teamStats, homeCSV);
    const awayF = getFeatures(teamStats, awayCSV);
    const ls = leagueStats[fixture.leagueCode] || { homeGoals: 1.45, awayGoals: 1.10 };

    let motivation = null;
    const standings = standingsByLeague[fixture.leagueCode];
    if (standings && standings.totalTeams >= 12) {
      const homePos = standings.positions[homeCSV];
      const awayPos = standings.positions[awayCSV];
      if (homePos && awayPos) {
        motivation = {
          homeInTop3: homePos <= 3,
          homeInBottom3: homePos > standings.totalTeams - 3,
          homeInDeadZone: isDeadZone(homePos, standings.totalTeams),
          awayInTop3: awayPos <= 3,
        };
      }
    }

    const pred = predict(homeF, awayF, ls, motivation);
    if (!pred) continue;

    if (!BET_TYPES.includes("H") || fixture.oddsH <= 0) continue;

    const prob = pred.pH;
    const odds = fixture.oddsH;
    const edge = prob - 1 / odds;

    if (edge < MIN_EDGE) continue;
    if (edge > MAX_EDGE) continue;

    const b = odds - 1;
    const kelly = (b * prob - (1 - prob)) / b;
    if (kelly <= 0) continue;
    const betPct = Math.min(kelly * KELLY_FRACTION, MAX_BET_PCT);

    // Comprobar para cada variante si entra en sus zonas
    for (const [key, variant] of Object.entries(VARIANTS)) {
      if (!inAnyZone(odds, variant.zones)) continue;

      // Skip duplicates
      const dup = states[key].signals.some(s =>
        s.homeTeam === fixture.homeTeam &&
        s.awayTeam === fixture.awayTeam &&
        s.commenceTime === fixture.commenceTime.toISOString()
      );
      if (dup) continue;

      const stake = states[key].bankroll * betPct;

      const signal = {
        id: `${fixture.id}_H_${Date.now()}`,
        eventId: fixture.id,
        leagueCode: fixture.leagueCode,
        leagueName: fixture.leagueName,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        commenceTime: fixture.commenceTime.toISOString(),
        side: "H",
        sideLabel: `${fixture.homeTeam} (Local)`,
        odds: odds,
        prob: prob,
        edge: edge,
        betPct: betPct,
        stake: Math.round(stake * 100) / 100,
        bankrollAtSignal: states[key].bankroll,
        timestamp: new Date().toISOString(),
        status: "PENDING",
      };

      states[key].signals.push(signal);
      totalNew[key]++;

      console.log(`  [${variant.name}] ${fixture.homeTeam} vs ${fixture.awayTeam} | odds ${odds.toFixed(2)} | edge ${(edge*100).toFixed(1)}% | stake EUR ${signal.stake}`);

      // Enviar notificacion a Telegram
      await sendTelegram(buildNewBetMessage(variant.name, signal, states[key]));
    }
  }

  // Guardar
  for (const [key, variant] of Object.entries(VARIANTS)) {
    saveState(variant.stateFile, states[key]);
  }

  console.log(`\n=== SCAN COMPLETO ===`);
  console.log(`  BASELINE:  ${totalNew.baseline} senales nuevas (${states.baseline.signals.filter(s => s.status === "PENDING").length} pendientes)`);
  console.log(`  EXTEND-UP: ${totalNew["extend-up"]} senales nuevas (${states["extend-up"].signals.filter(s => s.status === "PENDING").length} pendientes)`);
}

// ============================================================
// CHECK RESULTS
// ============================================================
async function checkResults() {
  console.log("\n=== VERIFICANDO RESULTADOS ===\n");

  const states = {};
  for (const [key, variant] of Object.entries(VARIANTS)) {
    states[key] = loadState(variant.stateFile);
  }

  const totalPending = Object.values(states).reduce(
    (s, st) => s + st.signals.filter(sg => sg.status === "PENDING").length, 0
  );

  if (totalPending === 0) {
    console.log("No hay senales pendientes.");
    return;
  }

  console.log(`Obteniendo resultados de la API...`);
  const scores = await fetchScores();
  console.log(`${scores.length} partidos completados encontrados\n`);

  let totalSettled = { baseline: 0, "extend-up": 0 };

  for (const [key, variant] of Object.entries(VARIANTS)) {
    const pending = states[key].signals.filter(s => s.status === "PENDING");

    for (const signal of pending) {
      const score = scores.find(s => {
        const homeMatch = normalizeTeamName(s.homeTeam) === normalizeTeamName(signal.homeTeam) ||
                          s.homeTeam === signal.homeTeam;
        const awayMatch = normalizeTeamName(s.awayTeam) === normalizeTeamName(signal.awayTeam) ||
                          s.awayTeam === signal.awayTeam;
        return homeMatch && awayMatch;
      });

      if (!score) continue;

      const won = (signal.side === "H" && score.result === "H");
      const profit = won ? signal.stake * (signal.odds - 1) : -signal.stake;

      signal.status = "SETTLED";
      signal.won = won;
      signal.homeScore = score.homeScore;
      signal.awayScore = score.awayScore;
      signal.profit = Math.round(profit * 100) / 100;
      signal.settledAt = new Date().toISOString();

      states[key].bankroll += profit;
      states[key].totalBets++;
      states[key].totalStaked += signal.stake;
      states[key].totalProfit += profit;
      if (won) states[key].wins++;
      else states[key].losses++;

      states[key].results.push({ ...signal });
      totalSettled[key]++;

      console.log(`  [${variant.name}] ${signal.homeTeam} ${score.homeScore}-${score.awayScore} ${signal.awayTeam} => ${won ? "WIN" : "LOSS"} (EUR ${profit >= 0 ? "+" : ""}${profit.toFixed(2)})`);

      // Enviar notificacion a Telegram
      const msg = won
        ? buildWinMessage(variant.name, signal, states[key])
        : buildLossMessage(variant.name, signal, states[key]);
      await sendTelegram(msg);
    }

    saveState(variant.stateFile, states[key]);
  }

  console.log(`\n=== LIQUIDACION COMPLETA ===`);
  console.log(`  BASELINE:  ${totalSettled.baseline} liquidadas`);
  console.log(`  EXTEND-UP: ${totalSettled["extend-up"]} liquidadas`);
}

// ============================================================
// REPORT
// ============================================================
function showReport() {
  console.log("\n" + "=".repeat(85));
  console.log("   PAPER TRADING COMPARISON REPORT");
  console.log("=".repeat(85));

  const states = {};
  for (const [key, variant] of Object.entries(VARIANTS)) {
    states[key] = loadState(variant.stateFile);
  }

  for (const [key, variant] of Object.entries(VARIANTS)) {
    const st = states[key];
    const pending = st.signals.filter(s => s.status === "PENDING").length;
    const winRate = st.totalBets > 0 ? (st.wins / st.totalBets * 100).toFixed(1) : "0.0";
    const roi = st.totalStaked > 0 ? (st.totalProfit / st.totalStaked * 100).toFixed(1) : "0.0";
    const profitPnL = st.bankroll - BANKROLL;

    console.log(`\n   ${variant.name} — ${variant.description}`);
    console.log("   " + "-".repeat(80));
    console.log(`     Bankroll:        EUR ${st.bankroll.toFixed(2)} (inicio: EUR ${BANKROLL})`);
    console.log(`     P&L:             EUR ${profitPnL >= 0 ? "+" : ""}${profitPnL.toFixed(2)}`);
    console.log(`     Apuestas:        ${st.totalBets} liquidadas (${pending} pendientes)`);
    console.log(`     Win/Loss:        ${st.wins}W / ${st.losses}L (${winRate}%)`);
    console.log(`     Total apostado:  EUR ${st.totalStaked.toFixed(2)}`);
    console.log(`     ROI:             ${roi}%`);
    if (st.startedAt) {
      const days = Math.floor((Date.now() - new Date(st.startedAt)) / (1000 * 60 * 60 * 24));
      console.log(`     Activo desde:    ${days} dias (${st.startedAt.slice(0, 10)})`);
    }
  }

  // Comparativa directa
  const baselineProfit = states.baseline.bankroll - BANKROLL;
  const extendProfit = states["extend-up"].bankroll - BANKROLL;
  const diff = extendProfit - baselineProfit;

  console.log("\n" + "=".repeat(85));
  console.log("   COMPARATIVA");
  console.log("=".repeat(85));
  console.log(`     EXTEND-UP vs BASELINE: ${diff >= 0 ? "+" : ""}EUR ${diff.toFixed(2)}`);

  if (states.baseline.totalBets > 0 && states["extend-up"].totalBets > 0) {
    const baseRoi = states.baseline.totalProfit / states.baseline.totalStaked * 100;
    const extendRoi = states["extend-up"].totalProfit / states["extend-up"].totalStaked * 100;
    console.log(`     ROI BASELINE:   ${baseRoi.toFixed(2)}%`);
    console.log(`     ROI EXTEND-UP:  ${extendRoi.toFixed(2)}%`);
    console.log(`     ROI diferencia: ${(extendRoi - baseRoi >= 0 ? "+" : "")}${(extendRoi - baseRoi).toFixed(2)}%`);
  } else {
    console.log(`     (Aun no hay suficientes apuestas liquidadas para comparar ROI)`);
  }

  // Ultimas senales
  console.log("\n   ULTIMAS SENALES PENDIENTES:");
  for (const [key, variant] of Object.entries(VARIANTS)) {
    const pending = states[key].signals.filter(s => s.status === "PENDING").slice(-5);
    if (pending.length === 0) {
      console.log(`     [${variant.name}] (sin pendientes)`);
      continue;
    }
    console.log(`     [${variant.name}]`);
    for (const s of pending) {
      const date = new Date(s.commenceTime).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      console.log(`       ${date} | ${s.homeTeam} vs ${s.awayTeam} | ${s.odds.toFixed(2)} | EUR ${s.stake}`);
    }
  }

  console.log("\n" + "=".repeat(85) + "\n");
}

function resetStates() {
  console.log("\nBORRANDO portfolios de paper trading...");
  for (const [key, variant] of Object.entries(VARIANTS)) {
    if (fs.existsSync(variant.stateFile)) {
      fs.unlinkSync(variant.stateFile);
      console.log(`  Borrado: ${variant.stateFile}`);
    }
  }
  console.log("Reset completo.\n");
}

// ============================================================
// UTILS
// ============================================================
function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// TEST TELEGRAM CONNECTION
// ============================================================
async function testTelegram() {
  console.log("\n=== TEST DE CONEXION TELEGRAM ===\n");

  if (!TELEGRAM_BOT_TOKEN) {
    console.log("  ERROR: TELEGRAM_BOT_TOKEN no esta definida");
    console.log("  Configurala con: $env:TELEGRAM_BOT_TOKEN=\"tu_token\"");
    return;
  }
  if (!TELEGRAM_CHANNEL_ID) {
    console.log("  ERROR: TELEGRAM_CHANNEL_ID no esta definida");
    console.log("  Configurala con: $env:TELEGRAM_CHANNEL_ID=\"tu_id\"");
    return;
  }

  console.log(`  Token: ${TELEGRAM_BOT_TOKEN.slice(0, 10)}...`);
  console.log(`  Channel: ${TELEGRAM_CHANNEL_ID}`);

  // Test 1: Verificar bot con getMe
  console.log("\n  [1/2] Verificando bot (getMe)...");
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      console.log(`  ERROR: ${data.description}`);
      return;
    }
    console.log(`  OK: @${data.result.username} (${data.result.first_name})`);
  } catch (err) {
    console.log(`  ERROR de conexion: ${err.message}`);
    return;
  }

  // Test 2: Enviar mensaje de prueba
  console.log("\n  [2/2] Enviando mensaje de prueba al canal...");
  const testMsg = [
    "🤖 <b>PAPER TRADE BOT — TEST</b>",
    "",
    "Conexion funcionando correctamente.",
    "",
    `🕒 ${new Date().toLocaleString("es-ES")}`,
    "",
    "A partir de ahora recibiras:",
    "• 🟢 Nuevas apuestas detectadas",
    "• ✅ Victorias con ganancia",
    "• ❌ Derrotas con perdida",
    "",
    "Para ambas variantes: BASELINE y EXTEND-UP",
  ].join("\n");

  const result = await sendTelegram(testMsg);
  if (result.ok && !result.dry_run) {
    console.log("  OK: Mensaje enviado. Revisa tu canal.");
  } else if (result.dry_run) {
    console.log("  DRY RUN: el mensaje no se envio (variables no configuradas).");
  } else {
    console.log(`  ERROR: ${result.error || "desconocido"}`);
  }
  console.log("");
}

// ============================================================
// FORCE NOTIFY — reenvia todas las pendientes a Telegram
// (util para testear despues de anadir la integracion)
// ============================================================
async function forceNotifyPending() {
  console.log("\n=== REENVIANDO PENDIENTES A TELEGRAM ===\n");

  for (const [key, variant] of Object.entries(VARIANTS)) {
    const state = loadState(variant.stateFile);
    const pending = state.signals.filter(s => s.status === "PENDING");

    if (pending.length === 0) {
      console.log(`  [${variant.name}] sin pendientes`);
      continue;
    }

    console.log(`  [${variant.name}] enviando ${pending.length} apuestas pendientes...`);
    for (const signal of pending) {
      await sendTelegram(buildNewBetMessage(variant.name, signal, state));
      await sleep(500); // Rate limit
    }
  }
  console.log("\nEnvio completo.\n");
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  const args = process.argv.slice(2);

  console.log("=".repeat(85));
  console.log("   PAPER TRADE COMPARE — BASELINE vs EXTEND-UP");
  console.log(`   Telegram: ${DRY_RUN ? "DRY RUN (no se envian mensajes)" : "ACTIVO"}`);
  console.log("=".repeat(85));

  if (args.includes("--test-telegram")) {
    await testTelegram();
  } else if (args.includes("--force-notify")) {
    await forceNotifyPending();
  } else if (args.includes("--scan")) {
    await scanForSignals();
  } else if (args.includes("--results")) {
    await checkResults();
  } else if (args.includes("--report")) {
    showReport();
  } else if (args.includes("--reset")) {
    resetStates();
  } else {
    console.log(`
  Uso:
    node paper-trade-compare.js --scan            Detecta senales nuevas (envia a Telegram)
    node paper-trade-compare.js --results         Verifica resultados (envia a Telegram)
    node paper-trade-compare.js --report          Muestra comparativa en consola
    node paper-trade-compare.js --test-telegram   Prueba la conexion con Telegram
    node paper-trade-compare.js --force-notify    Reenvia pendientes a Telegram
    node paper-trade-compare.js --reset           Borra todo y empieza de cero
    node paper-trade-compare.js --dry-run ...     Anade --dry-run para no enviar a Telegram

  Variantes:
    BASELINE:  zonas 2.30-2.60 + 3.00-3.50 (calidad alta, menos volumen)
    EXTEND-UP: zonas 2.30-2.60 + 3.00-4.00 (mas volumen, ROI ligeramente menor)

  Cada variante tiene su propio bankroll de EUR ${BANKROLL} y portfolio independiente.

  Workflow tipico:
    1. node paper-trade-compare.js --test-telegram    (primera vez, validar conexion)
    2. node paper-trade-compare.js --scan             (cada manana)
    3. node paper-trade-compare.js --results          (cada noche)
    4. node paper-trade-compare.js --report           (cuando quieras ver resultados)
`);
  }
}

main().catch(err => {
  console.error("Error fatal:", err);
  process.exit(1);
});
