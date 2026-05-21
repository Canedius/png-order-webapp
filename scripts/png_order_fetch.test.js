/* Unit tests for png_order_fetch.js helpers. Uses the built-in node:test
 * runner (Node 22+, no extra deps). Run with:
 *   node --test scripts/png_order_fetch.test.js
 *
 * These tests cover the pure helpers + the skip-paths in processOrder
 * (the happy path is covered by injecting a fake copyOrderPrints).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    SKIP_ORDERS,
    SOURCE_ID_MODERN_ARMOR,
    STATUS_ID_VBA_READY,
    buildListPageQuery,
    buildFileRow,
    dedupePrints,
    detectExtFromBuffer,
    processOrder,
} = require('./png_order_fetch.js');

// helper: build a Buffer that starts with the given byte sequence (rest zeroed).
function buf(...bytes) {
    const b = Buffer.alloc(Math.max(bytes.length, 16));
    for (let i = 0; i < bytes.length; i++) b[i] = bytes[i];
    return b;
}
function bufWithAscii(prefix, asciiAt, asciiStr) {
    const b = Buffer.alloc(16);
    for (let i = 0; i < prefix.length; i++) b[i] = prefix[i];
    b.write(asciiStr, asciiAt, 'ascii');
    return b;
}

// =========================================================================
// detectExtFromBuffer (regression: AVI must not be misdetected as CDR)
// =========================================================================
const RIFF = [0x52, 0x49, 0x46, 0x46];

test('detectExtFromBuffer: PNG magic → .png', () => {
    assert.equal(detectExtFromBuffer(buf(0x89, 0x50, 0x4E, 0x47)), '.png');
});

test('detectExtFromBuffer: JPEG (FFD8FF) → .jpg', () => {
    assert.equal(detectExtFromBuffer(buf(0xFF, 0xD8, 0xFF, 0xE0)), '.jpg');
});

test('detectExtFromBuffer: TIFF little-endian → .tif', () => {
    assert.equal(detectExtFromBuffer(buf(0x49, 0x49, 0x2A, 0x00)), '.tif');
});

test('detectExtFromBuffer: TIFF big-endian → .tif', () => {
    assert.equal(detectExtFromBuffer(buf(0x4D, 0x4D, 0x00, 0x2A)), '.tif');
});

test('detectExtFromBuffer: PDF magic → .pdf', () => {
    assert.equal(detectExtFromBuffer(buf(0x25, 0x50, 0x44, 0x46)), '.pdf');
});

test('detectExtFromBuffer: CDR (RIFF + CDR subtype) → .cdr', () => {
    assert.equal(detectExtFromBuffer(bufWithAscii(RIFF, 8, 'CDR9')), '.cdr');
    assert.equal(detectExtFromBuffer(bufWithAscii(RIFF, 8, 'cdrX')), '.cdr');
});

test('detectExtFromBuffer: AVI (RIFF + AVI subtype) is NOT .cdr', () => {
    // Regression: old code matched any RIFF as .cdr. CorelDRAW import would crash.
    assert.equal(detectExtFromBuffer(bufWithAscii(RIFF, 8, 'AVI ')), '');
});

test('detectExtFromBuffer: WAV (RIFF + WAVE) is NOT .cdr', () => {
    assert.equal(detectExtFromBuffer(bufWithAscii(RIFF, 8, 'WAVE')), '');
});

test('detectExtFromBuffer: WEBP (RIFF + WEBP) → .webp (bonus)', () => {
    assert.equal(detectExtFromBuffer(bufWithAscii(RIFF, 8, 'WEBP')), '.webp');
});

test('detectExtFromBuffer: BMP ("BM") → .bmp', () => {
    assert.equal(detectExtFromBuffer(buf(0x42, 0x4D, 0x00, 0x00)), '.bmp');
});

test('detectExtFromBuffer: GIF87a → .gif', () => {
    assert.equal(detectExtFromBuffer(buf(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)), '.gif');
});

test('detectExtFromBuffer: GIF89a → .gif', () => {
    assert.equal(detectExtFromBuffer(buf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), '.gif');
});

test('detectExtFromBuffer: PSD ("8BPS") → .psd', () => {
    assert.equal(detectExtFromBuffer(buf(0x38, 0x42, 0x50, 0x53)), '.psd');
});

test('detectExtFromBuffer: EPS ("%!PS") → .eps', () => {
    assert.equal(detectExtFromBuffer(buf(0x25, 0x21, 0x50, 0x53)), '.eps');
});

test('detectExtFromBuffer: SVG with <?xml header → .svg', () => {
    const b = Buffer.from('<?xml version="1.0"', 'ascii');
    assert.equal(detectExtFromBuffer(b), '.svg');
});

test('detectExtFromBuffer: SVG with <svg root → .svg', () => {
    const b = Buffer.from('<svg xmlns="http"', 'ascii');
    assert.equal(detectExtFromBuffer(b), '.svg');
});

test('detectExtFromBuffer: short buffer (< 4 bytes) returns empty', () => {
    assert.equal(detectExtFromBuffer(Buffer.from([0x89])), '');
});

test('detectExtFromBuffer: null/undefined safe', () => {
    assert.equal(detectExtFromBuffer(null), '');
    assert.equal(detectExtFromBuffer(undefined), '');
});

test('detectExtFromBuffer: unknown signature returns empty', () => {
    assert.equal(detectExtFromBuffer(buf(0x00, 0x01, 0x02, 0x03)), '');
});

// =========================================================================
// buildListPageQuery
// =========================================================================
test('buildListPageQuery keeps brackets literal (KeyCRM rejects percent-encoded)', () => {
    const q = buildListPageQuery(3);
    assert.match(q, /filter\[source_id\]=31/, 'literal [source_id]');
    assert.match(q, /filter\[status_id\]=38/, 'literal [status_id]');
    assert.doesNotMatch(q, /%5B|%5D/, 'no percent-encoded brackets');
    assert.match(q, /^limit=50&page=3&/, 'starts with paging params');
    assert.match(q, /include=products,customFields,shipping/, 'asks for shipping/customFields');
});

test('buildListPageQuery includes the page number', () => {
    assert.match(buildListPageQuery(1), /page=1/);
    assert.match(buildListPageQuery(7), /page=7/);
});

// =========================================================================
// dedupePrints
// =========================================================================
test('dedupePrints groups n8n copies (_1/_2/_3) under one entry', () => {
    const out = dedupePrints([
        'C:/temp/order_1/t1__print_1.png',
        'C:/temp/order_1/t1__print_2.png',
        'C:/temp/order_1/t1__print_3.png',
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 3);
    assert.equal(out[0].path, 'C:/temp/order_1/t1__print_1.png');
});

test('dedupePrints keeps distinct files separate', () => {
    const out = dedupePrints([
        'C:/temp/order_1/t1__a.png',
        'C:/temp/order_1/t2__b.png',
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(x => x.count).sort(), [1, 1]);
});

test('dedupePrints handles files without _N suffix', () => {
    const out = dedupePrints(['C:/temp/order_1/print.png']);
    assert.deepEqual(out, [{ path: 'C:/temp/order_1/print.png', count: 1 }]);
});

test('dedupePrints merges only files differing solely by _N (keeps extension)', () => {
    // foo.png + foo.pdf must NOT merge — extensions differ.
    const out = dedupePrints([
        'C:/temp/order_1/foo_1.png',
        'C:/temp/order_1/foo_1.pdf',
    ]);
    assert.equal(out.length, 2);
});

// =========================================================================
// buildFileRow
// =========================================================================
test('buildFileRow formats standard item with one callsign', () => {
    const row = buildFileRow(110672, 0, {
        'тип': 'стандарт',
        'логотип': true,
        'позивний': true,
        'розташування_внизу': true,
        'callsigns': ['КУМ'],
    }, 1);
    assert.equal(row, '110672|0|стандарт|true|true|true|КУМ|1');
});

test('buildFileRow joins multiple callsigns with semicolons', () => {
    const row = buildFileRow(110672, 1, {
        'тип': 'стандарт',
        'логотип': true,
        'позивний': true,
        'розташування_внизу': false,
        'callsigns': ['ТАНКІСТ', 'ДАРВІН'],
    }, 2);
    const parts = row.split('|');
    assert.equal(parts[6], 'ТАНКІСТ;ДАРВІН');
    assert.equal(parts[7], '2');
});

test('buildFileRow strips | and ; from callsigns', () => {
    const row = buildFileRow(1, 0, {
        'тип': 'стандарт',
        'логотип': false,
        'позивний': true,
        'розташування_внизу': false,
        'callsigns': ['A|B;C', 'D'],
    }, 1);
    // Inner | and ; must be replaced with / so parsing on the VBA side stays sane.
    assert.equal(row.split('|')[6], 'A/B/C;D');
});

test('buildFileRow defaults missing booleans to false and missing тип to стандарт', () => {
    const row = buildFileRow(1, 0, { callsigns: [] }, 1);
    assert.equal(row, '1|0|стандарт|false|false|false||1');
});

// =========================================================================
// processOrder skip paths
// =========================================================================
function makeOrder(overrides = {}) {
    return {
        id: 9999,
        source_id: SOURCE_ID_MODERN_ARMOR,
        status_id: STATUS_ID_VBA_READY,
        custom_fields: [{ uuid: 'OR_1086', value: '[]' }],
        products: [],
        ...overrides,
    };
}

test('processOrder skips orders in SKIP_ORDERS', () => {
    const skipId = [...SKIP_ORDERS][0];
    assert.ok(skipId, 'SKIP_ORDERS must contain at least one id for this test');
    const r = processOrder(makeOrder({ id: skipId }), []);
    assert.match(r.skip_reason, /SKIP_ORDERS/);
});

test('processOrder skips orders with wrong source_id', () => {
    const r = processOrder(makeOrder({ source_id: 43 }), []);
    assert.match(r.skip_reason, /source_id=43/);
});

test('processOrder skips orders without OR_1086', () => {
    const r = processOrder(makeOrder({ custom_fields: [] }), []);
    assert.equal(r.skip_reason, 'no OR_1086');
});

test('processOrder skips orders with empty OR_1086 value', () => {
    const r = processOrder(makeOrder({ custom_fields: [{ uuid: 'OR_1086', value: '' }] }), []);
    assert.equal(r.skip_reason, 'no OR_1086');
});

test('processOrder skips orders with invalid JSON in OR_1086', () => {
    const r = processOrder(makeOrder({ custom_fields: [{ uuid: 'OR_1086', value: '{not-json' }] }), []);
    assert.equal(r.skip_reason, 'OR_1086 parse error');
});

test('processOrder skips OR_1086 that is not an array', () => {
    const r = processOrder(makeOrder({ custom_fields: [{ uuid: 'OR_1086', value: '{"foo":1}' }] }), []);
    assert.equal(r.skip_reason, 'OR_1086 not array');
});

test('processOrder skips orders containing any кастом item', () => {
    const items = [
        { 'тип': 'стандарт', 'логотип': true, 'позивний': false, 'розташування_внизу': false, callsigns: [] },
        { 'тип': 'кастом',    'логотип': false, 'позивний': false, 'розташування_внизу': false, callsigns: [] },
    ];
    const r = processOrder(makeOrder({ custom_fields: [{ uuid: 'OR_1086', value: JSON.stringify(items) }] }), []);
    assert.equal(r.skip_reason, 'has custom items');
});

// =========================================================================
// processOrder happy path (with injected fake copyOrderPrints)
// =========================================================================
test('processOrder happy path produces fileRows/printRows/vizRows', () => {
    const items = [
        { 'тип': 'стандарт', 'логотип': true, 'позивний': true,  'розташування_внизу': true,  callsigns: ['КУМ'] },
        { 'тип': 'стандарт', 'логотип': true, 'позивний': false, 'розташування_внизу': false, callsigns: [] },
    ];
    const order = makeOrder({
        id: 110000,
        custom_fields: [{ uuid: 'OR_1086', value: JSON.stringify(items) }],
        products: [{ quantity: 3 }, { quantity: 1 }],
    });
    const fakeCopy = () => ({
        prints: ['C:/tmp/order_110000/t1__a_1.png', 'C:/tmp/order_110000/t1__a_2.png', 'C:/tmp/order_110000/t2__b.png'],
        vizes:  ['C:/tmp/order_110000/VIZ_main.png'],
    });
    const r = processOrder(order, [], { copyOrderPrints: fakeCopy });

    assert.equal(r.skip_reason, undefined);
    assert.equal(r.items_count, 2);
    assert.equal(r.prints_count, 3);
    assert.equal(r.vizes_count, 1);

    assert.equal(r.fileRows.length, 2);
    assert.equal(r.fileRows[0], '110000|0|стандарт|true|true|true|КУМ|3');
    assert.equal(r.fileRows[1], '110000|1|стандарт|true|false|false||1');

    // Prints are deduped: t1__a_1.png + t1__a_2.png → one entry count=2.
    assert.equal(r.printRows.length, 2);
    assert.ok(r.printRows.some(row => row.endsWith('|2')), 'expected a deduped count=2 entry');
    assert.ok(r.printRows.some(row => row.endsWith('|1')), 'expected a count=1 entry');
    for (const row of r.printRows) assert.match(row, /^110000\|/);

    // Viz rows are 1-indexed.
    assert.equal(r.vizRows.length, 1);
    assert.match(r.vizRows[0], /^110000\|C:\/tmp\/order_110000\/VIZ_main\.png\|1$/);
});

test('processOrder happy path defaults quantity to 1 when products array is short', () => {
    const items = [
        { 'тип': 'стандарт', 'логотип': true, 'позивний': false, 'розташування_внизу': false, callsigns: [] },
    ];
    const order = makeOrder({
        id: 1,
        custom_fields: [{ uuid: 'OR_1086', value: JSON.stringify(items) }],
        products: [],
    });
    const r = processOrder(order, [], { copyOrderPrints: () => ({ prints: [], vizes: [] }) });
    assert.equal(r.fileRows[0].split('|').pop(), '1', 'qty=1 fallback when no matching product');
});
