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

        // Annoteer elke product met alle image-filenames uit de lynk3d-product-images store
        // zodat de shop-modal een carousel kan renderen.
        try {
            const imgStore = getStore({ name: 'lynk3d-product-images' });
            const { blobs } = await imgStore.list();
            const byProduct = new Map();
            for (const b of (blobs || [])) {
                const key = b.key || '';
                const idx = key.indexOf('/');
                if (idx <= 0) continue;
                const pid = key.slice(0, idx);
                const filename = key.slice(idx + 1);
                if (!filename) continue;
                if (!byProduct.has(pid)) byProduct.set(pid, []);
                byProduct.get(pid).push(filename);
            }
            for (const p of products) {
                let files = (byProduct.get(p.id) || []).sort();
                // 1. Filter Etsy avatars/profile/stickers
                files = files.filter(f =>
                    !/_iusa_/.test(f) && !/_iap_/.test(f) && !/_isla_/.test(f)
                );
                // 2. Bij Etsy listing-images: prefereer fullxfull boven 794xN/cropped.
                //    Dedup op de Etsy fingerprint (NNNNN_xxxx) — neem fullxfull als die er is.
                const byFingerprint = new Map();
                for (const f of files) {
                    const m = f.match(/(\d{6,})_([a-z0-9]+)\./i);
                    const fp = m ? `${m[1]}_${m[2]}` : f;
                    const existing = byFingerprint.get(fp);
                    if (!existing) {
                        byFingerprint.set(fp, f);
                    } else if (/fullxfull/.test(f) && !/fullxfull/.test(existing)) {
                        byFingerprint.set(fp, f);  // upgrade naar fullxfull
                    }
                }
                files = Array.from(byFingerprint.values()).sort();
                p.image_files = files;
                p.images = files.map(f =>
                    `/.netlify/functions/get-product-image?id=${encodeURIComponent(p.id)}&file=${encodeURIComponent(f)}`
                );
            }
        } catch (e) {
            console.warn('Could not enumerate image files:', e);
        }

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
