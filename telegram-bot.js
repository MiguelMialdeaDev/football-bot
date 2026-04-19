// ============================================================
// TELEGRAM FOOTBALL BETTING BOT
// ============================================================
//
// Sends football betting signals from the predictor-v3 model
// to a Telegram channel. Tracks results and sends summaries.
//
// SETUP:
//   1. Open Telegram, search @BotFather
//   2. Send /newbot and follow the instructions
//   3. Copy the token BotFather gives you
//   4. Create a Telegram channel (or group)
//   5. Add your bot as admin of the channel
//   6. Get the channel ID:
//      - For public channels: use @channelname (e.g., "@my_bets")
//      - For private channels: forward a message from the channel to @userinfobot
//      - Or use: https://api.telegram.org/bot<TOKEN>/getUpdates after posting in the channel
//   7. Set environment variables:
//      export TELEGRAM_BOT_TOKEN="your_token_here"
//      export TELEGRAM_CHANNEL_ID="your_channel_id_here"
//
// USAGE:
//   node telegram-bot.js --scan          Scan for opportunities and send signals
//   node telegram-bot.js --results       Check results of pending signals
//   node telegram-bot.js --weekly        Send weekly summary
//   node telegram-bot.js --monthly       Send monthly summary
//   node telegram-bot.js --dry-run       Print what would be sent (no Telegram)
//
// SCHEDULING (cron examples):
//   0 9 * * * node telegram-bot.js --scan        # Scan every morning at 9am
//   0 22 * * * node telegram-bot.js --results     # Check results every night at 10pm
//   0 12 * * 0 node telegram-bot.js --weekly      # Weekly summary Sunday noon
//   0 10 1 * * node telegram-bot.js --monthly     # Monthly summary 1st of month
//
// ============================================================

const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "YOUR_CHANNEL_ID_HERE";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "400df6d994cce4079380c2bcdf229ae5";

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(__dirname, "telegram-bot-state.json");

// Model config — matches predictor-v3.js exactly
const BANKROLL = 5000;
const KELLY_FRACTION = 0.33;
const MIN_EDGE = 0.06;
const MAX_EDGE = 0.15;
const MAX_BET_PCT = 0.03;
const MIN_ODDS = 1.70;
const MAX_ODDS = 3.50;
const MIN_TEAM_MATCHES = 8;
const BET_TYPES = ["H"];

// Bankroll tiers for display
const BANKROLL_TIERS = [50, 500, 5000];

// The-odds-api sport keys mapped to our league codes
// Note: some keys may vary — check https://api.the-odds-api.com/v4/sports/?apiKey=KEY
// Leagues updated 2026-04-11: removed SC0 (-32% ROI in backtest), added D2 (+19.6% ROI)
const ODDS_API_SPORTS = {
  soccer_spain_segunda_division: "SP2",
  soccer_france_ligue_two: "F2",
  soccer_greece_super_league: "G1",
  soccer_germany_bundesliga2: "D2",
  // Fallback keys (the-odds-api sometimes uses different keys)
  soccer_spain_la_liga_2: "SP2",
  soccer_france_ligue_2: "F2",
  soccer_greece_super_league_2: "G1",
  soccer_germany_bundesliga_2: "D2",
};

// Team name aliases: API name -> CSV name
// This bridges the gap between the-odds-api team names and football-data.co.uk CSV names
const TEAM_ALIASES = {
  // Segunda Division
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
  // Ligue 2
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
  // Greek Super League
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
  // 2. Bundesliga
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

const TARGET_LEAGUES = {
  SP2: "Segunda Division",
  F2: "Ligue 2",
  G1: "Greek Super",
  D2: "2. Bundesliga",
};

// All leagues for CSV data loading (same as predictor-v3.js)
const ALL_LEAGUES = {
  SP1: "La Liga", E0: "Premier League", D1: "Bundesliga", I1: "Serie A",
  F1: "Ligue 1", D2: "2. Bundesliga", I2: "Serie B", T1: "Turquia",
  N1: "Eredivisie", P1: "Portugal", SP2: "Segunda",
  E1: "Championship", F2: "Ligue 2", SC0: "Scottish Prem",
  B1: "Belgian Pro", G1: "Greek Super",
  EC: "English League 1", E2: "English League 2", SC1: "Scottish Championship",
};
const SEASONS = ["2223", "2324", "2425"];

// Dry run flag
const DRY_RUN = process.argv.includes("--dry-run") || TELEGRAM_BOT_TOKEN === "YOUR_BOT_TOKEN_HERE";

// ============================================================
// TELEGRAM API
// ============================================================

async function sendTelegram(text) {
  if (DRY_RUN) {
    console.log("\n--- DRY RUN (would send to Telegram) ---");
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

// ============================================================
// STATE MANAGEMENT
// ============================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Error loading state:", e.message);
  }
  return {
    signals: [],
    results: [],
    totalPnL: 0,
    totalBets: 0,
    wins: 0,
    losses: 0,
    currentStreak: { type: null, count: 0 },
    monthlyPnL: {},
    weeklyPnL: {},
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// DATA LOADING (from predictor-v3.js)
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
          league, date, dateStr: c[g("Date")],
          home: c[g("HomeTeam")], away: c[g("AwayTeam")],
          hg: fthg, ag: ftag,
          result: c[g("FTR")],
          totalGoals: fthg + ftag,
          hs: parseInt(c[g("HS")]) || 0, as: parseInt(c[g("AS")]) || 0,
          hst: parseInt(c[g("HST")]) || 0, ast: parseInt(c[g("AST")]) || 0,
          hthg: parseInt(c[g("HTHG")]) || 0, htag: parseInt(c[g("HTAG")]) || 0,
          pinnH: parseFloat(c[g("PSH")]) || 0,
          pinnD: parseFloat(c[g("PSD")]) || 0,
          pinnA: parseFloat(c[g("PSA")]) || 0,
          pinnCH: parseFloat(c[g("PSCH")]) || 0,
          pinnCD: parseFloat(c[g("PSCD")]) || 0,
          pinnCA: parseFloat(c[g("PSCA")]) || 0,
          pinnOver: parseFloat(c[g("P>2.5")]) || 0,
          pinnUnder: parseFloat(c[g("P<2.5")]) || 0,
          pinnCOver: parseFloat(c[g("PC>2.5")]) || 0,
          pinnCUnder: parseFloat(c[g("PC<2.5")]) || 0,
        });
      }
    }
  }
  all.sort((a, b) => a.date - b.date);
  return all;
}

