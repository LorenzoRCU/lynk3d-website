// LYNK 3D Solutions — shop product catalog.
// Prices are inclusive of VAT, EXCLUSIVE of shipping (shown at checkout).
// Edit this file to tweak prices, add products, or change images.

// Shipping fee per destination (incl. BTW). Shown to customer in checkout modal.
export const SHIPPING_BY_COUNTRY = {
    NL: 3.95,
    BE: 5.95, DE: 5.95, FR: 5.95, AT: 5.95, LU: 5.95,
    ES: 7.95, IT: 7.95,
};
export const DEFAULT_SHIPPING = 7.95;
export const FREE_SHIPPING_THRESHOLD = 50; // gratis verzending boven dit subtotaal
export function shippingFor(country, subtotal = 0) {
    if (subtotal >= FREE_SHIPPING_THRESHOLD) return 0;
    return SHIPPING_BY_COUNTRY[country] != null ? SHIPPING_BY_COUNTRY[country] : DEFAULT_SHIPPING;
}

export const PRODUCTS = [
    {
        id: 'aera-bathroom-organizer',
        name: 'AERA Bathroom Organizer',
        subtitle: 'Stijlvolle badkamerorganizer voor dagelijkse essentials',
        price: 25.00,
        image: 'img/product-organizer.png',
        colors: ['Wit', 'Zwart', 'Lichtgrijs'],
        material: 'PETG',
        description: 'Stevige badkamer-organizer voor zeep, tandenborstels en toiletartikelen. Geprint in waterbestendig PETG.',
    },
    {
        id: 'ancient-skull-pen-holder',
        name: 'Ancient Skull Pen Holder',
        subtitle: 'Gotische pennenhouder voor bureau of werkplek',
        price: 18.95,
        image: 'img/project-skull.png',
        colors: ['Zwart', 'Goud', 'Brons', 'Wit'],
        material: 'PLA',
        description: 'Gedetailleerde pennenhouder in skull-design. Perfect accent voor je bureau.',
    },
    {
        id: 'puffa-desk-organizer',
        name: 'Puffa Desk Organizer',
        subtitle: 'Modulair bureau-organizer voor al je spullen',
        price: 20.95,
        image: 'img/project-puffa.png',
        colors: ['Zwart', 'Wit', 'Blauw', 'Groen'],
        material: 'PLA',
        description: 'Modulair opbergsysteem voor pennen, kabels en kleine accessoires. Combineerbaar.',
    },
    {
        id: 'mario-toilet-holder',
        name: 'Mario Mystery Box Toilet Holder',
        subtitle: 'WC-rolhouder in iconisch Mario design',
        price: 22.95,
        image: 'img/project-mario.png',
        colors: ['Geel', 'Rood', 'Groen', 'Blauw'],
        material: 'PLA',
        description: 'Speelse WC-rolhouder als Super Mario mystery box. Houdt 2 extra rollen vast.',
    },
    {
        id: 'milwaukee-airpod-case',
        name: 'Milwaukee AirPod Pro Case',
        subtitle: 'Robuuste AirPods case in Milwaukee-stijl',
        price: 14.95,
        image: 'img/project-milwaukee.png',
        colors: ['Rood', 'Zwart'],
        material: 'TPU',
        description: 'Schokbestendige AirPods Pro case in herkenbare Milwaukee rood-zwart kleurstelling. Flexibel TPU.',
    },
    {
        id: 'embercore-fire-kit',
        name: 'EmberCore Survival Fire Kit',
        subtitle: 'Tactical firestarter organizer voor outdoor',
        price: 15.95,
        image: 'img/project-embercore.png',
        colors: ['Zwart', 'Olijfgroen', 'Coyote Tan'],
        material: 'PETG',
        description: 'Compacte firestarter-behuizing voor tinder, flint en staal. Water- en UV-bestendig PETG.',
    },
    {
        id: 'modern-key-holder',
        name: 'Modern Key Holder & Planter',
        subtitle: 'Sleutelbakje met geïntegreerde plantenschaal',
        price: 13.95,
        image: 'img/project-keyholder.png',
        colors: ['Wit', 'Zwart', 'Lichtgrijs', 'Crème'],
        material: 'PLA',
        description: 'Elegante entree-bakje voor sleutels, met schaaltje voor een kleine plant of succulent.',
    },
    {
        id: 'norflake-tealight',
        name: 'NORFLAKE Tealight Holder',
        subtitle: 'Scandinavisch geometrisch theelicht',
        price: 12.95,
        image: 'img/project-norflake.png',
        colors: ['Wit', 'Zwart', 'Lichtgrijs'],
        material: 'PLA',
        description: 'Sneeuwvlok-geïnspireerd theelicht met fijne geometrie. Set van 1 inclusief theelicht.',
    },
    {
        id: 'handwrap-roller',
        name: 'Handwrap Roller',
        subtitle: 'Handwrap oproller voor boks-/MMA-training',
        price: 15.95,
        image: 'img/project-handwrap.png',
        colors: ['Zwart', 'Rood', 'Blauw'],
        material: 'PETG',
        description: 'Ergonomische roller voor het opbergen van handwraps. Past standaardmaat handwraps.',
    },
    {
        id: 'dewalt-battery-holder',
        name: 'DeWalt Battery Holder',
        subtitle: 'Wandhouder voor DeWalt 18V / 20V accu\'s',
        price: 13.95,
        image: 'img/product-batteryholder.png',
        colors: ['Geel', 'Zwart'],
        material: 'PETG',
        description: 'Stevige wandmontage voor 3 DeWalt 18V/20V MAX accu\'s. Inclusief schroeven.',
    },
    {
        id: 'lynk-keychain',
        name: 'LYNK Custom Keychain',
        subtitle: 'Gepersonaliseerde sleutelhanger met jouw tekst',
        price: 10.95,
        image: 'img/product-keychain.png',
        colors: ['Zwart', 'Wit', 'Rood', 'Blauw', 'Groen', 'Geel'],
        material: 'PLA',
        description: 'Sleutelhanger met je eigen tekst (maximaal 14 tekens). Vermeld de tekst bij opmerkingen.',
        hasCustomText: true,
    },
];

export function findProduct(id) {
    return PRODUCTS.find(p => p.id === id) || null;
}
