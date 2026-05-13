// Netlify Function: get-product-image
// Public (no auth) GET endpoint that serves product images persisted by
// admin-push-products into the `lynk3d-product-images` blob store.
// URL: /.netlify/functions/get-product-image?id=<product_id>&file=<filename>

import { getStore } from '@netlify/blobs';

export default async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(req.url);
    const id = (url.searchParams.get('id') || '').trim();
    const file = (url.searchParams.get('file') || '').trim();

    if (!id || !file) {
        return new Response('Missing id or file', { status: 400 });
    }
    // Path-traversal defence — same rules as admin-push-products write side
    if (
        id.includes('..') || id.includes('/') || id.includes('\\') ||
        file.includes('..') || file.includes('/') || file.includes('\\')
    ) {
        return new Response('Invalid path', { status: 400 });
    }

    try {
        const store = getStore({ name: 'lynk3d-product-images' });
        const key = `${id}/${file}`;
        const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });
        if (!result || !result.data) {
            return new Response('Not found', { status: 404 });
        }
        const contentType =
            (result.metadata && result.metadata.content_type) || guessContentType(file);
        return new Response(result.data, {
            status: 200,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400',
            },
        });
    } catch (e) {
        console.warn('get-product-image error:', e);
        return new Response('Not found', { status: 404 });
    }
};

function guessContentType(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
}
