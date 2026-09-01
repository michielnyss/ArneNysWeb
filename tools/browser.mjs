import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = path.join(root, '.browser-profile');
export const ROOT = root;

/**
 * Opens Chromium against a persistent profile, so a login done once by hand
 * (2FA included) is reused by every later headless run.
 */
export async function openBrowser({ headless = true } = {}) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}
