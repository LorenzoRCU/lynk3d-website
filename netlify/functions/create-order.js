// Netlify Function: create-order
// Receives an order with one OR MORE STL/3MF files (base64-gzipped), stores them
// in Netlify Blobs, creates a Mollie payment, returns checkout URL.
//
// Supports two payload shapes:
//  - NEW multi-file: { customer, items: [...], shipping, price }
//  - LEGACY single-file: { customer, config, analysis, derived, price, stl }
// Both normalize to the same on-disk `items[]` structure.

import { createMollieClient } from '@mollie/api-client';
import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const MAX_STL_MB = 30; // per-file, post-decompression
const MAX_TOTAL_MB = 80; // sum of decompressed STL bytes
const MAX_ITEMS = 20;

export default async (req, context) => {
    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    let payload;
    try {
        payload = await req.json();
    } catch {
        return new Response('Invalid JSON', { status: 400 });
    }

    // Normalize legacy single-STL payload to multi-item shape
    let normalized;
    try {
        normalized = normalizePayload(payload);
    } catch (e) {
        return jsonError(e.message || 'Ongeldige payload', 422);
    }

    const validation = validateNormalized(normalized);
    if (validation) return jsonError(validation, 422);

    const apiKey = process.env.MOLLIE_API_KEY;
    if (!apiKey) return jsonError('MOLLIE_API_KEY not configured', 500);

    const orderId = `L3D-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

    // Site URL — Netlify exposes this as URL (production) or DEPLOY_URL (preview)
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || new URL(req.url).origin;

    // Store each STL + order metadata in Blobs
    let storedItems;
    try {
        const stlStore = getStore({ name: 'lynk3d-stl', consistency: 'strong' });
        const orderStore = getStore({ name: 'lynk3d-orders', consistency: 'strong' });

        storedItems = [];
        let totalDecompressedBytes = 0;

        for (let i = 0; i < normalized.items.length; i++) {
            const it = normalized.items[i];

            let stlBuf = Buffer.from(it.base64, 'base64');
            if (it.encoding === 'gzip') {
                try {
                    stlBuf = gunzipSync(stlBuf);
                } catch (e) {
                    return jsonError(`Kon bestand "${it.filename}" niet uitpakken (gzip): ${e.message}`, 422);
                }
            }
            if (stlBuf.length > MAX_STL_MB * 1024 * 1024) {
                return jsonError(`Bestand "${it.filename}" te groot (>${MAX_STL_MB}MB)`, 413);
            }
            totalDecompressedBytes += stlBuf.length;
            if (totalDecompressedBytes > MAX_TOTAL_MB * 1024 * 1024) {
                return jsonError(`Totale bestandsgrootte te groot (>${MAX_TOTAL_MB}MB)`, 413);
            }

            const blobKey = `${orderId}-${i}.stl`;
            await stlStore.set(blobKey, stlBuf, {
                metadata: { filename: it.filename, sizeBytes: it.sizeBytes, orderId, itemIndex: i },
            });

            storedItems.push({
                index: i,
                filename: it.filename,
                sizeBytes: it.sizeBytes,
                material: it.material,
                color: it.color,
                infill: it.infill,
                quantity: it.quantity,
                analysis: it.analysis,
                derived: it.derived,
                price: it.price,
                stl: { filename: it.filename, blobKey, sizeBytes: it.sizeBytes },
            });
        }

        const orderRecord = {
            orderId,
            createdAt: new Date().toISOString(),
            status: 'pending',
            type: 'stl',
            customer: normalized.customer,
            items: storedItems,
            totalItems: storedItems.length,
            shipping: normalized.shipping,
            price: normalized.price,

            // Back-compat top-level fields for legacy consumers (EtsyManager etc.):
            // mirror the first item's config + a flat `stl` ref so old code keeps working.
            config: storedItems.length > 0 ? {
                material: storedItems[0].material,
                color: storedItems[0].color,
                infill: storedItems[0].infill,
                quantity: storedItems.reduce((s, it) => s + it.quantity, 0),
                shippingZone: normalized.shipping.zone,
            } : null,
            stl: storedItems.length > 0 ? {
                filename: storedItems[0].filename,
                sizeBytes: storedItems[0].sizeBytes,
                blobKey: storedItems[0].stl.blobKey,
            } : null,
        };
        await orderStore.setJSON(`${orderId}.json`, orderRecord);
    } catch (e) {
        console.error('Blob storage error:', e);
        return jsonError('Kon bestelling niet opslaan: ' + e.message, 500);
    }

    // Create Mollie payment
    let checkoutUrl;
    try {
        const mollie = createMollieClient({ apiKey });
        const amountStr = Number(normalized.price.totalIncVat).toFixed(2);

        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(siteUrl);

        const itemCount = storedItems.length;
        const description = itemCount === 1
            ? `LYNK 3D order ${orderId}`
            : `LYNK 3D order ${orderId} (${itemCount} bestanden)`;

        const paymentPayload = {
            amount: { currency: 'EUR', value: amountStr },
            description,
            redirectUrl: `${siteUrl}/bedankt.html?order=${encodeURIComponent(orderId)}`,
            metadata: { orderId },
            locale: 'nl_NL',
        };
        if (!isLocal) {
            paymentPayload.webhookUrl = `${siteUrl}/.netlify/functions/mollie-webhook`;
        } else {
            console.log(`[create-order] skipping webhookUrl for localhost (${siteUrl})`);
        }

        const payment = await mollie.payments.create(paymentPayload);

        checkoutUrl = payment.getCheckoutUrl();

        const orderStore = getStore({ name: 'lynk3d-orders', consistency: 'strong' });
        const existing = await orderStore.get(`${orderId}.json`, { type: 'json' });
        if (existing) {
            existing.molliePaymentId = payment.id;
            existing.amount = amountStr;
            await orderStore.setJSON(`${orderId}.json`, existing);
        }
    } catch (e) {
        console.error('Mollie error:', e);
        return jsonError('Betaalprovider fout: ' + (e.message || 'unknown'), 502);
    }

    return new Response(JSON.stringify({ orderId, checkoutUrl }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
};

// ---------- Normalization ----------
function normalizePayload(p) {
    if (!p || typeof p !== 'object') throw new Error('Ongeldige payload');

    // Detect shape: new multi-file has `items[]`; legacy single has `stl`
    if (Array.isArray(p.items) && p.items.length > 0) {
        if (p.items.length > MAX_ITEMS) {
            throw new Error(`Maximum ${MAX_ITEMS} bestanden per bestelling`);
        }
        return {
            customer: p.customer,
            items: p.items.map(it => ({
                filename: it.filename,
                sizeBytes: it.sizeBytes,
                base64: it.base64,
                encoding: it.encoding || 'gzip',
                material: it.material,
                color: it.color,
                infill: it.infill,
                quantity: it.quantity,
                analysis: it.analysis || {},
                derived: it.derived || {},
                price: it.price || {},
            })),
            shipping: p.shipping || { zone: (p.customer && p.customer.country) || 'NL', cost: 0 },
            price: p.price || {},
        };
    }

    // Legacy: single STL
    if (p.stl && p.stl.base64 && p.config) {
        const it = {
            filename: p.stl.filename,
            sizeBytes: p.stl.sizeBytes,
            base64: p.stl.base64,
            encoding: p.stl.encoding || 'gzip',
            material: p.config.material,
            color: p.config.color,
            infill: p.config.infill,
            quantity: p.config.quantity,
            analysis: p.analysis || {},
            derived: p.derived || {},
            price: {
                perUnitIncVat: p.price && p.price.totalIncVat && p.config.quantity
                    ? +(p.price.subtotalIncVat || p.price.totalIncVat) / p.config.quantity
                    : 0,
                itemSubtotalIncVat: p.price ? (p.price.subtotalIncVat ?? (p.price.totalIncVat - (p.price.shipping || 0))) : 0,
                breakdown: (p.price && p.price.breakdown) || {},
            },
        };
        return {
            customer: p.customer,
            items: [it],
            shipping: { zone: (p.config && p.config.shippingZone) || (p.customer && p.customer.country) || 'NL', cost: p.price ? (p.price.shipping || 0) : 0 },
            price: {
                subtotalNativeExVat: p.price ? p.price.subtotal : 0,
                itemsSubtotalNativeIncVat: p.price ? (p.price.subtotalIncVat ?? (p.price.totalIncVat - (p.price.shipping || 0))) : 0,
                minimumApplied: 0,
                subtotalIncVat: p.price ? (p.price.subtotalIncVat ?? (p.price.totalIncVat - (p.price.shipping || 0))) : 0,
                subtotalExVat: p.price ? p.price.subtotal : 0,
                vat: p.price ? p.price.vat : 0,
                shipping: p.price ? (p.price.shipping || 0) : 0,
                totalIncVat: p.price ? p.price.totalIncVat : 0,
            },
        };
    }

    throw new Error('Payload mist `items[]` of legacy `stl` veld');
}

function validateNormalized(p) {
    if (!p.customer || !p.customer.email || !p.customer.street || !p.customer.zip || !p.customer.city) return 'Klantgegevens ontbreken';
    if (!p.customer.name && !(p.customer.firstName || p.customer.lastName)) return 'Naam ontbreekt';
    if (!Array.isArray(p.items) || p.items.length === 0) return 'Geen bestanden in bestelling';
    for (const it of p.items) {
        if (!it.filename || !it.base64) return 'Bestand mist filename of inhoud';
        const ext = it.filename.toLowerCase();
        if (!ext.endsWith('.stl') && !ext.endsWith('.3mf')) return `Bestand "${it.filename}": alleen STL en 3MF worden ondersteund`;
        if (!it.material || !FILAMENT_NAMES.has(it.material)) return `Bestand "${it.filename}": onbekend materiaal`;
        if (!it.quantity || it.quantity < 1) return `Bestand "${it.filename}": ongeldige hoeveelheid`;
    }
    if (!p.price || typeof p.price.totalIncVat !== 'number' || p.price.totalIncVat <= 0) return 'Prijs ontbreekt of ongeldig';
    if (p.price.totalIncVat < 25) return 'Totaalbedrag lager dan minimum (€25)';
    return null;
}

const FILAMENT_NAMES = new Set([
    'PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'Wood PLA', 'Carbon PLA', 'Nylon', 'PC',
]);

function jsonError(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
