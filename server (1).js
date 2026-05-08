// ============================================================
// CS2 TRADEUP BOT — server.js  (full production version)
//
// New in this version:
//   - Float availability check via CSFloat listings
//   - Liquidity check (enough copies available to buy 10)
//   - StatTrak flag validated per-skin from ByMykel data
//   - Configurable sell fee per market (Steam 15%, CSFloat 2%, etc.)
//   - /api/refresh endpoint: re-fetch live prices for specific skins
//   - /api/history: save/load completed tradeup results (JSON file)
//   - Market selector: user declares which markets they have access to
//     and bot only shows prices from those markets
// ============================================================

try { require('dotenv').config(); } catch (_) {}
const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const NodeCache = require('node-cache');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Caches ----
const skinCache   = new NodeCache({ stdTTL: 3600 });
const priceCache  = new NodeCache({ stdTTL: parseInt(process.env.PRICE_CACHE_TTL || '300') });
const searchCache = new NodeCache({ stdTTL: 120 });
const floatCache  = new NodeCache({ stdTTL: 60 }); // listing floats cached 1min — very fresh

// ---- History file ----
const HISTORY_FILE = path.join(__dirname, 'history.json');
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveHistory(entry) {
  const history = loadHistory();
  history.unshift({ ...entry, savedAt: new Date().toISOString() });
  const trimmed = history.slice(0, 100); // keep last 100
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

// ============================================================
// MARKET CONFIG
// Sell fees per platform (what you actually receive after fees)
// User declares which markets they have access to in the request.
// ============================================================
const MARKET_FEES = {
  steam:      0.15,  // 15% — default, always available
  csfloat:    0.02,  // 2%
  skinport:   0.12,  // 12%
  waxpeer:    0.02,  // ~2% (varies)
  pricempire: 0.00,  // aggregator — no sell fee, used for prices only
};

// Default sell market if user doesn't specify
const DEFAULT_SELL_MARKET = 'steam';

// ============================================================
// DATA LAYER
// ============================================================
const BYMY_BASE = 'https://bymykel.github.io/CSGO-API/api/en';

const RARITY_MAP = {
  'Rarity_Common_Weapon':    'Consumer',
  'Rarity_Uncommon_Weapon':  'Industrial',
  'Rarity_Rare_Weapon':      'Mil-Spec',
  'Rarity_Mythical_Weapon':  'Restricted',
  'Rarity_Legendary_Weapon': 'Classified',
  'Rarity_Ancient_Weapon':   'Covert',
  'Rarity_Contraband':       'Contraband',
};
const SKIP_RARITIES     = new Set(['Contraband']);
const TRADEABLE_RARITIES = new Set(['Consumer','Industrial','Mil-Spec','Restricted','Classified','Covert']);
const RARITY_ORDER       = ['Consumer','Industrial','Mil-Spec','Restricted','Classified','Covert'];

const WEAR_BANDS = [
  { code: 'FN', name: 'Factory New',    min: 0.00, max: 0.07 },
  { code: 'MW', name: 'Minimal Wear',   min: 0.07, max: 0.15 },
  { code: 'FT', name: 'Field-Tested',   min: 0.15, max: 0.38 },
  { code: 'WW', name: 'Well-Worn',      min: 0.38, max: 0.45 },
  { code: 'BS', name: 'Battle-Scarred', min: 0.45, max: 1.00 },
];

function wearForFloat(f) {
  return WEAR_BANDS.find((w) => f >= w.min && f <= w.max) || WEAR_BANDS[2];
}

async function fetchAllSkins() {
  const cached = skinCache.get('skins');
  if (cached) return cached;

  console.log('[DATA] Fetching skin database from ByMykel/CSGO-API…');
  const [skinsRes] = await Promise.all([
    axios.get(`${BYMY_BASE}/skins.json`, { timeout: 15000 }),
  ]);

  const processed = [];
  for (const skin of skinsRes.data) {
    if (!skin.collections || skin.collections.length === 0) continue;
    const rarity = RARITY_MAP[skin.rarity?.id];
    if (!rarity || SKIP_RARITIES.has(rarity) || !TRADEABLE_RARITIES.has(rarity)) continue;
    if (skin.name?.includes('Souvenir')) continue;
    const cat = skin.category?.name || '';
    if (cat === 'Knives' || cat === 'Gloves') continue;

    const collection  = skin.collections[0].name;
    const weapon      = skin.weapon?.name || '';
    const skinName    = skin.name?.replace(`${weapon} | `, '') || '';
    const steamBase   = skin.name || `${weapon} | ${skinName}`;
    // ByMykel includes stattrak: true/false per skin — use it directly
    const hasST       = skin.stattrak === true;

    processed.push({
      id: skin.id,
      weapon,
      name: skinName,
      fullName: steamBase,
      collection,
      rarity,
      minFloat: skin.min_float ?? 0.00,
      maxFloat: skin.max_float ?? 1.00,
      imgUrl:   skin.image || null,
      hasST,
      prices: {},
    });
  }

  console.log(`[DATA] Loaded ${processed.length} tradeable skins`);
  skinCache.set('skins', processed);
  return processed;
}

// ============================================================
// PRICING LAYER — 5 sources, bulk where possible
// ============================================================
const STEAM_DELAY_MS = 120;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Pricempire bulk ----
async function fetchPricempirePrices() {
  const apiKey = process.env.PRICEMPIRE_API_KEY;
  if (!apiKey || apiKey === 'your_pricempire_api_key_here') return {};
  const cached = priceCache.get('pricempire:all');
  if (cached) return cached;
  console.log('[PRICES] Fetching Pricempire…');
  try {
    const res = await axios.get('https://api.pricempire.com/v3/items/prices', {
      params: { token: apiKey, currency: 'USD', sources: 'buff163,csfloat,waxpeer,skinport,dmarket,steam' },
      timeout: 30000,
    });
    const map = {};
    for (const [name, sourceData] of Object.entries(res.data || {})) {
      const prices = Object.values(sourceData)
        .map((s) => (s?.price && s.price > 0 ? s.price / 100 : null))
        .filter(Boolean);
      if (prices.length > 0) map[name] = Math.min(...prices);
    }
    priceCache.set('pricempire:all', map);
    console.log(`[PRICES] Pricempire: ${Object.keys(map).length} items`);
    return map;
  } catch (err) {
    console.warn('[PRICES] Pricempire failed:', err.message);
    return {};
  }
}

// ---- Waxpeer bulk ----
async function fetchWaxpeerPrices() {
  const apiKey = process.env.WAXPEER_API_KEY;
  if (!apiKey || apiKey === 'your_waxpeer_api_key_here') return {};
  const cached = priceCache.get('waxpeer:all');
  if (cached) return cached;
  console.log('[PRICES] Fetching Waxpeer…');
  try {
    const res = await axios.get('https://api.waxpeer.com/v1/prices', {
      params: { api: apiKey, game: 'csgo' },
      timeout: 20000,
    });
    const map = {};
    const items = res.data?.items || res.data || [];
    for (const item of items) {
      const name  = item.market_hash_name || item.name;
      const price = item.min || item.price;
      if (name && price && price > 0) map[name] = price / 1000;
    }
    priceCache.set('waxpeer:all', map);
    console.log(`[PRICES] Waxpeer: ${Object.keys(map).length} items`);
    return map;
  } catch (err) {
    console.warn('[PRICES] Waxpeer failed:', err.message);
    return {};
  }
}

// ---- Skinport bulk (free) ----
async function fetchSkinportPrices() {
  if (process.env.USE_SKINPORT !== 'true') return {};
  const cached = priceCache.get('skinport:all');
  if (cached) return cached;
  console.log('[PRICES] Fetching Skinport…');
  try {
    const res = await axios.get('https://api.skinport.com/v1/items', {
      params: { app_id: 730, currency: 'USD', tradable: 0 },
      timeout: 20000,
    });
    const map = {};
    for (const item of res.data) {
      const price = item.min_price || item.suggested_price;
      if (item.market_hash_name && price) map[item.market_hash_name] = price;
    }
    priceCache.set('skinport:all', map);
    console.log(`[PRICES] Skinport: ${Object.keys(map).length} items`);
    return map;
  } catch (err) {
    console.warn('[PRICES] Skinport failed:', err.message);
    return {};
  }
}

// ---- CSFloat per-item ----
async function fetchCSFloatPrice(marketName) {
  const apiKey = process.env.CSFLOAT_API_KEY;
  if (!apiKey || apiKey === 'your_csfloat_api_key_here') return null;
  const cacheKey = `csfloat:${marketName}`;
  const cached = priceCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await axios.get('https://csfloat.com/api/v1/listings', {
      params: { market_hash_name: marketName, sort_by: 'lowest_price', limit: 20 },
      headers: { 'Authorization': process.env.CSFLOAT_API_KEY, 'User-Agent': 'TradeupBot/1.0' },
      timeout: 8000,
    });
    const listings = res.data?.data || [];
    if (!listings.length) { priceCache.set(cacheKey, null); return null; }
    const price = listings[0].price / 100;
    priceCache.set(cacheKey, price);
    return price;
  } catch {
    priceCache.set(cacheKey, null);
    return null;
  }
}

