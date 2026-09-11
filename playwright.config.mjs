import { defineConfig } from '@playwright/test';
const matrix = [320, 375, 390, 430].flatMap(width => [1, 1.25, 1.5, 2].map(deviceScaleFactor => ({
  name: `responsive-${width}-dpr-${deviceScaleFactor}`,
  testMatch: /matrix\.spec\.mjs/,
  use: { viewport: { width, height: 900 }, deviceScaleFactor },
})));
export default defineConfig({
  // Production is plain Node ESM. Keep its original bytes/coverage offsets;
  // only the test runner's own files need Playwright's source transformation.
  build: {external:['**/lib/**','**/server.js','**/mkt.mjs','**/sent.mjs','**/log.mjs']},
  testDir: './tests/e2e', fullyParallel: true, forbidOnly: true, retries: 0,
  workers: 2, timeout: 45000, expect: { timeout: 10000 },
  outputDir: './test-results',
  reporter: [['line'], ['json', { outputFile: 'test-results/results.json' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { browserName: 'chromium', headless: true, serviceWorkers: 'allow', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [...matrix, { name: 'chromium-touch', testMatch: /touch\.spec\.mjs/, use: { viewport: {width:390,height:844}, deviceScaleFactor:2, hasTouch:true, isMobile:true } }, {name:'real-application',testMatch:/(?:real-application|snapshot-startup|global-markets)\.spec\.mjs/,use:{viewport:{width:1440,height:1000}}}, {name:'global-markets-dpr-1.25',testMatch:/global-markets\.spec\.mjs/,use:{viewport:{width:320,height:900},deviceScaleFactor:1.25}}, { name: 'desktop-journeys', testMatch: /journeys\.spec\.mjs/, use: { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } }],
});
