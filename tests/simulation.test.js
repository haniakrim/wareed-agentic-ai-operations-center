// Headless browser check of the live simulation, proactive layer and guided demo.
// Run: npm install && npm test   (uses installed Google Chrome, falls back to Playwright's Chromium)
// Playwright's fake clock fast-forwards the 5-second simulation ticks.
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const VIEWS = ['brief', 'branch', 'lab', 'home', 'cx', 'mkt', 'orchestrator', 'actions', 'vision', 'govern', 'architecture', 'health'];

async function launch() {
  try { return await chromium.launch({ channel: 'chrome' }); } catch (e) { return chromium.launch(); }
}

async function open(browser, query, hash, lang) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (lang) await page.addInitScript(l => { try { localStorage.setItem('wareed.lang', l); } catch (e) {} }, lang);
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.clock.install();
  await page.goto(PAGE + (query || '') + '#' + hash);
  page.until = async (fn, max = 120000, arg) => {
    for (let t = 0; t < max; t += 1000) {
      if (await page.evaluate(fn, arg)) return true;
      await page.clock.runFor(1000);
    }
    return false;
  };
  return page;
}
const text = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const clickNudge = (page, re) => page.evaluate(src => [...document.querySelectorAll('.nudge.auto')].find(n => new RegExp(src).test(n.textContent)).querySelector('button[data-ix="0"]').click(), re);