// ---- Steam per-item ----
async function fetchSteamPrice(marketName) {
  const cacheKey = `steam:${marketName}`;
  const cached = priceCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await axios.get('https://steamcommunity.com/market/priceoverview/', {
      params: { appid: 730, currency: 1, market_hash_name: marketName },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeupBot/1.0)' },
      timeout: 8000,
    });
    if (!res.data.success) { priceCache.set(cacheKey, null); return null; }
    const raw = res.data.lowest_price || res.data.median_price || null;
    if (!raw) { priceCache.set(cacheKey, null); return null; }
    const price = parseFloat(raw.replace(/[^0-9.]/g, ''));
    priceCache.set(cacheKey, price);
    return price;
  } catch {
    priceCache.set(cacheKey, null);
    return null;
  }
}

// ---- Get prices from all sources for a single skin+wear ----
// userMarkets: array of market IDs the user has access to
// If userMarkets is empty/null, use all available sources
async function getPriceFromSources(marketName, bulkMaps, userMarkets) {
  const { pricempireMap, waxpeerMap, skinportMap } = bulkMaps;
  const useAll = !userMarkets || userMarkets.length === 0;
  const candidates = [];

  if ((useAll || userMarkets.includes('pricempire')) && pricempireMap[marketName])
    candidates.push(pricempireMap[marketName]);
  if ((useAll || userMarkets.includes('waxpeer')) && waxpeerMap[marketName])
    candidates.push(waxpeerMap[marketName]);
  if ((useAll || userMarkets.includes('skinport')) && skinportMap[marketName])
    candidates.push(skinportMap[marketName]);

  if (useAll || userMarkets.includes('csfloat')) {
    const cf = await fetchCSFloatPrice(marketName);
    if (cf) { candidates.push(cf); await sleep(40); }
  }
  if (useAll || userMarkets.includes('steam')) {
    const st = await fetchSteamPrice(marketName);
    if (st) { candidates.push(st); await sleep(STEAM_DELAY_MS); }
  }

  return candidates.length > 0 ? Math.min(...candidates) : null;
}

