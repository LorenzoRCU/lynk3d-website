import * as THREE from 'https://esm.sh/three@0.160.0';
import { STLLoader } from 'https://esm.sh/three@0.160.0/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { unzipSync, strFromU8 } from 'https://esm.sh/fflate@0.8.2';

// ---------- Pricing settings (mirrors EtsyManager calc_settings) ----------
const SETTINGS = {
    materialEfficiency: 1.15,   // 15% overschot
    printRate: 1.50,            // €/uur machine
    laborRate: 35.00,           // €/uur
    defaultLaborHours: 0.25,    // post-processing per order
    packaging: 1.50,            // €
    margin: 0.50,               // 50% (was 60)
    vat: 0.21,                  // 21%
    minPriceIncVat: 25.00,      // minimum incl BTW per stuk
    handlingIncVat: 7.00,       // verzend+handling volledig ingebakken (was 3, shipping apart)
    freeShippingThreshold: 0,   // alles is gratis verzending (baked-in)
};

const FILAMENTS = {
    'PLA':        { priceKg: 20, density: 1.24 },
    'PLA+':       { priceKg: 24, density: 1.24 },
    'PETG':       { priceKg: 25, density: 1.27 },
    'ABS':        { priceKg: 22, density: 1.04 },
    'ASA':        { priceKg: 30, density: 1.07 },
    'TPU':        { priceKg: 35, density: 1.21 },
    'Wood PLA':   { priceKg: 28, density: 1.28 },
    'Carbon PLA': { priceKg: 40, density: 1.30 },
    'Nylon':      { priceKg: 45, density: 1.14 },
    'PC':         { priceKg: 50, density: 1.20 },
};

// Alle zones zichtbaar gratis — kosten zitten in handlingIncVat
// EU/BE verschil nog wel tracken voor admin, maar klant ziet €0 op de order
const SHIPPING = { NL: 0, BE: 0, EU: 0 };

const PRINT_BED_MM = 256; // Bambu P1S
const MAX_FILE_MB = 6; // Netlify Functions v2 accepts ~10MB body; base64 overhead ~33%

// ---------- STL analysis ----------
function computeVolumeMm3(geometry) {
    const pos = geometry.getAttribute('position');
    const idx = geometry.getIndex();
    let volume = 0;
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
    const cross = new THREE.Vector3();
    if (idx) {
        for (let i = 0; i < idx.count; i += 3) {
            v1.fromBufferAttribute(pos, idx.getX(i));
            v2.fromBufferAttribute(pos, idx.getX(i + 1));
            v3.fromBufferAttribute(pos, idx.getX(i + 2));
            cross.crossVectors(v2, v3);
            volume += v1.dot(cross) / 6;
        }
    } else {
        for (let i = 0; i < pos.count; i += 3) {
            v1.fromBufferAttribute(pos, i);
            v2.fromBufferAttribute(pos, i + 1);
            v3.fromBufferAttribute(pos, i + 2);
            cross.crossVectors(v2, v3);
            volume += v1.dot(cross) / 6;
        }
    }
    return Math.abs(volume);
}

