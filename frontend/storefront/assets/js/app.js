import { createCatalogClient } from "./catalog.js";
import { initFrench, t } from "./french.js";
import {
  formatDisplayPrice,
  sumPricesInSameCurrency,
  clearLegacyCurrencyPreference
} from "./currency.js";

const catalogClient = createCatalogClient();
const formatPrice = (product) => formatDisplayPrice(product.price, product.currency);
const page = document.body.dataset.page;
const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
const productText = (product, field) => typeof product[field] === "string"
  ? product[field]
  : product[field].fr;
const productDescription = (product) =>
  escapeHtml(productText(product, "description")).replace(/&lt;br\s*\/?&gt;/gi, "<br>");
const productImage = (product) =>
  new URL(product.image, new URL("../../", import.meta.url)).href;
const cartKey = "pgd-cart";
const normalizeCart = (cart) => [...new Set(cart.filter((productId) => typeof productId === "string"))];
let memoryCart = null;
let cartStorageUnavailable = false;
const useMemoryCart = (cart) => {
  memoryCart = normalizeCart(cart);
  cartStorageUnavailable = true;
  return [...memoryCart];
};
const discardInvalidCart = () => {
  try {
    localStorage.removeItem(cartKey);
    return true;
  } catch {
    return false;
  }
};
const readCart = () => {
  if (memoryCart !== null) return [...memoryCart];

  let stored;
  try {
    stored = localStorage.getItem(cartKey);
  } catch {
    return useMemoryCart([]);
  }
  if (!stored) return [];

  let cart;
  try {
    cart = JSON.parse(stored);
  } catch {
    return discardInvalidCart() ? [] : useMemoryCart([]);
  }
  if (!Array.isArray(cart)) return discardInvalidCart() ? [] : useMemoryCart([]);
  return normalizeCart(cart);
};
const writeCart = (cart) => {
  const normalized = normalizeCart(cart);
  try {
    localStorage.setItem(cartKey, JSON.stringify(normalized));
    memoryCart = null;
    cartStorageUnavailable = false;
    return true;
  } catch {
    useMemoryCart(normalized);
    return false;
  }
};
let catalogProducts = null;
let renderSequence = 0;
function addToCart(productId, button) {
  const cart = readCart();
  const alreadyAdded = cart.includes(productId);
  if (!alreadyAdded) {
    cart.push(productId);
    writeCart(cart);
    updateCartCount();
  }
  const originalContent = button.innerHTML;
  const originalLabel = button.getAttribute("aria-label");
  const message = t(alreadyAdded ? "cart.alreadyAdded" : "cart.added");
  button.innerHTML = `<span class="button-label">${escapeHtml(message)}</span><span class="button-icon" aria-hidden="true">✓</span>`;
  button.setAttribute("aria-label", message);
  button.classList.add("is-added");
  button.disabled = true;
  setTimeout(() => {
    button.innerHTML = originalContent;
    if (originalLabel) button.setAttribute("aria-label", originalLabel);
    else button.removeAttribute("aria-label");
    button.classList.remove("is-added");
    button.disabled = false;
  }, 1600);
}

function showCatalogLoading(target) {
  const homeClass = target.hasAttribute("data-home-catalog-state") ? " catalog-state--home" : "";
  target.innerHTML = `<div class="catalog-state${homeClass}" role="status" aria-live="polite">${escapeHtml(t("catalog.loading"))}</div>`;
}

function showCatalogError(target, error) {
  const messageKey = error?.code === "network"
    ? "catalog.networkError"
    : error?.code === "http"
      ? "catalog.httpError"
      : "catalog.invalidResponse";
  const homeClass = target.hasAttribute("data-home-catalog-state") ? " catalog-state--home" : "";
  target.innerHTML = `<div class="catalog-state${homeClass}" role="alert"><p>${escapeHtml(t(messageKey))}</p><button class="button button-outline" type="button" data-catalog-retry>${escapeHtml(t("catalog.retry"))}</button></div>`;
}

function showMissingProduct(target, messageKey) {
  target.innerHTML = `<div class="catalog-state" role="status"><p>${escapeHtml(t(messageKey))}</p><a class="button button-outline" href="boutique.html">${escapeHtml(t("catalog.backToShop"))}</a><button class="button button-outline" type="button" data-catalog-retry>${escapeHtml(t("catalog.retry"))}</button></div>`;
}