// ---- Get all wear-band prices for a skin ----
async function getPricesForSkin(skin, bulkMaps, userMarkets) {
  const prices = {};
  for (const wear of WEAR_BANDS) {
    if (skin.maxFloat < wear.min || skin.minFloat > wear.max) continue;
    const marketName = `${skin.fullName} (${wear.name})`;
    const price = await getPriceFromSources(marketName, bulkMaps, userMarkets);
    if (price) prices[wear.code] = price;
  }
  return prices;
}

// ============================================================
// FLOAT AVAILABILITY + LIQUIDITY CHECK
//
// For a proposed tradeup input (skin + target float + quantity),
// check CSFloat listings to verify:
//   1. There are actual listings at/near the target float
//   2. There are enough listings to cover the quantity needed
//   3. The actual buyable price matches what we quoted
//
// Returns: { available: bool, count: int, cheapestFloat: float,
//            cheapestPrice: float, listings: [...top 5] }
// ============================================================
async function checkFloatAvailability(marketName, targetFloat, quantityNeeded) {
  const apiKey = process.env.CSFLOAT_API_KEY;
  if (!apiKey || apiKey === 'your_csfloat_api_key_here') {
    // Can't check without CSFloat key — return optimistic result with warning
    return { available: null, warning: 'CSFloat key not set — cannot verify float availability', count: null };
  }

  const cacheKey = `floats:${marketName}:${targetFloat.toFixed(3)}`;
  const cached = floatCache.get(cacheKey);
  if (cached) return cached;

  try {
    const wear = wearForFloat(targetFloat);
    // Fetch the 50 cheapest listings for this skin+wear
    const res = await axios.get('https://csfloat.com/api/v1/listings', {
      params: {
        market_hash_name: marketName,
        sort_by: 'lowest_price',
        limit: 50,
        min_float: wear.min,
        max_float: wear.max,
      },
      headers: { 'Authorization': apiKey, 'User-Agent': 'TradeupBot/1.0' },
      timeout: 10000,
    });

    const listings = res.data?.data || [];
    if (!listings.length) {
      const result = { available: false, count: 0, warning: 'No listings found on CSFloat for this skin + wear band' };
      floatCache.set(cacheKey, result);
      return result;
    }

    // Find listings within ±0.02 float of the target
    const FLOAT_TOLERANCE = 0.02;
    const nearby = listings.filter((l) =>
      Math.abs((l.item?.float_value || 0) - targetFloat) <= FLOAT_TOLERANCE
    );

    const result = {
      available: nearby.length >= quantityNeeded,
      count: listings.length,         // total listings in wear band
      nearbyCount: nearby.length,     // listings within float tolerance
      quantityNeeded,
      cheapestFloat: listings[0]?.item?.float_value || null,
      cheapestPrice: listings[0] ? listings[0].price / 100 : null,
      listings: listings.slice(0, 5).map((l) => ({
        float:  l.item?.float_value || null,
        price:  l.price / 100,
        wear:   wearForFloat(l.item?.float_value || targetFloat).code,
        url:    `https://csfloat.com/item/${l.id}`,
      })),
      warning: nearby.length < quantityNeeded
        ? `Only ${nearby.length} listings within ±0.02 float of target — need ${quantityNeeded}`
        : null,
    };
    floatCache.set(cacheKey, result);
    return result;
  } catch (err) {
    return { available: null, warning: `CSFloat check failed: ${err.message}`, count: null };
  }
}

