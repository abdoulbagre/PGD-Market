import {
  createCatalogClient,
  findCatalogProduct,
  getOriginalProductPrice,
  getProductDiscountPercentage,
  plainTextDescription,
  renderProductRating
} from "./catalog.js";
import { initFrench, t } from "./french.js";
import {
  formatDisplayPrice,
  clearLegacyCurrencyPreference
} from "./currency.js";

const catalogClient = createCatalogClient();
const formatPrice = (product) => formatDisplayPrice(product.price, product.currency);
const originalPriceMarkup = (product) => {
  const originalPrice = getOriginalProductPrice(product);
  return originalPrice === null
    ? ""
    : `<del class="product-price-original">${escapeHtml(formatDisplayPrice(originalPrice, product.currency))}</del>`;
};
const discountBadgeMarkup = (product) => {
  const discount = getProductDiscountPercentage(product);
  return discount === null
    ? ""
    : `<span class="product-card__discount-badge">${escapeHtml(discount)} OFF</span>`;
};
const page = document.body.dataset.page;
const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
const productText = (product, field) => typeof product[field] === "string"
  ? product[field]
  : product[field].fr;
const productDescription = (product) =>
  escapeHtml(plainTextDescription(productText(product, "description"))).replace(/\n/g, "<br>");
const productImage = (product) =>
  new URL(product.image, new URL("../../", import.meta.url)).href;
