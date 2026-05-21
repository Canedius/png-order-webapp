/* Fetch 150 more Modern Armor product comments (older than the first 50).
 * Skips comments already collected in keycrm_modern_products.json.
 * Writes C:\tmp\keycrm_modern_products_more.json
 */
const https = require('https');
const fs = require('fs');

const TOKEN = 'YjRmYWRmY2Y4YzExYTEyOTg4MzM0MzI3YzI4OWNlODA0ZWMzODVmYg';
const TARGET_COUNT = 150;
const START_PAGE = 1;
const MAX_PAGE = 60;
const OUT_PATH = 'C:\\tmp\\keycrm_modern_products_more.json';
const PREV_PATH = 'C:\\tmp\\keycrm_modern_products.json';

function fetchPage(page) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams({
            limit: '50', page: String(page), sort: '-created_at', include: 'products,buyer',
        }).toString();
        const req = https.request({
            hostname: 'openapi.keycrm.app',
            path: `/v1/order?${qs}`,
            method: 'GET',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
            timeout: 60000,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (e) { reject(new Error('parse failed: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const seen = new Set();
    const seenPairs = new Set();
    if (fs.existsSync(PREV_PATH)) {
        for (const it of JSON.parse(fs.readFileSync(PREV_PATH, 'utf8'))) {
            if (it.text) seen.add(it.text.trim());
            if (it.order_id && it.product_id) seenPairs.add(`${it.order_id}:${it.product_id}`);
        }
        console.log(`Pre-seeded ${seen.size} comments and ${seenPairs.size} order:product pairs.`);
    }

    const collected = [];
    for (let page = START_PAGE; page <= MAX_PAGE && collected.length < TARGET_COUNT; page++) {
        process.stdout.write(`page ${page}... `);
        const res = await fetchPage(page);
        const orders = res?.data || [];
        if (!orders.length) { console.log('empty, stopping'); break; }
        let added = 0;
        for (const o of orders) {
            if (o.source_id !== 31) continue;
            for (const p of (o.products || [])) {
                const comment = (p.comment || '').trim();
                if (!comment || comment.length < 10) continue;
                const pair = `${o.id}:${p.id}`;
                if (seenPairs.has(pair)) continue;
                if (seen.has(comment)) { seenPairs.add(pair); continue; }
                seen.add(comment); seenPairs.add(pair);
                collected.push({
                    source: `keycrm:order-${o.id}`,
                    id: collected.length + 1,
                    order_id: o.id,
                    product_id: p.id,
                    sku: p.sku || (p.offer && p.offer.sku) || null,
                    product_name: (p.offer && p.offer.name) || p.name || null,
                    source_id: o.source_id,
                    text: comment,
                });
                added++;
                if (collected.length >= TARGET_COUNT) break;
            }
            if (collected.length >= TARGET_COUNT) break;
        }
        console.log(`+${added} → total ${collected.length}`);
        await new Promise(r => setTimeout(r, 200));
    }

    fs.writeFileSync(OUT_PATH, JSON.stringify(collected, null, 2), 'utf8');
    console.log(`\nCollected ${collected.length} → ${OUT_PATH}`);
})();