// Custom 3MF parser: opens the zip and reads mesh XML directly.
// Three.js stock 3MFLoader fails on Bambu's structure (components without direct mesh refs);
// this parser walks every .model file inside the 3MF and unions all geometry.
function parse3MFToGeometry(arrayBuffer) {
    const uint8 = new Uint8Array(arrayBuffer);
    const unzipped = unzipSync(uint8, {
        filter: (file) => {
            const n = file.name.toLowerCase();
            return n.endsWith('.model') || n.endsWith('.rels');
        },
    });

    // Collect all model XML files. Bambu puts per-object meshes in subfolders.
    const modelFiles = [];
    for (const name in unzipped) {
        if (name.toLowerCase().endsWith('.model')) {
            modelFiles.push({ name, xml: strFromU8(unzipped[name]) });
        }
    }
    if (modelFiles.length === 0) throw new Error('Geen 3D-model XML gevonden in 3MF archief.');

    // Prefer the canonical 3dmodel.model; but if it only contains build-instructions
    // (Bambu-style, with <component> refs), we also need to parse the referenced .model files.
    modelFiles.sort((a, b) => {
        const aMain = a.name.toLowerCase().includes('3dmodel.model') ? 0 : 1;
        const bMain = b.name.toLowerCase().includes('3dmodel.model') ? 0 : 1;
        return aMain - bMain;
    });

    const allVertices = [];
    const allIndices = [];
    let indexOffset = 0;
    let triangleCount = 0;
    let objectCount = 0;

    for (const { name, xml } of modelFiles) {
        let doc;
        try {
            doc = new DOMParser().parseFromString(xml, 'text/xml');
        } catch (e) {
            console.warn('[3MF] XML parse failed for', name, e);
            continue;
        }
        if (doc.getElementsByTagName('parsererror').length) {
            console.warn('[3MF] XML parser error in', name);
            continue;
        }

        const meshNodes = doc.getElementsByTagName('mesh');
        for (const mesh of meshNodes) {
            objectCount++;
            // Vertices
            const vertexEls = mesh.getElementsByTagName('vertex');
            const vertStart = indexOffset;
            for (const v of vertexEls) {
                allVertices.push(
                    parseFloat(v.getAttribute('x')) || 0,
                    parseFloat(v.getAttribute('y')) || 0,
                    parseFloat(v.getAttribute('z')) || 0,
                );
                indexOffset++;
            }
            // Triangles
            const triangleEls = mesh.getElementsByTagName('triangle');
            for (const t of triangleEls) {
                allIndices.push(
                    (parseInt(t.getAttribute('v1')) || 0) + vertStart,
                    (parseInt(t.getAttribute('v2')) || 0) + vertStart,
                    (parseInt(t.getAttribute('v3')) || 0) + vertStart,
                );
                triangleCount++;
            }
        }
    }

    console.log('[3MF] parsed', objectCount, 'mesh(es),', allVertices.length / 3, 'vertices,', triangleCount, 'triangles');

    if (triangleCount === 0 || allVertices.length === 0) {
        throw new Error('3MF bevat geen driehoek-geometrie');
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVertices), 3));
    // Use 32-bit index if vertex count exceeds 65k
    const IndexArray = (allVertices.length / 3) > 65535 ? Uint32Array : Uint16Array;
    geometry.setIndex(new THREE.BufferAttribute(new IndexArray(allIndices), 1));
    geometry.computeVertexNormals();
    return geometry;
}