let catalogProducts = null;
let renderSequence = 0;

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
  const checkoutStep = page === "checkout" ? 1 : 0;
  const progressLabels = ["Commande"];
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
        <a href="index.html" data-i18n="navigation.home"></a>
        <a href="boutique.html" data-i18n="navigation.shop"></a>
        <a href="contact.html" data-i18n="navigation.contact"></a>
      </nav>
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
  const homeLink = nav.querySelector('a[href="index.html"]');
  const shopLink = nav.querySelector('a[href="boutique.html"]');
  const contactLink = nav.querySelector('a[href="contact.html"]');
  if (page === "home") homeLink.setAttribute("aria-current", "page");
  if (page === "shop") shopLink.setAttribute("aria-current", "page");
  if (page === "product") shopLink.setAttribute("aria-current", "location");
  if (page === "info" && currentHref === "contact.html") contactLink.setAttribute("aria-current", "page");
  if (page === "checkout") shopLink.setAttribute("aria-current", "location");
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
  const description = plainTextDescription(productText(product, "description"))
    .replace(/\s+/g, " ");
  const excerpt = description.length > 154
    ? `${description.slice(0, 151).trimEnd()}…`
    : description;
  return `
    <article class="product-card">
      <span class="product-card__index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
      <div class="product-card__visual">
        <a class="product-image" href="${productUrl}" aria-label="${escapeHtml(t("product.view"))} : ${escapeHtml(name)}">${image}</a>
        ${discountBadgeMarkup(product)}
        <span class="product-card__image-note" aria-hidden="true">PGD Market · Ressource numérique</span>
      </div>
      <div class="product-card-body">
        <h3>${escapeHtml(name)}</h3>
        <p class="product-card__description">${escapeHtml(excerpt)}</p>
        ${renderProductRating(product.rating, t("product.ratingLabel", { rating: product.rating }))}
        <div class="product-card-footer">
          <div class="product-card-price">
            <strong>${escapeHtml(formatPrice(product))}</strong>
            ${originalPriceMarkup(product)}
          </div>
          <span>Format numérique</span>
        </div>
        <div class="product-actions">
          <a class="button product-card__view" href="${productUrl}">${escapeHtml(t("product.view"))}<span aria-hidden="true">→</span></a>
        </div>
      </div>
    </article>`;
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
  const actions = `<div class="product-actions"><a class="button button-primary" href="${checkoutUrl}"><span>${escapeHtml(t("product.order"))}</span><span aria-hidden="true">→</span></a></div>`;
  const paymentLogos = [{ name: "Orange Money", file: "orange-money.svg" }, { name: "Moov Money", file: "moov-money.png" }, { name: "Wave", file: "wave.svg" }, { name: "Visa", file: "visa.svg" }, { name: "Mastercard", file: "mastercard.svg" }, { name: "Bitcoin", file: "bitcoin.svg" }];
  const paymentMethods = `<div class="payment-methods" aria-label="${escapeHtml(t("productDetails.paymentMethods"))}"><p>${escapeHtml(t("productDetails.paymentMethods"))}</p><div class="payment-method-list">${paymentLogos.map((payment) => `<span class="payment-method"><img src="assets/payments/${payment.file}" alt="${payment.name}"></span>`).join("")}</div></div>`;
  const purchasePanel = `<aside class="product-purchase" aria-label="${escapeHtml(t("productDetails.purchaseOverview"))}"><p class="purchase-label">${escapeHtml(t("productDetails.purchaseOverview"))}</p><div class="product-purchase__prices"><p class="product-price">${escapeHtml(formatPrice(product))}</p>${originalPriceMarkup(product)}</div>${actions}${paymentMethods}<div class="purchase-links"><a href="contact.html">${escapeHtml(t("navigation.contact"))}</a><span aria-hidden="true">|</span><a href="contact.html">${escapeHtml(t("productDetails.report"))}</a></div><details class="purchase-help"><summary>${escapeHtml(t("productDetails.purchaseHelpTitle"))}</summary><p>Le paiement et, si nécessaire, la conversion de devise sont pris en charge au moment du règlement.</p></details></aside>`;
  const stickyAction = `<div class="product-sticky-cta is-hidden"><div class="product-sticky-cta__prices"><strong>${escapeHtml(formatPrice(product))}</strong>${originalPriceMarkup(product)}</div><a class="button button-primary" href="${checkoutUrl}">${escapeHtml(t("product.order"))}</a></div>`;
  const description = productDescription(product);
  target.innerHTML = `<div class="product-visual"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(name)}" width="900" height="900"></div><div class="product-heading"><h1>${escapeHtml(name)}</h1></div>${purchasePanel}<div class="rich-description">${renderProductRating(product.rating, t("product.ratingLabel", { rating: product.rating }))}${description}</div>${stickyAction}`;
  bindProductSticky(target);
}
function productFromUrlId(id) {
  return findCatalogProduct(catalogProducts, id);
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
  const firstNameInput = document.getElementById("first-name");
  const lastNameInput = document.getElementById("last-name");
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
  [firstNameInput, lastNameInput, emailInput, phoneInput, phoneCountryCodeInput].forEach((input) => {
    input.addEventListener("input", () => clearFieldError(input));
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    const button = form.querySelector("button[type=submit]");
    const buttonText = button.querySelector(".button-text-animate");
    const originalButtonText = buttonText.textContent;
    const message = document.getElementById("payment-message");
    const firstName = firstNameInput.value.trim();
    const lastName = lastNameInput.value.trim();
    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();
    const phoneCountryCode = phoneCountryCodeInput.value.trim().toUpperCase();
    form.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
    message.textContent = "";
    if (!firstName || !lastName) {
      message.textContent = t("checkout.nameRequired");
      if (!firstName) markFieldInvalid(firstNameInput);
      if (!lastName) markFieldInvalid(lastNameInput);
      (!firstName ? firstNameInput : lastNameInput).focus();
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
          product_id: product.id,
          email,
          first_name: firstName,
          last_name: lastName,
          phone: {
            number: phone,
            country_code: phoneCountryCode
          }
        })
      });
      let data;
      try { data = await response.json(); } catch { throw new Error("invalid-json"); }
      if (!response.ok) throw new Error(data.code || data.error || "server-error");
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
async function renderPage({ retryCatalog = false } = {}) {
  const sequence = ++renderSequence;
  if (!["home", "shop", "product", "checkout"].includes(page)) return;

  const target = {
    home: document.getElementById("featured-products"),
    shop: document.getElementById("shop-products"),
    product: document.getElementById("product-detail"),
    checkout: document.getElementById("checkout-summary")
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
      setupProduct(productFromUrlId(id));
      break;
    }
    case "checkout": {
      const id = new URLSearchParams(location.search).get("id");
      setupCheckout(productFromUrlId(id));
      break;
    }
  }
}

renderChrome();
clearLegacyCurrencyPreference();
await initFrench();
updateMenuToggleLabel();
renderPage();

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-catalog-retry]")) {
    void renderPage({ retryCatalog: true });
  }
});
