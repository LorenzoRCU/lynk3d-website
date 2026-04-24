// Netlify Function: create-product-order
// Receives a shop-product order (no STL), stores it in Netlify Blobs,
// creates a Mollie payment, returns checkout URL.

import { createMollieClient } from '@mollie/api-client';
import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

export default async (req) => {
    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    let payload;
    try { payload = await req.json(); } catch { return jsonError('Invalid JSON', 400); }

    const validation = validatePayload(payload);
    if (validation) return jsonError(validation, 422);

    const apiKey = process.env.MOLLIE_API_KEY;
    if (!apiKey) return jsonError('MOLLIE_API_KEY not configured', 500);

    const orderId = `L3D-P-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || new URL(req.url).origin;

    // Persist order metadata
    try {
        const orderStore = getStore({ name: 'lynk3d-orders', consistency: 'strong' });
        const record = {
            orderId,
            type: 'product',
            createdAt: new Date().toISOString(),
            status: 'pending',
            customer: payload.customer,
            config: payload.config,
            product: payload.product,
            price: payload.price,
        };
        await orderStore.setJSON(`${orderId}.json`, record);
    } catch (e) {
        console.error('Blob storage error:', e);
        return jsonError('Kon bestelling niet opslaan: ' + e.message, 500);
    }

    // Create Mollie payment
    let checkoutUrl;
    try {
        const mollie = createMollieClient({ apiKey });
        const amountStr = Number(payload.price.totalIncVat).toFixed(2);

        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(siteUrl);

        const paymentPayload = {
            amount: { currency: 'EUR', value: amountStr },
            description: `LYNK 3D shop ${orderId} — ${payload.product.name}`,
            redirectUrl: `${siteUrl}/bedankt.html?order=${encodeURIComponent(orderId)}`,
            metadata: { orderId },
            locale: 'nl_NL',
        };
        if (!isLocal) {
            paymentPayload.webhookUrl = `${siteUrl}/.netlify/functions/mollie-webhook`;
        } else {
            console.log(`[create-product-order] skipping webhookUrl for localhost (${siteUrl})`);
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

function validatePayload(p) {
    if (!p || typeof p !== 'object') return 'Ongeldige payload';
    if (p.type !== 'product') return 'Ongeldig order-type';
    if (!p.product || !p.product.id || !p.product.name) return 'Product ontbreekt';
    if (!p.customer || !p.customer.name || !p.customer.email || !p.customer.street || !p.customer.zip || !p.customer.city) return 'Klantgegevens ontbreken';
    if (!p.config || !p.config.color || !p.config.quantity) return 'Configuratie ontbreekt';
    if (!p.price || typeof p.price.totalIncVat !== 'number' || p.price.totalIncVat <= 0) return 'Prijs ontbreekt of ongeldig';
    return null;
}

function jsonError(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