// Parse Bambu Studio .3mf zip for exact print_time / filament metadata
function parse3MFBambuMetadata(arrayBuffer) {
    try {
        const uint8 = new Uint8Array(arrayBuffer);
        const unzipped = unzipSync(uint8, {
            filter: (file) => {
                const n = file.name.toLowerCase();
                return n.includes('slice_info.config') || (n.endsWith('.config') && n.includes('plate'));
            },
        });
        let printTimeHours, filamentUsedG, filamentType;
        for (const name in unzipped) {
            const text = strFromU8(unzipped[name]);
            if (printTimeHours === undefined) {
                const m = text.match(/print_time["\s=:]+(\d+)/i);
                if (m) printTimeHours = parseInt(m[1]) / 3600;
            }
            if (filamentUsedG === undefined) {
                const m = text.match(/used_g["\s=:]+([0-9.]+)/i);
                if (m) filamentUsedG = parseFloat(m[1]);
            }
            if (!filamentType) {
                const m = text.match(/filament.*?type="([^"]+)"/i);
                if (m) filamentType = m[1];
            }
        }
        return { printTimeHours, filamentUsedG, filamentType };
    } catch (e) {
        console.warn('3MF metadata parse failed:', e);
        return {};
    }
}

function estimateWeightG(volumeMm3, filament, infill = 0.20, wallFactor = 1.35) {
    const volumeCm3 = volumeMm3 / 1000;
    const effectiveFill = Math.min(infill * wallFactor + 0.15, 1.0);
    return volumeCm3 * filament.density * effectiveFill;
}

function estimatePrintHours(volumeCm3, infill = 0.20) {
    const baseMin = 6.0;
    const perCm3Min = 1.2 + (infill - 0.20) * 2.0;
    return (baseMin + volumeCm3 * perCm3Min) / 60;
}

// ---------- Pricing ----------
function calculatePrice({ weightG, printHours, quantity, filamentName, shippingZone }) {
    const filament = FILAMENTS[filamentName];
    const materialCost = (weightG / 1000) * filament.priceKg * SETTINGS.materialEfficiency;
    const printCost = printHours * SETTINGS.printRate;
    const laborCost = SETTINGS.defaultLaborHours * SETTINGS.laborRate;
    const packagingCost = SETTINGS.packaging;

    const perUnitCost = materialCost + printCost + laborCost + packagingCost;
    const perUnitWithMargin = perUnitCost * (1 + SETTINGS.margin);
    const perUnitIncVat = perUnitWithMargin * (1 + SETTINGS.vat);
    const perUnit = Math.max(perUnitIncVat, SETTINGS.minPriceIncVat);
    const minKicksIn = perUnitIncVat < SETTINGS.minPriceIncVat;

    const lineIncVat = perUnit * quantity;

    // Order-level handling (baked into subtotal, geen aparte regel)
    const handlingIncVat = SETTINGS.handlingIncVat;
    const subtotalIncVat = lineIncVat + handlingIncVat;
    const subtotalExVat = subtotalIncVat / (1 + SETTINGS.vat);
    const vatAmount = subtotalIncVat - subtotalExVat;

    const shippingCost = subtotalIncVat >= SETTINGS.freeShippingThreshold ? 0 : (SHIPPING[shippingZone] || 0);
    const totalIncVat = subtotalIncVat + shippingCost;

    return {
        perUnitIncVat: perUnit,
        subtotal: subtotalExVat,
        vat: vatAmount,
        subtotalIncVat,
        shipping: shippingCost,
        totalIncVat,
        minKicksIn,
        breakdown: {
            materialCost,
            printCost,
            laborCost,
            packagingCost,
            handlingBakedIn: handlingIncVat,
            marginPct: SETTINGS.margin,
        },
    };
}

// ---------- Formatters ----------
const fmtEuro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const fmtNum = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');

// ---------- Viewer state ----------
let renderer, scene, camera, controls, meshObj;
let currentFile = null;
let currentAnalysis = null;

function initViewer() {
    const el = document.getElementById('viewer');
    el.style.display = 'block';

    const rect = el.getBoundingClientRect();
    const width = rect.width || el.clientWidth || 500;
    const height = el.clientHeight || 420;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    el.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    camera.position.set(80, 80, 80);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambient);
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.9);
    dir1.position.set(100, 150, 100);
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.35);
    dir2.position.set(-100, -80, -100);
    scene.add(dir2);

    window.addEventListener('resize', onResize);
    animate();
}

function onResize() {
    if (!renderer) return;
    const el = document.getElementById('viewer');
    const w = el.clientWidth;
    const h = el.clientHeight || 420;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}

function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
}

function disposeViewerObject() {
    if (!meshObj) return;
    scene.remove(meshObj);
    meshObj.traverse(child => {
        if (child.isMesh) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                else child.material.dispose();
            }
        }
    });
    meshObj = null;
}

function loadGeometryIntoViewer(geometry) {
    disposeViewerObject();
    geometry.computeVertexNormals();
    geometry.center();

    const material = new THREE.MeshStandardMaterial({
        color: 0x20433e,
        metalness: 0.15,
        roughness: 0.55,
        flatShading: false,
    });
    meshObj = new THREE.Mesh(geometry, material);
    scene.add(meshObj);

    geometry.computeBoundingBox();
    frameToObject(geometry.boundingBox);
}

function frameToObject(bb) {
    const size = new THREE.Vector3();
    bb.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 50;
    const dist = maxDim * 2.2;
    camera.position.set(dist, dist, dist);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
}