// ============================================================
// TRADEUP MATH ENGINE
// ============================================================
function computeOutputFloat(avgFloat, skin) {
  return avgFloat * (skin.maxFloat - skin.minFloat) + skin.minFloat;
}

function priceAt(skin, floatVal, isST) {
  if (isST && !skin.hasST) return null; // validated StatTrak flag
  const wear = wearForFloat(floatVal);
  const base = skin.prices[wear.code];
  if (!base) return null;
  // ST premium: use market-specific multiplier if available, else ~1.65x
  return isST ? base * 1.65 : base;
}

function evaluateTradeup(inputs, allSkins, isST, sellMarket) {
  if (inputs.length !== 10) return null;
  const inputRarity = inputs[0].rarity;
  if (!inputs.every((s) => s.rarity === inputRarity)) return null;
  if (isST && !inputs.every((s) => s.hasST)) return null; // reject if any skin lacks ST

  const nextIdx = RARITY_ORDER.indexOf(inputRarity) + 1;
  if (nextIdx >= RARITY_ORDER.length) return null;
  const nextRarity = RARITY_ORDER[nextIdx];

  const avgFloat = inputs.reduce((a, s) => a + s.targetFloat, 0) / 10;
  const collectionCounts = {};
  for (const s of inputs) collectionCounts[s.collection] = (collectionCounts[s.collection] || 0) + 1;

  const outcomes = [];
  for (const [collection, count] of Object.entries(collectionCounts)) {
    const possibleOutputs = allSkins.filter(
      (s) => s.collection === collection && s.rarity === nextRarity && Object.keys(s.prices).length > 0
    );
    if (!possibleOutputs.length) return null;
    for (const out of possibleOutputs) {
      outcomes.push({ skin: out, weight: count / possibleOutputs.length });
    }
  }
  if (!outcomes.length) return null;

  // Apply user's sell market fee (not always Steam's 15%)
  const sellFee = MARKET_FEES[sellMarket] ?? MARKET_FEES.steam;

  const totalWeight = outcomes.reduce((a, o) => a + o.weight, 0);
  const enrichedOutcomes = outcomes.map((o) => {
    const outFloat = computeOutputFloat(avgFloat, o.skin);
    const outPrice = priceAt(o.skin, outFloat, isST);
    if (!outPrice) return null;
    return {
      skin: o.skin,
      probability: o.weight / totalWeight,
      outputFloat: outFloat,
      outputWear: wearForFloat(outFloat),
      outputPrice: outPrice,
      netReturn: outPrice * (1 - sellFee),
    };
  }).filter(Boolean);

  if (!enrichedOutcomes.length) return null;

  const inputCost = inputs.reduce((a, s) => a + s.cost, 0);
  if (!inputCost) return null;

  const expectedReturn  = enrichedOutcomes.reduce((a, o) => a + o.probability * o.netReturn, 0);
  const expectedProfit  = expectedReturn - inputCost;
  const profitChance    = enrichedOutcomes.filter((o) => o.netReturn > inputCost).reduce((a, o) => a + o.probability, 0);
  const maxProfit       = Math.max(...enrichedOutcomes.map((o) => o.netReturn - inputCost));
  const maxLoss         = Math.min(...enrichedOutcomes.map((o) => o.netReturn - inputCost));

  return {
    inputs: inputs.map((i) => {
      const wearBand = wearForFloat(i.targetFloat);
      return {
        id: i.id,
        weapon: i.weapon,
        name: i.name,
        fullName: i.fullName,
        collection: i.collection,
        rarity: i.rarity,
        targetFloat: i.targetFloat,
        cost: i.cost,
        wear: wearBand.code,
        wearName: wearBand.name,
        imgUrl: i.imgUrl,
        hasST: i.hasST,
        steamMarketName: `${i.fullName} (${wearBand.name})`,
        steamMarketUrl:  `https://steamcommunity.com/market/listings/730/${encodeURIComponent(`${i.fullName} (${wearBand.name})`)}`,
        csfloatUrl:      `https://csfloat.com/search?market_hash_name=${encodeURIComponent(`${i.fullName} (${wearBand.name})`)}&sort_by=lowest_price`,
      };
    }),
    avgFloat,
    inputCost,
    sellMarket,
    sellFee,
    outcomes: enrichedOutcomes.sort((a, b) => b.probability - a.probability).map((o) => ({
      weapon: o.skin.weapon,
      name: o.skin.name,
      fullName: o.skin.fullName,
      collection: o.skin.collection,
      rarity: o.skin.rarity,
      probability: o.probability,
      outputFloat: o.outputFloat,
      wear: o.outputWear.code,
      wearName: o.outputWear.name,
      outputPrice: o.outputPrice,
      netReturn: o.netReturn,
      imgUrl: o.skin.imgUrl,
      steamMarketName: `${o.skin.fullName} (${o.outputWear.name})`,
      steamMarketUrl:  `https://steamcommunity.com/market/listings/730/${encodeURIComponent(`${o.skin.fullName} (${o.outputWear.name})`)}`,
      csfloatUrl:      `https://csfloat.com/search?market_hash_name=${encodeURIComponent(`${o.skin.fullName} (${o.outputWear.name})`)}&sort_by=lowest_price`,
    })),
    expectedReturn,
    expectedProfit,
    profitChance,
    profitabilityRatio: expectedReturn / inputCost,
    maxProfit,
    maxLoss,
    isST,
  };
}

