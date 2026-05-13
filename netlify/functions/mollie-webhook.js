// Netlify Function: mollie-webhook
// Receives Mollie payment status updates. On "paid", emails order + STL attachment
// to info@cvlsolutions.nl via Microsoft Graph API and marks the order as paid.

import { createMollieClient } from '@mollie/api-client';
import { getStore } from '@netlify/blobs';

export default async (req, context) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    // Mollie posts "id=tr_xxx" as form-urlencoded
    let paymentId;
    try {
        const contentType = req.headers.get('content-type') || '';
        if (contentType.includes('application/x-www-form-urlencoded')) {
            const text = await req.text();
            const params = new URLSearchParams(text);
            paymentId = params.get('id');
        } else if (contentType.includes('application/json')) {
            const body = await req.json();
            paymentId = body.id;
        }
    } catch (e) {
        console.error('Body parse error:', e);
    }

    if (!paymentId) return new Response('Missing payment id', { status: 400 });

    const apiKey = process.env.MOLLIE_API_KEY;
    if (!apiKey) return new Response('MOLLIE_API_KEY not configured', { status: 500 });

    let payment;
    try {
        const mollie = createMollieClient({ apiKey });
        payment = await mollie.payments.get(paymentId);
    } catch (e) {
        console.error('Mollie fetch error:', e);
        return new Response('Mollie lookup failed', { status: 502 });
    }

    const orderId = payment.metadata && payment.metadata.orderId;
    if (!orderId) {
        console.warn(`No orderId in metadata for payment ${paymentId}`);
        return new Response('ok', { status: 200 }); // ack to Mollie anyway
    }

    const orderStore = getStore({ name: 'lynk3d-orders', consistency: 'strong' });
    const stlStore = getStore({ name: 'lynk3d-stl', consistency: 'strong' });

    const order = await orderStore.get(`${orderId}.json`, { type: 'json' });
    if (!order) {
        console.warn(`Order ${orderId} not found in store`);
        return new Response('ok', { status: 200 });
    }

    // Update status based on Mollie state
    order.molliePaymentId = paymentId;
    order.molliePaymentStatus = payment.status;
    order.updatedAt = new Date().toISOString();

    if (payment.status === 'paid' && order.status !== 'paid') {
        order.status = 'paid';
        order.paidAt = new Date().toISOString();

        // Email (non-blocking failures)
        try {
            if (order.type === 'product') {
                await sendProductOrderEmail(order);
            } else {
                // Multi-item or legacy single-file? Pull all STL blobs and attach them.
                const stlAttachments = await loadStlAttachments(order, stlStore);
                await sendOrderEmail(order, stlAttachments);
            }
            order.emailSent = true;
        } catch (e) {
            console.error(`Email send failed for ${orderId}:`, e);
            order.emailError = String(e.message || e);
        }

        // Telegram push (non-blocking — runs independent of email success)
        try {
            await sendTelegramAlert(order);
            order.telegramSent = true;
        } catch (e) {
            console.error(`Telegram push failed for ${orderId}:`, e);
            order.telegramError = String(e.message || e);
        }
    } else if (['failed', 'canceled', 'expired'].includes(payment.status)) {
        order.status = payment.status;
    }

    await orderStore.setJSON(`${orderId}.json`, order);

    return new Response('ok', { status: 200 });
};

// ---------- Mail via Microsoft Graph (reuses BIM LYNK's Azure app registration) ----------
async function getGraphToken() {
    const tenant = process.env.GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID;
    const clientSecret = process.env.GRAPH_CLIENT_SECRET;
    if (!tenant || !clientId || !clientSecret) {
        throw new Error('GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET ontbreken');
    }
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials',
        }),
    });
    if (!tokenRes.ok) throw new Error('Graph token fetch failed: ' + await tokenRes.text());
    return (await tokenRes.json()).access_token;
}

