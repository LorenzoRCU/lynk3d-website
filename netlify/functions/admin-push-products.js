// Netlify Function: admin-push-products
// Receives a JSON array of product-objects and stores them in the
// lynk3d-products blob under key 'products.json'. Used by EtsyManager
// to sync Etsy-uploaded concepts AND active Etsy listings to the Lynk3D shop.
// Auth via Authorization: Bearer <ADMIN_BEARER_TOKEN>.
//
// Products may carry an `images: [{filename, base64, content_type}]` array.
// Each image is decoded and stored in the `lynk3d-product-images` blob
// under key `<product_id>/<filename>`. The first image becomes the
// product's `image` URL (served by get-product-image.js).
//
// Idempotency / merge semantics:
//   - Incoming products with the same `id` UPDATE the existing entry.
//   - Existing products NOT in the incoming payload are PRESERVED (so
//     daily Etsy-listings-sync doesn't wipe Etsy-draft products and vice
//     versa). To force a full replace, pass query param ?mode=replace.
//   - If `source === 'etsy_listing'` we additionally dedupe on
//     `etsy_listing_id`: an existing product (regardless of id) with the
//     same etsy_listing_id is updated in-place — id gets normalized to
//     `etsy-<listing_id>`.
//   - If incoming product has no `images` but the existing entry already
//     has an `image` set (uploaded earlier), we KEEP the existing image
//     URL — never blank out a working image.

import { getStore } from '@netlify/blobs';