// ============================================================
// FEATURE ENGINEERING (from predictor-v3.js — exact copy)
// ============================================================

function buildTeamStats(matches) {
  const stats = {};

  for (const m of matches) {
    for (const side of ["home", "away"]) {
      const team = side === "home" ? m.home : m.away;
      if (!stats[team]) stats[team] = { matches: [], league: m.league };

      const isHome = side === "home";
      stats[team].matches.push({
        date: m.date,
        isHome,
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

  // FEATURE 1: Form — blended long-term (last 10) + short-term (last 4)
  const points = recent.reduce((s, m) =>
    s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const formPctLong = points / (recent.length * 3);

  const recent4 = ts.matches.slice(-4);
  const points4 = recent4.reduce((s, m) =>
    s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const recentFormPct = points4 / (recent4.length * 3);

  // Blend: 40% long-term, 60% short-term
  const formPct = formPctLong * 0.4 + recentFormPct * 0.6;

  // FEATURE 2: Goals ratio (scored / conceded, capped)
  const goalsFor = avg(recent.map(m => m.goalsFor));
  const goalsAgainst = avg(recent.map(m => m.goalsAgainst));
  const goalsRatio = goalsAgainst > 0
    ? Math.min(3.0, goalsFor / goalsAgainst)
    : goalsFor > 0 ? 3.0 : 1.0;

  // FEATURE 3: Home/Away win percentage
  const homeWinPct = homeMatches.length >= 3
    ? homeMatches.filter(m => m.result === "W").length / homeMatches.length
    : 0.45;
  const awayWinPct = awayMatches.length >= 3
    ? awayMatches.filter(m => m.result === "W").length / awayMatches.length
    : 0.30;

  // FEATURE 4: Shots on target ratio (attacking quality proxy)
  const sotFor = avg(recent.map(m => m.shotsOnTarget || 0));
  const sotAgainst = avg(recent.map(m => m.shotsOnTargetAgainst || 0));
  const sotRatio = sotAgainst > 0
    ? Math.min(3.0, sotFor / sotAgainst)
    : sotFor > 0 ? 3.0 : 1.0;

  // FEATURE 5: Blended performance ratio (goals + SOT xG proxy)
  const shotRatio = sotFor > 0.1 ? Math.min(3.0, sotFor / Math.max(0.1, sotAgainst)) : 1.0;
  const performanceRatio = goalsRatio * 0.5 + shotRatio * 0.5;

  return {
    formPct,
    goalsFor,
    goalsAgainst,
    goalsRatio,
    performanceRatio,
    homeWinPct,
    awayWinPct,
    sotFor,
    sotAgainst,
    sotRatio,
    totalMatches: ts.matches.length,
  };
}

// ============================================================
// PREDICTION (from predictor-v3.js — exact copy)
// ============================================================

function predict(homeFeatures, awayFeatures, leagueAvg, motivation) {
  if (!homeFeatures || !awayFeatures) return null;

  const baseHome = leagueAvg.homeGoals || 1.45;
  const baseAway = leagueAvg.awayGoals || 1.10;
  const avgGoals = (baseHome + baseAway) / 2;

  let homeAttack = homeFeatures.goalsFor / avgGoals;
  let awayAttack = awayFeatures.goalsFor / avgGoals;
  let homeDefense = homeFeatures.goalsAgainst / avgGoals;
  let awayDefense = awayFeatures.goalsAgainst / avgGoals;

  // xG proxy adjustment
  if (homeFeatures.performanceRatio > 0 && homeFeatures.goalsRatio > 0) {
    const perfAdj = homeFeatures.performanceRatio / homeFeatures.goalsRatio;
    homeAttack *= Math.max(0.92, Math.min(1.08, perfAdj));
  }
  if (awayFeatures.performanceRatio > 0 && awayFeatures.goalsRatio > 0) {
    const perfAdj = awayFeatures.performanceRatio / awayFeatures.goalsRatio;
    awayAttack *= Math.max(0.92, Math.min(1.08, perfAdj));
  }

  // Form adjustment
  const homeFormAdj = 0.95 + homeFeatures.formPct * 0.10;
  const awayFormAdj = 0.95 + awayFeatures.formPct * 0.10;

  // Home advantage
  const homeAdv = homeFeatures.homeWinPct > 0.1
    ? Math.max(0.95, Math.min(1.08, homeFeatures.homeWinPct / 0.45))
    : 1.0;

  // Expected goals
  let lambdaHome = homeAttack * awayDefense * baseHome * homeFormAdj * homeAdv;
  let lambdaAway = awayAttack * homeDefense * baseAway * awayFormAdj;

  // Motivation adjustment
  if (motivation) {
    if (motivation.homeInTop3 || motivation.homeInBottom3) lambdaHome *= 1.03;
    if (motivation.homeInDeadZone) lambdaHome *= 0.97;
    if (motivation.awayInTop3) lambdaHome *= 0.98;
  }

  // Shrinkage
  const homeShrink = Math.min(1, homeFeatures.totalMatches / 20);
  const awayShrink = Math.min(1, awayFeatures.totalMatches / 20);
  lambdaHome = lambdaHome * homeShrink + baseHome * (1 - homeShrink);
  lambdaAway = lambdaAway * awayShrink + baseAway * (1 - awayShrink);

  // Cap lambdas
  lambdaHome = Math.max(0.4, Math.min(3.5, lambdaHome));
  lambdaAway = Math.max(0.3, Math.min(3.0, lambdaAway));

  // Poisson probabilities
  let pH = 0, pD = 0, pA = 0, pOver = 0, pUnder = 0;
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = poisson(i, lambdaHome) * poisson(j, lambdaAway);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (i + j > 2) pOver += p;
      if (i + j <= 2) pUnder += p;
    }
  }

  const total = pH + pD + pA;
  pH /= total; pD /= total; pA /= total;

  // Calibration fix v3.4: Variable shrinkage per bucket
  const baseH = 0.45;
  const baseD = 0.27;
  const baseA = 0.28;

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

  pOver = variableShrink(pOver, 0.50);
  pUnder = variableShrink(pUnder, 0.50);

  return { pH, pD, pA, pOver, pUnder, lambdaHome, lambdaAway };
}

function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

// ============================================================
// TABLE POSITION / MOTIVATION
// ============================================================

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

    if (m.result === "H") {
      table[m.home].pts += 3;
    } else if (m.result === "D") {
      table[m.home].pts += 1;
      table[m.away].pts += 1;
    } else {
      table[m.away].pts += 3;
    }
  }

  const sorted = Object.values(table).sort((a, b) =>
    b.pts - a.pts || b.gd - a.gd);

  const positions = {};
  sorted.forEach((t, i) => { positions[t.team] = i + 1; });

  return { positions, totalTeams: sorted.length };
}

function isDeadZone(position, totalTeams) {
  if (totalTeams < 12) return false;
  const thirdSize = Math.floor(totalTeams / 3);
  const deadStart = thirdSize + 1;
  const deadEnd = totalTeams - thirdSize;
  return position >= deadStart && position <= deadEnd;
}

// ============================================================
// LEAGUE STATS
// ============================================================

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
// UTILS
// ============================================================

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatDate(d) {
  const days = ["Domingo", "Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado"];
  const months = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateShort(d) {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function getWeekKey(d) {
  const start = new Date(d);
  start.setDate(start.getDate() - start.getDay() + 1); // Monday
  return `${start.getFullYear()}-W${String(Math.ceil((start.getDate()) / 7)).padStart(2, "0")}-${formatDateShort(start)}`;
}

function getMonthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthName(monthKey) {
  const months = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const [y, m] = monthKey.split("-");
  return `${months[parseInt(m) - 1]} ${y}`;
}

// ============================================================
// FETCH UPCOMING FIXTURES + ODDS (the-odds-api.com)
// ============================================================

async function fetchUpcomingFixtures() {
  const fixtures = [];

  // First, check which sports are available
  let availableSports = new Set();
  try {
    const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
    const sportsData = await sportsRes.json();
    if (Array.isArray(sportsData)) {
      for (const s of sportsData) availableSports.add(s.key);
      console.log(`  ${availableSports.size} sports available on the-odds-api`);
    }
  } catch (e) {
    console.log(`  Could not fetch sports list: ${e.message}`);
  }

  for (const [sportKey, leagueCode] of Object.entries(ODDS_API_SPORTS)) {
    // Skip if sport not available
    if (availableSports.size > 0 && !availableSports.has(sportKey)) {
      continue; // Silently skip unavailable sport keys (aliases)
    }
    console.log(`  Fetching odds for ${TARGET_LEAGUES[leagueCode]} (${sportKey})...`);

    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
      const res = await fetch(url);

      if (!res.ok) {
        const remaining = res.headers.get("x-requests-remaining");
        console.log(`  API error ${res.status} for ${sportKey} (remaining: ${remaining})`);
        continue;
      }

      const remaining = res.headers.get("x-requests-remaining");
      const used = res.headers.get("x-requests-used");
      console.log(`  API requests: ${used} used, ${remaining} remaining`);

      const data = await res.json();
      if (!Array.isArray(data)) continue;

      for (const event of data) {
        // Get best odds from all bookmakers
        let bestHomeOdds = 0, bestDrawOdds = 0, bestAwayOdds = 0;
        let avgHomeOdds = 0, avgDrawOdds = 0, avgAwayOdds = 0;
        let bookCount = 0;

        for (const bm of (event.bookmakers || [])) {
          const market = bm.markets?.find(m => m.key === "h2h");
          if (!market) continue;

          const homeOutcome = market.outcomes?.find(o => o.name === event.home_team);
          const awayOutcome = market.outcomes?.find(o => o.name === event.away_team);
          const drawOutcome = market.outcomes?.find(o => o.name === "Draw");

          if (homeOutcome) {
            bestHomeOdds = Math.max(bestHomeOdds, homeOutcome.price);
            avgHomeOdds += homeOutcome.price;
          }
          if (drawOutcome) {
            bestDrawOdds = Math.max(bestDrawOdds, drawOutcome.price);
            avgDrawOdds += drawOutcome.price;
          }
          if (awayOutcome) {
            bestAwayOdds = Math.max(bestAwayOdds, awayOutcome.price);
            avgAwayOdds += awayOutcome.price;
          }
          bookCount++;
        }

        if (bookCount > 0) {
          avgHomeOdds /= bookCount;
          avgDrawOdds /= bookCount;
          avgAwayOdds /= bookCount;
        }

        // Use average odds (closer to Pinnacle-like sharp odds)
        fixtures.push({
          id: event.id,
          sportKey,
          leagueCode,
          leagueName: TARGET_LEAGUES[leagueCode],
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          commenceTime: new Date(event.commence_time),
          oddsH: avgHomeOdds || bestHomeOdds,
          oddsD: avgDrawOdds || bestDrawOdds,
          oddsA: avgAwayOdds || bestAwayOdds,
          bestOddsH: bestHomeOdds,
          bestOddsD: bestDrawOdds,
          bestOddsA: bestAwayOdds,
        });
      }

      await sleep(600); // Rate limit: 10 req/min
    } catch (err) {
      console.error(`  Error fetching ${sportKey}:`, err.message);
    }
  }

  return fixtures;
}

// ============================================================
// FETCH SCORES / RESULTS (the-odds-api.com)
// ============================================================

async function fetchScores() {
  const scores = [];

  // Check which sports are available
  let availableSports = new Set();
  try {
    const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
    const sportsData = await sportsRes.json();
    if (Array.isArray(sportsData)) {
      for (const s of sportsData) availableSports.add(s.key);
    }
  } catch (e) { /* ignore */ }

  for (const [sportKey, leagueCode] of Object.entries(ODDS_API_SPORTS)) {
    if (availableSports.size > 0 && !availableSports.has(sportKey)) continue;
    console.log(`  Fetching scores for ${TARGET_LEAGUES[leagueCode]}...`);

    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=5&dateFormat=iso`;
      const res = await fetch(url);

      if (!res.ok) {
        console.log(`  API error ${res.status} for ${sportKey}`);
        continue;
      }

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
          sportKey,
          leagueCode,
          leagueName: TARGET_LEAGUES[leagueCode],
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          homeScore,
          awayScore,
          result,
          completed: true,
        });
      }

      await sleep(600);
    } catch (err) {
      console.error(`  Error fetching scores for ${sportKey}:`, err.message);
    }
  }

  return scores;
}

// ============================================================
// TEAM NAME MATCHING (API names vs CSV names)
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
  // Direct match
  if (teamStats[apiName]) return apiName;

  // Alias match (most reliable)
  const alias = TEAM_ALIASES[apiName];
  if (alias && teamStats[alias]) return alias;

  // Normalized match
  const normalized = normalizeTeamName(apiName);
  for (const csvName of Object.keys(teamStats)) {
    if (normalizeTeamName(csvName) === normalized) return csvName;
  }

  // Partial match — API name contains CSV name or vice versa
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

// ============================================================
// SCAN FOR OPPORTUNITIES
// ============================================================

async function scanOpportunities() {
  console.log("\n=== SCANNING FOR BETTING OPPORTUNITIES ===\n");

  // Load historical data and build model
  console.log("  Loading historical data...");
  const allMatches = loadAllData();
  console.log(`  ${allMatches.length} matches loaded from ${Object.keys(ALL_LEAGUES).length} leagues`);

  const teamStats = buildTeamStats(allMatches);
  const leagueStats = computeLeagueStats(allMatches);

  // Build standings per target league
  const standingsByLeague = {};
  for (const lg of Object.keys(TARGET_LEAGUES)) {
    standingsByLeague[lg] = buildStandings(allMatches, lg);
  }

  // Fetch upcoming fixtures with odds
  console.log("\n  Fetching upcoming fixtures...");
  const fixtures = await fetchUpcomingFixtures();
  console.log(`  ${fixtures.length} upcoming fixtures found\n`);

  if (fixtures.length === 0) {
    console.log("  No fixtures found. Check API key and sport availability.");
    return [];
  }

  const state = loadState();
  const signals = [];

  for (const fixture of fixtures) {
    // Skip if already signaled
    const alreadySignaled = state.signals.some(s =>
      s.homeTeam === fixture.homeTeam &&
      s.awayTeam === fixture.awayTeam &&
      s.commenceTime === fixture.commenceTime.toISOString()
    );
    if (alreadySignaled) {
      console.log(`  SKIP (already signaled): ${fixture.homeTeam} vs ${fixture.awayTeam}`);
      continue;
    }

    // Match team names to CSV data
    const homeCSV = findTeamInStats(fixture.homeTeam, teamStats);
    const awayCSV = findTeamInStats(fixture.awayTeam, teamStats);

    if (!homeCSV || !awayCSV) {
      console.log(`  SKIP (no data): ${fixture.homeTeam} vs ${fixture.awayTeam} [home=${homeCSV || "?"}, away=${awayCSV || "?"}]`);
      continue;
    }

    const homeF = getFeatures(teamStats, homeCSV);
    const awayF = getFeatures(teamStats, awayCSV);
    const ls = leagueStats[fixture.leagueCode] || { homeGoals: 1.45, awayGoals: 1.10 };

    // Motivation context
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
    if (!pred) {
      console.log(`  SKIP (no prediction): ${fixture.homeTeam} vs ${fixture.awayTeam}`);
      continue;
    }

    // Check for betting opportunities (Home only, matching predictor-v3.js)
    const candidates = [];

    if (BET_TYPES.includes("H") && fixture.oddsH > 0) {
      candidates.push({
        side: "H",
        sideLabel: `${fixture.homeTeam} (Local)`,
        prob: pred.pH,
        odds: fixture.oddsH,
      });
    }

    for (const bet of candidates) {
      // Odds zone filter — exact match of predictor-v3.js
      const inZone1 = bet.odds >= 2.30 && bet.odds <= 2.60;
      const inZone2 = bet.odds >= 3.00 && bet.odds <= 3.50;
      if (!inZone1 && !inZone2) {
        console.log(`  SKIP (odds ${bet.odds.toFixed(2)} outside zones): ${fixture.homeTeam} vs ${fixture.awayTeam}`);
        continue;
      }

      const edge = bet.prob - 1 / bet.odds;
      if (edge < MIN_EDGE) {
        console.log(`  SKIP (edge ${(edge * 100).toFixed(1)}% < ${MIN_EDGE * 100}%): ${fixture.homeTeam} vs ${fixture.awayTeam}`);
        continue;
      }
      if (edge > MAX_EDGE) {
        console.log(`  SKIP (edge ${(edge * 100).toFixed(1)}% > ${MAX_EDGE * 100}% — model error): ${fixture.homeTeam} vs ${fixture.awayTeam}`);
        continue;
      }

      // Kelly sizing
      const b = bet.odds - 1;
      const kelly = (b * bet.prob - (1 - bet.prob)) / b;
      if (kelly <= 0) continue;

      const betPct = Math.min(kelly * KELLY_FRACTION, MAX_BET_PCT);

      console.log(`  >>> SIGNAL: ${fixture.homeTeam} vs ${fixture.awayTeam} | ${bet.sideLabel} @ ${bet.odds.toFixed(2)} | Edge: ${(edge * 100).toFixed(1)}% | Prob: ${(bet.prob * 100).toFixed(1)}%`);

      const signal = {
        id: `${fixture.id}_${bet.side}_${Date.now()}`,
        eventId: fixture.id,
        sportKey: fixture.sportKey,
        leagueCode: fixture.leagueCode,
        leagueName: fixture.leagueName,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        commenceTime: fixture.commenceTime.toISOString(),
        side: bet.side,
        sideLabel: bet.sideLabel,
        odds: bet.odds,
        edge: edge,
        prob: bet.prob,
        betPct: betPct,
        kellyRaw: kelly,
        timestamp: new Date().toISOString(),
        status: "PENDING",
      };

      signals.push(signal);

      // Build signal message
      const msg = buildSignalMessage(signal, fixture.commenceTime);
      await sendTelegram(msg);

      // Save to state
      state.signals.push(signal);
    }
  }

  saveState(state);
  console.log(`\n=== SCAN COMPLETE: ${signals.length} signals sent ===\n`);
  return signals;
}

// ============================================================
// MESSAGE BUILDERS
// ============================================================

function buildSignalMessage(signal, matchDate) {
  const stakes = BANKROLL_TIERS.map(br => {
    const stake = br * signal.betPct;
    return `  Con \u20ac${br.toLocaleString("es-ES")}: apostar \u20ac${stake.toFixed(2)}`;
  }).join("\n");

  return [
    "\ud83d\udfe2 NUEVA SENAL",
    "",
    `\u26bd ${signal.homeTeam} vs ${signal.awayTeam}`,
    `\ud83c\udfc6 ${signal.leagueName}`,
    `\ud83d\udcc5 ${formatDate(matchDate)}`,
    "",
    `\u2705 Apuesta: ${signal.sideLabel}`,
    `\ud83d\udcca Odds: ${signal.odds.toFixed(2)}`,
    `\ud83d\udcb0 Edge: ${(signal.edge * 100).toFixed(1)}%`,
    `\ud83c\udfaf Confianza del modelo: ${(signal.prob * 100).toFixed(1)}%`,
    "",
    `\ud83d\udcb5 Apuesta sugerida:`,
    stakes,
    "",
    `\u26a0\ufe0f Disclaimer: Esto no es consejo financiero. Apostar implica riesgo de perdida.`,
  ].join("\n");
}

function buildWinMessage(signal, homeScore, awayScore, state) {
  const profitPerUnit = signal.odds - 1;
  const profits = BANKROLL_TIERS.map(br => {
    const stake = br * signal.betPct;
    const profit = stake * profitPerUnit;
    return `  Con \u20ac${br.toLocaleString("es-ES")} bankroll: +\u20ac${profit.toFixed(2)}`;
  }).join("\n");

  const streakText = state.currentStreak.type === "W"
    ? `${state.currentStreak.count}W seguidas`
    : `${state.currentStreak.count}W`;

  return [
    "\u2705 RESULTADO \u2014 GANADA",
    "",
    `\u26bd ${signal.homeTeam} ${homeScore} - ${awayScore} ${signal.awayTeam}`,
    `\ud83c\udfc6 ${signal.leagueName}`,
    "",
    `Apostamos: ${signal.sideLabel} a odds ${signal.odds.toFixed(2)}`,
    `Resultado: \u2705 GANADA`,
    "",
    `\ud83d\udcb0 Profit por cada \u20ac1 apostado: +\u20ac${profitPerUnit.toFixed(2)}`,
    profits,
    "",
    `\ud83d\udcc8 Racha: ${streakText}`,
  ].join("\n");
}

function buildLossMessage(signal, homeScore, awayScore, state) {
  const losses = BANKROLL_TIERS.map(br => {
    const stake = br * signal.betPct;
    return `  Con \u20ac${br.toLocaleString("es-ES")} bankroll: -\u20ac${stake.toFixed(2)}`;
  }).join("\n");

  const streakText = state.currentStreak.type === "L"
    ? `${state.currentStreak.count}L`
    : `${state.currentStreak.count}L`;

  // Calculate month profit
  const monthKey = getMonthKey(new Date());
  const monthPnL = state.monthlyPnL[monthKey]?.pnl || 0;
  const monthNote = monthPnL >= 0
    ? `Seguimos +\u20ac${monthPnL.toFixed(2)} este mes.`
    : `Vamos -\u20ac${Math.abs(monthPnL).toFixed(2)} este mes.`;

  return [
    "\u274c RESULTADO \u2014 PERDIDA",
    "",
    `\u26bd ${signal.homeTeam} ${homeScore} - ${awayScore} ${signal.awayTeam}`,
    `\ud83c\udfc6 ${signal.leagueName}`,
    "",
    `Apostamos: ${signal.sideLabel} a odds ${signal.odds.toFixed(2)}`,
    `Resultado: \u274c PERDIDA`,
    "",
    `\ud83d\udcb0 Perdida por cada \u20ac1 apostado: -\u20ac1.00`,
    losses,
    "",
    `\ud83d\udcc9 Racha: ${streakText}`,
    `Nota: Las rachas perdedoras son normales. ${monthNote}`,
  ].join("\n");
}

function buildWeeklySummary(state) {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);

  // Filter results from this week
  const weekResults = state.results.filter(r => {
    const d = new Date(r.settledAt);
    return d >= weekStart && d <= now;
  });

  const weekBets = weekResults.length;
  const weekWins = weekResults.filter(r => r.won).length;
  const weekLosses = weekBets - weekWins;
  const winRate = weekBets > 0 ? (weekWins / weekBets * 100).toFixed(1) : "0.0";

  // Calculate week profit per unit staked
  let weekProfitPerUnit = 0;
  for (const r of weekResults) {
    if (r.won) {
      weekProfitPerUnit += (r.odds - 1) * r.betPct;
    } else {
      weekProfitPerUnit -= r.betPct;
    }
  }

  // Month profit
  const monthKey = getMonthKey(now);
  const monthPnL = state.monthlyPnL[monthKey]?.pnl || 0;

  // Total profit
  const totalProfitPer100 = state.totalPnL * 100;

  // Best and worst bets of the week
  let bestBet = null, worstBet = null;
  for (const r of weekResults) {
    const pnlPerUnit = r.won ? (r.odds - 1) : -1;
    if (!bestBet || pnlPerUnit > bestBet.pnl) {
      bestBet = { match: `${r.homeTeam} vs ${r.awayTeam}`, pnl: pnlPerUnit };
    }
    if (!worstBet || pnlPerUnit < worstBet.pnl) {
      worstBet = { match: `${r.homeTeam} vs ${r.awayTeam}`, pnl: pnlPerUnit };
    }
  }

  // Streak
  const streakText = state.currentStreak.type
    ? `${state.currentStreak.count}${state.currentStreak.type}`
    : "N/A";

  // Historical stats
  const histWinRate = state.totalBets > 0 ? (state.wins / state.totalBets * 100).toFixed(1) : "0.0";
  const histROI = state.totalBets > 0 ? (state.totalPnL / state.totalBets * 100 * 100).toFixed(1) : "0.0";

  const dateRange = `${formatDateShort(weekStart)}-${formatDateShort(now)}`;

  const lines = [
    `\ud83d\udcca RESUMEN SEMANAL \u2014 ${dateRange}`,
    "",
    `Apuestas: ${weekBets}`,
    `Ganadas: ${weekWins} \u2705 | Perdidas: ${weekLosses} \u274c`,
    `Win Rate: ${winRate}%`,
    "",
    `\ud83d\udcb0 Profit esta semana: ${weekProfitPerUnit >= 0 ? "+" : ""}\u20ac${(weekProfitPerUnit * 100).toFixed(2)} por cada \u20ac100 de bankroll`,
    `\ud83d\udcc8 Profit este mes: ${monthPnL >= 0 ? "+" : ""}\u20ac${(monthPnL * 100).toFixed(2)} por cada \u20ac100 de bankroll`,
    `\ud83d\udcc8 Profit total: ${state.totalPnL >= 0 ? "+" : ""}\u20ac${totalProfitPer100.toFixed(2)} por cada \u20ac100 de bankroll`,
  ];

  if (bestBet && weekBets > 0) {
    lines.push("");
    lines.push(`\ud83c\udfc6 Mejor apuesta: ${bestBet.match} (${bestBet.pnl >= 0 ? "+" : ""}\u20ac${bestBet.pnl.toFixed(2)} por \u20ac1)`);
    lines.push(`\ud83d\udc80 Peor apuesta: ${worstBet.match} (${worstBet.pnl >= 0 ? "+" : ""}\u20ac${worstBet.pnl.toFixed(2)} por \u20ac1)`);
  }

  lines.push("");
  lines.push(`Racha actual: ${streakText}`);
  lines.push(`Win Rate historico: ${histWinRate}%`);
  lines.push(`ROI historico: ${histROI}%`);

  return lines.join("\n");
}

function buildMonthlySummary(state) {
  const now = new Date();
  // Previous month
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthKey = getMonthKey(prevMonth);
  const monthName = getMonthName(monthKey);

  // Filter results from that month
  const monthResults = state.results.filter(r => {
    const d = new Date(r.settledAt);
    return getMonthKey(d) === monthKey;
  });

  const monthBets = monthResults.length;
  const monthWins = monthResults.filter(r => r.won).length;
  const monthLosses = monthBets - monthWins;
  const winRate = monthBets > 0 ? (monthWins / monthBets * 100).toFixed(1) : "0.0";

  // Calculate month profit per unit
  let monthProfitPerUnit = 0;
  for (const r of monthResults) {
    if (r.won) {
      monthProfitPerUnit += (r.odds - 1) * r.betPct;
    } else {
      monthProfitPerUnit -= r.betPct;
    }
  }

  const profitTiers = BANKROLL_TIERS.map(br => {
    const profit = monthProfitPerUnit * br;
    return `  Con \u20ac${br.toLocaleString("es-ES")}:    ${profit >= 0 ? "+" : ""}\u20ac${profit.toFixed(2)}`;
  }).join("\n");

  // Historical stats
  const histWinRate = state.totalBets > 0 ? (state.wins / state.totalBets * 100).toFixed(1) : "0.0";
  const histROI = state.totalBets > 0 ? (state.totalPnL / state.totalBets * 100 * 100).toFixed(1) : "0.0";

  // Count positive months
  const allMonths = Object.keys(state.monthlyPnL);
  const positiveMonths = allMonths.filter(k => (state.monthlyPnL[k]?.pnl || 0) > 0).length;

  return [
    `\ud83d\udcca RESUMEN MENSUAL \u2014 ${monthName}`,
    "",
    `Apuestas: ${monthBets}`,
    `Ganadas: ${monthWins} \u2705 | Perdidas: ${monthLosses} \u274c`,
    `Win Rate: ${winRate}%`,
    "",
    `\ud83d\udcb0 Profit: ${monthProfitPerUnit >= 0 ? "+" : ""}\u20ac${(monthProfitPerUnit * 100).toFixed(2)} por cada \u20ac100 de bankroll`,
    "",
    `\ud83d\udcc8 Tabla de resultados:`,
    profitTiers,
    "",
    `\ud83d\udcca Historico completo:`,
    `  Total apuestas: ${state.totalBets}`,
    `  Win Rate: ${histWinRate}%`,
    `  ROI: ${histROI}%`,
    `  Meses positivos: ${positiveMonths}/${allMonths.length}`,
    "",
    `\u26a0\ufe0f Rendimiento pasado no garantiza resultados futuros.`,
  ].join("\n");
}

// ============================================================
// CHECK RESULTS
// ============================================================

async function checkResults() {
  console.log("\n=== CHECKING RESULTS ===\n");

  const state = loadState();
  const pendingSignals = state.signals.filter(s => s.status === "PENDING");

  if (pendingSignals.length === 0) {
    console.log("  No pending signals to check.");
    return;
  }

  console.log(`  ${pendingSignals.length} pending signals to check\n`);

  // Fetch recent scores
  const scores = await fetchScores();
  console.log(`  ${scores.length} completed matches found\n`);

  let settled = 0;

  for (const signal of pendingSignals) {
    // Try to find matching score
    const score = scores.find(s => {
      // Match by team names (normalize for comparison)
      const homeMatch = normalizeTeamName(s.homeTeam) === normalizeTeamName(signal.homeTeam) ||
                        s.homeTeam === signal.homeTeam;
      const awayMatch = normalizeTeamName(s.awayTeam) === normalizeTeamName(signal.awayTeam) ||
                        s.awayTeam === signal.awayTeam;
      return homeMatch && awayMatch;
    });

    if (!score) {
      console.log(`  PENDING: ${signal.homeTeam} vs ${signal.awayTeam} (not yet played)`);
      continue;
    }

    // Determine if bet won
    const won = (signal.side === "H" && score.result === "H") ||
                (signal.side === "D" && score.result === "D") ||
                (signal.side === "A" && score.result === "A");

    // Update signal
    signal.status = "SETTLED";
    signal.won = won;
    signal.homeScore = score.homeScore;
    signal.awayScore = score.awayScore;
    signal.settledAt = new Date().toISOString();

    // Update state stats
    state.totalBets++;
    if (won) {
      state.wins++;
      state.totalPnL += (signal.odds - 1) * signal.betPct;
    } else {
      state.losses++;
      state.totalPnL -= signal.betPct;
    }

    // Update streak
    if (won) {
      if (state.currentStreak.type === "W") {
        state.currentStreak.count++;
      } else {
        state.currentStreak = { type: "W", count: 1 };
      }
    } else {
      if (state.currentStreak.type === "L") {
        state.currentStreak.count++;
      } else {
        state.currentStreak = { type: "L", count: 1 };
      }
    }

    // Update monthly P&L
    const monthKey = getMonthKey(new Date(signal.settledAt));
    if (!state.monthlyPnL[monthKey]) {
      state.monthlyPnL[monthKey] = { pnl: 0, bets: 0, wins: 0 };
    }
    state.monthlyPnL[monthKey].bets++;
    if (won) {
      state.monthlyPnL[monthKey].wins++;
      state.monthlyPnL[monthKey].pnl += (signal.odds - 1) * signal.betPct;
    } else {
      state.monthlyPnL[monthKey].pnl -= signal.betPct;
    }

    // Update weekly P&L
    const weekKey = getWeekKey(new Date(signal.settledAt));
    if (!state.weeklyPnL[weekKey]) {
      state.weeklyPnL[weekKey] = { pnl: 0, bets: 0, wins: 0 };
    }
    state.weeklyPnL[weekKey].bets++;
    if (won) {
      state.weeklyPnL[weekKey].wins++;
      state.weeklyPnL[weekKey].pnl += (signal.odds - 1) * signal.betPct;
    } else {
      state.weeklyPnL[weekKey].pnl -= signal.betPct;
    }

    // Add to results
    state.results.push({
      ...signal,
      won,
      homeScore: score.homeScore,
      awayScore: score.awayScore,
      settledAt: signal.settledAt,
    });

    // Send result message
    const msg = won
      ? buildWinMessage(signal, score.homeScore, score.awayScore, state)
      : buildLossMessage(signal, score.homeScore, score.awayScore, state);

    await sendTelegram(msg);
    settled++;

    console.log(`  SETTLED: ${signal.homeTeam} ${score.homeScore}-${score.awayScore} ${signal.awayTeam} => ${won ? "WIN" : "LOSS"}`);
  }

  saveState(state);
  console.log(`\n=== RESULTS CHECK COMPLETE: ${settled} settled, ${pendingSignals.length - settled} still pending ===\n`);
}

// ============================================================
// SEND WEEKLY SUMMARY
// ============================================================

async function sendWeekly() {
  console.log("\n=== SENDING WEEKLY SUMMARY ===\n");
  const state = loadState();
  const msg = buildWeeklySummary(state);
  await sendTelegram(msg);
  console.log("  Weekly summary sent.");
}

// ============================================================
// SEND MONTHLY SUMMARY
// ============================================================

async function sendMonthly() {
  console.log("\n=== SENDING MONTHLY SUMMARY ===\n");
  const state = loadState();
  const msg = buildMonthlySummary(state);
  await sendTelegram(msg);
  console.log("  Monthly summary sent.");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  console.log("=".repeat(60));
  console.log("  TELEGRAM FOOTBALL BETTING BOT");
  console.log("  Model: predictor-v3 | Leagues: " + Object.values(TARGET_LEAGUES).join(", "));
  console.log("  Mode: " + (DRY_RUN ? "DRY RUN (no Telegram)" : "LIVE"));
  console.log("=".repeat(60));

  if (args.includes("--scan")) {
    await scanOpportunities();
  } else if (args.includes("--results")) {
    await checkResults();
  } else if (args.includes("--weekly")) {
    await sendWeekly();
  } else if (args.includes("--monthly")) {
    await sendMonthly();
  } else {
    console.log(`
  Usage:
    node telegram-bot.js --scan       Scan for opportunities and send signals
    node telegram-bot.js --results    Check results of pending signals
    node telegram-bot.js --weekly     Send weekly summary
    node telegram-bot.js --monthly    Send monthly summary

  Add --dry-run to any command to print without sending to Telegram.

  Setup:
    1. Create a bot via @BotFather on Telegram
    2. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID env vars
    3. Add the bot as admin of your channel
    4. Run: node telegram-bot.js --scan --dry-run
`);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