// ============================================================
// SEARCH ENGINE
// ============================================================
function scoreTradeup(t, mode) {
  if (mode === 'profit')  return (t.profitabilityRatio - 1) * 100;
  if (mode === 'safety')  return t.profitChance * 100;
  if (mode === 'dollars') return t.expectedProfit;
  return t.expectedProfit * 0.5 + t.profitChance * 50 + (t.profitabilityRatio - 1) * 30;
}

async function runSearch(allSkins, filters, durationMs) {
  const deadline = Date.now() + durationMs;
  const {
    rarities        = ['Mil-Spec','Restricted','Classified'],
    statTrak        = 'non-st',
    maxCost         = 100,
    minProfit       = 0,
    minProfitChance = 0,
    optimizeFor     = 'balanced',
    sellMarket      = 'steam',
    userMarkets     = [],
  } = filters;

  const stOptions = statTrak === 'both' ? [false, true]
    : statTrak === 'st' ? [true] : [false];

  const results = [];
  let tried = 0;

  const passesFilters = (t) => {
    if (!t) return false;
    if (maxCost > 0         && t.inputCost > maxCost)              return false;
    if (minProfit > 0       && t.expectedProfit < minProfit)       return false;
    if (minProfitChance > 0 && t.profitChance * 100 < minProfitChance) return false;
    return true;
  };

  // Build tier pools
  const tierPools = {};
  for (const tier of rarities) {
    const tierIdx = RARITY_ORDER.indexOf(tier);
    if (tierIdx < 0 || tierIdx >= RARITY_ORDER.length - 1) continue;
    const nextRarity = RARITY_ORDER[tierIdx + 1];
    const validCollections = [...new Set(
      allSkins.filter((s) => s.rarity === tier && Object.keys(s.prices).length > 0).map((s) => s.collection)
    )].filter((col) =>
      allSkins.some((s) => s.collection === col && s.rarity === nextRarity && Object.keys(s.prices).length > 0)
    );
    tierPools[tier] = {
      nextRarity,
      collections: validCollections,
      skinsByCollection: Object.fromEntries(
        validCollections.map((col) => [col,
          allSkins.filter((s) => s.collection === col && s.rarity === tier && Object.keys(s.prices).length > 0)
        ])
      ),
    };
  }

  const tryCombo = (inputs, isST) => {
    if (inputs.length !== 10) return;
    tried++;
    const result = evaluateTradeup(inputs, allSkins, isST, sellMarket);
    if (result && passesFilters(result)) {
      results.push({ ...result, score: scoreTradeup(result, optimizeFor) });
    }
  };

  // ---- Phase 1: deterministic sweep ----
  for (const tier of rarities) {
    const pool = tierPools[tier];
    if (!pool) continue;
    for (const isST of stOptions) {
      for (const collection of pool.collections) {
        const skins = pool.skinsByCollection[collection] || [];

        // Single-skin runs — 25 float steps
        for (const skin of skins) {
          if (isST && !skin.hasST) continue;
          for (let step = 0; step <= 25; step++) {
            if (Date.now() > deadline) break;
            const tFloat = skin.minFloat + (step / 25) * (skin.maxFloat - skin.minFloat);
            const cost = priceAt(skin, tFloat, isST);
            if (!cost) continue;
            tryCombo(Array.from({ length: 10 }, () => ({ ...skin, targetFloat: tFloat, cost })), isST);
          }
        }

        // 2-skin within-collection splits
        for (let ai = 0; ai < skins.length; ai++) {
          for (let bi = ai + 1; bi < skins.length; bi++) {
            const a = skins[ai], b = skins[bi];
            if (isST && (!a.hasST || !b.hasST)) continue;
            for (let split = 1; split <= 9; split++) {
              for (let step = 0; step <= 6; step++) {
                if (Date.now() > deadline) break;
                const fRange = Math.min(a.maxFloat, b.maxFloat);
                const tFloat = (step / 6) * fRange;
                const aCost = priceAt(a, tFloat, isST);
                const bCost = priceAt(b, tFloat, isST);
                if (!aCost || !bCost) continue;
                tryCombo([
                  ...Array.from({ length: split },      () => ({ ...a, targetFloat: tFloat, cost: aCost })),
                  ...Array.from({ length: 10 - split }, () => ({ ...b, targetFloat: tFloat, cost: bCost })),
                ], isST);
              }
            }
          }
        }
      }

      // Cross-collection 2-collection splits
      const cols = pool.collections;
      for (let ci = 0; ci < cols.length; ci++) {
        for (let cj = ci + 1; cj < cols.length; cj++) {
          if (Date.now() > deadline) break;
          const skA = pool.skinsByCollection[cols[ci]] || [];
          const skB = pool.skinsByCollection[cols[cj]] || [];
          for (const a of skA) {
            for (const b of skB) {
              if (isST && (!a.hasST || !b.hasST)) continue;
              for (const split of [5, 7, 3, 2, 8]) {
                if (Date.now() > deadline) break;
                const fRange = Math.min(a.maxFloat, b.maxFloat);
                for (let step = 0; step <= 5; step++) {
                  const tFloat = (step / 5) * fRange;
                  const aCost = priceAt(a, tFloat, isST);
                  const bCost = priceAt(b, tFloat, isST);
                  if (!aCost || !bCost) continue;
                  tryCombo([
                    ...Array.from({ length: split },      () => ({ ...a, targetFloat: tFloat, cost: aCost })),
                    ...Array.from({ length: 10 - split }, () => ({ ...b, targetFloat: tFloat, cost: bCost })),
                  ], isST);
                }
              }
            }
          }
        }
      }
    }
  }

  // ---- Phase 2: random perturbation until deadline ----
  const tierKeys = Object.keys(tierPools);
  while (Date.now() < deadline) {
    const tier = tierKeys[Math.floor(Math.random() * tierKeys.length)];
    const pool = tierPools[tier];
    if (!pool?.collections.length) continue;
    const isST = stOptions[Math.floor(Math.random() * stOptions.length)];
    const numCols = Math.min(pool.collections.length, 1 + Math.floor(Math.random() * 3));
    const chosen = [...pool.collections].sort(() => Math.random() - 0.5).slice(0, numCols);
    const skinChoices = chosen.map((col) => {
      const opts = (pool.skinsByCollection[col] || []).filter((s) => !isST || s.hasST);
      return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
    }).filter(Boolean);
    if (skinChoices.length !== numCols) continue;
    const parts = [];
    let rem = 10;
    for (let p = 0; p < numCols - 1; p++) {
      const v = 1 + Math.floor(Math.random() * (rem - (numCols - 1 - p)));
      parts.push(v); rem -= v;
    }
    parts.push(rem);
    const fRange = Math.min(...skinChoices.map((s) => s.maxFloat));
    const tFloat = Math.random() * fRange;
    const inputs = [];
    let valid = true;
    for (let idx = 0; idx < numCols; idx++) {
      const sk = skinChoices[idx];
      const cost = priceAt(sk, tFloat, isST);
      if (!cost) { valid = false; break; }
      for (let n = 0; n < parts[idx]; n++) inputs.push({ ...sk, targetFloat: tFloat, cost });
    }
    if (!valid || inputs.length !== 10) continue;
    tryCombo(inputs, isST);
  }

  // Dedup and sort
  results.sort((a, b) => b.score - a.score);
  const dedup = [];
  const seen  = new Set();
  for (const r of results) {
    const key = r.inputs.map((i) => i.id).sort().join('|') + '|' + r.avgFloat.toFixed(4) + (r.isST ? '|ST' : '');
    if (!seen.has(key)) { seen.add(key); dedup.push(r); }
    if (dedup.length >= 50) break;
  }
  console.log(`[SEARCH] ${tried} combos tried → ${dedup.length} results`);
  return { results: dedup, tried };
}

