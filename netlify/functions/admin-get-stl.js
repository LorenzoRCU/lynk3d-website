// Netlify Function: admin-get-stl
// Streams a single STL blob from the `lynk3d-stl` store as a download.
// Auth via Authorization: Bearer <ADMIN_BEARER_TOKEN>.
//
// Query: ?key=<blobKey>   (e.g. L3D-MPNV45QX-FA9665-0.stl)
// Optional: ?filename=<...>  (overrides Content-Disposition filename)
//
// Used by EtsyManager to fetch customer-uploaded STLs from site orders.

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

    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    if (!key) {
        return jsonError('Missing ?key=<blobKey>', 400);
    }
    // Basic safety: only allow our naming pattern (orderId-<index>.stl)
    if (!/^[A-Za-z0-9_\-]+\.stl$/.test(key)) {
        return jsonError('Invalid key format', 400);
    }

    try {
        const store = getStore({ name: 'lynk3d-stl', consistency: 'strong' });
        // Use { type: 'arrayBuffer' } so we get raw bytes regardless of how it was stored.
        const buf = await store.get(key, { type: 'arrayBuffer' });
        if (!buf) {
            return jsonError(`Blob "${key}" not found`, 404);
        }

        // Try to recover original filename from metadata for the download name.
        let downloadName = url.searchParams.get('filename') || key;
        try {
            const meta = await store.getMetadata(key);
            if (meta && meta.metadata && meta.metadata.filename) {
                downloadName = url.searchParams.get('filename') || meta.metadata.filename;
            }
        } catch {
            // metadata is best-effort
        }

        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': 'application/sla',
                'Content-Length': String(buf.byteLength),
                'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`,
                'Cache-Control': 'private, no-store',
            },
        });
    } catch (e) {
        console.error('admin-get-stl error:', e);
        return jsonError('Failed to read STL: ' + e.message, 500);
    }
};

function jsonError(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
