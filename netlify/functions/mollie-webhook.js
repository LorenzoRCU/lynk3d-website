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
                const stlBuf = await stlStore.get(`${orderId}.stl`, { type: 'arrayBuffer' });
                const stlBase64 = stlBuf ? Buffer.from(stlBuf).toString('base64') : null;
                await sendOrderEmail(order, stlBase64);
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

// ---------- STL calculator order email ----------
async function sendOrderEmail(order, stlBase64) {
    const recipient = process.env.NOTIFICATION_EMAIL || 'info@cvlsolutions.nl';
    const c = order.customer;
    const cfg = order.config;
    const a = order.analysis;
    const d = order.derived;
    const p = order.price;
    const b = p.breakdown || {};

    const euro = (n) => '€' + Number(n).toFixed(2).replace('.', ',');

    const htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #1C1C1E; max-width: 600px;">
            <h2 style="color: #20433e;">Nieuwe 3D-print bestelling</h2>
            <p><b>Ordernummer:</b> ${order.orderId}<br>
               <b>Besteld op:</b> ${new Date(order.createdAt).toLocaleString('nl-NL')}<br>
               <b>Betaald op:</b> ${new Date(order.paidAt).toLocaleString('nl-NL')}<br>
               <b>Mollie payment:</b> ${order.molliePaymentId}</p>

            <h3 style="color: #20433e;">Klant</h3>
            <p>${esc(c.name)}<br>${esc(c.email)}${c.phone ? '<br>' + esc(c.phone) : ''}<br>
               ${esc(c.street)}<br>${esc(c.zip)} ${esc(c.city)}<br>${esc(c.country)}</p>
            ${c.notes ? `<p><b>Opmerkingen:</b> ${esc(c.notes)}</p>` : ''}

            <h3 style="color: #20433e;">Print</h3>
            <table style="border-collapse: collapse; width: 100%;">
                <tr><td><b>Bestand</b></td><td>${esc(order.stl.filename)} (${(order.stl.sizeBytes / 1024 / 1024).toFixed(2)} MB)</td></tr>
                <tr><td><b>Materiaal</b></td><td>${esc(cfg.material)}</td></tr>
                <tr><td><b>Kleur</b></td><td>${esc(cfg.color)}</td></tr>
                <tr><td><b>Infill</b></td><td>${Math.round(cfg.infill * 100)}%</td></tr>
                <tr><td><b>Aantal</b></td><td>${cfg.quantity}</td></tr>
                <tr><td><b>Gewicht per stuk</b></td><td>${d.weightG} g</td></tr>
                <tr><td><b>Printtijd per stuk</b></td><td>${d.printHours} u</td></tr>
                <tr><td><b>Volume</b></td><td>${a.volumeCm3} cm³</td></tr>
                <tr><td><b>Afmetingen</b></td><td>${a.dims.x} × ${a.dims.y} × ${a.dims.z} mm</td></tr>
            </table>

            <h3 style="color: #20433e;">Prijs</h3>
            <table style="border-collapse: collapse; width: 100%;">
                <tr><td>Subtotaal (excl BTW)</td><td style="text-align:right;">${euro(p.subtotal)}</td></tr>
                <tr><td>BTW 21%</td><td style="text-align:right;">${euro(p.vat)}</td></tr>
                <tr><td>Verzending</td><td style="text-align:right;">${p.shipping === 0 ? 'Gratis' : euro(p.shipping)}</td></tr>
                <tr><td><b>Totaal incl BTW</b></td><td style="text-align:right;"><b>${euro(p.totalIncVat)}</b></td></tr>
            </table>

            <h3 style="color: #20433e;">Kosten-opbouw (intern)</h3>
            <table style="border-collapse: collapse; width: 100%; font-size: 0.9em; color: #666;">
                <tr><td>Materiaal</td><td style="text-align:right;">${euro(b.materialCost || 0)}</td></tr>
                <tr><td>Print (machine)</td><td style="text-align:right;">${euro(b.printCost || 0)}</td></tr>
                <tr><td>Labor (0,25u)</td><td style="text-align:right;">${euro(b.laborCost || 0)}</td></tr>
                <tr><td>Packaging</td><td style="text-align:right;">${euro(b.packagingCost || 0)}</td></tr>
                <tr><td>Marge toegepast</td><td style="text-align:right;">${Math.round((b.marginPct || 0) * 100)}%</td></tr>
            </table>

            <p style="margin-top: 24px; color: #8E8E93; font-size: 0.85em;">
                STL-bestand zit als bijlage bij deze e-mail.
            </p>
        </div>
    `;

    const attachments = [];
    if (stlBase64) {
        attachments.push({
            name: order.stl.filename,
            contentType: 'application/vnd.ms-pki.stl',
            contentBase64: stlBase64,
        });
    }

    await sendViaRelay(
        `LYNK 3D bestelling ${order.orderId} — ${euro(p.totalIncVat)}`,
        htmlBody,
        {
            to: recipient,
            replyTo: { address: c.email, name: c.name },
            attachments,
        },
    );

    // Also send confirmation to the customer
    try {
        const customerHtml = `
            <div style="font-family: Arial, sans-serif; color: #1C1C1E;">
                <h2 style="color: #20433e;">Bedankt voor je bestelling, ${esc(c.name.split(' ')[0])}!</h2>
                <p>We hebben je betaling ontvangen en starten met produceren.</p>
                <p><b>Ordernummer:</b> ${order.orderId}<br>
                   <b>Bestand:</b> ${esc(order.stl.filename)}<br>
                   <b>Materiaal:</b> ${esc(cfg.material)}, ${esc(cfg.color)}, ${Math.round(cfg.infill * 100)}% infill<br>
                   <b>Aantal:</b> ${cfg.quantity}<br>
                   <b>Totaal betaald:</b> ${euro(p.totalIncVat)}</p>
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
        // don't throw — internal email already sent
    }
}

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
            `👤 ${escMd(c.name)}`,
            `${escMd(c.street)}, ${escMd(c.zip)} ${escMd(c.city)} (${escMd(c.country)})`,
            `📧 ${escMd(c.email)}${c.phone ? ' · 📱 ' + escMd(c.phone) : ''}`,
            ``,
            `Order: \`${order.orderId}\``,
        ].join('\n');
    } else {
        // STL calculator order
        const cfg = order.config || {};
        const stl = order.stl || {};
        const d = order.derived || {};
        body = [
            `🖨 *Nieuwe print-bestelling*`,
            ``,
            `*${escMd(stl.filename || 'STL')}* · ${d.weightG || '?'}g · ${d.printHours || '?'}u`,
            `Materiaal: ${escMd(cfg.material || '?')} · Kleur: ${escMd(cfg.color || '?')}`,
            `Infill: ${cfg.infill ? Math.round(cfg.infill * 100) + '%' : '?'} · Aantal: ${cfg.quantity || 1}`,
            ``,
            `💰 *${eur(p.totalIncVat)}* incl BTW`,
            ``,
            `👤 ${escMd(c.name)}`,
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
                <tr><td><b>Totaal</b></td><td><b>${euro(p.totalIncVat)}</b></td></tr>
            </table>

            <h3 style="color: #20433e;">Klant</h3>
            <p>${esc(c.name)}<br>${esc(c.email)}${c.phone ? '<br>' + esc(c.phone) : ''}<br>
               ${esc(c.street)}<br>${esc(c.zip)} ${esc(c.city)}<br>${esc(c.country)}</p>
            ${c.notes ? `<p><b>Opmerkingen:</b> ${esc(c.notes)}</p>` : ''}

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
            replyTo: { address: c.email, name: c.name },
        },
    );

    // Customer confirmation
    try {
        const customerHtml = `
            <div style="font-family: Arial, sans-serif; color: #1C1C1E;">
                <h2 style="color: #20433e;">Bedankt voor je bestelling, ${esc(c.name.split(' ')[0])}!</h2>
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

