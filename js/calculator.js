import * as THREE from 'https://esm.sh/three@0.160.0';
import { STLLoader } from 'https://esm.sh/three@0.160.0/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { unzipSync, strFromU8 } from 'https://esm.sh/fflate@0.8.2';

// ---------- Pricing settings (mirrors EtsyManager calc_settings) ----------
const SETTINGS = {
    materialEfficiency: 1.15,   // 15% overschot
    printRate: 1.50,            // €/uur machine
    margin: 0.50,               // 50% marge (dekt overhead)
    vat: 0.21,                  // 21%
    minPriceIncVat: 25.00,      // minimum order-totaal (artikelen incl BTW, zonder verzending)
    freeShippingThreshold: 50,  // gratis verzending boven dit ordertotaal
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

const MATERIAL_KEYS = Object.keys(FILAMENTS);
const COLOR_OPTIONS = ['Zwart', 'Wit', 'Grijs', 'Rood', 'Blauw', 'Groen', 'Geel', 'Oranje', 'Transparant', 'Goud', 'Zilver', 'Advies'];
const INFILL_OPTIONS = [
    { value: 0.10, label: '10% – licht' },
    { value: 0.20, label: '20% – standaard' },
    { value: 0.40, label: '40% – stevig' },
    { value: 0.70, label: '70% – zeer sterk' },
    { value: 1.00, label: '100% – massief' },
];

// Verzending per zone (incl BTW). Gratis boven freeShippingThreshold.
const SHIPPING = { NL: 3.95, BE: 5.95, EU: 7.95 };

const PRINT_BED_MM = 256; // Bambu P1S
const MAX_FILE_MB = 25;
const MAX_FILES = 20; // sanity cap to keep payload under Netlify Function body limit

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

// Custom 3MF parser (same as before — Three's 3MFLoader fails on Bambu's structure).
function parse3MFToGeometry(arrayBuffer) {
    const uint8 = new Uint8Array(arrayBuffer);
    const unzipped = unzipSync(uint8, {
        filter: (file) => {
            const n = file.name.toLowerCase();
            return n.endsWith('.model') || n.endsWith('.rels');
        },
    });

    const modelFiles = [];
    for (const name in unzipped) {
        if (name.toLowerCase().endsWith('.model')) {
            modelFiles.push({ name, xml: strFromU8(unzipped[name]) });
        }
    }
    if (modelFiles.length === 0) throw new Error('Geen 3D-model XML gevonden in 3MF archief.');

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

    if (triangleCount === 0 || allVertices.length === 0) {
        throw new Error('3MF bevat geen driehoek-geometrie');
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVertices), 3));
    const IndexArray = (allVertices.length / 3) > 65535 ? Uint32Array : Uint16Array;
    geometry.setIndex(new THREE.BufferAttribute(new IndexArray(allIndices), 1));
    geometry.computeVertexNormals();
    return geometry;
}

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

// ---------- Pricing (per item — native, geen minimum op item-niveau) ----------
function calculateItemPrice({ weightG, printHours, quantity, filamentName }) {
    const filament = FILAMENTS[filamentName];
    const materialCost = (weightG / 1000) * filament.priceKg * SETTINGS.materialEfficiency;
    const printCost = printHours * SETTINGS.printRate;
    const perStukCostExVat = materialCost + printCost;
    const perStukExVat = perStukCostExVat * (1 + SETTINGS.margin);
    const perUnitIncVat = perStukExVat * (1 + SETTINGS.vat);
    const itemSubtotalIncVat = perUnitIncVat * quantity;
    return {
        perUnitIncVat,
        itemSubtotalIncVat,
        breakdown: {
            materialCost,
            printCost,
            marginPct: SETTINGS.margin,
        },
    };
}

