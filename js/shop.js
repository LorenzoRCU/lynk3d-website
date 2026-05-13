import { PRODUCTS as STATIC_PRODUCTS, shippingFor } from './products.js?v=2';

const fmtEuro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
let activeProduct = null;

// Combined list = static catalog + extras pushed by EtsyManager via Netlify Blobs.
// Refreshed once on DOMContentLoaded, falls back to static-only on fetch errors.
const PRODUCTS = [...STATIC_PRODUCTS];
function findProduct(id) {
    return PRODUCTS.find(p => p.id === id) || null;
}

async function loadExtraProducts() {
    try {
        const res = await fetch('/.netlify/functions/list-extra-products', { cache: 'no-store' });
        if (!res.ok) return;
        const extras = await res.json();
        if (!Array.isArray(extras) || !extras.length) return;
        // Dedupe by id — static wins over dynamic with the same id.
        const known = new Set(PRODUCTS.map(p => p.id));
        for (const p of extras) {
            if (!p || !p.id || known.has(p.id)) continue;
            PRODUCTS.push(p);
            known.add(p.id);
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
        // Etsy-listing producten: toon "Op Etsy" badge + directe link i.p.v. modaal
        const isEtsy = p.source === 'etsy_listing' || (p.etsy_url && /etsy\.com\/listing/.test(p.etsy_url));
        const etsyBadge = isEtsy
            ? `<a class="etsy-badge" href="${escapeHtml(p.etsy_url || '#')}" target="_blank" rel="noopener" title="Bekijk op Etsy">Op Etsy &#8599;</a>`
            : '';
        const buyBtn = isEtsy
            ? `<a class="buy-btn etsy-buy" href="${escapeHtml(p.etsy_url || '#')}" target="_blank" rel="noopener">Bekijk op Etsy</a>`
            : `<button type="button" class="buy-btn">Bestel</button>`;
        return `
        <div class="product-card${isEtsy ? ' product-card--etsy' : ''}" data-id="${p.id}" data-etsy="${isEtsy ? '1' : '0'}">
            <div class="image">
                <img src="${p.image}" alt="${escapeHtml(p.name)}" loading="lazy">
                ${etsyBadge}
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
        card.addEventListener('click', (ev) => {
            // Voor Etsy-producten: laat de <a> z'n werk doen, geen modaal
            if (card.dataset.etsy === '1') {
                // Als klik op de buy-button → laat default navigatie door
                // Als elders op de card → ook naar Etsy
                const p = findProduct(card.dataset.id);
                if (p && p.etsy_url && !ev.target.closest('a')) {
                    window.open(p.etsy_url, '_blank', 'noopener');
                }
                return;
            }
            openModal(card.dataset.id);
        });
    });
}

function openModal(productId) {
    const p = findProduct(productId);
    if (!p) return;
    activeProduct = p;

    document.getElementById('mImage').src = p.image;
    document.getElementById('mImage').alt = p.name;
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
