/* Run KeyCRM product comments through the new callsign-only test workflow.
 * AI Extract now returns only { callsign: "..." } — no simplicity/has_logo/position.
 *
 * Reads:  C:\tmp\keycrm_modern_products.json
 * Writes: C:\tmp\callsign_test_results.json
 *         C:\tmp\callsign_test_results.csv
 */
const fs = require('fs');
const https = require('https');

const ENDPOINT = 'https://primary-production-eeb3.up.railway.app/webhook/test-parse-comment';
const INPUT_PATH = process.argv[2] || 'C:\\tmp\\keycrm_modern_products.json';
const OUT_BASE = process.argv[3] || 'C:\\tmp\\callsign_test_results';
const OUT_JSON = `${OUT_BASE}.json`;
const OUT_CSV = `${OUT_BASE}.csv`;
const CONCURRENCY = 4;
const TIMEOUT_MS = 60000;

function postJson(url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = Buffer.from(JSON.stringify(body), 'utf8');
        const req = https.request({
            hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
            timeout: TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch (e) { resolve({ status: res.statusCode, raw: text, error: 'parse_failed' }); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.write(data); req.end();
    });
}

function csvEscape(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ');
    return /[",\n]/.test(s) ? `"${s}"` : s;
}

async function runBatch(items) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            const it = items[i];
            const t0 = Date.now();
            let res;
            const payload = {
                order_id: `keycrm-${it.order_id}`,
                products: [{ product_id: it.product_id, sku: it.sku, type: it.product_name, comment: it.text }]
            };
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    res = await postJson(ENDPOINT, payload);
                    break;
                } catch (e) {
                    if (attempt === 1) res = { error: String(e) };
                }
            }
            const root = res.json || {};
            const item = (root.items && root.items[0]) || {};
            const callsigns = Array.isArray(item.callsigns) ? item.callsigns : (item.callsign ? [item.callsign] : []);
            results[i] = {
                id: it.id,
                order_id: it.order_id,
                product_id: it.product_id,
                sku: it.sku,
                product_name: it.product_name,
                text: it.text,
                status: res.status || 0,
                callsigns,
                ms: Date.now() - t0,
                error: res.error || null,
            };
            const preview = (it.text || '').replace(/\n/g, ' | ').slice(0, 70);
            const shown = callsigns.length ? `[${callsigns.map(c => `"${c}"`).join(', ')}]` : '-';
            process.stdout.write(`#${String(it.id).padStart(2)} order=${it.order_id} → ${shown}   :: ${preview}\n`);
        }
    });
    await Promise.all(workers);
    return results;
}

(async () => {
    const items = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
    console.log(`Loaded ${items.length} KeyCRM product comments.`);
    const t0 = Date.now();
    const results = await runBatch(items);
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8');
    const header = ['id', 'order_id', 'product_id', 'sku', 'status', 'callsigns_count', 'callsigns', 'text'];
    const lines = [header.join(',')];
    for (const r of results) {
        lines.push([r.id, r.order_id, r.product_id, r.sku, r.status, (r.callsigns || []).length, (r.callsigns || []).join(' | '), r.text].map(csvEscape).join(','));
    }
    fs.writeFileSync(OUT_CSV, '﻿' + lines.join('\n'), 'utf8');

    const ok = results.filter(r => r.status === 200).length;
    const withCall = results.filter(r => (r.callsigns || []).length > 0).length;
    const noCall = results.filter(r => r.status === 200 && (r.callsigns || []).length === 0).length;
    const multi = results.filter(r => (r.callsigns || []).length >= 2).length;
    console.log(`\nOK=${ok}/${results.length}  with_callsign=${withCall}  no_callsign=${noCall}  multi(>=2)=${multi}`);
    console.log(`Wrote ${OUT_JSON} and ${OUT_CSV}`);
})();
