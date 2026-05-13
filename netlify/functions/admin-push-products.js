// Netlify Function: admin-push-products
// Receives a JSON array of product-objects and stores them in the
// lynk3d-products blob under key 'products.json'. Used by EtsyManager
// to sync Etsy-uploaded concepts to the Lynk3D shop.
// Auth via Authorization: Bearer <ADMIN_BEARER_TOKEN>.
//
// Products may carry an `images: [{filename, base64, content_type}]` array.
// Each image is decoded and stored in the `lynk3d-product-images` blob
// under key `<product_id>/<filename>`. The first image becomes the
// product's `image` URL (served by get-product-image.js).

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
    const baseProducts = products
        .filter((p) => p && typeof p === 'object' && p.id && p.name)
        .map((p) => ({
            id: String(p.id),
            name: String(p.name),
            subtitle: String(p.subtitle || ''),
            price: Number(p.price) || 0,
            image: String(p.image || '/img/lynk3d-product.png'),
            colors: Array.isArray(p.colors) ? p.colors.map(String) : [],
            material: String(p.material || 'PLA'),
            description: String(p.description || ''),
            etsy_url: p.etsy_url ? String(p.etsy_url) : null,
            images: Array.isArray(p.images) ? p.images : [],
        }));

    // Persist images into lynk3d-product-images blob store, replace product.image
    let imagesStored = 0;
    let imageErrors = 0;
    try {
        const imageStore = getStore({ name: 'lynk3d-product-images' });
        for (const p of baseProducts) {
            if (!p.images.length) continue;
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
    const cleaned = baseProducts.map(({ images, ...rest }) => rest);

    try {
        const store = getStore({ name: 'lynk3d-products', consistency: 'strong' });
        await store.setJSON('products.json', {
            updatedAt: new Date().toISOString(),
            products: cleaned,
        });
    } catch (e) {
        console.error('Blob write error:', e);
        return jsonError('Failed to write products: ' + e.message, 500);
    }

    return new Response(
        JSON.stringify({ stored: cleaned.length, images_stored: imagesStored, image_errors: imageErrors }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
};

function jsonError(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