export default async (req) => {
    if (req.method !== 'POST') {
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

    const url = new URL(req.url);
    const mode = (url.searchParams.get('mode') || 'merge').toLowerCase();
    const deleteIds = (url.searchParams.get('delete') || '').split(',').map(s => s.trim()).filter(Boolean);

    // DELETE flow: ?delete=id1,id2 verwijdert die products uit products.json + hun blobs.
    if (deleteIds.length) {
        const store = getStore({ name: 'lynk3d-products', consistency: 'strong' });
        const imageStore = getStore({ name: 'lynk3d-product-images' });
        let existing = [];
        try {
            const ed = await store.get('products.json', { type: 'json' });
            existing = Array.isArray(ed) ? ed : (ed && Array.isArray(ed.products) ? ed.products : []);
        } catch (e) {
            console.warn('Could not load products.json:', e);
        }
        const before = existing.length;
        const kept = existing.filter(p => !deleteIds.includes(p.id));
        await store.setJSON('products.json', kept);
        let imagesDeleted = 0;
        for (const id of deleteIds) {
            try {
                const { blobs } = await imageStore.list({ prefix: `${id}/` });
                for (const b of (blobs || [])) {
                    await imageStore.delete(b.key);
                    imagesDeleted++;
                }
            } catch (e) {
                console.warn(`Delete blobs voor ${id} faalde:`, e);
            }
        }
        return new Response(JSON.stringify({
            deleted_ids: deleteIds,
            products_before: before,
            products_after: kept.length,
            images_deleted: imagesDeleted,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    let products;
    try {
        products = await req.json();
    } catch {
        return jsonError('Invalid JSON', 400);
    }
    if (!Array.isArray(products)) {
        return jsonError('Body must be a JSON array of products', 422);
    }

    // Light shape validation — accept and clean each product
    const incoming = products
        .filter((p) => p && typeof p === 'object' && p.id && p.name)
        .map((p) => {
            const etsyListingId =
                p.etsy_listing_id != null && !Number.isNaN(Number(p.etsy_listing_id))
                    ? Number(p.etsy_listing_id)
                    : null;
            return {
                id: String(p.id),
                name: String(p.name),
                subtitle: String(p.subtitle || ''),
                price: Number(p.price) || 0,
                image: String(p.image || '/img/lynk3d-product.png'),
                colors: Array.isArray(p.colors) ? p.colors.map(String) : [],
                material: String(p.material || 'PLA'),
                description: String(p.description || ''),
                etsy_url: p.etsy_url ? String(p.etsy_url) : null,
                source: p.source ? String(p.source) : 'draft',
                etsy_listing_id: etsyListingId,
                images: Array.isArray(p.images) ? p.images : [],
            };
        });

    // Persist images into lynk3d-product-images blob store, replace product.image
    let imagesStored = 0;
    let imageErrors = 0;
    let imagesDeleted = 0;
    try {
        const imageStore = getStore({ name: 'lynk3d-product-images' });
        for (const p of incoming) {
            if (!p.images.length) continue;

            // STAP 1: Wis bestaande images voor dit product (uit eerdere syncs / bug-runs)
            // zodat we beginnen met een schone leien voor de nieuwe set.
            try {
                const { blobs } = await imageStore.list({ prefix: `${p.id}/` });
                for (const b of (blobs || [])) {
                    try {
                        await imageStore.delete(b.key);
                        imagesDeleted++;
                    } catch (e) {
                        console.warn(`Delete oude image faalde ${b.key}:`, e);
                    }
                }
            } catch (e) {
                console.warn(`Kon oude images niet listen voor ${p.id}:`, e);
            }

            let firstUrl = null;
            for (const img of p.images) {
                if (!img || typeof img !== 'object') continue;
                const filename = String(img.filename || '').trim();
                const b64 = String(img.base64 || '');
                if (!filename || !b64) continue;
                if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                    console.warn('Skip unsafe image filename:', filename);
                    imageErrors++;
                    continue;
                }
                try {
                    const buffer = Buffer.from(b64, 'base64');
                    const contentType = String(img.content_type || 'image/jpeg');
                    const key = `${p.id}/${filename}`;
                    await imageStore.set(key, buffer, { metadata: { content_type: contentType } });
                    imagesStored++;
                    if (!firstUrl) {
                        firstUrl = `/.netlify/functions/get-product-image?id=${encodeURIComponent(p.id)}&file=${encodeURIComponent(filename)}`;
                    }
                } catch (e) {
                    console.error(`Image store error for ${p.id}/${filename}:`, e);
                    imageErrors++;
                }
            }
            if (firstUrl) p.image = firstUrl;
        }
    } catch (e) {
        console.error('Image store init error:', e);
    }

    // Strip the `images` payload before persisting products.json (keep blob small)
    const incomingCleaned = incoming.map(({ images, ...rest }) => rest);

    // Load existing products and merge (unless mode=replace)
    const store = getStore({ name: 'lynk3d-products', consistency: 'strong' });
    let existing = [];
    try {
        const existingData = await store.get('products.json', { type: 'json' });
        existing = Array.isArray(existingData)
            ? existingData
            : (existingData && Array.isArray(existingData.products) ? existingData.products : []);
    } catch (e) {
        console.warn('Could not load existing products.json — assuming empty:', e);
    }

    let merged;
    if (mode === 'replace') {
        merged = incomingCleaned;
    } else {
        // Build lookup maps for existing
        const byId = new Map();
        const byEtsy = new Map();
        for (const p of existing) {
            if (!p || !p.id) continue;
            byId.set(p.id, p);
            if (p.etsy_listing_id != null) byEtsy.set(Number(p.etsy_listing_id), p);
        }

        // Apply each incoming update
        for (const inc of incomingCleaned) {
            // Resolve which existing entry (if any) this incoming maps onto
            let prev = null;
            if (inc.source === 'etsy_listing' && inc.etsy_listing_id != null) {
                prev = byEtsy.get(inc.etsy_listing_id) || byId.get(inc.id);
            } else {
                prev = byId.get(inc.id);
            }
            if (prev) {
                // If incoming has no fresh image and existing already had one,
                // keep the existing image URL (do not blank-out).
                if (
                    (!inc.image || inc.image === '/img/lynk3d-product.png') &&
                    prev.image &&
                    prev.image !== '/img/lynk3d-product.png'
                ) {
                    inc.image = prev.image;
                }
                // Replace the prev entry in-place
                byId.delete(prev.id);
                if (prev.etsy_listing_id != null) byEtsy.delete(Number(prev.etsy_listing_id));
            }
            byId.set(inc.id, inc);
            if (inc.etsy_listing_id != null) byEtsy.set(inc.etsy_listing_id, inc);
        }
        merged = Array.from(byId.values());
    }

    try {
        await store.setJSON('products.json', {
            updatedAt: new Date().toISOString(),
            products: merged,
        });
    } catch (e) {
        console.error('Blob write error:', e);
        return jsonError('Failed to write products: ' + e.message, 500);
    }

    return new Response(
        JSON.stringify({
            mode,
            received: incomingCleaned.length,
            total: merged.length,
            images_stored: imagesStored,
            image_errors: imageErrors,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
};

function jsonError(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