// Order-niveau: som van items, min €25 op artikel-subtotaal (vóór verzending), verzending erbij.
function calculateOrderPrice(items, shippingZone) {
    const itemsSubtotalNativeIncVat = items.reduce((sum, it) => sum + (it.price ? it.price.itemSubtotalIncVat : 0), 0);
    const subtotalIncVat = Math.max(itemsSubtotalNativeIncVat, SETTINGS.minPriceIncVat);
    const minimumApplied = subtotalIncVat - itemsSubtotalNativeIncVat;
    const subtotalExVat = subtotalIncVat / (1 + SETTINGS.vat);
    const vatAmount = subtotalIncVat - subtotalExVat;

    const shippingCost = subtotalIncVat >= SETTINGS.freeShippingThreshold
        ? 0
        : (SHIPPING[shippingZone] || SHIPPING.EU);

    const totalIncVat = subtotalIncVat + shippingCost;

    return {
        itemsSubtotalNativeIncVat,
        minimumApplied,
        subtotalIncVat,
        subtotalExVat,
        vatAmount,
        shipping: shippingCost,
        totalIncVat,
    };
}

// ---------- Formatters ----------
const fmtEuro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const fmtNum = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');

// ---------- Viewer state (one shared viewer; previews the active item) ----------
let renderer, scene, camera, controls, meshObj;

