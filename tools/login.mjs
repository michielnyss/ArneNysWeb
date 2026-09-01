import { openBrowser, PROFILE_DIR } from './browser.mjs';

// Run once, by hand:  npm run login
// A real browser window opens. Log into Squarespace, finish any 2FA, then
// come back here and press Enter. The session is saved to .browser-profile/.
const ctx = await openBrowser({ headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://login.squarespace.com/', { waitUntil: 'domcontentloaded' });

console.log(`
A browser window is open.

  1. Log into Squarespace (and complete 2FA / email verification).
  2. Make sure you can see the site dashboard.
  3. Come back to this terminal and press Enter.

Session will be stored in: ${PROFILE_DIR}
`);

await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.once('data', resolve);
});

const cookies = await ctx.cookies();
const signedIn = cookies.some((c) => /squarespace/.test(c.domain) && /crumb|SecureSession|Secure-SSID/i.test(c.name));
console.log(signedIn
  ? '\nSession captured. Later runs can go headless.'
  : '\nNo Squarespace session cookie found — log in fully, then run this again.');

await ctx.close();
process.exit(0);
