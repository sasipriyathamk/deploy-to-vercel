// Run independently of the browser and discovery pipeline on an always-on Node host.
const base = process.env.KEEL_APP_URL?.trim();
const secret = process.env.CRON_SECRET?.trim();
if (!base || !secret) throw new Error('Set KEEL_APP_URL and CRON_SECRET securely before starting the alert worker.');
const endpoint = new URL('/api/cron/alerts', base);
if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) throw new Error('KEEL_APP_URL must use HTTPS.');
let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
while (!stopped) {
  try {
    const response = await fetch(endpoint, {headers:{Authorization:`Bearer ${secret}`}, signal:AbortSignal.timeout(55000)});
    if (!response.ok) console.error(`Alert worker HTTP ${response.status}; review configuration and service health.`);
    else {
      const data = await response.json();
      console.log(JSON.stringify({at:new Date().toISOString(),enabled:data.enabled,sent:data.sent,observed:data.observed,failed:data.failed}));
    }
  } catch { console.error('Alert worker request interrupted; durable delivery states require normal reconciliation.'); }
  if (!stopped) await new Promise(resolve => setTimeout(resolve,5000));
}