function initViewer() {
    const el = document.getElementById('viewer');
    el.style.display = 'block';

    const rect = el.getBoundingClientRect();
    const width = rect.width || el.clientWidth || 500;
    const height = el.clientHeight || 380;

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
    const h = el.clientHeight || 380;
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
    if (!renderer) initViewer();
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

// ---------- Multi-item state ----------
// Each item: { id, file, geometry (cached for re-preview), analysis, config, derived, price, warns: [] }
const state = {
    items: [],
    activeId: null,
    nextId: 1,
};

function uid() { return 'item_' + (state.nextId++); }

// ---------- File ingestion ----------
async function handleFiles(fileList) {
    clearGlobalWarn();
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let added = 0;
    for (const file of files) {
        if (state.items.length >= MAX_FILES) {
            showGlobalWarn(`Maximum ${MAX_FILES} bestanden per bestelling. Mail info@cvlsolutions.nl voor grotere orders.`, 'error');
            break;
        }
        const ok = await ingestFile(file);
        if (ok) added++;
    }

    // After ingest, if we have items, hide big dropzone and show compact one
    if (state.items.length > 0) {
        document.getElementById('dropzone').style.display = 'none';
        document.getElementById('dropzoneAdd').style.display = 'flex';
        document.getElementById('viewer').style.display = 'block';
        document.getElementById('viewerInfo').style.display = 'flex';
    }

    // Order matters: recalc first (sets item.price), then render (reads it),
    // then setActiveItem (updates viewer + re-renders highlight).
    recalc();
    render();

    if (state.items.length > 0 && !state.activeId && added > 0) {
        const lastValid = [...state.items].reverse().find(i => i.analysis);
        if (lastValid) setActiveItem(lastValid.id);
    }

    // Reset file input so re-selecting the same file works
    document.getElementById('fileInput').value = '';
    const addInp = document.getElementById('fileInputAdd');
    if (addInp) addInp.value = '';
}

async function ingestFile(file) {
    const lower = file.name.toLowerCase();
    const isStl = lower.endsWith('.stl');
    const is3mf = lower.endsWith('.3mf');
    const sizeMb = file.size / (1024 * 1024);

    if (!isStl && !is3mf) {
        showGlobalWarn(`"${file.name}": alleen STL en 3MF worden ondersteund.`, 'error');
        return false;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
        showGlobalWarn(`"${file.name}": ${sizeMb.toFixed(1)} MB is groter dan max ${MAX_FILE_MB} MB. Mail info@cvlsolutions.nl voor een handmatige offerte.`, 'error');
        return false;
    }

    const item = {
        id: uid(),
        file,
        geometry: null,
        analysis: null,
        config: { material: 'PLA', infill: 0.20, color: 'Zwart', quantity: 1 },
        derived: null,
        price: null,
        warns: [],
        error: null,
    };
    state.items.push(item);

    try {
        const buffer = await file.arrayBuffer();
        let volumeMm3, dims, bambuMeta = null, exactPrintTimeHours = null, geometry;

        if (isStl) {
            const loader = new STLLoader();
            geometry = loader.parse(buffer);
            volumeMm3 = computeVolumeMm3(geometry);
            if (!isFinite(volumeMm3) || volumeMm3 <= 0) {
                throw new Error('Kon geen geldig volume berekenen uit dit STL.');
            }
            geometry.computeBoundingBox();
            const bb = geometry.boundingBox;
            dims = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
        } else {
            geometry = parse3MFToGeometry(buffer);
            volumeMm3 = computeVolumeMm3(geometry);
            if (!isFinite(volumeMm3) || volumeMm3 <= 0) {
                throw new Error('Kon geen geldig volume berekenen uit dit 3MF.');
            }
            geometry.computeBoundingBox();
            const bb = geometry.boundingBox;
            dims = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
            bambuMeta = parse3MFBambuMetadata(buffer);
            if (bambuMeta && bambuMeta.printTimeHours) {
                exactPrintTimeHours = bambuMeta.printTimeHours;
            }
        }

        item.geometry = geometry;
        item.analysis = {
            volumeMm3,
            volumeCm3: volumeMm3 / 1000,
            dims,
            format: isStl ? 'stl' : '3mf',
            exactPrintTimeHours,
            bambuFilamentUsedG: bambuMeta ? bambuMeta.filamentUsedG : null,
            bambuFilamentType: bambuMeta ? bambuMeta.filamentType : null,
        };

        // Per-item warnings
        const maxSide = Math.max(dims.x, dims.y, dims.z);
        const minSide = Math.min(dims.x, dims.y, dims.z);
        if (maxSide > PRINT_BED_MM) item.warns.push(`Model is groter dan het printbed (${PRINT_BED_MM} mm). We splitsen het voor je of nemen contact op.`);
        if (minSide < 5) item.warns.push('Model is erg klein (< 5 mm). Weet je zeker dat je verder wilt?');
        if (exactPrintTimeHours) item.warns.push(`Exacte printtijd uit 3MF gebruikt (${exactPrintTimeHours.toFixed(2)} u).`);
        return true;
    } catch (e) {
        console.error('[ingest] error parsing', file.name, e);
        item.error = e.message || 'onbekende fout';
        return false;
    }
}

function removeItem(id) {
    const idx = state.items.findIndex(i => i.id === id);
    if (idx < 0) return;
    state.items.splice(idx, 1);

    if (state.activeId === id) {
        // Pick another valid item as active, else hide viewer
        const nextActive = state.items.find(i => i.analysis);
        if (nextActive) {
            setActiveItem(nextActive.id);
        } else {
            state.activeId = null;
            disposeViewerObject();
        }
    }

    if (state.items.length === 0) {
        document.getElementById('dropzone').style.display = 'flex';
        document.getElementById('dropzoneAdd').style.display = 'none';
        document.getElementById('viewer').style.display = 'none';
        document.getElementById('viewerInfo').style.display = 'none';
    }

    render();
    recalc();
}

function setActiveItem(id) {
    const item = state.items.find(i => i.id === id);
    if (!item || !item.geometry) return;
    state.activeId = id;

    // Clone geometry into the viewer (Three centers it in place, so we use a clone to keep our cache pristine)
    const geomClone = item.geometry.clone();
    loadGeometryIntoViewer(geomClone);

    // Update viewer info
    document.getElementById('fileName').textContent = item.file.name;
    document.getElementById('fileSize').textContent = (item.file.size / 1024 / 1024).toFixed(2) + ' MB';
    document.getElementById('viewerCount').textContent = state.items.length > 1
        ? `Bestand ${state.items.findIndex(i => i.id === id) + 1} van ${state.items.length}`
        : '';

    // Re-render item list to update .active highlight
    render();
}

// ---------- Recalc all items + order totals ----------
function recalc() {
    // Compute per-item derived + price
    for (const item of state.items) {
        if (!item.analysis) {
            item.derived = null;
            item.price = null;
            continue;
        }
        const filament = FILAMENTS[item.config.material];
        const weightG = item.analysis.bambuFilamentUsedG
            ? item.analysis.bambuFilamentUsedG
            : estimateWeightG(item.analysis.volumeMm3, filament, item.config.infill);
        const printHours = item.analysis.exactPrintTimeHours
            ? item.analysis.exactPrintTimeHours
            : estimatePrintHours(item.analysis.volumeCm3, item.config.infill);

        const price = calculateItemPrice({
            weightG,
            printHours,
            quantity: item.config.quantity,
            filamentName: item.config.material,
        });

        item.derived = { weightG, printHours };
        item.price = price;
    }

    const validItems = state.items.filter(i => i.price);
    const shippingZone = document.getElementById('shipping').value;
    const order = calculateOrderPrice(validItems, shippingZone);

    // Update right-column summary UI
    const fileCount = validItems.length;
    const totalUnits = validItems.reduce((s, it) => s + it.config.quantity, 0);
    const totalWeightG = validItems.reduce((s, it) => s + (it.derived.weightG * it.config.quantity), 0);
    const totalHours = validItems.reduce((s, it) => s + (it.derived.printHours * it.config.quantity), 0);

    document.getElementById('statFiles').textContent = fileCount;
    document.getElementById('statItems').textContent = totalUnits;
    document.getElementById('statWeight').textContent = fileCount > 0 ? `${fmtNum(totalWeightG, 0)} g` : '–';
    if (fileCount > 0 && totalHours > 0) {
        const hrs = Math.floor(totalHours);
        const mins = Math.round((totalHours - hrs) * 60);
        document.getElementById('statTime').textContent = `${hrs}u ${mins}m`;
    } else {
        document.getElementById('statTime').textContent = '–';
    }

    document.getElementById('priceItems').textContent = fmtEuro.format(order.itemsSubtotalNativeIncVat);

    const minRow = document.getElementById('priceMinRow');
    if (order.minimumApplied > 0.005) {
        minRow.style.display = 'flex';
        document.getElementById('priceMin').textContent = '+' + fmtEuro.format(order.minimumApplied);
    } else {
        minRow.style.display = 'none';
    }

    document.getElementById('priceSub').textContent = fmtEuro.format(order.subtotalExVat);
    document.getElementById('priceVat').textContent = fmtEuro.format(order.vatAmount);
    document.getElementById('priceShipping').textContent = order.shipping === 0 ? 'Gratis' : fmtEuro.format(order.shipping);
    document.getElementById('priceTotal').textContent = fmtEuro.format(order.totalIncVat);

    let note = '';
    if (order.minimumApplied > 0.005) {
        note = `Minimum orderwaarde &euro;25 toegepast (&euro;${order.minimumApplied.toFixed(2).replace('.', ',')} aanvulling).`;
    } else if (order.shipping === 0 && order.subtotalIncVat >= SETTINGS.freeShippingThreshold) {
        note = 'Gratis verzending toegepast (vanaf &euro;50 ordertotaal).';
    } else if (fileCount > 0) {
        note = 'Tip: gratis verzending vanaf &euro;50 ordertotaal.';
    }
    document.getElementById('priceNote').innerHTML = note;

    document.getElementById('summarySub').textContent = fileCount === 0
        ? 'Upload een bestand om te beginnen.'
        : (fileCount === 1 ? '1 bestand klaar om te bestellen.' : `${fileCount} bestanden klaar om te bestellen.`);

    document.getElementById('orderBtn').disabled = fileCount === 0;

    // Stash full order data for the modal/submit
    window.__lynk3d_order = {
        items: validItems.map(it => ({
            id: it.id,
            file: it.file,
            analysis: it.analysis,
            config: { ...it.config },
            derived: it.derived,
            price: it.price,
        })),
        shipping: { zone: shippingZone, cost: order.shipping },
        order,
    };
}

// ---------- Item list rendering ----------
function render() {
    const list = document.getElementById('itemsList');
    if (state.items.length === 0) {
        list.innerHTML = '';
        return;
    }

    list.innerHTML = state.items.map((item, idx) => {
        const isActive = state.activeId === item.id;
        const isError = !!item.error;
        const isPending = !item.analysis && !item.error;
        const isPriceless = !!item.analysis && !item.price;
        const klass = `item-card${isActive ? ' active' : ''}${isError ? ' error' : ''}`;
        const sizeMb = (item.file && item.file.size != null) ? (item.file.size / 1024 / 1024).toFixed(2) : '?';
        const filename = escapeHtml((item.file && item.file.name) || 'bestand');

        if (isError) {
            return `
                <div class="${klass}" data-id="${item.id}">
                    <div class="item-head">
                        <div>
                            <div class="filename">${filename}</div>
                            <span class="meta">${sizeMb} MB &middot; <span style="color: #9C1C14;">${escapeHtml(item.error)}</span></span>
                        </div>
                        <button type="button" class="item-remove" data-action="remove" data-id="${item.id}" aria-label="Verwijder">&times;</button>
                    </div>
                </div>`;
        }

        if (isPending || isPriceless) {
            return `
                <div class="${klass}" data-id="${item.id}">
                    <div class="item-head">
                        <div>
                            <div class="filename">${filename}</div>
                            <span class="meta">${sizeMb} MB &middot; <em>Bezig met verwerken…</em></span>
                        </div>
                        <button type="button" class="item-remove" data-action="remove" data-id="${item.id}" aria-label="Verwijder">&times;</button>
                    </div>
                </div>`;
        }

        const a = item.analysis;
        const d = item.derived;
        const p = item.price;
        const metaTxt = `${sizeMb} MB &middot; ${fmtNum(a.volumeCm3, 1)} cm³ &middot; ${fmtNum(a.dims.x)}×${fmtNum(a.dims.y)}×${fmtNum(a.dims.z)} mm`;

        const materialOpts = MATERIAL_KEYS.map(m =>
            `<option value="${m}" ${item.config.material === m ? 'selected' : ''}>${m} – &euro;${FILAMENTS[m].priceKg}/kg</option>`
        ).join('');
        const colorOpts = COLOR_OPTIONS.map(c =>
            `<option value="${c}" ${item.config.color === c ? 'selected' : ''}>${c === 'Advies' ? 'In overleg' : c}</option>`
        ).join('');
        const infillOpts = INFILL_OPTIONS.map(o =>
            `<option value="${o.value}" ${Math.abs(item.config.infill - o.value) < 0.001 ? 'selected' : ''}>${o.label}</option>`
        ).join('');

        const perUnit = p.perUnitIncVat;
        const totalUnit = p.itemSubtotalIncVat;

        const warnHtml = item.warns.length
            ? `<div class="item-warn">${item.warns.map(escapeHtml).join(' ')}</div>`
            : '';

        return `
            <div class="${klass}" data-id="${item.id}" data-action="select">
                <div class="item-head">
                    <div style="flex: 1; min-width: 0;">
                        <div class="filename">${filename}</div>
                        <span class="meta">${metaTxt}${d ? ` &middot; ${fmtNum(d.weightG, 0)} g/stuk` : ''}</span>
                    </div>
                    <button type="button" class="item-remove" data-action="remove" data-id="${item.id}" aria-label="Verwijder">&times;</button>
                </div>
                <div class="item-config">
                    <div>
                        <label>Materiaal</label>
                        <select data-action="config" data-id="${item.id}" data-key="material">${materialOpts}</select>
                    </div>
                    <div>
                        <label>Kleur</label>
                        <select data-action="config" data-id="${item.id}" data-key="color">${colorOpts}</select>
                    </div>
                    <div>
                        <label>Infill</label>
                        <select data-action="config" data-id="${item.id}" data-key="infill">${infillOpts}</select>
                    </div>
                    <div>
                        <label>Aantal</label>
                        <input type="number" min="1" max="500" value="${item.config.quantity}" data-action="config" data-id="${item.id}" data-key="quantity">
                    </div>
                </div>
                ${warnHtml}
                <div class="item-foot">
                    <span class="per-unit">${fmtEuro.format(perUnit)} per stuk incl. BTW</span>
                    <span class="item-total">${fmtEuro.format(totalUnit)}</span>
                </div>
            </div>`;
    }).join('');
}

// ---------- Item list event handling (delegation) ----------
function bindItemList() {
    const list = document.getElementById('itemsList');
    list.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-action="remove"]');
        if (removeBtn) {
            e.stopPropagation();
            removeItem(removeBtn.getAttribute('data-id'));
            return;
        }
        const card = e.target.closest('.item-card');
        if (card && !e.target.closest('select, input, button')) {
            const id = card.getAttribute('data-id');
            setActiveItem(id);
        }
    });
    list.addEventListener('change', (e) => {
        const el = e.target.closest('[data-action="config"]');
        if (!el) return;
        const id = el.getAttribute('data-id');
        const key = el.getAttribute('data-key');
        const item = state.items.find(i => i.id === id);
        if (!item) return;
        let val = el.value;
        if (key === 'quantity') val = Math.max(1, Math.min(500, parseInt(val) || 1));
        else if (key === 'infill') val = parseFloat(val);
        item.config[key] = val;
        recalc();
        render();
    });
    list.addEventListener('input', (e) => {
        // qty input also triggers on input for snappier UX
        const el = e.target.closest('input[data-action="config"]');
        if (!el || el.getAttribute('data-key') !== 'quantity') return;
        const id = el.getAttribute('data-id');
        const item = state.items.find(i => i.id === id);
        if (!item) return;
        const val = Math.max(1, Math.min(500, parseInt(el.value) || 1));
        item.config.quantity = val;
        recalc();
        // Only re-render the affected card's total — skip full render to preserve focus
        const card = el.closest('.item-card');
        if (card && item.price) {
            const totEl = card.querySelector('.item-total');
            if (totEl) totEl.textContent = fmtEuro.format(item.price.itemSubtotalIncVat);
        }
    });
}