// ---------- File handling ----------
async function handleFile(file) {
    clearWarn();
    if (!file) return;

    const lower = file.name.toLowerCase();
    const isStl = lower.endsWith('.stl');
    const is3mf = lower.endsWith('.3mf');
    const sizeMb = file.size / (1024 * 1024);
    console.log(`[upload] file="${file.name}" size=${file.size} bytes (${sizeMb.toFixed(2)} MB) limit=${MAX_FILE_MB} MB`);

    if (!isStl && !is3mf) {
        showWarn('Alleen STL en 3MF bestanden worden ondersteund.', 'error');
        return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
        showWarn(`Bestand is ${sizeMb.toFixed(1)} MB; max is ${MAX_FILE_MB} MB voor directe bestelling. Mail het bestand direct naar info@cvlsolutions.nl, dan sturen we een betaallink.`, 'error');
        return;
    }

    currentFile = file;
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileSize').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB';

    const buffer = await file.arrayBuffer();

    if (!renderer) initViewer();

    let volumeMm3, dims, bambuMeta = null, exactPrintTimeHours = null;

    if (isStl) {
        let geometry;
        try {
            const loader = new STLLoader();
            geometry = loader.parse(buffer);
        } catch (e) {
            showWarn('Kan dit bestand niet lezen. Is het een geldig STL?', 'error');
            return;
        }

        volumeMm3 = computeVolumeMm3(geometry);
        if (!isFinite(volumeMm3) || volumeMm3 <= 0) {
            showWarn('Kon geen geldig volume berekenen uit dit STL-bestand.', 'error');
            return;
        }

        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        dims = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };

        loadGeometryIntoViewer(geometry);
    } else {
        // 3MF: custom parser (direct zip + XML) — Three's 3MFLoader fails on Bambu.
        let geometry;
        try {
            console.log('[3MF] starting custom parse, buffer size:', buffer.byteLength);
            geometry = parse3MFToGeometry(buffer);
        } catch (e) {
            console.error('[3MF] parse failed:', e);
            showWarn('Kan dit 3MF-bestand niet lezen: ' + (e.message || 'onbekende fout') + '. Exporteer het opnieuw vanuit je slicer of probeer een STL.', 'error');
            return;
        }

        volumeMm3 = computeVolumeMm3(geometry);
        if (!isFinite(volumeMm3) || volumeMm3 <= 0) {
            showWarn('Kon geen geldig volume berekenen uit dit 3MF-bestand.', 'error');
            return;
        }

        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        if (!bb) {
            showWarn('Geen afmetingen gevonden in 3MF-bestand.', 'error');
            return;
        }
        dims = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };

        loadGeometryIntoViewer(geometry);

        // Try to get exact Bambu print metadata
        bambuMeta = parse3MFBambuMetadata(buffer);
        console.log('[3MF] bambu metadata:', bambuMeta);
        if (bambuMeta && bambuMeta.printTimeHours) {
            exactPrintTimeHours = bambuMeta.printTimeHours;
        }
    }

    currentAnalysis = {
        volumeMm3,
        volumeCm3: volumeMm3 / 1000,
        dims,
        format: isStl ? 'stl' : '3mf',
        exactPrintTimeHours,
        bambuFilamentUsedG: bambuMeta ? bambuMeta.filamentUsedG : null,
        bambuFilamentType: bambuMeta ? bambuMeta.filamentType : null,
    };

    document.getElementById('viewerInfo').style.display = 'flex';
    document.getElementById('dropzone').style.display = 'none';

    // Warnings
    const maxSide = Math.max(dims.x, dims.y, dims.z);
    const minSide = Math.min(dims.x, dims.y, dims.z);
    const warns = [];
    if (maxSide > PRINT_BED_MM) warns.push(`Model is groter dan het printbed (${PRINT_BED_MM} mm). We splitsen het voor je op of nemen contact op.`);
    if (minSide < 5) warns.push('Model is erg klein (< 5 mm). Weet je zeker dat je verder wilt?');
    if (exactPrintTimeHours) warns.push(`Exacte printtijd uit 3MF gebruikt (${exactPrintTimeHours.toFixed(2)} u).`);
    if (warns.length) showWarn(warns.join(' '), exactPrintTimeHours && warns.length === 1 ? 'warn' : 'warn');

    recalc();
}

function resetFile() {
    currentFile = null;
    currentAnalysis = null;
    if (meshObj && scene) {
        scene.remove(meshObj);
        meshObj.geometry.dispose();
        meshObj.material.dispose();
        meshObj = null;
    }
    document.getElementById('viewer').style.display = 'none';
    document.getElementById('viewerInfo').style.display = 'none';
    document.getElementById('dropzone').style.display = 'block';
    document.getElementById('fileInput').value = '';
    clearWarn();
    recalc();
}

