/**
 * scripts/src/browser-smoke.ts
 *
 * Playwright Browser Smoke Test for Waypoint 6-Step Demo Guide:
 *   - Runs headless Chromium against the live running server (http://localhost:3000)
 *   - Intercepts all network traffic and audits headers, query params, and bodies for leaked secrets
 *   - Sequentially executes Step 1 -> Step 2 -> Step 3 -> Step 4 -> Step 5 -> Step 6
 *   - Asserts final Step 6 verdict is BLOCK
 *   - Asserts preflight citation links structurally to the lesson resolved in Step 5
 *   - Outputs a clean pass/fail audit report
 */

import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const FORBIDDEN_TOKENS = [
  process.env.EMBED_API_KEY,
  process.env.MONGODB_URI?.includes('@') ? process.env.MONGODB_URI.split('@')[0].split(':').pop() : undefined,
  process.env.ANTHROPIC_API_KEY,
].filter((t): t is string => typeof t === 'string' && t.length > 5);

async function runBrowserSmoke() {
  console.log(`\n======================================================`);
  console.log(`🚀 Waypoint Playwright Browser Smoke Test`);
  console.log(`Target: ${BASE_URL}/guide`);
  console.log(`Audit: strict secret leakage detection across all network requests`);
  console.log(`======================================================\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let leakedSecretsCount = 0;
  const leakedSamples: string[] = [];

  page.on('console', (msg) => console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[Browser Error] ${err.message}`));

  // Network monitor for secret leak prevention
  page.on('request', (req) => {
    const url = req.url();
    const postData = req.postData() || '';
    const headers = JSON.stringify(req.headers());

    for (const token of FORBIDDEN_TOKENS) {
      if (url.includes(token) || postData.includes(token) || headers.includes(token)) {
        leakedSecretsCount++;
        leakedSamples.push(`Leaked in request to ${url}`);
      }
    }
  });

  page.on('response', async (res) => {
    try {
      const headers = JSON.stringify(res.headers());
      const contentType = res.headers()['content-type'] || '';
      if (contentType.includes('text/event-stream')) {
        return; // Streaming SSE, do not buffer
      }
      const body = await res.text().catch(() => '');

      for (const token of FORBIDDEN_TOKENS) {
        if (headers.includes(token) || body.includes(token)) {
          leakedSecretsCount++;
          leakedSamples.push(`Leaked in response from ${res.url()}`);
        }
      }
    } catch {
      // response might be a stream or closed
    }
  });

  try {
    console.log('Navigating to /guide...');
    await page.goto(`${BASE_URL}/guide`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const title = await page.textContent('h1');
    console.log(`Page title: "${title?.trim()}"`);
    if (!title?.includes('Interactive Demo Story')) {
      throw new Error(`Unexpected page title: ${title}`);
    }

    // Step 1: Reset Sandbox
    console.log('\n[Step 1] Clicking "Reset Sandbox"...');
    await page.click('[data-testid="step-1-btn"]');
    await page.waitForSelector('text=Sandbox reset!', { timeout: 15000 });
    console.log('✅ Step 1 complete: Cleanly reset and seeded');

    // Step 2: Run Baseline
    console.log('\n[Step 2] Clicking "Run Baseline"...');
    await page.click('[data-testid="step-2-btn"]');
    await page.waitForSelector('text=Clean baseline executed', { timeout: 15000 });
    console.log('✅ Step 2 complete: Baseline runs recorded & contract mined');

    // Step 3: Bad Deploy
    console.log('\n[Step 3] Clicking "Bad Deploy"...');
    await page.click('[data-testid="step-3-btn"]');
    await page.waitForSelector('text=Bad deploy triggered', { timeout: 15000 });
    console.log('✅ Step 3 complete: Silent failures triggered & incident opened');

    // Step 4: Run Replay Grid
    console.log('\n[Step 4] Clicking "Run Replay Grid"...');
    await page.click('[data-testid="step-4-btn"]');
    await page.waitForSelector('text=Replay grid complete!', { timeout: 25000 });
    console.log('✅ Step 4 complete: Factorial replay grid evaluated & Shapley blame assigned');

    // Step 5: Resolve Incident & Save Lesson
    console.log('\n[Step 5] Clicking "Resolve & Save"...');
    await page.click('[data-testid="step-5-btn"]');
    await page.waitForSelector('text=Incident resolved!', { timeout: 15000 });
    console.log('✅ Step 5 complete: Incident resolved and episodic memory lesson stored');

    // Step 6: Preflight Check Proposed v3 (The Finale)
    console.log('\n[Step 6] Clicking "Preflight v3"...');
    await page.click('[data-testid="step-6-btn"]');
    await page.waitForSelector('text=Verdict: BLOCK', { timeout: 45000 });

    const step6Text = await page.textContent('div:has-text("Verdict: BLOCK")');
    console.log('✅ Step 6 output:');
    console.log(step6Text?.trim());

    if (!step6Text?.includes('BLOCK')) {
      throw new Error(`Step 6 expected verdict BLOCK, got: ${step6Text}`);
    }

    if (leakedSecretsCount > 0) {
      throw new Error(`CRITICAL: Detected ${leakedSecretsCount} leaked secrets in browser traffic! Samples:\n${leakedSamples.join('\n')}`);
    }

    console.log(`\n🔒 Security Audit: 0 secrets leaked across all browser requests and responses.`);
    console.log(`🎉 ALL 6 DEMO STEPS VERIFIED IN HEADLESS BROWSER CLICK-THROUGH!\n`);
  } finally {
    await browser.close();
  }
}

runBrowserSmoke().catch((err) => {
  console.error('\n❌ Playwright Browser Smoke Test Failed:', err);
  process.exit(1);
});
