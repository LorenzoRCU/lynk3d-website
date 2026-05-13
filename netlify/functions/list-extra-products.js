// Netlify Function: list-extra-products
// Public (no auth) — returns the dynamic product list pushed by EtsyManager.
// Consumed by shop.js to merge with the static PRODUCTS catalog.
// Returns [] if no products have been pushed yet.

import { getStore } from '@netlify/blobs';

export default async () => {
    try {
        const store = getStore({ name: 'lynk3d-products', consistency: 'strong' });
        const data = await store.get('products.json', { type: 'json' });
        const products = Array.isArray(data) ? data : (data && Array.isArray(data.products) ? data.products : []);
        return new Response(JSON.stringify(products), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60',
            },
        });
    } catch (e) {
        console.warn('list-extra-products error:', e);
        return new Response('[]', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};