function showHomeCatalogState(error = null) {
  const hero = document.querySelector(".hero");
  const heroCopy = hero?.querySelector(".hero-copy");
  const featuredProducts = document.getElementById("featured-products");
  if (!hero || !heroCopy || !featuredProducts) {
    if (featuredProducts) {
      if (error) showCatalogError(featuredProducts, error);
      else showCatalogLoading(featuredProducts);
    }
    return;
  }

  hero.classList.add("hero--catalog-unavailable");
  const heroArt = document.getElementById("home-hero-products");
  if (heroArt) heroArt.hidden = true;
  const featuredSection = featuredProducts.closest(".section");
  if (featuredSection) featuredSection.hidden = true;

  let target = heroCopy.querySelector("[data-home-catalog-state]");
  if (!target) {
    target = document.createElement("div");
    target.dataset.homeCatalogState = "true";
    heroCopy.append(target);
  }
  if (error) showCatalogError(target, error);
  else showCatalogLoading(target);
}

function showHomeCatalogEmpty() {
  showHomeCatalogState();
  const target = document.querySelector("[data-home-catalog-state]");
  if (target) {
    target.innerHTML = `<div class="catalog-state catalog-state--home" role="status"><p>${escapeHtml(t("catalog.noProducts"))}</p></div>`;
  }
}

function clearHomeCatalogState() {
  const hero = document.querySelector(".hero");
  hero?.classList.remove("hero--catalog-unavailable");
  hero?.querySelector("[data-home-catalog-state]")?.remove();
  const featuredProducts = document.getElementById("featured-products");
  const featuredSection = featuredProducts?.closest(".section");
  if (featuredSection) featuredSection.hidden = false;
}