async function proactive(browser) {
  const page = await open(browser, '', 'lab');

  for (const v of VIEWS) {
    await page.evaluate(v => { location.hash = v; }, v);
    await page.clock.runFor(200);
    assert(/Proactive insight/.test(await text(page, '#viewInsight') || ''), 'insight card missing on ' + v);
  }
  console.log('ok  live agent insight on all ' + VIEWS.length + ' views');

  assert.strictEqual(await page.evaluate(() => document.getElementById('cpDot').hidden), false, 'copilot badge not shown');
  console.log('ok  copilot queues a briefing when a view opens');

  assert(await page.until(() => [...document.querySelectorAll('.nudge.auto')].some(n => /Auto-executing/.test(n.textContent))), 'no auto-executing alert');
  const c1 = await text(page, '.nudge.auto [data-count]');
  await page.clock.runFor(3000);
  const c2 = await text(page, '.nudge.auto [data-count]');
  assert(parseInt(c2) < parseInt(c1), 'countdown not ticking');
  assert(await page.until(() => [...document.querySelectorAll('.nudge.auto')].some(n => /Auto-executed/.test(n.textContent)), 15000), 'auto action never executed');
  await clickNudge(page, 'Auto-executed');
  assert(/Undone/.test(await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|'))), 'undo failed');
  console.log('ok  auto-execute countdown ' + c1 + ' → ' + c2 + ' → executed → undone');

  assert(await page.until(() => [...document.querySelectorAll('.nudge.auto')].some(n => /Auto-executing/.test(n.textContent)), 180000), 'no second auto alert');
  await clickNudge(page, 'Auto-executing');
  await page.evaluate(() => document.getElementById('bellBtn').click());
  const tags = await page.evaluate(() => [...document.querySelectorAll('#notifList .nrow .tag')].map(t => t.textContent));
  assert(tags.includes('Cancelled') && tags.includes('Undone'), 'notification statuses: ' + tags);
  assert(await page.evaluate(() => document.getElementById('bellCount').hidden), 'bell not cleared');
  console.log('ok  cancel, notification center statuses, bell cleared');

  await page.evaluate(() => { document.getElementById('autonomyChk').click(); document.getElementById('notifClose').click(); });
  assert(await page.until(() => [...document.querySelectorAll('.nudge.auto')].some(n => /Suggested/.test(n.textContent)), 240000), 'no suggested alert with autonomy off');
  await clickNudge(page, 'Suggested');
  assert(await page.evaluate(() => [...document.querySelectorAll('.nudge.auto')].some(n => /Executed \(approved\)/.test(n.textContent))), 'approve & run failed');
  console.log('ok  autonomy off → suggested → approved & run');

  // first-open question must not be dropped while the greeting streams
  await page.evaluate(() => { location.hash = 'lab'; });
  await page.clock.runFor(300);
  const dec = await page.evaluate(() => { const b = document.querySelector('#viewInsight [data-decision="approve"]'); if (!b) return null; b.click(); return b.getAttribute('data-id'); });
  await page.evaluate(() => document.querySelector('[data-act="brief"]').click());
  assert(await page.until(() => [...document.querySelectorAll('#cpLog .msg.user')].some(m => /daily CEO brief/.test(m.textContent)), 20000), 'daily brief question dropped on first open');
  assert(await page.until(re => [...document.querySelectorAll('#cpLog .msg.ai.pro .txt')].some(t => new RegExp(re).test(t.textContent)), 90000, 'Follow-up on ' + dec), 'no follow-up for ' + dec);
  console.log('ok  queued first question + follow-up after approving ' + dec);

  await page.evaluate(() => { document.getElementById('cpClose').click(); document.getElementById('bellBtn').click(); document.getElementById('autonomyChk').click(); document.getElementById('notifClose').click(); });
  assert(await page.until(() => [...document.querySelectorAll('.nudge.auto')].some(n => /Auto-executing/.test(n.textContent)), 240000), 'no auto alert for emergency-stop check');
  await page.evaluate(() => { document.getElementById('estopBtn').click(); document.querySelector('[data-confirm="estop-on"]').click(); });
  await page.clock.runFor(1500);
  await page.evaluate(() => document.getElementById('bellBtn').click());
  assert((await page.evaluate(() => [...document.querySelectorAll('#notifList .nrow .tag')].map(t => t.textContent))).includes('Held'), 'emergency stop did not hold the pending action');
  console.log('ok  emergency stop holds pending auto action');

  assert.deepStrictEqual(page.errors, [], 'console errors');
  await page.close();
}

async function guidedDemo(browser) {
  const page = await open(browser, '?demo=1', 'brief');
  await page.clock.runFor(500);
  const total = await page.evaluate(() => document.querySelectorAll('[data-demo-jump] option').length);
  assert(total >= 20, 'storyline too short: ' + total);
  const seen = [];
  for (let i = 0; i < total; i++) {
    const title = await text(page, '.pr-t');
    seen.push(title);
    await page.clock.runFor(12000);
    if (/— proactive$/.test(title)) assert(/Proactive insight/.test(await text(page, '#viewInsight') || ''), 'no insight card on tour step ' + title);
    if (i < total - 1) await page.evaluate(() => document.querySelector('[data-demo-next]').click());
  }
  assert(/Control & audit/.test(seen[seen.length - 1]), 'did not reach the last step');
  assert(!(await page.evaluate(() => document.getElementById('notifPanel').hidden)), 'last step should open the notification center');
  await page.evaluate(() => { document.getElementById('notifClose').click(); location.hash = 'govern'; });
  await page.clock.runFor(300);
  const gov = await text(page, '#viewInsight .vi-b');
  assert(/[1-9]\d* L1–L2 auto-action/.test(gov), 'governance insight should count the demo auto-actions: ' + gov);
  assert.deepStrictEqual(page.errors, [], 'console errors');
  console.log('ok  guided demo: ' + total + ' steps, every tour page shows its proactive insight, governance counts the auto-actions');
  await page.close();
}

const ARABIC = /[\u0600-\u06FF]/;
async function arabic(browser) {
  const page = await open(browser, '?demo=1', 'brief', 'ar');
  await page.clock.runFor(500);
  assert.strictEqual(await page.evaluate(() => document.documentElement.dir), 'rtl', 'not RTL');
  const total = await page.evaluate(() => document.querySelectorAll('[data-demo-jump] option').length);
  for (let i = 0; i < total; i++) {
    await page.clock.runFor(12000);
    for (const sel of ['.pr-t', '.pr-s']) assert(ARABIC.test(await text(page, sel) || ''), 'presenter not Arabic at step ' + (i + 1));
    const card = await text(page, '#viewInsight .vi-b');
    if (card) assert(ARABIC.test(card) && !/ is waiting for you| forecast to breach| in 2h \(conf/.test(card), 'insight card not Arabic at step ' + (i + 1) + ': ' + card.slice(0, 120));
    const nudges = await page.evaluate(() => [...document.querySelectorAll('.nudge .nt')].map(n => n.textContent));
    nudges.forEach(t => assert(ARABIC.test(t), 'alert not Arabic: ' + t));
    if (i < total - 1) await page.evaluate(() => document.querySelector('[data-demo-next]').click());
  }
  const answers = await page.evaluate(() => [...document.querySelectorAll('#cpLog .msg.ai .txt')].map(t => t.textContent));
  assert(answers.length >= 3, 'copilot answered ' + answers.length + ' times');
  answers.forEach(a => assert(ARABIC.test(a), 'copilot answer not Arabic: ' + a.slice(0, 80)));
  assert(answers.some(a => /لا يمكنني المساعدة/.test(a)), 'Arabic clinical guardrail missing');
  await page.evaluate(() => { document.getElementById('notifClose').click(); location.hash = 'govern'; });
  await page.clock.runFor(300);
  assert.strictEqual(await text(page, '#viewInsight .tag'), 'ضمن السياسة', 'Arabic governance tag');
  assert.deepStrictEqual(page.errors, [], 'console errors');
  console.log('ok  Arabic (RTL): presenter, insight cards, alerts and ' + answers.length + ' copilot answers all in Arabic');
  await page.close();
}

(async () => {
  const browser = await launch();
  try {
    await proactive(browser);
    await guidedDemo(browser);
    await arabic(browser);
    console.log('all checks passed');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