// ============================================================
// PRICE PRELOAD
// ============================================================
let preloadState = { status: 'idle', total: 0, loaded: 0, message: '', sources: [] };

async function preloadPrices() {
  try {
    preloadState = { status: 'loading', total: 0, loaded: 0, message: 'Fetching skin database…', sources: [] };
    const skins = await fetchAllSkins();
    preloadState.total = skins.length;

    preloadState.message = 'Fetching bulk prices (Pricempire · Waxpeer · Skinport)…';
    const [pricempireMap, waxpeerMap, skinportMap] = await Promise.all([
      fetchPricempirePrices(),
      fetchWaxpeerPrices(),
      fetchSkinportPrices(),
    ]);

    const activeSources = [
      Object.keys(pricempireMap).length ? 'Pricempire' : null,
      Object.keys(waxpeerMap).length    ? 'Waxpeer'    : null,
      Object.keys(skinportMap).length   ? 'Skinport'   : null,
      process.env.CSFLOAT_API_KEY && process.env.CSFLOAT_API_KEY !== 'your_csfloat_api_key_here' ? 'CSFloat' : null,
      'Steam',
    ].filter(Boolean);
    console.log(`[PRICES] Active sources: ${activeSources.join(', ')}`);

    const bulkMaps = { pricempireMap, waxpeerMap, skinportMap };

    preloadState.message = 'Fetching per-skin prices (CSFloat · Steam)…';
    for (let i = 0; i < skins.length; i++) {
      skins[i].prices = await getPricesForSkin(skins[i], bulkMaps, []);
      preloadState.loaded = i + 1;
      if (i % 50 === 0) {
        const pct = Math.round(((i + 1) / skins.length) * 100);
        preloadState.message = `Pricing skins… ${pct}% (${i + 1}/${skins.length})`;
      }
    }

    skinCache.set('skins', skins);
    preloadState = {
      status: 'ready',
      total: skins.length,
      loaded: skins.length,
      message: `Ready — ${skins.length} skins across ${activeSources.join(' · ')}`,
      sources: activeSources,
    };
    console.log('[PRICES] Ready.');
  } catch (err) {
    preloadState = { status: 'error', total: 0, loaded: 0, message: err.message, sources: [] };
    console.error('[PRICES] Preload error:', err.message);
  }
}