// ---------- UI wiring ----------
function showWarn(msg, type = 'warn') {
    const el = document.getElementById('warn');
    el.textContent = msg;
    el.className = 'warn show ' + (type === 'error' ? 'error' : '');
}
function clearWarn() {
    const el = document.getElementById('warn');
    el.textContent = '';
    el.className = 'warn';
}

function recalc() {
    const weightEl = document.getElementById('statWeight');
    const timeEl = document.getElementById('statTime');
    const dimsEl = document.getElementById('statDims');
    const subEl = document.getElementById('priceSub');
    const vatEl = document.getElementById('priceVat');
    const shipEl = document.getElementById('priceShipping');
    const totalEl = document.getElementById('priceTotal');
    const noteEl = document.getElementById('priceNote');
    const btn = document.getElementById('orderBtn');

    if (!currentAnalysis) {
        weightEl.textContent = '—';
        timeEl.textContent = '—';
        dimsEl.textContent = '—';
        subEl.textContent = fmtEuro.format(0);
        vatEl.textContent = fmtEuro.format(0);
        shipEl.textContent = fmtEuro.format(0);
        totalEl.textContent = fmtEuro.format(0);
        noteEl.textContent = '';
        btn.disabled = true;
        return;
    }

    const material = document.getElementById('material').value;
    const infill = parseFloat(document.getElementById('infill').value);
    const quantity = Math.max(1, parseInt(document.getElementById('quantity').value || 1));
    const shippingZone = document.getElementById('shipping').value;

    const filament = FILAMENTS[material];
    const weightG = currentAnalysis.bambuFilamentUsedG
        ? currentAnalysis.bambuFilamentUsedG
        : estimateWeightG(currentAnalysis.volumeMm3, filament, infill);
    const printHours = currentAnalysis.exactPrintTimeHours
        ? currentAnalysis.exactPrintTimeHours
        : estimatePrintHours(currentAnalysis.volumeCm3, infill);

    const price = calculatePrice({ weightG, printHours, quantity, filamentName: material, shippingZone });

    weightEl.textContent = `${fmtNum(weightG, 0)} g` + (quantity > 1 ? ` × ${quantity}` : '');
    const totalHours = printHours * quantity;
    const hrs = Math.floor(totalHours);
    const mins = Math.round((totalHours - hrs) * 60);
    timeEl.textContent = `${hrs}u ${mins}m` + (quantity > 1 ? ` (${quantity}x)` : '');
    dimsEl.textContent = `${fmtNum(currentAnalysis.dims.x)} × ${fmtNum(currentAnalysis.dims.y)} × ${fmtNum(currentAnalysis.dims.z)} mm`;

    subEl.textContent = fmtEuro.format(price.subtotal);
    vatEl.textContent = fmtEuro.format(price.vat);
    shipEl.textContent = price.shipping === 0 ? 'Gratis' : fmtEuro.format(price.shipping);
    totalEl.textContent = fmtEuro.format(price.totalIncVat);

    if (price.minKicksIn) noteEl.textContent = 'Minimum prijs €25 incl. BTW per stuk is toegepast';
    else noteEl.textContent = 'Alle prijzen incl. BTW, inclusief verzending binnen EU';

    btn.disabled = false;

    // Stash for order
    window.__lynk3d_order = {
        file: currentFile,
        analysis: currentAnalysis,
        config: { material, infill, quantity, shippingZone, color: document.getElementById('color').value },
        derived: { weightG, printHours },
        price,
    };
}

function bindEvents() {
    const fileInput = document.getElementById('fileInput');
    const dropzone = document.getElementById('dropzone');
    const resetBtn = document.getElementById('resetBtn');
    const configInputs = ['material', 'infill', 'quantity', 'color', 'shipping'];

    fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

    ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.remove('dragover');
    }));
    dropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files[0];
        handleFile(file);
    });

    resetBtn.addEventListener('click', resetFile);
    configInputs.forEach(id => {
        document.getElementById(id).addEventListener('change', recalc);
        document.getElementById(id).addEventListener('input', recalc);
    });

    document.getElementById('orderBtn').addEventListener('click', openOrderModal);
    document.getElementById('cancelOrder').addEventListener('click', closeOrderModal);
    document.getElementById('confirmOrder').addEventListener('click', submitOrder);
    document.getElementById('orderModal').addEventListener('click', (e) => {
        if (e.target.id === 'orderModal') closeOrderModal();
    });
}