function renderChrome() {
  const main = document.querySelector("main");
  if (main && !main.id) main.id = "main-content";
  if (!document.querySelector(".skip-link")) {
    const skipLink = document.createElement("a");
    skipLink.className = "skip-link";
    skipLink.href = "#main-content";
    skipLink.textContent = "Aller au contenu";
    document.body.prepend(skipLink);
  }
  if (!document.querySelector("link[rel=icon]")) {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.href = "assets/Background/logo-bronze.png";
    document.head.append(icon);
  }
  const checkoutStep = { cart: 1, checkout: 2 }[page] || 0;
  const progressLabels = ["Sélection", "Commande"];
  const checkoutProgress = checkoutStep
    ? `<nav class="checkout-progress-nav" aria-label="Progression de commande">
      <ol class="checkout-progress">
        ${progressLabels.slice(0, 2).map((label, index) => {
          const step = index + 1;
          const state = step === checkoutStep ? " is-current" : step < checkoutStep ? " is-complete" : "";
          const current = step === checkoutStep ? ' aria-current="step"' : "";
          return `<li class="checkout-progress__step${state}"${current}><span class="checkout-progress__number" aria-hidden="true">${step}</span><span>${label}</span></li>`;
        }).join("")}
      </ol>
    </nav>`
    : "";
  document.querySelector("[data-header]").innerHTML = `
    <div class="header-inner">
      <a class="brand" href="index.html" aria-label="${t("navigation.brandHome")}" data-i18n-aria-label="navigation.brandHome">
        <img src="assets/Background/logo-bronze.png" alt="" width="44" height="49">
        <span>PGD</span><span>Market</span>
      </a>
      <nav id="main-nav" class="main-nav" aria-label="${t("navigation.mainNavigation")}" data-i18n-aria-label="navigation.mainNavigation">
        <a href="boutique.html" data-i18n="navigation.shop"></a>
        <a href="contact.html" data-i18n="navigation.contact"></a>
      </nav>
      <a class="cart-link" href="panier.html" aria-label="${t("navigation.cart")}">
        <svg class="cart-link__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 4.5h2l2.1 10.1a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.9-1.5l1.4-6.2H7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="19.5" r="1" fill="currentColor"/><circle cx="17.5" cy="19.5" r="1" fill="currentColor"/></svg>
        <span class="cart-link__label" data-i18n="navigation.cart"></span>
        <span class="cart-count" data-cart-count aria-hidden="true">0</span>
      </a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="main-nav" aria-label="${t("navigation.openMenu")}" data-i18n-aria-label="navigation.openMenu">
        <span class="menu-toggle-label" data-i18n="navigation.menu"></span><span class="menu-toggle-icon" aria-hidden="true"></span>
      </button>
    </div>
    ${checkoutProgress}`;
  document.querySelector("[data-footer]").innerHTML = `
    <div class="footer-inner">
      <div class="footer-brand-block">
        <p class="footer-kicker" data-i18n="footer.signature"></p>
        <a class="brand footer-brand" href="index.html" aria-label="${t("navigation.brandHome")}" data-i18n-aria-label="navigation.brandHome">
          <img src="assets/Background/logo-champagne.png" alt="" width="28" height="32">
          <span>PGD</span><span>Market</span>
        </a>
        <p class="footer-description" data-i18n="footer.description"></p>
        <a class="footer-cta" href="boutique.html">
          <span data-i18n="footer.shopCta"></span><span aria-hidden="true">↗</span>
        </a>
      </div>
      <nav class="footer-column" aria-label="${t("footer.explore")}" data-i18n-aria-label="footer.explore">
        <strong data-i18n="footer.explore"></strong>
        <a href="boutique.html" data-i18n="navigation.shop"></a>
        <a href="panier.html" data-i18n="navigation.cart"></a>
        <a href="contact.html" data-i18n="navigation.contact"></a>
      </nav>
      <nav class="footer-column" aria-label="${t("footer.information")}" data-i18n-aria-label="footer.information">
        <strong data-i18n="footer.information"></strong>
        <a href="mentions-legales.html" data-i18n="legal.title"></a>
        <a href="politique-confidentialite.html" data-i18n="footer.privacy"></a>
      </nav>
    </div>
    <div class="footer-bottom">
      <span data-i18n="footer.copyright"></span>
      <span class="footer-note" data-i18n="footer.brandNote"></span>
    </div>`;
  const toggle = document.querySelector(".menu-toggle");
  const nav = document.querySelector(".main-nav");
  const currentHref = location.pathname.split("/").pop() || "index.html";
  const shopLink = nav.querySelector('a[href="boutique.html"]');
  const contactLink = nav.querySelector('a[href="contact.html"]');
  const cartLink = document.querySelector(".cart-link");
  if (page === "home") document.querySelector(".brand").setAttribute("aria-current", "page");
  if (page === "shop") shopLink.setAttribute("aria-current", "page");
  if (page === "product") shopLink.setAttribute("aria-current", "location");
  if (page === "info" && currentHref === "contact.html") contactLink.setAttribute("aria-current", "page");
  if (page === "cart") cartLink.setAttribute("aria-current", "page");
  if (page === "checkout") cartLink.setAttribute("aria-current", "location");
  if (!document.querySelector(".site-header [aria-current]")) {
    document.querySelectorAll(".footer-column a[href]").forEach((link) => {
      if (link.getAttribute("href") === currentHref) link.setAttribute("aria-current", "page");
    });
  }
  const closeMenu = () => {
    toggle.setAttribute("aria-expanded", "false");
    nav.classList.remove("is-open");
    updateMenuToggleLabel(toggle);
  };
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    nav.classList.toggle("is-open", !open);
    updateMenuToggleLabel(toggle);
  });
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".site-header") && toggle.getAttribute("aria-expanded") === "true") {
      closeMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      closeMenu();
      toggle.focus();
    }
  });
  updateCartCount();
}

function updateMenuToggleLabel(toggle = document.querySelector(".menu-toggle")) {
  if (!toggle) return;
  const isOpen = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-label", t(isOpen ? "navigation.closeMenu" : "navigation.openMenu"));
}

function productCard(product, index = 0) {
  const productUrl = `produit.html?id=${encodeURIComponent(product.id)}`;
  const name = productText(product, "name");
  const image = `<img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" width="720" height="720">`;
  const description = productText(product, "description")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const excerpt = description.length > 154
    ? `${description.slice(0, 151).trimEnd()}…`
    : description;
  return `
    <article class="product-card">
      <span class="product-card__index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
      <div class="product-card__visual">
        <a class="product-image" href="${productUrl}" aria-label="${escapeHtml(t("product.view"))} : ${escapeHtml(name)}">${image}</a>
        <span class="product-card__image-note" aria-hidden="true">PGD Market · Ressource numérique</span>
      </div>
      <div class="product-card-body">
        <h3>${escapeHtml(name)}</h3>
        <p class="product-card__description">${escapeHtml(excerpt)}</p>
        <div class="product-card-footer">
          <strong>${escapeHtml(formatPrice(product))}</strong>
          <span>Format numérique</span>
        </div>
        <div class="product-actions">
          <button class="button button-primary product-card__add" type="button" data-add-cart="${escapeHtml(product.id)}">
            <span class="button-label">${escapeHtml(t("product.add"))}</span><span class="button-icon" aria-hidden="true">+</span>
          </button>
          <a class="text-link product-card__view" href="${productUrl}">${escapeHtml(t("product.view"))}<span aria-hidden="true">→</span></a>
        </div>
      </div>
    </article>`;
}

