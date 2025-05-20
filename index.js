require('dotenv').config();
const { Telegraf } = require('telegraf');
const {
  JsonRpcProvider,
  Contract,
  id,
  parseUnits,
  formatUnits,
  formatEther,
} = require('ethers');

// --- Configuration Validation ---
const requiredEnvVars = [
  'RPC_URL',
  'BOT_TOKEN',
  'PAIR_ADDRESS',
  'ROUTER_ADDRESS',
  'TOKEN_ADDRESS',
  'BESC_ADDRESS',
  'WVSG_ADDRESS',
  'USDC_ADDRESS',
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// --- Setup ---
const provider = new JsonRpcProvider(process.env.RPC_URL);
const bot = new Telegraf(process.env.BOT_TOKEN);
let CHAT_ID = null;
const POLLING_INTERVAL = 5000; // 5 seconds
const MAX_RETRIES = 3; // Retry failed RPC calls
const RETRY_DELAY = 1000; // 1 second delay between retries

// --- ABIs ---
const pairAbi = [
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const routerAbi = [
  'function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)',
];

const erc20Abi = [
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
];

// --- Contracts ---
const pair = new Contract(process.env.PAIR_ADDRESS, pairAbi, provider);
const router = new Contract(process.env.ROUTER_ADDRESS, routerAbi, provider);
const token = new Contract(process.env.TOKEN_ADDRESS, erc20Abi, provider);

// --- Utility: Retry Wrapper for RPC Calls ---
async function withRetry(fn, retries = MAX_RETRIES, delay = RETRY_DELAY) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`⚠️ Attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) throw new Error(`Max retries reached: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// --- Get USD Price via BESC → WVSG → USDC ---
async function getBescUsdPrice() {
  try {
    // Step 1: BESC → WVSG (BESC: 9 decimals, WVSG: 18 decimals assumed)
    const path1 = [process.env.BESC_ADDRESS, process.env.WVSG_ADDRESS];
    const amountsOut1 = await withRetry(() =>
      router.getAmountsOut(parseUnits('1', 9), path1) // BESC has 9 decimals
    );
    if (!amountsOut1 || !amountsOut1[1]) {
      throw new Error('Invalid amountsOut response for BESC → WVSG');
    }
    const bescToWvsg = parseFloat(formatUnits(amountsOut1[1], 18)); // WVSG has 18 decimals
    console.log(`📈 BESC to WVSG: 1 BESC = ${bescToWvsg} WVSG`);

    // Step 2: WVSG → USDC (WVSG: 18 decimals, USDC: 6 decimals)
    const path2 = [process.env.WVSG_ADDRESS, process.env.USDC_ADDRESS];
    const amountsOut2 = await withRetry(() =>
      router.getAmountsOut(parseUnits('1', 18), path2) // WVSG has 18 decimals
    );
    if (!amountsOut2 || !amountsOut2[1]) {
      throw new Error('Invalid amountsOut response for WVSG → USDC');
    }
    const wvsgToUsdc = parseFloat(formatUnits(amountsOut2[1], 6)); // USDC has 6 decimals
    console.log(`📈 WVSG to USDC: 1 WVSG = $${wvsgToUsdc}`);

    // Calculate BESC USD price
    const bescUsd = bescToWvsg * wvsgToUsdc;
    console.log(`📈 BESC USD Price: $${bescUsd}`);
    return bescUsd;
  } catch (err) {
    console.error('❌ Failed to fetch BESC USD price:', err.message);
    return null;
  }
}

// --- Fetch Pool Stats ---
async function fetchStats() {
  try {
    const [reserves, [t0, t1]] = await Promise.all([
      withRetry(() => pair.getReserves()),
      withRetry(() => Promise.all([pair.token0(), pair.token1()])),
    ]);
    const [r0, r1] = reserves;

    const isBescFirst = t0.toLowerCase() === process.env.BESC_ADDRESS.toLowerCase();
    const reserveBesc = isBescFirst ? r0 : r1;
    const reserveTok = isBescFirst ? r1 : r0;

    const reserveBescFloat = parseFloat(formatUnits(reserveBesc, 9)); // BESC has 9 decimals
    const reserveTokFloat = parseFloat(formatEther(reserveTok)); // MONEY has 18 decimals

    console.log(`🏦 Reserves - BESC: ${reserveBescFloat}, MONEY: ${reserveTokFloat}`);

    if (reserveTokFloat === 0) {
      throw new Error('Zero MONEY reserve');
    }

    // Calculate price of 1 MONEY in BESC (BESC per MONEY)
    const priceBescPerTok = reserveBescFloat / reserveTokFloat;
    console.log(`📊 Price of 1 MONEY in BESC: ${priceBescPerTok} BESC`);

    const bescUsd = await getBescUsdPrice();
    if (bescUsd === null) {
      throw new Error('Failed to fetch BESC USD price');
    }

    // Calculate MONEY price in USD
    const priceUsd = priceBescPerTok * bescUsd;
    console.log(`📊 Price of 1 MONEY in USD: $${priceUsd}`);

    const [decimals, totalSupply] = await Promise.all([
      withRetry(() => token.decimals()),
      withRetry(() => token.totalSupply()),
    ]);
    const supplyFloat = parseFloat(formatUnits(totalSupply, decimals));
    console.log(`📊 Total Supply: ${supplyFloat} MONEY`);

    const marketCap = priceUsd * supplyFloat;
    const liquidityUsd = reserveBescFloat * bescUsd * 2; // Liquidity = value of BESC * 2 (total pool value)

    console.log(`📊 Market Cap: $${(marketCap / 1e6).toFixed(2)}M, Liquidity: $${(liquidityUsd / 1e6).toFixed(2)}M`);

    return {
      priceUsd,
      marketCap,
      liquidityUsd,
      supply: supplyFloat,
    };
  } catch (err) {
    console.error('❌ Failed to fetch stats:', err.message);
    return null;
  }
}

// --- Parse Swap Logs and Send Alerts ---
async function handleSwapLog(log) {
  try {
    const parsed = pair.interface.parseLog(log);
    const { amount0In, amount1In, amount0Out, amount1Out, to } = parsed.args;

    const isBuy =
      (amount0In > 0n && amount1Out > 0n) ||
      (amount1In > 0n && amount0Out > 0n);
    if (!isBuy) return;

    const amountIn = amount0In > 0n ? amount0In : amount1In;
    const amountOut = amount1Out > 0n ? amount1Out : amount0Out;

    const paidBesc = parseFloat(formatUnits(amountIn, 9)); // BESC has 9 decimals
    const decimals = await withRetry(() => token.decimals());
    const gotTok = parseFloat(formatUnits(amountOut, decimals));
    const stats = await fetchStats();

    if (!stats) {
      console.error('❌ Skipping swap alert due to failed stats fetch');
      return;
    }

    const msg =
      `💰 *New MONEY Buy!*  \n` +
      `👤 Buyer: \`${to}\`  \n` +
      `💸 Paid: *${paidBesc.toFixed(4)} BESC*  \n` +
      `🎟️ Received: *${gotTok.toFixed(4)} MONEY*\n\n` +
      `📊 *Live Stats*  \n` +
      `• Price: *$${stats.priceUsd.toFixed(4)}*  \n` +
      `• Market Cap: *$${(stats.marketCap / 1e6).toFixed(2)}M*  \n` +
      `• Liquidity: *$${(stats.liquidityUsd / 1e6).toFixed(2)}M*  \n` +
      `• Supply: *${stats.supply.toLocaleString()} MONEY*`;

    if (!CHAT_ID) {
      console.warn('⚠️ No CHAT_ID set, cannot send message');
      return;
    }

    await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
    console.log(`✅ Sent buy alert for ${gotTok.toFixed(4)} MONEY`);
  } catch (err) {
    console.error('❌ Error parsing swap log:', err.message);
  }
}

// --- Polling Logic ---
let lastBlock = 0;

async function pollSwaps() {
  try {
    const currentBlock = await withRetry(() => provider.getBlockNumber());
    if (currentBlock <= lastBlock) return;

    console.log(`📡 Polling blocks ${lastBlock + 1} to ${currentBlock}`);
    const logs = await withRetry(() =>
      provider.getLogs({
        address: process.env.PAIR_ADDRESS,
        fromBlock: lastBlock + 1,
        toBlock: currentBlock,
        topics: [id('Swap(address,uint256,uint256,uint256,uint256,address)')],
      })
    );

    for (const log of logs) {
      await handleSwapLog(log);
    }

    lastBlock = currentBlock;
  } catch (err) {
    console.error('❌ Polling error:', err.message);
  }
}

// --- Telegram Bot Initialization ---
bot.start(async (ctx) => {
  try {
    CHAT_ID = ctx.chat.id;
    await ctx.reply(
      '🚀 *Buy bot started!* Listening for BESC → MONEY buys...',
      { parse_mode: 'Markdown' }
    );

    const startBlock = await withRetry(() => provider.getBlockNumber());
    lastBlock = startBlock;
    console.log(`✅ Started at block ${startBlock}`);

    setInterval(pollSwaps, POLLING_INTERVAL);
  } catch (err) {
    console.error('❌ Bot start error:', err.message);
    await ctx.reply('❌ Failed to start bot. Check server logs.');
  }
});

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down bot...');
  await bot.stop();
  console.log('✅ Bot stopped');
  process.exit(0);
});

// --- Launch Bot ---
bot
  .launch()
  .then(() => console.log('✅ Buy bot is live and watching'))
  .catch((err) => {
    console.error('❌ Bot launch failed:', err.message);
    process.exit(1);
  });
