// Netlify Function: admin-list-orders
// Returns all orders from the lynk3d-orders blob store as JSON.
// Auth via Authorization: Bearer <ADMIN_BEARER_TOKEN>.
// Used by EtsyManager backend to enrich its local orders table with
// the shipping addresses that live in Netlify Blobs (not in Mollie).

import { getStore } from '@netlify/blobs';

export default async (req) => {
    if (req.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
    }

    const expected = process.env.ADMIN_BEARER_TOKEN;
    if (!expected) {
        return jsonError('ADMIN_BEARER_TOKEN not configured', 500);
    }
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${expected}`) {
        return jsonError('Unauthorized', 401);
    }

    let orders;
    try {
        const store = getStore({ name: 'lynk3d-orders', consistency: 'strong' });
        const { blobs } = await store.list();
        orders = await Promise.all(
            blobs.map(async (b) => {
                try {
                    const o = await store.get(b.key, { type: 'json' });
                    if (!o) return null;
                    const c = o.customer || {};
                    // For multi-item STL orders: expose totalItems + a compact items[] slice
                    // (without base64 STL blobs). Legacy orders only have `stl` — leave items[]
                    // empty so consumers can still detect "single-file" by stl !== null.
                    const items = Array.isArray(o.items)
                        ? o.items.map(it => ({
                            filename: it.filename,
                            sizeBytes: it.sizeBytes,
                            material: it.material,
                            color: it.color,
                            infill: it.infill,
                            quantity: it.quantity,
                            analysis: it.analysis,
                            derived: it.derived,
                            price: it.price,
                            blobKey: it.stl && it.stl.blobKey,
                        }))
                        : [];

                    return {
                        order_id: o.orderId,
                        type: o.type || 'stl',
                        status: o.status,
                        createdAt: o.createdAt,
                        paidAt: o.paidAt,
                        molliePaymentId: o.molliePaymentId,
                        molliePaymentStatus: o.molliePaymentStatus,
                        amount: o.amount,
                        price: o.price,
                        product: o.product || null,
                        // STL-order specific:
                        items,
                        totalItems: o.totalItems != null ? o.totalItems : (items.length || (o.stl ? 1 : 0)),
                        stl: o.stl || null, // legacy single-file ref
                        config: o.config || null, // legacy mirror
                        shipping: o.shipping || null,
                        customer: {
                            firstName: c.firstName || '',
                            lastName: c.lastName || '',
                            name: c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
                            email: c.email || '',
                            phone: c.phone || '',
                            street: c.street || '',
                            zip: c.zip || '',
                            city: c.city || '',
                            country: c.country || '',
                            notes: c.notes || '',
                        },
                    };
                } catch (e) {
                    console.warn(`Failed to read blob ${b.key}:`, e);
                    return null;
                }
            }),
        );
        orders = orders.filter(Boolean);
    } catch (e) {
        console.error('Blob list error:', e);
        return jsonError('Failed to list orders: ' + e.message, 500);
    }

    return new Response(JSON.stringify(orders), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
};

function jsonError(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