function bindCartButtons(root = document) { root.querySelectorAll("[data-add-cart]").forEach((button) => button.addEventListener("click", () => addToCart(button.dataset.addCart, button))); }
function updateCartCount() {
  const count = readCart().length;
  document.querySelectorAll("[data-cart-count]").forEach((element) => {
    element.textContent = count;
  });
  document.querySelectorAll(".cart-link").forEach((link) => {
    const labelKey = count === 0
      ? "navigation.cartCountEmpty"
      : count === 1
        ? "navigation.cartCountOne"
        : "navigation.cartCountMany";
    link.setAttribute("aria-label", t(labelKey, { count }));
  });
  const main = document.querySelector("main");
  const existingWarning = main?.querySelector("[data-cart-storage-warning]");
  if (!cartStorageUnavailable) {
    existingWarning?.remove();
    return;
  }
  if (!main) return;
  const warning = existingWarning || document.createElement("p");
  warning.className = "cart-storage-warning";
  warning.dataset.cartStorageWarning = "true";
  warning.setAttribute("role", "status");
  warning.setAttribute("aria-live", "polite");
  warning.textContent = "Le panier n’a pas pu être enregistré sur cet appareil. Il reste disponible jusqu’à la fermeture ou l’actualisation de cette page.";
  if (!existingWarning) main.prepend(warning);
}
function setupShop() {
  const output = document.getElementById("shop-products");
  const search = document.getElementById("search");
  const category = document.getElementById("category");
  const sort = document.getElementById("sort");
  const priceSortOptions = [...sort.options].filter((option) =>
    option.value === "price-up" || option.value === "price-down"
  );
  const render = () => {
    let result = catalogProducts.filter((product) =>
      productText(product, "name").toLocaleLowerCase()
        .includes(search.value.toLocaleLowerCase()) &&
      (!category.value || product.category === category.value)
    );
    const hasComparablePrices = new Set(result.map((product) => product.currency)).size <= 1;
    priceSortOptions.forEach((option) => { option.disabled = !hasComparablePrices; });
    if (!hasComparablePrices && (sort.value === "price-up" || sort.value === "price-down")) {
      sort.value = "default";
    }
    if (sort.value === "name") {
      result.sort((a, b) => productText(a, "name").localeCompare(productText(b, "name")));
    }
    if (sort.value === "price-up") {
      result.sort((a, b) => a.price - b.price);
    }
    if (sort.value === "price-down") {
      result.sort((a, b) => b.price - a.price);
    }
    output.innerHTML = result.length
      ? result.map((product, index) => productCard(product, index)).join("")
      : `<div class="catalog-state" role="status">${escapeHtml(t("shop.noResults"))}</div>`;
    document.getElementById("result-count").textContent =
      `${result.length} ${result.length === 1 ? t("shop.resultOne") : t("shop.resultMany")}`;
    bindCartButtons(output);
  };
  if (!output.dataset.bound) {
    const categories = [...new Set(catalogProducts.map((product) => product.category).filter(Boolean))];
    categories.forEach((value) => category.add(new Option(value, value)));
    category.closest("label").hidden = categories.length === 0;
    [search, category, sort].forEach((element) => element.addEventListener("input", render));
    sort.addEventListener("change", render);
    output.dataset.bound = "true";
  }
  render();
}