// ---------- Order modal ----------
function openOrderModal() {
    const data = window.__lynk3d_order;
    if (!data) return;
    const p = data.price;
    document.getElementById('orderSummary').innerHTML = `
        <div class="row"><span>Bestand</span><span>${escapeHtml(data.file.name)}</span></div>
        <div class="row"><span>Materiaal</span><span>${escapeHtml(data.config.material)}, ${Math.round(data.config.infill * 100)}% infill, ${escapeHtml(data.config.color)}</span></div>
        <div class="row"><span>Aantal</span><span>${data.config.quantity}</span></div>
        <div class="row"><span>Totaal incl. BTW + verzending</span><span>${fmtEuro.format(p.totalIncVat)}</span></div>
    `;
    document.getElementById('orderModal').classList.add('open');
    document.getElementById('orderForm').style.display = 'block';
    document.getElementById('orderLoader').classList.remove('show');
}

function closeOrderModal() {
    document.getElementById('orderModal').classList.remove('open');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showModalWarn(msg) {
    const w = document.getElementById('modalWarn');
    w.textContent = msg;
    w.className = 'warn show error';
}
function clearModalWarn() {
    const w = document.getElementById('modalWarn');
    w.textContent = '';
    w.className = 'warn';
}

async function submitOrder() {
    clearModalWarn();
    const data = window.__lynk3d_order;
    if (!data) { showModalWarn('Geen bestand geladen.'); return; }

    const name = document.getElementById('oName').value.trim();
    const email = document.getElementById('oEmail').value.trim();
    const phone = document.getElementById('oPhone').value.trim();
    const street = document.getElementById('oStreet').value.trim();
    const zip = document.getElementById('oZip').value.trim();
    const city = document.getElementById('oCity').value.trim();
    const notes = document.getElementById('oNotes').value.trim();
    const terms = document.getElementById('oTerms').checked;

    if (!name || !email || !street || !zip || !city) { showModalWarn('Vul alle verplichte velden in.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showModalWarn('Vul een geldig e-mailadres in.'); return; }
    if (!terms) { showModalWarn('Ga akkoord met de voorwaarden om verder te gaan.'); return; }

    document.getElementById('orderForm').style.display = 'none';
    document.getElementById('orderLoader').classList.add('show');

    try {
        const stlBase64 = await fileToBase64(data.file);

        const payload = {
            customer: { name, email, phone, street, zip, city, country: data.config.shippingZone, notes },
            config: data.config,
            analysis: {
                volumeCm3: +data.analysis.volumeCm3.toFixed(2),
                dims: {
                    x: +data.analysis.dims.x.toFixed(1),
                    y: +data.analysis.dims.y.toFixed(1),
                    z: +data.analysis.dims.z.toFixed(1),
                },
            },
            derived: {
                weightG: +data.derived.weightG.toFixed(1),
                printHours: +data.derived.printHours.toFixed(2),
            },
            price: {
                subtotal: +data.price.subtotal.toFixed(2),
                vat: +data.price.vat.toFixed(2),
                shipping: +data.price.shipping.toFixed(2),
                totalIncVat: +data.price.totalIncVat.toFixed(2),
                breakdown: {
                    materialCost: +data.price.breakdown.materialCost.toFixed(4),
                    printCost: +data.price.breakdown.printCost.toFixed(4),
                    laborCost: +data.price.breakdown.laborCost.toFixed(4),
                    packagingCost: +data.price.breakdown.packagingCost.toFixed(4),
                    marginPct: data.price.breakdown.marginPct,
                },
            },
            stl: {
                filename: data.file.name,
                sizeBytes: data.file.size,
                base64: stlBase64,
            },
        };

        const res = await fetch('/.netlify/functions/create-order', {
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
        showModalWarn('Er ging iets mis: ' + (e.message || 'onbekende fout') + '. Probeer het opnieuw of mail ons.');
    }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
            const result = r.result;
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    recalc();
});