async function sendViaRelay(subject, html, { to, replyTo, attachments } = {}) {
    const sender = process.env.GRAPH_SENDER_EMAIL || 'info@bimlynk.com';
    const recipient = to || process.env.NOTIFICATION_EMAIL || 'info@cvlsolutions.nl';
    const toList = Array.isArray(recipient) ? recipient : [recipient];

    const token = await getGraphToken();

    const message = {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: toList.map(addr => ({ emailAddress: { address: addr } })),
    };
    if (replyTo) {
        const r = typeof replyTo === 'string' ? { address: replyTo } : replyTo;
        message.replyTo = [{ emailAddress: r }];
    }
    if (Array.isArray(attachments) && attachments.length) {
        message.attachments = attachments.map(a => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.name,
            contentType: a.contentType || 'application/octet-stream',
            contentBytes: a.contentBase64,
        }));
    }

    const sendRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, saveToSentItems: 'true' }),
        },
    );
    if (!sendRes.ok) {
        const errText = await sendRes.text();
        throw new Error(`Graph sendMail failed (${sendRes.status}): ${errText.slice(0, 300)}`);
    }
}

// ---------- Load STL attachments for an order ----------
// Returns an array of { name, contentType, contentBase64 }, supporting both
// new multi-item orders (items[].stl.blobKey) and legacy single-file orders
// (one STL stored as `{orderId}.stl`).
async function loadStlAttachments(order, stlStore) {
    const attachments = [];

    // Determine item list (normalize legacy → items[])
    const items = Array.isArray(order.items) && order.items.length
        ? order.items
        : (order.stl
            ? [{
                filename: order.stl.filename,
                sizeBytes: order.stl.sizeBytes,
                stl: { filename: order.stl.filename, blobKey: order.stl.blobKey || `${order.orderId}.stl`, sizeBytes: order.stl.sizeBytes },
            }]
            : []);

    for (const it of items) {
        const blobKey = (it.stl && it.stl.blobKey) || `${order.orderId}.stl`;
        try {
            const buf = await stlStore.get(blobKey, { type: 'arrayBuffer' });
            if (!buf) {
                console.warn(`[email] STL blob missing: ${blobKey}`);
                continue;
            }
            attachments.push({
                name: it.filename || (it.stl && it.stl.filename) || blobKey,
                contentType: (it.filename || '').toLowerCase().endsWith('.3mf')
                    ? 'application/vnd.ms-3mfdocument'
                    : 'application/vnd.ms-pki.stl',
                contentBase64: Buffer.from(buf).toString('base64'),
            });
        } catch (e) {
            console.warn(`[email] failed to load blob ${blobKey}:`, e);
        }
    }
    return attachments;
}

