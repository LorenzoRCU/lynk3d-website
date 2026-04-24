// Netlify Function: create-order
// Receives order + STL (base64), stores STL and order metadata in Netlify Blobs,
// creates a Mollie payment, returns checkout URL.

import { createMollieClient } from '@mollie/api-client';
import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

const MAX_STL_MB = 7; // Netlify Functions v2 accepts ~10MB incl base64

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

    const validation = validatePayload(payload);
    if (validation) return jsonError(validation, 422);

    const apiKey = process.env.MOLLIE_API_KEY;
    if (!apiKey) return jsonError('MOLLIE_API_KEY not configured', 500);

    const orderId = `L3D-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

    // Site URL — Netlify exposes this as URL (production) or DEPLOY_URL (preview)
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || new URL(req.url).origin;

    // Store STL + order metadata in Blobs
    try {
        const stlStore = getStore({ name: 'lynk3d-stl', consistency: 'strong' });
        const orderStore = getStore({ name: 'lynk3d-orders', consistency: 'strong' });

        const stlBuf = Buffer.from(payload.stl.base64, 'base64');
        if (stlBuf.length > MAX_STL_MB * 1024 * 1024) {
            return jsonError(`STL te groot (>${MAX_STL_MB}MB)`, 413);
        }

        await stlStore.set(`${orderId}.stl`, stlBuf, {
            metadata: { filename: payload.stl.filename, sizeBytes: payload.stl.sizeBytes },
        });

        const orderRecord = {
            orderId,
            createdAt: new Date().toISOString(),
            status: 'pending',
            customer: payload.customer,
            config: payload.config,
            analysis: payload.analysis,
            derived: payload.derived,
            price: payload.price,
            stl: { filename: payload.stl.filename, sizeBytes: payload.stl.sizeBytes },
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
        const amountStr = Number(payload.price.totalIncVat).toFixed(2);

        // Mollie requires the webhook to be publicly reachable.
        // On localhost we skip it — the email-on-paid step won't fire locally,
        // but the full upload → checkout → redirect flow can still be tested.
        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(siteUrl);

        const paymentPayload = {
            amount: { currency: 'EUR', value: amountStr },
            description: `LYNK 3D order ${orderId}`,
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

        // Persist Mollie payment id on the order record
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

function validatePayload(p) {
    if (!p || typeof p !== 'object') return 'Ongeldige payload';
    if (!p.customer || !p.customer.name || !p.customer.email || !p.customer.street || !p.customer.zip || !p.customer.city) return 'Klantgegevens ontbreken';
    if (!p.config || !p.config.material || !p.config.quantity) return 'Configuratie ontbreekt';
    if (!p.stl || !p.stl.base64 || !p.stl.filename) return 'STL ontbreekt';
    const ext = p.stl.filename.toLowerCase();
    if (!ext.endsWith('.stl') && !ext.endsWith('.3mf')) return 'Alleen STL en 3MF bestanden zijn toegestaan';
    if (!p.price || typeof p.price.totalIncVat !== 'number' || p.price.totalIncVat <= 0) return 'Prijs ontbreekt of ongeldig';
    if (p.price.totalIncVat < 25) return 'Totaalbedrag lager dan minimum';
    return null;
}

function jsonError(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