// ---------- Drag & drop wiring ----------
function bindDropzones() {
    const fileInput = document.getElementById('fileInput');
    const dropzone = document.getElementById('dropzone');
    const fileInputAdd = document.getElementById('fileInputAdd');
    const dropzoneAdd = document.getElementById('dropzoneAdd');

    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
    fileInputAdd.addEventListener('change', (e) => handleFiles(e.target.files));

    [dropzone, dropzoneAdd].forEach(dz => {
        ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation();
            dz.classList.add('dragover');
        }));
        ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation();
            dz.classList.remove('dragover');
        }));
        dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
    });

    document.getElementById('shipping').addEventListener('change', recalc);
}

// ---------- Warnings ----------
function showGlobalWarn(msg, type = 'warn') {
    const el = document.getElementById('warn');
    el.textContent = msg;
    el.className = 'warn show ' + (type === 'error' ? 'error' : '');
}
function clearGlobalWarn() {
    const el = document.getElementById('warn');
    el.textContent = '';
    el.className = 'warn';
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

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Order modal ----------
function openOrderModal() {
    const data = window.__lynk3d_order;
    if (!data || !data.items.length) return;

    const rows = data.items.map(it => `
        <div class="row">
            <span class="col-file" title="${escapeHtml(it.file.name)}">
                ${escapeHtml(it.file.name)}
                <span style="display:block; color: var(--gray-mid); font-size: 0.75rem; font-weight: 400;">
                    ${escapeHtml(it.config.material)} &middot; ${escapeHtml(it.config.color)} &middot; ${Math.round(it.config.infill * 100)}% &middot; ${it.config.quantity}×
                </span>
            </span>
            <span class="col-price">${fmtEuro.format(it.price.itemSubtotalIncVat)}</span>
        </div>
    `).join('');

    const minRow = data.order.minimumApplied > 0.005
        ? `<div class="row"><span>Minimum &euro;25 aanvulling</span><span>+${fmtEuro.format(data.order.minimumApplied)}</span></div>`
        : '';
    const shipRow = `<div class="row"><span>Verzending</span><span>${data.order.shipping === 0 ? 'Gratis' : fmtEuro.format(data.order.shipping)}</span></div>`;

    document.getElementById('orderSummary').innerHTML = `
        <div class="group-head">Je bestelling</div>
        ${rows}
        ${minRow}
        ${shipRow}
        <div class="row total"><span>Totaal incl. BTW</span><span>${fmtEuro.format(data.order.totalIncVat)}</span></div>
    `;
    document.getElementById('orderModal').classList.add('open');
    document.getElementById('orderForm').style.display = 'block';
    document.getElementById('orderLoader').classList.remove('show');
}

function closeOrderModal() {
    document.getElementById('orderModal').classList.remove('open');
}

// ---------- Compression helpers ----------
async function compressFileToBase64(file) {
    const buf = await file.arrayBuffer();
    if (typeof CompressionStream === 'undefined') {
        const u8 = new Uint8Array(buf);
        return { base64: bytesToBase64(u8), compressedBytes: u8.length, encoding: 'identity' };
    }
    const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return { base64: bytesToBase64(compressed), compressedBytes: compressed.length, encoding: 'gzip' };
}

function bytesToBase64(u8) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// ---------- Submit order ----------
async function submitOrder() {
    clearModalWarn();
    const data = window.__lynk3d_order;
    if (!data || !data.items.length) { showModalWarn('Geen bestanden geladen.'); return; }

    const firstName = document.getElementById('oFirstName').value.trim();
    const lastName = document.getElementById('oLastName').value.trim();
    const name = `${firstName} ${lastName}`.trim();
    const email = document.getElementById('oEmail').value.trim();
    const phone = document.getElementById('oPhone').value.trim();
    const street = document.getElementById('oStreet').value.trim();
    const zip = document.getElementById('oZip').value.trim();
    const city = document.getElementById('oCity').value.trim();
    const notes = document.getElementById('oNotes').value.trim();
    const terms = document.getElementById('oTerms').checked;

    if (!firstName || !lastName || !email || !street || !zip || !city) { showModalWarn('Vul alle verplichte velden in.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showModalWarn('Vul een geldig e-mailadres in.'); return; }
    if (!terms) { showModalWarn('Ga akkoord met de voorwaarden om verder te gaan.'); return; }

    document.getElementById('orderForm').style.display = 'none';
    document.getElementById('orderLoader').classList.add('show');

    try {
        // Compress all STL files in parallel
        const compressedFiles = await Promise.all(
            data.items.map(it => compressFileToBase64(it.file))
        );

        const itemsPayload = data.items.map((it, idx) => {
            const c = compressedFiles[idx];
            return {
                filename: it.file.name,
                sizeBytes: it.file.size,
                base64: c.base64,
                encoding: c.encoding,
                compressedBytes: c.compressedBytes,
                material: it.config.material,
                color: it.config.color,
                infill: it.config.infill,
                quantity: it.config.quantity,
                analysis: {
                    volumeCm3: +it.analysis.volumeCm3.toFixed(2),
                    dims: {
                        x: +it.analysis.dims.x.toFixed(1),
                        y: +it.analysis.dims.y.toFixed(1),
                        z: +it.analysis.dims.z.toFixed(1),
                    },
                    format: it.analysis.format,
                },
                derived: {
                    weightG: +it.derived.weightG.toFixed(1),
                    printHours: +it.derived.printHours.toFixed(2),
                },
                price: {
                    perUnitIncVat: +it.price.perUnitIncVat.toFixed(2),
                    itemSubtotalIncVat: +it.price.itemSubtotalIncVat.toFixed(2),
                    breakdown: {
                        materialCost: +it.price.breakdown.materialCost.toFixed(4),
                        printCost: +it.price.breakdown.printCost.toFixed(4),
                        marginPct: it.price.breakdown.marginPct,
                    },
                },
            };
        });

        const totalPayloadKb = compressedFiles.reduce((s, c) => s + c.compressedBytes, 0) / 1024;
        console.log(`[upload] ${data.items.length} files, total gzip=${totalPayloadKb.toFixed(0)}KB`);

        const payload = {
            customer: { firstName, lastName, name, email, phone, street, zip, city, country: data.shipping.zone, notes },
            items: itemsPayload,
            shipping: { zone: data.shipping.zone, cost: +data.shipping.cost.toFixed(2) },
            price: {
                subtotalNativeExVat: +(data.order.itemsSubtotalNativeIncVat / (1 + SETTINGS.vat)).toFixed(2),
                itemsSubtotalNativeIncVat: +data.order.itemsSubtotalNativeIncVat.toFixed(2),
                minimumApplied: +data.order.minimumApplied.toFixed(2),
                subtotalIncVat: +data.order.subtotalIncVat.toFixed(2),
                subtotalExVat: +data.order.subtotalExVat.toFixed(2),
                vat: +data.order.vatAmount.toFixed(2),
                shipping: +data.order.shipping.toFixed(2),
                totalIncVat: +data.order.totalIncVat.toFixed(2),
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

// ---------- Init ----------
function bindEvents() {
    bindDropzones();
    bindItemList();
    document.getElementById('orderBtn').addEventListener('click', openOrderModal);
    document.getElementById('cancelOrder').addEventListener('click', closeOrderModal);
    document.getElementById('confirmOrder').addEventListener('click', submitOrder);
    document.getElementById('orderModal').addEventListener('click', (e) => {
        if (e.target.id === 'orderModal') closeOrderModal();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    recalc();
});