// ---------- STL calculator order email (multi-item) ----------
async function sendOrderEmail(order, stlAttachments) {
    const recipient = process.env.NOTIFICATION_EMAIL || 'info@cvlsolutions.nl';
    const c = order.customer;
    const p = order.price || {};
    const euro = (n) => '€' + Number(n || 0).toFixed(2).replace('.', ',');

    // Normalize items list (legacy single-file orders → wrap into items[])
    const items = Array.isArray(order.items) && order.items.length
        ? order.items
        : (order.stl ? [{
            filename: order.stl.filename,
            sizeBytes: order.stl.sizeBytes,
            material: order.config && order.config.material,
            color: order.config && order.config.color,
            infill: order.config && order.config.infill,
            quantity: order.config && order.config.quantity,
            analysis: order.analysis || {},
            derived: order.derived || {},
            price: {
                perUnitIncVat: order.price && order.config
                    ? (order.price.subtotalIncVat || order.price.totalIncVat) / Math.max(order.config.quantity || 1, 1)
                    : 0,
                itemSubtotalIncVat: order.price ? (order.price.subtotalIncVat ?? (order.price.totalIncVat - (order.price.shipping || 0))) : 0,
                breakdown: order.price && order.price.breakdown || {},
            },
        }] : []);

    const totalUnits = items.reduce((s, it) => s + (it.quantity || 0), 0);
    const totalWeightG = items.reduce((s, it) => s + ((it.derived && it.derived.weightG ? it.derived.weightG : 0) * (it.quantity || 1)), 0);
    const totalPrintHours = items.reduce((s, it) => s + ((it.derived && it.derived.printHours ? it.derived.printHours : 0) * (it.quantity || 1)), 0);

    const itemRows = items.map((it, idx) => {
        const a = it.analysis || {};
        const d = it.derived || {};
        const ip = it.price || {};
        const dims = a.dims ? `${a.dims.x} × ${a.dims.y} × ${a.dims.z} mm` : '–';
        return `
            <tr>
                <td style="padding:6px 8px; border-bottom:1px solid #eee;">${idx + 1}</td>
                <td style="padding:6px 8px; border-bottom:1px solid #eee;">
                    <b>${esc(it.filename)}</b>
                    <div style="color:#888; font-size:0.85em;">${a.volumeCm3 != null ? a.volumeCm3 + ' cm³' : ''} ${dims !== '–' ? '· ' + dims : ''}</div>
                </td>
                <td style="padding:6px 8px; border-bottom:1px solid #eee;">${esc(it.material || '')}</td>
                <td style="padding:6px 8px; border-bottom:1px solid #eee;">${esc(it.color || '')}</td>
                <td style="padding:6px 8px; border-bottom:1px solid #eee;">${it.infill != null ? Math.round(it.infill * 100) + '%' : ''}</td>
                <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right;">${it.quantity || 1}×</td>
                <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right;">${d.weightG != null ? d.weightG + ' g' : '–'}</td>
                <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right;">${ip.perUnitIncVat != null ? euro(ip.perUnitIncVat) : '–'}</td>
                <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right;"><b>${ip.itemSubtotalIncVat != null ? euro(ip.itemSubtotalIncVat) : '–'}</b></td>
            </tr>`;
    }).join('');

    // Internal breakdown (sum across items)
    const totalMaterialCost = items.reduce((s, it) => s + ((it.price && it.price.breakdown && it.price.breakdown.materialCost) || 0) * (it.quantity || 1), 0);
    const totalPrintCost = items.reduce((s, it) => s + ((it.price && it.price.breakdown && it.price.breakdown.printCost) || 0) * (it.quantity || 1), 0);
    const marginPct = (items[0] && items[0].price && items[0].price.breakdown && items[0].price.breakdown.marginPct) || 0.5;

    const minRow = (p.minimumApplied && p.minimumApplied > 0.005)
        ? `<tr><td>Minimum &euro;25 aanvulling</td><td style="text-align:right;">+${euro(p.minimumApplied)}</td></tr>`
        : '';

    // For legacy orders without `subtotalExVat`, fall back to `subtotal`
    const subEx = p.subtotalExVat != null ? p.subtotalExVat : (p.subtotal != null ? p.subtotal : 0);
    const vat = p.vat || 0;
    const shipping = p.shipping || 0;
    const totalIncVat = p.totalIncVat || 0;

    const htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #1C1C1E; max-width: 760px;">
            <h2 style="color: #20433e;">Nieuwe 3D-print bestelling (${items.length} bestand${items.length === 1 ? '' : 'en'})</h2>
            <p><b>Ordernummer:</b> ${order.orderId}<br>
               <b>Besteld op:</b> ${new Date(order.createdAt).toLocaleString('nl-NL')}<br>
               <b>Betaald op:</b> ${new Date(order.paidAt).toLocaleString('nl-NL')}<br>
               <b>Mollie payment:</b> ${order.molliePaymentId}</p>

            <h3 style="color: #20433e;">Verzendadres</h3>
            <table style="border-collapse: collapse;">
                <tr><td><b>Voornaam</b></td><td>${esc(c.firstName || firstName(c))}</td></tr>
                <tr><td><b>Achternaam</b></td><td>${esc(c.lastName || '')}</td></tr>
                <tr><td><b>Straat</b></td><td>${esc(c.street)}</td></tr>
                <tr><td><b>Postcode / Plaats</b></td><td>${esc(c.zip)} ${esc(c.city)}</td></tr>
                <tr><td><b>Land</b></td><td>${esc(c.country)}</td></tr>
                <tr><td><b>E-mail</b></td><td>${esc(c.email)}</td></tr>
                ${c.phone ? `<tr><td><b>Telefoon</b></td><td>${esc(c.phone)}</td></tr>` : ''}
            </table>
            ${c.notes ? `<p style="margin-top: 12px;"><b>Opmerkingen:</b> ${esc(c.notes)}</p>` : ''}

            <h3 style="color: #20433e;">Bestanden</h3>
            <table style="border-collapse: collapse; width: 100%; font-size: 0.9em;">
                <thead>
                    <tr style="background:#f5f5f7;">
                        <th style="padding:6px 8px; text-align:left;">#</th>
                        <th style="padding:6px 8px; text-align:left;">Bestand</th>
                        <th style="padding:6px 8px; text-align:left;">Materiaal</th>
                        <th style="padding:6px 8px; text-align:left;">Kleur</th>
                        <th style="padding:6px 8px; text-align:left;">Infill</th>
                        <th style="padding:6px 8px; text-align:right;">Aantal</th>
                        <th style="padding:6px 8px; text-align:right;">Gewicht/stuk</th>
                        <th style="padding:6px 8px; text-align:right;">Per stuk</th>
                        <th style="padding:6px 8px; text-align:right;">Totaal</th>
                    </tr>
                </thead>
                <tbody>${itemRows}</tbody>
            </table>

            <p style="margin-top:12px; font-size: 0.88em; color:#555;">
                <b>Totaal artikelen:</b> ${totalUnits} &middot;
                <b>Totaal gewicht:</b> ${totalWeightG.toFixed(0)} g &middot;
                <b>Totaal printtijd:</b> ${formatHours(totalPrintHours)}
            </p>

            <h3 style="color: #20433e;">Prijs</h3>
            <table style="border-collapse: collapse; width: 100%;">
                ${p.itemsSubtotalNativeIncVat != null ? `<tr><td>Artikelen subtotaal (incl BTW, native)</td><td style="text-align:right;">${euro(p.itemsSubtotalNativeIncVat)}</td></tr>` : ''}
                ${minRow}
                <tr><td>Subtotaal (excl BTW)</td><td style="text-align:right;">${euro(subEx)}</td></tr>
                <tr><td>BTW 21%</td><td style="text-align:right;">${euro(vat)}</td></tr>
                <tr><td>Verzending</td><td style="text-align:right;">${shipping === 0 ? 'Gratis' : euro(shipping)}</td></tr>
                <tr><td><b>Totaal incl BTW</b></td><td style="text-align:right;"><b>${euro(totalIncVat)}</b></td></tr>
            </table>

            <h3 style="color: #20433e;">Kosten-opbouw (intern, gesommeerd)</h3>
            <table style="border-collapse: collapse; width: 100%; font-size: 0.9em; color: #666;">
                <tr><td>Materiaal</td><td style="text-align:right;">${euro(totalMaterialCost)}</td></tr>
                <tr><td>Print (machine)</td><td style="text-align:right;">${euro(totalPrintCost)}</td></tr>
                <tr><td>Marge toegepast</td><td style="text-align:right;">${Math.round(marginPct * 100)}%</td></tr>
            </table>

            <p style="margin-top: 24px; color: #8E8E93; font-size: 0.85em;">
                ${stlAttachments && stlAttachments.length ? `${stlAttachments.length} bestand${stlAttachments.length === 1 ? '' : 'en'} zitten als bijlage bij deze e-mail.` : 'Geen bijlagen beschikbaar.'}
            </p>
        </div>
    `;

    await sendViaRelay(
        `LYNK 3D bestelling ${order.orderId} — ${euro(totalIncVat)} (${items.length}× bestand)`,
        htmlBody,
        {
            to: recipient,
            replyTo: { address: c.email, name: fullName(c) },
            attachments: stlAttachments || [],
        },
    );

    // Customer confirmation
    try {
        const customerItemRows = items.map(it => `
            <li>
                <b>${esc(it.filename)}</b> &mdash; ${esc(it.material || '')}, ${esc(it.color || '')}, ${it.infill != null ? Math.round(it.infill * 100) + '%' : ''} infill, ${it.quantity || 1}× &mdash; ${euro((it.price && it.price.itemSubtotalIncVat) || 0)}
            </li>
        `).join('');

        const customerHtml = `
            <div style="font-family: Arial, sans-serif; color: #1C1C1E;">
                <h2 style="color: #20433e;">Bedankt voor je bestelling, ${esc(firstName(c))}!</h2>
                <p>We hebben je betaling ontvangen en starten met produceren.</p>
                <p><b>Ordernummer:</b> ${order.orderId}<br>
                   <b>Totaal betaald:</b> ${euro(totalIncVat)}</p>
                <p><b>Je bestelling (${items.length} bestand${items.length === 1 ? '' : 'en'}):</b></p>
                <ul>${customerItemRows}</ul>
                <p>Je ontvangt binnen 24 uur van ons een planning met de verwachte leverdatum. Gemiddelde doorlooptijd is 3-7 werkdagen.</p>
                <p>Vragen? Antwoord gewoon op deze mail of bel/WhatsApp <a href="tel:+31613277621">06 1327 7621</a>.</p>
                <p style="margin-top: 24px;">Hartelijke groet,<br><b>LYNK 3D Solutions</b><br>onderdeel van CVL Solutions</p>
            </div>
        `;
        await sendViaRelay(
            `Bevestiging van je bestelling — LYNK 3D Solutions`,
            customerHtml,
            { to: c.email },
        );
    } catch (e) {
        console.warn('Customer confirmation email failed:', e);
    }
}

function formatHours(h) {
    if (!h || !isFinite(h)) return '–';
    const hrs = Math.floor(h);
    const mins = Math.round((h - hrs) * 60);
    return `${hrs}u ${mins}m`;
}

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Customer name helpers — new orders have firstName + lastName; old orders only have .name.
function fullName(c) {
    if (c.firstName || c.lastName) return `${c.firstName || ''} ${c.lastName || ''}`.trim();
    return c.name || '';
}
function firstName(c) {
    if (c.firstName) return c.firstName;
    return (c.name || '').split(' ')[0] || '';
}

// ---------- Telegram push notification ----------
async function sendTelegramAlert(order) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!token || !chatId) {
        console.warn('[telegram] skipped — missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID');
        return;
    }

    const c = order.customer;
    const p = order.price;
    const eur = (n) => '€' + Number(n).toFixed(2).replace('.', ',');

    let body;
    if (order.type === 'product') {
        const prod = order.product;
        const cfg = order.config;
        body = [
            `🛒 *Nieuwe shop-bestelling*`,
            ``,
            `*${escMd(prod.name)}* × ${cfg.quantity}`,
            `Kleur: ${escMd(cfg.color)}` + (cfg.customText ? ` · Tekst: "${escMd(cfg.customText)}"` : ''),
            `Materiaal: ${escMd(prod.material)}`,
            ``,
            `💰 *${eur(p.totalIncVat)}* incl BTW`,
            ``,
            `👤 ${escMd(fullName(c))}`,
            `${escMd(c.street)}, ${escMd(c.zip)} ${escMd(c.city)} (${escMd(c.country)})`,
            `📧 ${escMd(c.email)}${c.phone ? ' · 📱 ' + escMd(c.phone) : ''}`,
            ``,
            `Order: \`${order.orderId}\``,
        ].join('\n');
    } else {
        // STL calculator order (multi-item aware)
        const items = Array.isArray(order.items) && order.items.length
            ? order.items
            : (order.stl ? [{
                filename: order.stl.filename,
                material: order.config && order.config.material,
                color: order.config && order.config.color,
                infill: order.config && order.config.infill,
                quantity: order.config && order.config.quantity,
                derived: order.derived || {},
            }] : []);

        const totalUnits = items.reduce((s, it) => s + (it.quantity || 1), 0);
        const totalWeight = items.reduce((s, it) => s + ((it.derived && it.derived.weightG ? it.derived.weightG : 0) * (it.quantity || 1)), 0);
        const totalHours = items.reduce((s, it) => s + ((it.derived && it.derived.printHours ? it.derived.printHours : 0) * (it.quantity || 1)), 0);

        const header = items.length === 1
            ? `🖨 *Nieuwe print-bestelling*`
            : `🖨 *Nieuwe print-bestelling* (${items.length} bestanden)`;

        const itemLines = items.slice(0, 6).map((it, idx) => {
            const inf = it.infill != null ? Math.round(it.infill * 100) + '%' : '?';
            return `${idx + 1}. *${escMd(it.filename || '?')}* — ${escMd(it.material || '?')}, ${escMd(it.color || '?')}, ${inf}, ${it.quantity || 1}×`;
        });
        if (items.length > 6) itemLines.push(`… +${items.length - 6} meer`);

        body = [
            header,
            ``,
            ...itemLines,
            ``,
            `Totaal: ${totalUnits} stuks · ${totalWeight.toFixed(0)}g · ${totalHours.toFixed(1)}u`,
            ``,
            `💰 *${eur(p.totalIncVat)}* incl BTW`,
            ``,
            `👤 ${escMd(fullName(c))}`,
            `${escMd(c.street)}, ${escMd(c.zip)} ${escMd(c.city)} (${escMd(c.country)})`,
            `📧 ${escMd(c.email)}${c.phone ? ' · 📱 ' + escMd(c.phone) : ''}`,
            ``,
            `Order: \`${order.orderId}\``,
        ].join('\n');
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: body,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
        }),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Telegram sendMessage failed (${res.status}): ${errText}`);
    }
}

// Escape Telegram Markdown special chars (v1 markdown is forgiving but we escape *_`[)
function escMd(s) {
    return String(s || '').replace(/([*_`\[\]])/g, '\\$1');
}

// ---------- Product order email (shop) ----------
async function sendProductOrderEmail(order) {
    const recipient = process.env.NOTIFICATION_EMAIL || 'info@cvlsolutions.nl';
    const c = order.customer;
    const cfg = order.config;
    const prod = order.product;
    const p = order.price;
    const euro = (n) => '€' + Number(n).toFixed(2).replace('.', ',');

    const customLine = cfg.customText ? `<tr><td><b>Custom tekst</b></td><td>${esc(cfg.customText)}</td></tr>` : '';

    const adminHtml = `
        <div style="font-family: Arial, sans-serif; color: #1C1C1E; max-width: 600px;">
            <h2 style="color: #20433e;">🛒 Nieuwe shop-bestelling</h2>
            <p><b>Ordernummer:</b> ${order.orderId}<br>
               <b>Besteld op:</b> ${new Date(order.createdAt).toLocaleString('nl-NL')}<br>
               <b>Betaald op:</b> ${new Date(order.paidAt).toLocaleString('nl-NL')}<br>
               <b>Mollie payment:</b> ${order.molliePaymentId}</p>

            <h3 style="color: #20433e;">Product</h3>
            <table style="border-collapse: collapse; width: 100%;">
                <tr><td><b>Item</b></td><td>${esc(prod.name)}</td></tr>
                <tr><td><b>Product-ID</b></td><td>${esc(prod.id)}</td></tr>
                <tr><td><b>Materiaal</b></td><td>${esc(prod.material)}</td></tr>
                <tr><td><b>Kleur</b></td><td>${esc(cfg.color)}</td></tr>
                <tr><td><b>Aantal</b></td><td>${cfg.quantity}</td></tr>
                ${customLine}
                <tr><td><b>Stuksprijs</b></td><td>${euro(prod.unitPrice)}</td></tr>
                ${p.subtotal != null ? `<tr><td>Subtotaal</td><td>${euro(p.subtotal)}</td></tr>` : ''}
                ${p.shipping != null ? `<tr><td>Verzending</td><td>${euro(p.shipping)}</td></tr>` : ''}
                <tr><td><b>Totaal</b></td><td><b>${euro(p.totalIncVat)}</b></td></tr>
            </table>

            <h3 style="color: #20433e;">Verzendadres</h3>
            <table style="border-collapse: collapse;">
                <tr><td><b>Voornaam</b></td><td>${esc(c.firstName || firstName(c))}</td></tr>
                <tr><td><b>Achternaam</b></td><td>${esc(c.lastName || '')}</td></tr>
                <tr><td><b>Straat</b></td><td>${esc(c.street)}</td></tr>
                <tr><td><b>Postcode / Plaats</b></td><td>${esc(c.zip)} ${esc(c.city)}</td></tr>
                <tr><td><b>Land</b></td><td>${esc(c.country)}</td></tr>
                <tr><td><b>E-mail</b></td><td>${esc(c.email)}</td></tr>
                ${c.phone ? `<tr><td><b>Telefoon</b></td><td>${esc(c.phone)}</td></tr>` : ''}
            </table>
            ${c.notes ? `<p style="margin-top: 12px;"><b>Opmerkingen:</b> ${esc(c.notes)}</p>` : ''}

            <p style="margin-top: 24px; color: #8E8E93; font-size: 0.85em;">
                Deze order is direct betaald via Mollie. Start productie binnen 24 uur.
            </p>
        </div>
    `;

    await sendViaRelay(
        `LYNK 3D shop ${order.orderId} — ${prod.name} (${euro(p.totalIncVat)})`,
        adminHtml,
        {
            to: recipient,
            replyTo: { address: c.email, name: fullName(c) },
        },
    );

    // Customer confirmation
    try {
        const customerHtml = `
            <div style="font-family: Arial, sans-serif; color: #1C1C1E;">
                <h2 style="color: #20433e;">Bedankt voor je bestelling, ${esc(firstName(c))}!</h2>
                <p>We hebben je betaling ontvangen en starten met produceren.</p>
                <p><b>Ordernummer:</b> ${order.orderId}<br>
                   <b>Product:</b> ${esc(prod.name)}<br>
                   <b>Kleur:</b> ${esc(cfg.color)}<br>
                   <b>Aantal:</b> ${cfg.quantity}<br>
                   ${cfg.customText ? `<b>Custom tekst:</b> ${esc(cfg.customText)}<br>` : ''}
                   <b>Totaal betaald:</b> ${euro(p.totalIncVat)}</p>
                <p>Je ontvangt binnen 24 uur een planning met verwachte leverdatum. Gemiddelde doorlooptijd 3-7 werkdagen.</p>
                <p>Vragen? Antwoord gewoon op deze mail of WhatsApp <a href="tel:+31613277621">06 1327 7621</a>.</p>
                <p style="margin-top: 24px;">Hartelijke groet,<br><b>LYNK 3D Solutions</b><br>onderdeel van CVL Solutions</p>
            </div>
        `;
        await sendViaRelay(
            `Bevestiging van je bestelling — LYNK 3D Solutions`,
            customerHtml,
            { to: c.email },
        );
    } catch (e) {
        console.warn('Customer confirmation failed:', e);
    }
}