function setupHome() {
  clearHomeCatalogState();
  const output = document.getElementById("featured-products");
  const heroArt = document.getElementById("home-hero-products");
  if (!catalogProducts.length) {
    output.innerHTML = "";
    showHomeCatalogEmpty();
    return;
  }
  const [backProduct, frontProduct] = catalogProducts;
  if (heroArt && backProduct) {
    const backCover = `<figure class="hero-art__book hero-art__book--back"><img src="${escapeHtml(productImage(backProduct))}" alt="" width="720" height="720"></figure>`;
    const frontCover = frontProduct
      ? `<figure class="hero-art__book hero-art__book--front"><img src="${escapeHtml(productImage(frontProduct))}" alt="" width="720" height="720"></figure>`
      : "";
    heroArt.innerHTML = `
      ${backCover}
      <div class="hero-art__folio"><span>PGD MARKET · GUIDES NUMÉRIQUES</span></div>
      ${frontCover}
      <span class="hero-art__seal" aria-hidden="true">PGD</span>
      <span class="hero-art__caption">Guides pratiques<br>Format numérique</span>`;
    heroArt.hidden = false;
  } else if (heroArt) {
    heroArt.hidden = true;
  }
  output.innerHTML = catalogProducts.length
    ? catalogProducts.map((product, index) => productCard(product, index)).join("")
    : `<div class="catalog-state" role="status">${escapeHtml(t("catalog.noProducts"))}</div>`;
  bindCartButtons(output);
}
let productStickyObserver;
let productStickyCleanup;
function bindProductSticky(target) { productStickyObserver?.disconnect(); productStickyCleanup?.(); const sticky = target.querySelector(".product-sticky-cta"); const realCta = target.querySelector(".product-purchase .product-actions .button-primary"); if (!sticky || !realCta || !window.matchMedia("(max-width: 699px)").matches) return; const updateVisibility = () => { const realRect = realCta.getBoundingClientRect(); const showSticky = realRect.bottom <= 0; sticky.classList.toggle("is-hidden", !showSticky); }; const handleScroll = () => requestAnimationFrame(updateVisibility); window.addEventListener("scroll", handleScroll, { passive: true }); window.addEventListener("resize", updateVisibility); productStickyCleanup = () => { window.removeEventListener("scroll", handleScroll); window.removeEventListener("resize", updateVisibility); }; if ("IntersectionObserver" in window) { productStickyObserver = new IntersectionObserver(updateVisibility, { threshold: [0, 0.01, 1] }); productStickyObserver.observe(realCta); } updateVisibility(); }
function setupProduct(product) {
  const target = document.getElementById("product-detail");
  if (!product) {
    document.title = t("titles.product");
    showMissingProduct(target, "product.notFound");
    return;
  }
  const name = productText(product, "name");
  document.title = `${name} | ${t("siteName")}`;
  const checkoutUrl = `commande.html?id=${encodeURIComponent(product.id)}`;
  const actions = `<div class="product-actions"><a class="button button-primary" href="${checkoutUrl}"><span>${escapeHtml(t("product.order"))}</span><span aria-hidden="true">→</span></a><button class="button button-cart" type="button" data-add-cart="${escapeHtml(product.id)}"><span class="button-label">${escapeHtml(t("product.add"))}</span><span class="button-icon" aria-hidden="true">+</span></button></div>`;
  const paymentLogos = [{ name: "Orange Money", file: "orange-money.svg" }, { name: "Moov Money", file: "moov-money.png" }, { name: "Wave", file: "wave.svg" }, { name: "Visa", file: "visa.svg" }, { name: "Mastercard", file: "mastercard.svg" }, { name: "Bitcoin", file: "bitcoin.svg" }];
  const paymentMethods = `<div class="payment-methods" aria-label="${escapeHtml(t("productDetails.paymentMethods"))}"><p>${escapeHtml(t("productDetails.paymentMethods"))}</p><div class="payment-method-list">${paymentLogos.map((payment) => `<span class="payment-method"><img src="assets/payments/${payment.file}" alt="${payment.name}"></span>`).join("")}</div></div>`;
  const purchasePanel = `<aside class="product-purchase" aria-label="${escapeHtml(t("productDetails.purchaseOverview"))}"><p class="purchase-label">${escapeHtml(t("productDetails.purchaseOverview"))}</p><p class="product-price">${escapeHtml(formatPrice(product))}</p>${actions}${paymentMethods}<div class="purchase-links"><a href="contact.html">${escapeHtml(t("navigation.contact"))}</a><span aria-hidden="true">|</span><a href="contact.html">${escapeHtml(t("productDetails.report"))}</a></div><details class="purchase-help"><summary>${escapeHtml(t("productDetails.purchaseHelpTitle"))}</summary><p>Chariow gère le paiement et, si nécessaire, la conversion de devise au moment du règlement.</p></details></aside>`;
  const stickyAction = `<div class="product-sticky-cta is-hidden"><strong>${escapeHtml(formatPrice(product))}</strong><a class="button button-primary" href="${checkoutUrl}">${escapeHtml(t("product.order"))}</a></div>`;
  const description = productDescription(product);
  target.innerHTML = `<div class="product-heading"><h1>${escapeHtml(name)}</h1></div><div class="product-left"><div class="product-visual"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(name)}" width="900" height="900"></div><div class="rich-description">${description}</div></div>${purchasePanel}${stickyAction}`;
  bindCartButtons(target);
  bindProductSticky(target);
}
function mapPaymentError(error) {
  const message = String(error?.message || "");
  if (message === "ALREADY_PURCHASED") return t("checkout.alreadyPurchased");
  if (/produit|product|vente|sale/i.test(message)) return t("errors.productUnavailable");
  if (/initialiser|initialize|paiement|payment|indisponible|unavailable|checkout|CHARIOW_/i.test(message)) {
    return t("checkout.paymentFailed");
  }
  return t("errors.unknown");
}
function setupCheckout(product) {
  const summary = document.getElementById("checkout-summary");
  const form = document.getElementById("checkout-form");
  if (!product) {
    form.hidden = true;
    showMissingProduct(summary, "checkout.unavailableText");
    return;
  }
  form.hidden = false;
  const name = productText(product, "name");
  summary.innerHTML = `<img src="${escapeHtml(productImage(product))}" alt="" width="720" height="720"><p class="summary-panel__label">${escapeHtml(t("checkout.summary"))}</p><h2>${escapeHtml(name)}</h2><div class="summary-panel__total"><span>Montant de la commande</span><strong>${escapeHtml(formatPrice(product))}</strong></div>`;
  if (form.dataset.bound) return;
  form.dataset.bound = "true";
  const phoneCountryCodeInput = document.getElementById("phone-country-code");
  const nameInput = document.getElementById("nom");
  const emailInput = document.getElementById("email");
  const phoneInput = document.getElementById("phone");
  let isSubmitting = false;
  const clearFieldError = (input) => {
    input.removeAttribute("aria-invalid");
    const descriptions = (input.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((description) => description && description !== "payment-message");
    if (descriptions.length) input.setAttribute("aria-describedby", descriptions.join(" "));
    else input.removeAttribute("aria-describedby");
  };
  const markFieldInvalid = (input) => {
    input.setAttribute("aria-invalid", "true");
    const descriptions = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    descriptions.add("payment-message");
    input.setAttribute("aria-describedby", [...descriptions].join(" "));
  };
  const normalizePhoneCountryCode = () => {
    phoneCountryCodeInput.value = phoneCountryCodeInput.value.trim().toUpperCase();
  };
  phoneCountryCodeInput.addEventListener("input", normalizePhoneCountryCode);
  phoneCountryCodeInput.addEventListener("change", normalizePhoneCountryCode);
  [nameInput, emailInput, phoneInput, phoneCountryCodeInput].forEach((input) => {
    input.addEventListener("input", () => clearFieldError(input));
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    const button = form.querySelector("button[type=submit]");
    const buttonText = button.querySelector(".button-text-animate");
    const originalButtonText = buttonText.textContent;
    const message = document.getElementById("payment-message");
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();
    const phoneCountryCode = phoneCountryCodeInput.value.trim().toUpperCase();
    form.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
    message.textContent = "";
    if (!name) {
      message.textContent = t("checkout.nameRequired");
      markFieldInvalid(nameInput);
      nameInput.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      message.textContent = t("checkout.emailInvalid");
      markFieldInvalid(emailInput);
      emailInput.focus();
      return;
    }
    if (phone.replace(/\D/g, "").length < 6 || !/^[A-Z]{2}$/.test(phoneCountryCode)) {
      message.textContent = t("checkout.phoneInvalid");
      const invalidPhone = phone.replace(/\D/g, "").length < 6;
      const invalidCountryCode = !/^[A-Z]{2}$/.test(phoneCountryCode);
      if (invalidPhone) markFieldInvalid(phoneInput);
      if (invalidCountryCode) markFieldInvalid(phoneCountryCodeInput);
      (invalidPhone ? phoneInput : phoneCountryCodeInput).focus();
      return;
    }
    isSubmitting = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    buttonText.textContent = t("checkout.preparing");
    message.classList.add("is-loading");
    message.textContent = t("checkout.preparing");
    try {
      const response = await fetch("/.netlify/functions/create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nom: name,
          email,
          phone,
          phoneCountryCode,
          produitId: product.chariowProductId
        })
      });
      let data;
      try { data = await response.json(); } catch { throw new Error("invalid-json"); }
      if (!response.ok) throw new Error(data.code || data.error || "server-error");
      if (data.status === "completed") {
        location.href = "success.html";
        return;
      }
      const url = data.checkout_url || "";
      if (data.status !== "payment" || !url) throw new Error("missing-payment-data");
      location.href = url;
    } catch (error) {
      const knownErrors = ["invalid-json", "missing-payment-data", "server-error"];
      message.textContent = knownErrors.includes(error.message)
        ? (error.message === "missing-payment-data" ? t("checkout.paymentLinkMissing") : t("checkout.paymentFailed"))
        : mapPaymentError(error);
      message.classList.remove("is-loading");
      isSubmitting = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      buttonText.textContent = originalButtonText;
    }
  });
}
function setupCart() {
  const content = document.getElementById("cart-content");
  const ids = readCart();
  const productById = new Map(catalogProducts.map((product) => [product.id, product]));
  const items = ids.map((id) => productById.get(id)).filter(Boolean);
  const staleIds = ids.filter((id) => !productById.has(id));
  const staleNotice = staleIds.length
    ? `<div class="catalog-state" role="status"><p>${escapeHtml(t("cart.staleReferences", { count: staleIds.length }))}</p><button class="button button-danger" type="button" data-remove-stale>${escapeHtml(t("cart.removeStale"))}</button></div>`
    : "";
  if (!items.length) {
    content.innerHTML = `${staleNotice}<section class="cart-empty" aria-labelledby="cart-empty-title">
      <span class="cart-empty__mark" aria-hidden="true">
        <svg viewBox="0 0 48 48" fill="none"><path d="M10 17h28l-3 23H13l-3-23Z" stroke="currentColor" stroke-width="1.5"/><path d="M17 19v-5a7 7 0 0 1 14 0v5M18 25v.5M30 25v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </span>
      <h2 id="cart-empty-title">${escapeHtml(t("cart.empty"))}</h2>
      <p class="cart-empty__copy">${escapeHtml(t("cart.emptyDescription"))}</p>
      <a class="button button-primary" href="boutique.html"><span>${escapeHtml(t("cart.discover"))}</span><span aria-hidden="true">→</span></a>
    </section>`;
  } else {
    const cartTotal = sumPricesInSameCurrency(items);
    const hasMixedCurrencies = new Set(items.map((product) => product.currency)).size > 1;
    const totalMarkup = cartTotal
      ? `<div class="cart-summary__total"><span>${escapeHtml(t("cart.total"))}</span><strong>${escapeHtml(formatDisplayPrice(cartTotal.amount, cartTotal.currency))}</strong></div>`
      : hasMixedCurrencies
        ? `<p class="cart-summary__currency-note">Aucun total global n’est affiché : les produits utilisent des devises différentes. Passez chaque commande séparément.</p>`
        : "";
    const rows = items.map((product) => {
      const name = productText(product, "name");
      const productUrl = `produit.html?id=${encodeURIComponent(product.id)}`;
      return `      <article class="cart-item">
        <a class="cart-item__visual" href="${productUrl}" aria-label="${escapeHtml(t("product.view"))} : ${escapeHtml(name)}"><img src="${escapeHtml(productImage(product))}" alt="" loading="lazy" decoding="async" width="160" height="160"></a>
        <div class="cart-item__details">
          <h2><a href="${productUrl}">${escapeHtml(name)}</a></h2>
          <div class="cart-item__meta">
            <strong>${escapeHtml(formatPrice(product))}</strong>
            <span class="cart-item__quantity"><span>${escapeHtml(t("cart.quantity"))}</span><b>1</b></span>
          </div>
        </div>
        <button class="button button-remove" type="button" data-remove="${escapeHtml(product.id)}">
          <span class="button-remove__icon" aria-hidden="true">−</span><span>${escapeHtml(t("cart.remove"))}</span>
        </button>
      </article>`;
    }).join("");
    const checkout = items.length === 1
      ? `<a class="button button-primary" href="commande.html?id=${encodeURIComponent(items[0].id)}"><span>${escapeHtml(t("cart.checkout"))}</span><span aria-hidden="true">→</span></a>`
      : `<div class="cart-order-options"><p class="form-message">${escapeHtml(t("cart.groupUnavailable"))}</p>${items.map((product) => `<a class="text-link" href="commande.html?id=${encodeURIComponent(product.id)}">${escapeHtml(t("cart.singleCheckout"))} : ${escapeHtml(productText(product, "name"))}<span aria-hidden="true">→</span></a>`).join("")}</div>`;
    const itemCountLabel = items.length === 1 ? "cart.itemOne" : "cart.itemMany";
    content.innerHTML = `${staleNotice}
      <div class="cart-items">${rows}</div>
      <aside class="cart-summary" aria-label="${escapeHtml(t("cart.summary"))}">
        <h2>${escapeHtml(t("cart.summary"))}</h2>
        <div class="cart-summary__count"><span>${escapeHtml(t(itemCountLabel, { count: items.length }))}</span><span>${escapeHtml(t("cart.quantity"))} <b>${items.length}</b></span></div>
        ${totalMarkup}
        <p class="cart-summary__note">${escapeHtml(t("cart.summaryNote"))}</p>
        <div class="cart-actions">${checkout}<button class="button button-clear" type="button" data-clear-cart>${escapeHtml(t("cart.clear"))}</button></div>
      </aside>`;
    content.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
      writeCart(ids.filter((id) => id !== button.dataset.remove));
      setupCart();
      updateCartCount();
    }));
    content.querySelector("[data-clear-cart]").addEventListener("click", () => {
      writeCart([]);
      setupCart();
      updateCartCount();
    });
  }
  content.querySelector("[data-remove-stale]")?.addEventListener("click", () => {
    writeCart(items.map((product) => product.id));
    setupCart();
    updateCartCount();
  });
}
function setupResult() {
  const isSuccess = page === "success";
  const target = document.getElementById("result-content");

  if (!isSuccess) {
    document.title = t("extra.cancelTitle");
    target.innerHTML = `<p class="result-icon result-icon-error" aria-hidden="true">×</p><h1>${t("extra.cancelTitle")}</h1><p>${t("extra.cancelText")}</p><a class="button button-primary" href="boutique.html">${t("extra.backShop")}</a>`;
    return;
  }

  document.title = "Retour du paiement | PGD Market";
  target.innerHTML = `<h1>Retour du paiement</h1><p class="result-intro">Vous êtes revenu de la page de paiement Chariow.</p><p class="result-intro">Cette page ne confirme pas à elle seule le statut de la transaction.</p><a class="button button-outline result-back" href="index.html">Retour à l’accueil</a>`;
}

