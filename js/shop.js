import { PRODUCTS as STATIC_PRODUCTS, shippingFor } from './products.js?v=2';

const fmtEuro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
let activeProduct = null;

// Combined list = static catalog + extras pushed by EtsyManager via Netlify Blobs.
// Refreshed once on DOMContentLoaded, falls back to static-only on fetch errors.
const PRODUCTS = [...STATIC_PRODUCTS];
function findProduct(id) {
    return PRODUCTS.find(p => p.id === id) || null;
}

// Genereer een fingerprint uit een naam: lowercase, alleen letters/cijfers,
// eerste 2-3 sleutelwoorden. Gebruikt voor smart dedup tussen static (EN) en
// dynamic (NL) namen — bv "Mario Mystery Box Toilet Holder" en
// "Mario Mystery Box-toiletrolhouder" matchen op 'mario mystery box'.
function nameFingerprint(name) {
    const STOP = new Set(['de','het','een','en','met','voor','van','op','in','aan',
        'the','a','an','and','with','for','of','to','in','on']);
    const tokens = String(name || '').toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3 && !STOP.has(t));
    // Pak de eerste 2 lange tokens als fingerprint
    return tokens.slice(0, 2).join(' ');
}

async function loadExtraProducts() {
    try {
        const res = await fetch('/.netlify/functions/list-extra-products', { cache: 'no-store' });
        if (!res.ok) return;
        const extras = await res.json();
        if (!Array.isArray(extras) || !extras.length) return;

        // Build dedup-maps: bestaande static products
        const knownIds = new Set(PRODUCTS.map(p => p.id));
        const knownFingerprints = new Map();
        for (const p of PRODUCTS) {
            const fp = nameFingerprint(p.name);
            if (fp) knownFingerprints.set(fp, p);
        }

        for (const p of extras) {
            if (!p || !p.id || knownIds.has(p.id)) continue;
            const fp = nameFingerprint(p.name);
            const dup = fp ? knownFingerprints.get(fp) : null;
            if (dup) {
                // Dynamic versie heeft betere foto's (uit Etsy) — vervang static
                const idx = PRODUCTS.indexOf(dup);
                if (idx >= 0) {
                    PRODUCTS[idx] = p;
                    knownIds.delete(dup.id);
                    knownIds.add(p.id);
                }
                continue;
            }
            PRODUCTS.push(p);
            knownIds.add(p.id);
            if (fp) knownFingerprints.set(fp, p);
        }
    } catch (e) {
        console.warn('Extra products fetch failed — using static catalog only:', e);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderGrid() {
    const grid = document.getElementById('shopGrid');
    grid.innerHTML = PRODUCTS.map(p => {
        // Geen Etsy-links meer — alle producten verkopen we via Lynk3D zelf.
        const buyBtn = `<button type="button" class="buy-btn">Bestel</button>`;
        return `
        <div class="product-card" data-id="${p.id}">
            <div class="image">
                <img src="${p.image}" alt="${escapeHtml(p.name)}" loading="lazy">
            </div>
            <div class="body">
                <h3>${escapeHtml(p.name)}</h3>
                <p class="subtitle">${escapeHtml(p.subtitle)}</p>
                <div class="price-row">
                    <div>
                        <div class="price">${fmtEuro.format(p.price)}</div>
                        <div class="price-meta">incl. BTW, excl. verzending</div>
                    </div>
                    ${buyBtn}
                </div>
            </div>
        </div>
        `;
    }).join('');

    grid.querySelectorAll('.product-card').forEach(card => {
        card.addEventListener('click', () => openModal(card.dataset.id));
    });
}

function openModal(productId) {
    const p = findProduct(productId);
    if (!p) return;
    activeProduct = p;

    const mainImg = document.getElementById('mImage');
    mainImg.src = p.image;
    mainImg.alt = p.name;

    // Thumbnail carousel (alle foto's) — vul container of maak 'm aan
    const allImages = Array.isArray(p.images) && p.images.length ? p.images : [p.image];
    let thumbs = document.getElementById('mThumbs');
    if (!thumbs && mainImg && mainImg.parentNode) {
        thumbs = document.createElement('div');
        thumbs.id = 'mThumbs';
        thumbs.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;';
        mainImg.parentNode.insertBefore(thumbs, mainImg.nextSibling);
    }
    if (thumbs) {
        if (allImages.length <= 1) {
            thumbs.style.display = 'none';
            thumbs.innerHTML = '';
        } else {
            thumbs.style.display = 'flex';
            thumbs.innerHTML = allImages.map((url, idx) => `
                <img src="${url}" alt="${escapeHtml(p.name)} foto ${idx + 1}"
                     loading="lazy"
                     style="width:54px;height:54px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid ${url === p.image ? 'var(--teal,#20433E)' : 'transparent'};"
                     data-img-url="${url}">
            `).join('');
            thumbs.querySelectorAll('img').forEach(t => {
                t.addEventListener('click', () => {
                    mainImg.src = t.dataset.imgUrl;
                    thumbs.querySelectorAll('img').forEach(x => x.style.borderColor = 'transparent');
                    t.style.borderColor = 'var(--teal,#20433E)';
                });
            });
        }
    }

    document.getElementById('mName').textContent = p.name;
    document.getElementById('mSubtitle').textContent = p.subtitle;
    document.getElementById('mDesc').textContent = p.description;
    document.getElementById('mPrice').textContent = fmtEuro.format(p.price);

    const colorSelect = document.getElementById('mColor');
    colorSelect.innerHTML = p.colors.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

    document.getElementById('mQty').value = 1;

    const customWrap = document.getElementById('mCustomTextWrap');
    customWrap.style.display = p.hasCustomText ? 'block' : 'none';
    document.getElementById('mCustomText').value = '';

    clearModalWarn();
    updateTotal();

    document.getElementById('productModal').classList.add('open');
    document.getElementById('orderForm').style.display = 'block';
    document.getElementById('orderLoader').classList.remove('show');
}

function closeModal() {
    document.getElementById('productModal').classList.remove('open');
    activeProduct = null;
}

function updateTotal() {
    if (!activeProduct) return;
    const qty = Math.max(1, parseInt(document.getElementById('mQty').value || 1));
    const country = document.getElementById('oCountry').value;
    const subtotal = activeProduct.price * qty;
    const shipping = shippingFor(country, subtotal);
    const total = subtotal + shipping;
    document.getElementById('mSubtotal').textContent = fmtEuro.format(subtotal);
    document.getElementById('mShipping').textContent = shipping === 0 ? 'Gratis' : fmtEuro.format(shipping);
    document.getElementById('mTotal').textContent = fmtEuro.format(total);
}

function showModalWarn(msg) {
    const w = document.getElementById('modalWarn');
    w.textContent = msg;
    w.className = 'warn show';
}
function clearModalWarn() {
    const w = document.getElementById('modalWarn');
    w.textContent = '';
    w.className = 'warn';
}

async function submitOrder() {
    clearModalWarn();
    if (!activeProduct) return;

    const color = document.getElementById('mColor').value;
    const qty = Math.max(1, parseInt(document.getElementById('mQty').value || 1));
    const customText = activeProduct.hasCustomText ? document.getElementById('mCustomText').value.trim() : null;

    if (activeProduct.hasCustomText && !customText) {
        showModalWarn('Vul de gewenste tekst in voor de keychain.');
        return;
    }

    const firstName = document.getElementById('oFirstName').value.trim();
    const lastName = document.getElementById('oLastName').value.trim();
    const name = `${firstName} ${lastName}`.trim();
    const email = document.getElementById('oEmail').value.trim();
    const phone = document.getElementById('oPhone').value.trim();
    const street = document.getElementById('oStreet').value.trim();
    const zip = document.getElementById('oZip').value.trim();
    const city = document.getElementById('oCity').value.trim();
    const country = document.getElementById('oCountry').value;
    const notes = document.getElementById('oNotes').value.trim();
    const terms = document.getElementById('oTerms').checked;

    if (!firstName || !lastName || !email || !street || !zip || !city) { showModalWarn('Vul alle verplichte velden in.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showModalWarn('Vul een geldig e-mailadres in.'); return; }
    if (!terms) { showModalWarn('Ga akkoord met de voorwaarden om verder te gaan.'); return; }

    document.getElementById('orderForm').style.display = 'none';
    document.getElementById('orderLoader').classList.add('show');

    try {
        const subtotal = +(activeProduct.price * qty).toFixed(2);
        const shipping = +shippingFor(country, subtotal).toFixed(2);
        const totalIncVat = +(subtotal + shipping).toFixed(2);
        const payload = {
            type: 'product',
            product: {
                id: activeProduct.id,
                name: activeProduct.name,
                material: activeProduct.material,
                unitPrice: activeProduct.price,
            },
            customer: { firstName, lastName, name, email, phone, street, zip, city, country, notes },
            config: { color, quantity: qty, customText },
            price: { subtotal, shipping, totalIncVat, unitPrice: activeProduct.price, quantity: qty },
        };

        const res = await fetch('/.netlify/functions/create-product-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(err || 'Kon bestelling niet aanmaken');
        }

        const { checkoutUrl } = await res.json();
        if (!checkoutUrl) throw new Error('Geen checkout URL ontvangen');

        window.location.href = checkoutUrl;
    } catch (e) {
        document.getElementById('orderLoader').classList.remove('show');
        document.getElementById('orderForm').style.display = 'block';
        showModalWarn('Er ging iets mis: ' + (e.message || 'onbekende fout'));
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    renderGrid();
    // Fetch dynamic Etsy-synced products in the background and re-render when done.
    await loadExtraProducts();
    renderGrid();

    document.getElementById('mQty').addEventListener('input', updateTotal);
    document.getElementById('oCountry').addEventListener('change', updateTotal);
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('cancelOrder').addEventListener('click', closeModal);
    document.getElementById('confirmOrder').addEventListener('click', submitOrder);
    document.getElementById('productModal').addEventListener('click', (e) => {
        if (e.target.id === 'productModal') closeModal();
    });
});
