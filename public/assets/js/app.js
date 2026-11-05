import { createCatalogClient } from "./catalog.js";
import { initLanguage, t } from "./language.js";
import {
  currencyOptions,
  convertPriceBetweenCurrencies,
  formatDisplayPrice,
  getSelectedCurrency,
  setSelectedCurrency
} from "./currency.js";

const catalogClient = createCatalogClient();
const formatPrice = (product) => formatDisplayPrice(product.price, product.currency);
const page = document.body.dataset.page;
const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
const productText = (product, field) =>
  product[field][document.documentElement.lang === "en" ? "en" : "fr"] || product[field].fr;
const productDescription = (product) =>
  escapeHtml(productText(product, "description")).replace(/&lt;br\s*\/?&gt;/gi, "<br>");
const productImage = (product) => new URL(`../../${product.image}`, import.meta.url).href;
const cartKey = "pgd-cart";
const readCart = () => { try { const cart = JSON.parse(localStorage.getItem(cartKey) || "[]"); return Array.isArray(cart) ? [...new Set(cart)] : []; } catch { return []; } };
const writeCart = (cart) => localStorage.setItem(cartKey, JSON.stringify([...new Set(cart)]));
let currencyOutsideClickBound = false;
let catalogProducts = null;
let renderSequence = 0;
function addToCart(productId, button) { const cart = readCart(); const alreadyAdded = cart.includes(productId); if (!alreadyAdded) { cart.push(productId); writeCart(cart); updateCartCount(); } const original = button.textContent; button.textContent = t(alreadyAdded ? "cart.alreadyAdded" : "cart.added"); button.disabled = true; setTimeout(() => { button.textContent = original; button.disabled = false; }, 1600); }

function showCatalogLoading(target) {
  target.innerHTML = `<div class="catalog-state" role="status" aria-live="polite">${escapeHtml(t("catalog.loading"))}</div>`;
}

function showCatalogError(target, error) {
  const messageKey = error?.code === "network"
    ? "catalog.networkError"
    : error?.code === "http"
      ? "catalog.httpError"
      : "catalog.invalidResponse";
  target.innerHTML = `<div class="catalog-state" role="alert"><p>${escapeHtml(t(messageKey))}</p><button class="button button-outline" type="button" data-catalog-retry>${escapeHtml(t("catalog.retry"))}</button></div>`;
}

function showMissingProduct(target, messageKey) {
  target.innerHTML = `<div class="catalog-state" role="status"><p>${escapeHtml(t(messageKey))}</p><a class="button button-outline" href="boutique.html">${escapeHtml(t("catalog.backToShop"))}</a><button class="button button-outline" type="button" data-catalog-retry>${escapeHtml(t("catalog.retry"))}</button></div>`;
}

function bindCheckoutCurrency() {
  bindCurrencyPickers(document.querySelectorAll("[data-checkout-currency-picker]"));
}