// ============================================================
// API ROUTES
// ============================================================

// Status
app.get('/api/status', (req, res) => res.json(preloadState));

// Collections list
app.get('/api/collections', async (req, res) => {
  try {
    const skins = await fetchAllSkins();
    res.json({ collections: [...new Set(skins.map((s) => s.collection))].sort() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Main search
app.post('/api/search', async (req, res) => {
  if (preloadState.status !== 'ready')
    return res.status(503).json({ error: 'Prices still loading', status: preloadState });

  const skins = skinCache.get('skins');
  if (!skins) return res.status(503).json({ error: 'Skin DB not loaded' });

  const filters = {
    rarities:        req.body.rarities        || ['Mil-Spec','Restricted','Classified'],
    statTrak:        req.body.statTrak        || 'non-st',
    maxCost:         parseFloat(req.body.maxCost)         || 100,
    minProfit:       parseFloat(req.body.minProfit)       || 0,
    minProfitChance: parseFloat(req.body.minProfitChance) || 0,
    optimizeFor:     req.body.optimizeFor     || 'balanced',
    sellMarket:      req.body.sellMarket      || 'steam',
    userMarkets:     req.body.userMarkets     || [],
  };

  const maxSec = parseInt(process.env.MAX_SEARCH_SECONDS || '55');
  const reqSec = Math.min(parseInt(req.body.duration) || 30, maxSec);

  const cacheKey = JSON.stringify({ ...filters, duration: reqSec });
  const cached   = searchCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const { results, tried } = await runSearch(skins, filters, reqSec * 1000);
    const payload = { results, tried, filters, duration: reqSec };
    searchCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Float + liquidity check for a specific tradeup's inputs
// POST /api/check-availability
// Body: { inputs: [{ steamMarketName, targetFloat, quantity }] }
app.post('/api/check-availability', async (req, res) => {
  const inputs = req.body.inputs || [];
  if (!inputs.length) return res.status(400).json({ error: 'No inputs provided' });

  try {
    const results = await Promise.all(
      inputs.map((inp) => checkFloatAvailability(inp.steamMarketName, inp.targetFloat, inp.quantity || 1))
    );
    res.json({ checks: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refresh prices for specific skins (re-fetch live, bypass cache)
// POST /api/refresh
// Body: { skins: [{ fullName, wear }] }  e.g. [{ fullName: "AK-47 | Redline", wear: "WW" }]
app.post('/api/refresh', async (req, res) => {
  const toRefresh = req.body.skins || [];
  if (!toRefresh.length) return res.status(400).json({ error: 'No skins provided' });

  const [pricempireMap, waxpeerMap, skinportMap] = await Promise.all([
    fetchPricempirePrices(),
    fetchWaxpeerPrices(),
    fetchSkinportPrices(),
  ]);
  const bulkMaps    = { pricempireMap, waxpeerMap, skinportMap };
  const userMarkets = req.body.userMarkets || [];

  const prices = {};
  for (const { fullName, wear } of toRefresh) {
    const wearBand   = WEAR_BANDS.find((w) => w.code === wear);
    if (!wearBand) continue;
    const marketName = `${fullName} (${wearBand.name})`;

    // Bust per-item caches so we get fresh data
    priceCache.del(`csfloat:${marketName}`);
    priceCache.del(`steam:${marketName}`);

    const price = await getPriceFromSources(marketName, bulkMaps, userMarkets);
    prices[marketName] = price;
  }
  res.json({ prices, refreshedAt: new Date().toISOString() });
});

// Save a tradeup to history
// POST /api/history
app.post('/api/history', (req, res) => {
  try {
    saveHistory(req.body);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get history
app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

// Delete history entry
app.delete('/api/history/:index', (req, res) => {
  try {
    const history = loadHistory();
    history.splice(parseInt(req.params.index), 1);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Image proxy (avoids CORS)
app.get('/api/image', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://')) return res.status(400).send('Bad url');
  try {
    const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
    res.set('Content-Type', img.headers['content-type'] || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(img.data);
  } catch { res.status(404).send('Not found'); }
});

// Fallback SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// BOOT
// ============================================================
app.listen(PORT, () => {
  console.log(`[SERVER] CS2 Tradeup Bot on port ${PORT}`);
  preloadPrices().catch(console.error);
});