async function renderPage({ retryCatalog = false } = {}) {
  const sequence = ++renderSequence;
  if (page === "success" || page === "cancel") {
    setupResult();
    return;
  }
  if (!["home", "shop", "product", "checkout", "cart"].includes(page)) return;

  const target = {
    home: document.getElementById("featured-products"),
    shop: document.getElementById("shop-products"),
    product: document.getElementById("product-detail"),
    checkout: document.getElementById("checkout-summary"),
    cart: document.getElementById("cart-content")
  }[page];

  if (retryCatalog || catalogProducts === null) {
    catalogProducts = null;
    if (page === "home") showHomeCatalogState();
    else showCatalogLoading(target);
    if (page === "checkout") document.getElementById("checkout-form").hidden = true;
  }

  try {
    catalogProducts = retryCatalog
      ? await catalogClient.retry()
      : await catalogClient.load();
  } catch (error) {
    if (sequence !== renderSequence) return;
    catalogProducts = null;
    if (page === "home") showHomeCatalogState(error);
    else showCatalogError(target, error);
    return;
  }

  if (sequence !== renderSequence) return;
  switch (page) {
    case "home":
      setupHome();
      break;
    case "shop":
      setupShop();
      break;
    case "product": {
      const id = new URLSearchParams(location.search).get("id");
      setupProduct(catalogProducts.find((product) => product.id === id));
      break;
    }
    case "checkout": {
      const id = new URLSearchParams(location.search).get("id");
      setupCheckout(catalogProducts.find((product) => product.id === id));
      break;
    }
    case "cart":
      setupCart();
      break;
  }
}

renderChrome();
clearLegacyCurrencyPreference();
await initFrench();
updateMenuToggleLabel();
updateCartCount();
renderPage();

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-catalog-retry]")) {
    void renderPage({ retryCatalog: true });
  }
});