function bindCurrencyPickers(pickers) {
  if (!currencyOutsideClickBound) {
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-currency-picker-root]")) return;
      document.querySelectorAll("[data-currency-menu]").forEach((menu) => {
        menu.hidden = true;
        menu.classList.remove("is-open-up");
        menu.parentElement.querySelector("[data-currency-trigger]")?.setAttribute("aria-expanded", "false");
      });
    });
    currencyOutsideClickBound = true;
  }

  pickers.forEach((picker) => {
    const trigger = picker.querySelector("[data-currency-trigger]");
    const menu = picker.querySelector("[data-currency-menu]");
    if (!trigger || !menu) return;

    const updatePicker = () => {
      const selected = currencyOptions.find((option) => option.currency === getSelectedCurrency()) || currencyOptions[0];
      picker.querySelector("[data-currency-flag]").textContent = selected.flag;
      picker.querySelector("[data-currency-label]").textContent = t(`checkout.currency${selected.currency[0]}${selected.currency.slice(1).toLowerCase()}`);
      menu.querySelectorAll("[data-currency-option]").forEach((option) => {
        option.setAttribute("aria-selected", String(option.dataset.currencyOption === selected.currency));
      });
    };

    if (picker.dataset.bound) {
      updatePicker();
      return;
    }

    const closeMenu = () => {
      menu.hidden = true;
      menu.classList.remove("is-open-up");
      trigger.setAttribute("aria-expanded", "false");
    };

    trigger.addEventListener("click", () => {
      document.querySelectorAll("[data-currency-menu]").forEach((otherMenu) => {
        if (otherMenu !== menu) {
          otherMenu.hidden = true;
          otherMenu.classList.remove("is-open-up");
          otherMenu.parentElement.querySelector("[data-currency-trigger]")?.setAttribute("aria-expanded", "false");
        }
      });
      const open = !menu.hidden;
      if (open) {
        closeMenu();
        return;
      }
      menu.hidden = false;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      menu.classList.toggle("is-open-up", menuRect.bottom > window.innerHeight && triggerRect.top > menuRect.height + 8);
      trigger.setAttribute("aria-expanded", "true");
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
    menu.querySelectorAll("[data-currency-option]").forEach((option) => option.addEventListener("click", () => {
      setSelectedCurrency(option.dataset.currencyOption);
      closeMenu();
    renderPage();
      bindCheckoutCurrency();
    }));
    updatePicker();
    picker.dataset.bound = "true";
  });
}

function bindProductCurrency(root = document) {
  bindCurrencyPickers(root.querySelectorAll("[data-product-currency-picker]"));
}

function renderChrome() {
  if (!document.querySelector("link[rel=icon]")) { const icon = document.createElement("link"); icon.rel = "icon"; icon.href = "../../assets/Background/logo.png"; document.head.append(icon); }
  document.querySelector("[data-header]").innerHTML = `<div class="header-inner"><a class="brand" href="index.html" aria-label="${t("navigation.brandHome")}" data-i18n-aria-label="navigation.brandHome"><img src="../../assets/Background/logo.png" alt="PGD DIGITAL" width="52" height="52"><span>DIGITAL</span></a><button class="menu-toggle" type="button" aria-expanded="false" aria-controls="main-nav" aria-label="${t("navigation.openMenu")}" data-i18n="navigation.menu"></button><nav id="main-nav" class="main-nav" aria-label="${t("navigation.mainNavigation")}" data-i18n-aria-label="navigation.mainNavigation"><a href="index.html" data-i18n="navigation.home"></a><a href="boutique.html" data-i18n="navigation.shop"></a><a href="panier.html" aria-label="${t("navigation.cart")}" data-i18n-aria-label="navigation.cart"><span data-i18n="navigation.cart"></span> <span class="cart-count" data-cart-count aria-label="${t("navigation.cartCount")}" data-i18n-aria-label="navigation.cartCount">0</span></a><a href="contact.html" data-i18n="navigation.contact"></a></nav></div>`;
  document.querySelector("[data-footer]").innerHTML = `<div class="footer-inner"><div><a class="brand footer-brand" href="index.html" aria-label="${t("navigation.brandHome")}" data-i18n-aria-label="navigation.brandHome"><span>PGD</span><span>DIGITAL</span></a><p data-i18n="footer.description"></p></div><div><strong data-i18n="footer.information"></strong><a href="contact.html" data-i18n="navigation.contact"></a><a href="mentions-legales.html" data-i18n="legal.title"></a><a href="politique-confidentialite.html" data-i18n="footer.privacy"></a></div></div><div class="footer-bottom" data-i18n="footer.copyright"></div>`;
  const toggle = document.querySelector(".menu-toggle");
  toggle.addEventListener("click", () => { const open = toggle.getAttribute("aria-expanded") === "true"; toggle.setAttribute("aria-expanded", String(!open)); document.querySelector(".main-nav").classList.toggle("is-open", !open); updateMenuToggleLabel(toggle); });
  updateCartCount();
}

function updateMenuToggleLabel(toggle = document.querySelector(".menu-toggle")) {
  if (!toggle) return;
  const isOpen = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-label", t(isOpen ? "navigation.closeMenu" : "navigation.openMenu"));
}

function productCard(product) {
  const productUrl = `produit.html?id=${encodeURIComponent(product.id)}`;
  const name = productText(product, "name");
  const image = `<img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(name)}" loading="lazy" width="420" height="260">`;
  const currencySelector = currencyPickerMarkup("product-currency-control", "data-product-currency-picker");
  return `<article class="product-card reveal"><a class="product-image" href="${productUrl}" aria-label="${escapeHtml(t("product.view"))} ${escapeHtml(name)}">${image}</a><div class="product-card-body"><h3>${escapeHtml(name)}</h3><div class="product-card-footer"><strong>${escapeHtml(formatPrice(product))}</strong>${currencySelector}</div><div class="product-actions"><a class="button button-small button-primary" href="${productUrl}">${escapeHtml(t("product.view"))}</a></div></div></article>`;
}

function currencyPickerMarkup(className, dataAttribute) {
  const options = currencyOptions.map((option) => `<button class="currency-option" type="button" role="option" data-currency-option="${option.currency}">${option.flag ? `<span aria-hidden="true">${option.flag}</span>` : ""}<span>${t(`checkout.currency${option.currency[0]}${option.currency.slice(1).toLowerCase()}`)}</span></button>`).join("");
  return `<div class="${className}" ${dataAttribute} data-currency-picker-root><span class="currency-picker-label">${t("checkout.currency")}</span><button class="currency-picker-trigger" type="button" data-currency-trigger aria-expanded="false" aria-haspopup="listbox"><span data-currency-flag aria-hidden="true"></span><span data-currency-label></span><span class="currency-picker-chevron" aria-hidden="true">⌄</span></button><div class="currency-picker-menu" data-currency-menu role="listbox" hidden>${options}</div></div>`;
}

function bindCartButtons(root = document) { root.querySelectorAll("[data-add-cart]").forEach((button) => button.addEventListener("click", () => addToCart(button.dataset.addCart, button))); bindProductCurrency(root); }
function updateCartCount() { const cart = readCart(); document.querySelectorAll("[data-cart-count]").forEach((element) => { element.textContent = cart.length; }); }
function setupShop() {
  const output = document.getElementById("shop-products");
  const search = document.getElementById("search");
  const category = document.getElementById("category");
  const sort = document.getElementById("sort");
  const render = () => {
    let result = catalogProducts.filter((product) =>
      productText(product, "name").toLocaleLowerCase()
        .includes(search.value.toLocaleLowerCase()) &&
      (!category.value || product.category === category.value)
    );
    if (sort.value === "name") {
      result.sort((a, b) => productText(a, "name").localeCompare(productText(b, "name")));
    }
    if (sort.value === "price-up") {
      result.sort((a, b) =>
        convertPriceBetweenCurrencies(a.price, a.currency, "XOF") -
        convertPriceBetweenCurrencies(b.price, b.currency, "XOF")
      );
    }
    if (sort.value === "price-down") {
      result.sort((a, b) =>
        convertPriceBetweenCurrencies(b.price, b.currency, "XOF") -
        convertPriceBetweenCurrencies(a.price, a.currency, "XOF")
      );
    }
    output.innerHTML = result.length
      ? result.map(productCard).join("")
      : `<div class="catalog-state" role="status">${escapeHtml(t("shop.noResults"))}</div>`;
    document.getElementById("result-count").textContent =
      `${result.length} ${result.length === 1 ? t("shop.resultOne") : t("shop.resultMany")}`;
    bindCartButtons(output);
  };
  if (!output.dataset.bound) {
    [...new Set(catalogProducts.map((product) => product.category).filter(Boolean))]
      .forEach((value) => category.add(new Option(value, value)));
    [search, category, sort].forEach((element) => element.addEventListener("input", render));
    sort.addEventListener("change", render);
    output.dataset.bound = "true";
  }
  render();
}

function setupHome() {
  const output = document.getElementById("featured-products");
  output.innerHTML = catalogProducts.length
    ? catalogProducts.slice(0, 3).map(productCard).join("")
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
  const actions = `<div class="product-actions"><a class="button button-primary" href="${checkoutUrl}">${escapeHtml(t("product.order"))}</a><button class="button button-outline" type="button" data-add-cart="${escapeHtml(product.id)}">${escapeHtml(t("product.add"))}</button></div>`;
  const paymentLogos = [{ name: "Orange Money", file: "orange-money.svg" }, { name: "Moov Money", file: "moov-money.png" }, { name: "Wave", file: "wave.svg" }, { name: "Visa", file: "visa.svg" }, { name: "Mastercard", file: "mastercard.svg" }, { name: "Bitcoin", file: "bitcoin.svg" }];
  const paymentMethods = `<div class="payment-methods" aria-label="${escapeHtml(t("productDetails.paymentMethods"))}"><p>${escapeHtml(t("productDetails.paymentMethods"))}</p><div class="payment-method-list">${paymentLogos.map((payment) => `<span class="payment-method"><img src="assets/payments/${payment.file}" alt="${payment.name}"></span>`).join("")}</div></div>`;
  const purchasePanel = `<aside class="product-purchase" aria-label="${escapeHtml(t("productDetails.purchaseOverview"))}"><p class="purchase-label">${escapeHtml(t("productDetails.purchaseOverview"))}</p><p class="product-price">${escapeHtml(formatPrice(product))}</p>${actions}${paymentMethods}<div class="purchase-links"><a href="contact.html">${escapeHtml(t("navigation.contact"))}</a><span aria-hidden="true">|</span><a href="contact.html">${escapeHtml(t("productDetails.report"))}</a></div><details class="purchase-help"><summary>${escapeHtml(t("productDetails.purchaseHelpTitle"))}</summary><p>${escapeHtml(t("productDetails.purchaseHelpText"))}</p></details></aside>`;
  const stickyAction = `<div class="product-sticky-cta"><strong>${escapeHtml(formatPrice(product))}</strong><a class="button button-primary" href="${checkoutUrl}">${escapeHtml(t("product.order"))}</a></div>`;
  const description = productDescription(product);
  target.innerHTML = `<div class="product-heading"><h1>${escapeHtml(name)}</h1></div><div class="product-left"><div class="product-visual"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(name)}"></div><div class="rich-description">${description}</div></div>${purchasePanel}${stickyAction}`;
  bindCartButtons(target);
  bindProductSticky(target);
}
function mapPaymentError(error) { const message = String(error?.message || ""); if (/indisponible|unavailable|vente|sale/i.test(message)) return t("errors.productUnavailable"); if (/initialiser|initialize|paiement|payment/i.test(message)) return t("checkout.paymentFailed"); return t("errors.unknown"); }
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
  summary.innerHTML = `<img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(name)}"><p class="eyebrow">${escapeHtml(t("checkout.summary"))}</p><h2>${escapeHtml(name)}</h2><strong>${escapeHtml(formatPrice(product))}</strong>`;
  if (form.dataset.bound) return;
  form.dataset.bound = "true";
  const phoneCountryCodeInput = document.getElementById("phone-country-code");
  const normalizePhoneCountryCode = () => {
    phoneCountryCodeInput.value = phoneCountryCodeInput.value.trim().toUpperCase();
  };
  phoneCountryCodeInput.addEventListener("input", normalizePhoneCountryCode);
  phoneCountryCodeInput.addEventListener("change", normalizePhoneCountryCode);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const message = document.getElementById("payment-message");
    const name = document.getElementById("nom").value.trim();
    const email = document.getElementById("email").value.trim();
    const phone = document.getElementById("phone").value.trim();
    const phoneCountryCode = document.getElementById("phone-country-code").value.trim().toUpperCase();
    const selectedCurrency = getSelectedCurrency();
    message.textContent = "";
    if (!name) {
      message.textContent = t("checkout.nameRequired");
      document.getElementById("nom").focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      message.textContent = t("checkout.emailInvalid");
      document.getElementById("email").focus();
      return;
    }
    if (phone.replace(/\D/g, "").length < 6 || !/^[A-Z]{2}$/.test(phoneCountryCode)) {
      message.textContent = t("checkout.phoneInvalid");
      return;
    }
    button.disabled = true;
    message.textContent = t("checkout.preparing");
    try {
      const response = await fetch("/.netlify/functions/create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nom: name, email, phone, phoneCountryCode, produitId: product.id, currency: selectedCurrency })
      });
      let data;
      try { data = await response.json(); } catch { throw new Error("invalid-json"); }
      if (!response.ok) throw new Error(data.error || "server-error");
      const url = data.checkout_url || "";
      if (!url) throw new Error("missing-payment-data");
      location.href = url;
    } catch (error) {
      const knownErrors = ["invalid-json", "missing-payment-data", "server-error"];
      message.textContent = knownErrors.includes(error.message)
        ? (error.message === "invalid-json" ? t("checkout.paymentFailed") : t("checkout.paymentLinkMissing"))
        : error.message;
      button.disabled = false;
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
    ? `<div class="catalog-state" role="status"><p>${escapeHtml(t("cart.staleReferences", { count: staleIds.length }))}</p><button class="button button-outline" type="button" data-remove-stale>${escapeHtml(t("cart.removeStale"))}</button></div>`
    : "";
  if (!items.length) {
    content.innerHTML = `${staleNotice}<p>${escapeHtml(t("cart.empty"))}</p><div class="cart-actions"><button class="button button-disabled" type="button" disabled>${escapeHtml(t("cart.checkout"))}</button><a class="button button-primary" href="boutique.html">${escapeHtml(t("cart.discover"))}</a></div>`;
  } else {
    const totalInXof = items.reduce(
      (sum, product) => sum + convertPriceBetweenCurrencies(product.price, product.currency, "XOF"),
      0
    );
    const rows = items.map((product) => {
      const name = productText(product, "name");
      return `<div class="cart-item"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(name)}"><div><h2>${escapeHtml(name)}</h2><strong>${escapeHtml(formatPrice(product))}</strong></div><button class="button button-small button-outline" type="button" data-remove="${escapeHtml(product.id)}">${escapeHtml(t("cart.remove"))}</button></div>`;
    }).join("");
    const checkout = items.length === 1
      ? `<a class="button button-primary" href="commande.html?id=${encodeURIComponent(items[0].id)}">${escapeHtml(t("cart.checkout"))}</a>`
      : `<div class="cart-order-options"><p class="form-message">${escapeHtml(t("cart.groupUnavailable"))}</p>${items.map((product) => `<a class="text-link" href="commande.html?id=${encodeURIComponent(product.id)}">${escapeHtml(t("cart.singleCheckout"))} : ${escapeHtml(productText(product, "name"))}</a>`).join("")}</div>`;
    content.innerHTML = `${staleNotice}<div class="cart-items">${rows}</div><div class="cart-summary"><p>${escapeHtml(t("cart.subtotal"))} : <strong>${escapeHtml(formatDisplayPrice(totalInXof, "XOF"))}</strong></p><p>${escapeHtml(t("cart.total"))} : <strong>${escapeHtml(formatDisplayPrice(totalInXof, "XOF"))}</strong></p><div class="cart-actions">${checkout}<button class="button button-outline" type="button" data-clear-cart>${escapeHtml(t("cart.clear"))}</button></div></div>`;
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
async function setupResult() {
  const isSuccess = page === "success";
  document.title = t(`extra.${isSuccess ? "successTitle" : "cancelTitle"}`);
  const target = document.getElementById("result-content");

  if (!isSuccess) {
    target.innerHTML = `<p class="result-icon result-icon-error" aria-hidden="true">×</p><p class="eyebrow">${t("extra.cancelEyebrow")}</p><h1>${t("extra.cancelTitle")}</h1><p>${t("extra.cancelText")}</p><a class="button button-primary" href="boutique.html">${t("extra.backShop")}</a>`;
    return;
  }

  document.title = t("successPage.title");
  target.innerHTML = `<p class="result-icon" aria-hidden="true">✓</p><p class="eyebrow">${t("successPage.eyebrow")}</p><h1>${t("successPage.heading")}</h1><p class="result-intro">${t("successPage.delivery")}</p><p class="result-intro">${t("successPage.spam")}</p><p class="result-intro">${t("successPage.thanks")}</p><a class="button button-outline result-back" href="index.html">${t("successPage.back")}</a>`;
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
    showCatalogLoading(target);
    if (page === "checkout") document.getElementById("checkout-form").hidden = true;
  }

  try {
    catalogProducts = retryCatalog
      ? await catalogClient.retry()
      : await catalogClient.load();
  } catch (error) {
    if (sequence !== renderSequence) return;
    catalogProducts = null;
    showCatalogError(target, error);
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
await initLanguage();
updateMenuToggleLabel();
renderPage();
bindCheckoutCurrency();
document.addEventListener("languagechange", () => {
  updateMenuToggleLabel();
  renderPage();
  bindCheckoutCurrency();
});

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-catalog-retry]")) {
    void renderPage({ retryCatalog: true });
  }
});
