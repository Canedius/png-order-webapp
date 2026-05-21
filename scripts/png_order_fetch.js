/* PNG Order fetcher — referenced by PngOrderAuto.bas.
 *
 * Usage:
 *   node png_order_fetch.js <orderId>     — single order
 *   node png_order_fetch.js today         — batch: all today's Modern Armor orders
 *   node png_order_fetch.js all           — batch: all active Modern Armor orders (any date)
 *
 * For every order:
 *   - reads custom_field OR_1086 (per-item form+AI signals)
 *   - skips orders with тип=кастом, missing OR_1086, parse errors
 *   - copies print files from G:\…\PNG_Order_<id>\ to C:\PNG_ORDER\temp\order_<id>\
 *   - trims transparent borders via sharp (parallel, libvips threadpool)
 *
 * Writes:
 *   - C:\PNG_ORDER\file_list.txt   header: order_id|index|type|logo|callsign_flag|under_logo|callsigns|quantity
 *   - C:\PNG_ORDER\prints_list.txt rows:    <order_id>|<abs path>|<count>
 *   - C:\PNG_ORDER\viz_list.txt    rows:    <order_id>|<abs path>|<index>  (VIZ* files only)
 *   - C:\PNG_ORDER\errors.log      fatal-only (VBA aborts if non-empty)
 *   - C:\PNG_ORDER\logs\node.log   timings + skipped-orders summary
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// sharp is loaded lazily inside trimTransparent so this module can be
// require()'d from tests/CI machines that do not have the native binary.
let sharp = null;
function getSharp() {
    if (sharp) return sharp;
    try { sharp = require('sharp'); } catch (_) { sharp = false; }
    return sharp;
}

process.on('unhandledRejection', (reason) => {
    try { nlog(`UNHANDLED REJECTION: ${reason && reason.stack || reason}`); } catch (_) {}
});
process.on('uncaughtException', (err) => {
    try { nlog(`UNCAUGHT EXCEPTION: ${err && err.stack || err}`); } catch (_) {}
});

const TOKEN = 'YjRmYWRmY2Y4YzExYTEyOTg4MzM0MzI3YzI4OWNlODA0ZWMzODVmYg';
const KEYCRM_HOST = 'openapi.keycrm.app';
const SOURCE_ID_MODERN_ARMOR = 31;
const STATUS_ID_VBA_READY = 38;  // KeyCRM status that flags an order as ready to be sent through VBA
// Temporary skip-list: orders we know hang or break the helper. Remove when fixed.
const SKIP_ORDERS = new Set([110671]);
const PRINTS_ROOT = 'G:\\Мій диск\\ДРОП\\Дроп_принти\\Дроп Modern Armor';
const OUT_ROOT = 'C:\\PNG_ORDER';
const TEMP_DIR = path.join(OUT_ROOT, 'temp');
const ERRORS_LOG = path.join(OUT_ROOT, 'errors.log');
const FILE_LIST = path.join(OUT_ROOT, 'file_list.txt');
const PRINTS_LIST = path.join(OUT_ROOT, 'prints_list.txt');
const VIZ_LIST = path.join(OUT_ROOT, 'viz_list.txt');
const NODE_LOG = path.join(OUT_ROOT, 'logs', 'node.log');

function nlog(msg) {
    try {
        const dir = path.dirname(NODE_LOG);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
        fs.appendFileSync(NODE_LOG, `${ts} | ${msg}\n`, 'utf8');
    } catch (_) {}
}

function fail(msg) {
    try { fs.appendFileSync(ERRORS_LOG, msg + '\n', 'utf8'); } catch (_) {}
    console.error(msg);
    process.exit(1);
}

function clearOutputs() {
    for (const p of [ERRORS_LOG, FILE_LIST, PRINTS_LIST, VIZ_LIST]) {
        try { fs.unlinkSync(p); } catch (_) {}
    }
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    // recursive rm of TEMP_DIR contents
    for (const entry of fs.readdirSync(TEMP_DIR, { withFileTypes: true })) {
        const full = path.join(TEMP_DIR, entry.name);
        try {
            if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
            else fs.unlinkSync(full);
        } catch (_) {}
    }
}

function httpGet(pathQs) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: KEYCRM_HOST,
            path: pathQs,
            method: 'GET',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            timeout: 30000,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) {
                    return reject(new Error(`KeyCRM HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
                }
                try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('KeyCRM timeout')); });
        req.end();
    });
}

function fetchOrder(orderId) {
    return httpGet(`/v1/order/${orderId}?include=products,customFields`);
}

// Build the raw query string for the KeyCRM list endpoint. Exposed so unit
// tests can verify the literal "[" / "]" brackets that URLSearchParams would
// otherwise percent-encode (which KeyCRM silently ignores → empty result).
function buildListPageQuery(page) {
    return [
        `limit=50`,
        `page=${page}`,
        `sort=-created_at`,
        `include=products,customFields,shipping`,
        `filter[source_id]=${SOURCE_ID_MODERN_ARMOR}`,
        `filter[status_id]=${STATUS_ID_VBA_READY}`,
    ].join('&');
}

function fetchListPage(page) {
    return httpGet(`/v1/order?${buildListPageQuery(page)}`);
}

// Identify a file by its leading magic bytes. Exported for tests.
// Returns extension with leading dot, or '' when nothing matched (caller skips).
function detectExt(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    try {
        fs.readSync(fd, buf, 0, 16, 0);
    } finally {
        // Always release the fd — even if readSync threw (corrupt file, EIO, etc.).
        fs.closeSync(fd);
    }
    return detectExtFromBuffer(buf);
}

// Pure: decide extension from the first 16 bytes of a file. Exported for tests.
function detectExtFromBuffer(buf) {
    if (!buf || buf.length < 4) return '';
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png';
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg';
    // TIFF little/big endian: II*\0 / MM\0*
    if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) return '.tif';
    if (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A) return '.tif';
    // PDF: %PDF (often used by AI files too — Corel imports either way via cdrPDF)
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '.pdf';
    // BMP: "BM"
    if (buf[0] === 0x42 && buf[1] === 0x4D) return '.bmp';
    // GIF: "GIF8" (7a or 9a)
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
    // Photoshop PSD: "8BPS"
    if (buf[0] === 0x38 && buf[1] === 0x42 && buf[2] === 0x50 && buf[3] === 0x53) return '.psd';
    // PostScript / EPS: "%!PS"
    if (buf[0] === 0x25 && buf[1] === 0x21 && buf[2] === 0x50 && buf[3] === 0x53) return '.eps';
    // SVG (text-based): "<?xml" or "<svg" or "<?XM" etc. — best-effort.
    if (buf[0] === 0x3C) {
        const head = buf.slice(0, Math.min(buf.length, 16)).toString('ascii').toLowerCase();
        if (head.includes('<?xml') || head.includes('<svg')) return '.svg';
    }
    // RIFF container — needs subtype at bytes 8-11 to distinguish CDR from AVI/WAV/WEBP.
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12) {
        const sub = buf.slice(8, 12).toString('ascii');
        if (sub.startsWith('CDR') || sub.startsWith('cdr')) return '.cdr';
        if (sub === 'WEBP') return '.webp';
    }
    return '';
}

// Crop transparent borders (PNG/TIFF). Best-effort: failures only logged.
async function trimTransparent(filePath) {
    const e = path.extname(filePath).toLowerCase();
    if (e !== '.png' && e !== '.tif' && e !== '.tiff') return;
    const sharpLib = getSharp();
    if (!sharpLib) {
        nlog(`trim SKIP ${path.basename(filePath)}: sharp not installed`);
        return;
    }
    const baseName = path.basename(filePath);
    const sizeBefore = fs.statSync(filePath).size;
    const t0 = Date.now();
    const tmpPath = filePath + '.trim.tmp';
    try {
        await sharpLib(filePath, { unlimited: true })
            .trim()
            .withMetadata()
            .toFile(tmpPath);
        fs.unlinkSync(filePath);
        fs.renameSync(tmpPath, filePath);
        const dt = Date.now() - t0;
        const sizeAfter = fs.statSync(filePath).size;
        const dPct = sizeBefore > 0 ? ((sizeAfter - sizeBefore) / sizeBefore) * 100 : 0;
        const dStr = (dPct >= 0 ? '+' : '') + dPct.toFixed(1) + '%';
        nlog(`trim OK ${baseName}: ${(sizeBefore / 1048576).toFixed(2)} → ${(sizeAfter / 1048576).toFixed(2)} MB (${dStr}) in ${dt} ms`);
    } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        nlog(`trim FAIL ${baseName} (${(sizeBefore / 1048576).toFixed(2)} MB) after ${Date.now() - t0} ms: ${err.message}`);
        console.error(`WARN: trim failed for ${filePath}: ${err.message}`);
    }
}

// Copy print + viz files for a single order into <destDir>. Returns
// { prints, vizes } — absolute paths split by file-name convention:
//   - VIZ* (case-insensitive) → vizes
//   - everything else → prints
function copyOrderPrints(orderId, destDir, trimPromises) {
    const srcDir = path.join(PRINTS_ROOT, `PNG_Order_${orderId}`);
    if (!fs.existsSync(srcDir)) {
        nlog(`WARN: print folder missing for order=${orderId}: ${srcDir}`);
        return { prints: [], vizes: [] };
    }
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const prints = [];
    const vizes = [];
    for (const name of fs.readdirSync(srcDir)) {
        if (name.toLowerCase() === 'desktop.ini') continue;
        const src = path.join(srcDir, name);
        const stat = fs.statSync(src);
        if (!stat.isFile()) continue;
        let ext = path.extname(name).toLowerCase();
        if (!ext) ext = detectExt(src);
        if (!ext) {
            nlog(`WARN: unknown file type for order=${orderId}, skipping: ${src}`);
            continue;
        }
        const dest = path.join(destDir, name + ext);
        fs.copyFileSync(src, dest);
        // trim disabled for now — was hanging on certain large PNGs.
        // trimPromises.push(trimTransparent(dest));
        if (/^viz/i.test(name)) vizes.push(dest);
        else prints.push(dest);
    }
    return { prints, vizes };
}

// Group copies of the same print file (n8n suffixes _1/_2/_N) into deduped
// entries so VBA imports once and Duplicate()s the rest.
function dedupePrints(paths) {
    const groups = new Map();
    for (const full of paths) {
        const name = path.basename(full);
        const m = name.match(/^(.+?)_(\d+)(\.[^.]+)$/);
        const key = m ? m[1] + m[3] : name;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(full);
    }
    return Array.from(groups.values()).map(p => ({ path: p[0], count: p.length }));
}

// Build a single file_list.txt data row. Pure formatter — extracted for tests.
function buildFileRow(orderId, index, item, qty) {
    const callsigns = Array.isArray(item.callsigns) ? item.callsigns : [];
    return [
        orderId, index,
        item['тип'] || 'стандарт',
        item['логотип'] ? 'true' : 'false',
        item['позивний'] ? 'true' : 'false',
        item['розташування_внизу'] ? 'true' : 'false',
        callsigns.map(c => String(c).replace(/[|;]/g, '/')).join(';'),
        qty,
    ].join('|');
}

// Process one order: validate OR_1086, copy prints, schedule trim, return
// { fileRows, printRows, skip_reason }. skip_reason set => order ignored.
//
// `deps` allows tests to inject a fake copyOrderPrints implementation; in
// production it falls back to the real one defined above.
function processOrder(order, trimPromises, deps = {}) {
    const copyFn = deps.copyOrderPrints || copyOrderPrints;
    const orderId = order.id;
    if (SKIP_ORDERS.has(orderId)) {
        return { skip_reason: 'manually skipped (SKIP_ORDERS)' };
    }
    if (order.source_id !== SOURCE_ID_MODERN_ARMOR) {
        return { skip_reason: `source_id=${order.source_id}` };
    }
    const cf = (order.custom_fields || []).find(c => c.uuid === 'OR_1086');
    if (!cf || !cf.value) return { skip_reason: 'no OR_1086' };
    let items;
    try { items = JSON.parse(cf.value); }
    catch (e) { return { skip_reason: 'OR_1086 parse error' }; }
    if (!Array.isArray(items)) return { skip_reason: 'OR_1086 not array' };
    if (items.some(it => it && it['тип'] === 'кастом')) return { skip_reason: 'has custom items' };

    const orderDir = path.join(TEMP_DIR, `order_${orderId}`);
    const { prints: orderPrints, vizes: orderVizes } = copyFn(orderId, orderDir, trimPromises);
    const deduped = dedupePrints(orderPrints);
    const printRows = deduped.map(d => `${orderId}|${d.path}|${d.count}`);
    const vizRows = orderVizes.map((p, i) => `${orderId}|${p}|${i + 1}`);

    const products = Array.isArray(order.products) ? order.products : [];
    const fileRows = items.map((it, i) => {
        const qty = (products[i] && products[i].quantity) || 1;
        return buildFileRow(orderId, i, it, qty);
    });
    return {
        fileRows, printRows, vizRows,
        items_count: items.length,
        prints_count: orderPrints.length,
        vizes_count: orderVizes.length,
    };
}

function writeListFiles(allFileRows, allPrintRows, allVizRows) {
    const header = 'order_id|index|type|logo|callsign_flag|under_logo|callsigns|quantity';
    fs.writeFileSync(FILE_LIST, header + '\r\n' + allFileRows.join('\r\n') + (allFileRows.length ? '\r\n' : ''), 'utf8');
    fs.writeFileSync(PRINTS_LIST, allPrintRows.join('\r\n') + (allPrintRows.length ? '\r\n' : ''), 'utf8');
    fs.writeFileSync(VIZ_LIST, allVizRows.join('\r\n') + (allVizRows.length ? '\r\n' : ''), 'utf8');
}

async function runSingle(orderId) {
    clearOutputs();
    const tStart = Date.now();
    nlog(`=== START single order=${orderId} ===`);

    let order;
    const t0 = Date.now();
    try { order = await fetchOrder(orderId); }
    catch (e) { fail(`Не вдалося отримати замовлення ${orderId}: ${e.message}`); }
    nlog(`KeyCRM fetch: ${Date.now() - t0} ms`);

    const trimPromises = [];
    const tProc = Date.now();
    const result = processOrder(order, trimPromises);
    if (result.skip_reason) {
        // In single-order mode skip_reason is fatal — surface it in errors.log.
        fail(`Замовлення ${orderId} пропущено: ${result.skip_reason}`);
    }
    if (trimPromises.length) await Promise.all(trimPromises);
    nlog(`process + trim ${trimPromises.length} files: ${Date.now() - tProc} ms`);

    writeListFiles(result.fileRows, result.printRows, result.vizRows);

    nlog(`=== DONE single order=${orderId} items=${result.items_count} prints=${result.prints_count} vizes=${result.vizes_count} | total ${Date.now() - tStart} ms ===`);
    console.log(`OK order=${orderId} items=${result.items_count} prints=${result.prints_count} vizes=${result.vizes_count}`);
    process.exit(0);
}

async function runBatch(mode) {
    if (mode !== 'today' && mode !== 'all') {
        fail(`Невідомий batch-режим: ${mode}. Очікую "today" або "all".`);
    }
    clearOutputs();
    const tStart = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    nlog(`=== START batch mode=${mode}${mode === 'today' ? ` date=${today}` : ''} ===`);

    // Collect candidate orders (Modern Armor only). Filter locally by
    // shipping.shipping_date (the date the order has to be shipped) — that's
    // the criterion that matters for "today's orders", not created_at.
    const candidates = [];
    let page = 1;
    const MAX_PAGES = 20;
    const tFetch = Date.now();
    while (page <= MAX_PAGES) {
        let res;
        try { res = await fetchListPage(page); }
        catch (e) { fail(`KeyCRM list page ${page} failed: ${e.message}`); }
        const orders = res.data || [];
        if (!orders.length) break;
        for (const o of orders) {
            if (o.source_id !== SOURCE_ID_MODERN_ARMOR) continue;
            if (o.status_id !== STATUS_ID_VBA_READY) continue;
            if (mode === 'today') {
                // KeyCRM actual ship date lives in shipping.shipping_date_actual
                // (the "shipping_date" field is something else and almost always null).
                const shipDate = ((o.shipping && o.shipping.shipping_date_actual) || '').slice(0, 10);
                if (shipDate !== today) continue;
            }
            candidates.push(o);
        }
        if (orders.length < 50) break;
        page++;
    }
    nlog(`KeyCRM fetch ${page} page(s): ${Date.now() - tFetch} ms, candidates=${candidates.length}`);

    const allFileRows = [];
    const allPrintRows = [];
    const allVizRows = [];
    const skipped = [];
    const trimPromises = [];
    let okCount = 0, totalPrints = 0, totalVizes = 0;

    const tProc = Date.now();
    for (const order of candidates) {
        const tOrd = Date.now();
        let r;
        try {
            r = processOrder(order, trimPromises);
        } catch (e) {
            nlog(`processOrder THREW order=${order.id}: ${e.stack || e.message}`);
            skipped.push(`${order.id}(threw: ${e.message})`);
            continue;
        }
        if (r.skip_reason) {
            nlog(`order=${order.id} skipped: ${r.skip_reason}`);
            skipped.push(`${order.id}(${r.skip_reason})`);
            continue;
        }
        allFileRows.push(...r.fileRows);
        allPrintRows.push(...r.printRows);
        allVizRows.push(...r.vizRows);
        okCount++;
        totalPrints += r.prints_count;
        totalVizes += r.vizes_count;
        nlog(`order=${order.id} processed: items=${r.items_count} prints=${r.prints_count} vizes=${r.vizes_count} in ${Date.now() - tOrd} ms (trim queued: ${trimPromises.length})`);
    }
    if (trimPromises.length) {
        try {
            await Promise.all(trimPromises);
        } catch (e) {
            // trimTransparent catches internally — this should not fire, but log if it does.
            nlog(`Promise.all(trim) REJECTED: ${e.stack || e.message}`);
        }
    }
    nlog(`process + trim all (${trimPromises.length} files) in ${Date.now() - tProc} ms`);

    writeListFiles(allFileRows, allPrintRows, allVizRows);

    nlog(`skipped ${skipped.length} orders: ${skipped.join(', ') || '(none)'}`);
    nlog(`=== DONE batch mode=${mode} ok=${okCount}/${candidates.length} prints=${totalPrints} vizes=${totalVizes} | total ${Date.now() - tStart} ms ===`);
    console.log(`OK batch mode=${mode} ok=${okCount}/${candidates.length} prints=${totalPrints} vizes=${totalVizes} skipped=${skipped.length}`);
    process.exit(0);
}

// Expose pure helpers + flag set for unit tests. The CLI keeps working when
// the file is run directly; when require()'d (from tests) we skip the main
// IIFE so jest/node:test can import without side effects.
module.exports = {
    SKIP_ORDERS,
    SOURCE_ID_MODERN_ARMOR,
    STATUS_ID_VBA_READY,
    buildListPageQuery,
    buildFileRow,
    dedupePrints,
    detectExtFromBuffer,
    processOrder,
};

if (require.main === module) {
    (async () => {
        const arg = (process.argv[2] || '').trim();
        if (/^\d+$/.test(arg)) {
            await runSingle(arg);
        } else if (arg === 'today' || arg === 'all') {
            await runBatch(arg);
        } else {
            fail(`Невалідний аргумент: "${arg}". Очікую <orderId> | today | all.`);
        }
    })().catch(e => fail(`FATAL: ${e.message}`));
}
