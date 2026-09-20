import { products, findProduct } from "./products.js";
import { initLanguage, t } from "./language.js";
import {
  currencyOptions,
  formatDisplayPrice,
  getSelectedCurrency,
  setSelectedCurrency
} from "./currency.js";

const formatPrice = formatDisplayPrice;
const page = document.body.dataset.page;
const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
const available = (product) => Boolean(product.fichier);
const productImage = (product) => new URL(`../../${product.image}`, import.meta.url).href;
const cartKey = "pgd-cart";
const readCart = () => { try { const cart = JSON.parse(localStorage.getItem(cartKey) || "[]"); return Array.isArray(cart) ? [...new Set(cart)] : []; } catch { return []; } };
const writeCart = (cart) => localStorage.setItem(cartKey, JSON.stringify([...new Set(cart)]));
let currencyOutsideClickBound = false;
function addToCart(productId, button) { const cart = readCart(); const alreadyAdded = cart.includes(productId); if (!alreadyAdded) { cart.push(productId); writeCart(cart); updateCartCount(); } const original = button.textContent; button.textContent = t(alreadyAdded ? "cart.alreadyAdded" : "cart.added"); button.disabled = true; setTimeout(() => { button.textContent = original; button.disabled = false; }, 1600); }

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
      picker.querySelector("[data-currency-label]").textContent = selected.label;
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
  document.querySelector("[data-header]").innerHTML = `<div class="header-inner"><a class="brand" href="index.html" aria-label="PGD DIGITAL - Accueil"><img src="../../assets/Background/logo.png" alt="PGD DIGITAL" width="52" height="52"><span>DIGITAL</span></a><button class="menu-toggle" type="button" aria-expanded="false" aria-controls="main-nav" aria-label="Ouvrir le menu" data-i18n="navigation.menu"></button><nav id="main-nav" class="main-nav" aria-label="Navigation principale"><a href="index.html" data-i18n="navigation.home"></a><a href="boutique.html" data-i18n="navigation.shop"></a><a href="panier.html" aria-label="Voir le panier"><span data-i18n="navigation.cart"></span> <span class="cart-count" data-cart-count aria-label="Nombre d'articles dans le panier">0</span></a><a href="contact.html" data-i18n="navigation.contact"></a></nav></div>`;
  document.querySelector("[data-footer]").innerHTML = `<div class="footer-inner"><div><a class="brand footer-brand" href="index.html" aria-label="PGD DIGITAL - Accueil"><span>PGD</span><span>DIGITAL</span></a><p data-i18n="footer.description"></p></div><div><strong data-i18n="footer.information"></strong><a href="contact.html" data-i18n="navigation.contact"></a><a href="mentions-legales.html" data-i18n="legal.title"></a><a href="politique-confidentialite.html" data-i18n="footer.privacy"></a></div></div><div class="footer-bottom" data-i18n="footer.copyright"></div>`;
  const toggle = document.querySelector(".menu-toggle");
  toggle.addEventListener("click", () => { const open = toggle.getAttribute("aria-expanded") === "true"; toggle.setAttribute("aria-expanded", String(!open)); document.querySelector(".main-nav").classList.toggle("is-open", !open); });
  updateCartCount();
}

function productCard(product) {
  const state = available(product) ? `<span class="availability available">${t("product.available")}</span>` : `<span class="availability">${t("product.comingSoon")}</span>`;
  const action = available(product) ? `<a class="button button-small button-outline" href="produit.html?id=${encodeURIComponent(product.id)}">${t("product.view")}</a><button class="button button-small button-primary" type="button" data-add-cart="${product.id}">${t("product.add")}</button>` : `<span class="button button-small button-disabled">${t("product.unavailable")}</span>`;
  const currencySelector = currencyPickerMarkup("product-currency-control", "data-product-currency-picker");
  return `<article class="product-card reveal"><a class="product-image" href="produit.html?id=${encodeURIComponent(product.id)}" aria-label="Voir ${escapeHtml(product.nom)}"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.nom)}" loading="lazy" width="420" height="260"></a><div class="product-card-body">${state}<h3>${escapeHtml(product.nom)}</h3><p class="product-description">${escapeHtml(product.description.replace(/<br\s*\/?>/gi, " ")).slice(0, 120)}...</p><div class="product-card-footer"><strong>${formatPrice(product.prix)}</strong>${currencySelector}</div><div class="product-actions">${action}</div></div></article>`;
}

function currencyPickerMarkup(className, dataAttribute) {
  const options = currencyOptions.map((option) => `<button class="currency-option" type="button" role="option" data-currency-option="${option.currency}">${option.flag ? `<span aria-hidden="true">${option.flag}</span>` : ""}<span>${option.label}</span></button>`).join("");
  return `<div class="${className}" ${dataAttribute} data-currency-picker-root><span class="currency-picker-label">${t("checkout.currency")}</span><button class="currency-picker-trigger" type="button" data-currency-trigger aria-expanded="false" aria-haspopup="listbox"><span data-currency-flag aria-hidden="true"></span><span data-currency-label></span><span class="currency-picker-chevron" aria-hidden="true">⌄</span></button><div class="currency-picker-menu" data-currency-menu role="listbox" hidden>${options}</div></div>`;
}

function bindCartButtons(root = document) { root.querySelectorAll("[data-add-cart]").forEach((button) => button.addEventListener("click", () => addToCart(button.dataset.addCart, button))); bindProductCurrency(root); }
function updateCartCount() { const cart = readCart(); document.querySelectorAll("[data-cart-count]").forEach((element) => { element.textContent = cart.length; }); }
function setupShop() { const output = document.getElementById("shop-products"); const search = document.getElementById("search"); const category = document.getElementById("category"); const sort = document.getElementById("sort");[...new Set(products.map((product) => product.categorie).filter(Boolean))].forEach((value) => category.add(new Option(value, value))); const render = () => { let result = products.filter((product) => product.nom.toLowerCase().includes(search.value.toLowerCase()) && (!category.value || product.categorie === category.value)); if (sort.value === "name") result.sort((a, b) => a.nom.localeCompare(b.nom)); if (sort.value === "price-up") result.sort((a, b) => a.prix - b.prix); if (sort.value === "price-down") result.sort((a, b) => b.prix - a.prix); output.innerHTML = result.map(productCard).join(""); document.getElementById("result-count").textContent = `${result.length} ${result.length > 1 ? t("shop.resultMany") : t("shop.resultOne")}`; bindCartButtons(output); };[search, category, sort].forEach((element) => element.addEventListener("input", render)); sort.addEventListener("change", render); render(); }
function setupHome() { const output = document.getElementById("featured-products"); output.innerHTML = products.slice(0, 3).map(productCard).join(""); bindCartButtons(output); }
function setupProduct() { const product = findProduct(new URLSearchParams(location.search).get("id")); const target = document.getElementById("product-detail"); if (!product) { target.innerHTML = `<p>${t("product.notFound")}</p>`; document.title = t("titles.product"); return; } document.title = `${product.nom} | ${t("siteName")}`; target.innerHTML = `<div class="product-visual"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.nom)}"></div><div class="product-info"><span class="availability ${available(product) ? "available" : ""}">${available(product) ? t("product.available") : t("product.comingSoon")}</span><h1>${escapeHtml(product.nom)}</h1><p class="product-price">${formatPrice(product.prix)}</p><div class="rich-description">${product.description}</div>${available(product) ? `<div class="product-actions"><button class="button button-outline" type="button" data-add-cart="${product.id}">${t("product.add")}</button><a class="button button-primary" href="commande.html?id=${encodeURIComponent(product.id)}">${t("product.order")}</a></div>` : `<span class="button button-disabled">${t("product.unavailable")}</span>`}</div>`; bindCartButtons(target); }
function mapPaymentError(error) { const message = String(error?.message || ""); if (/indisponible|unavailable|vente|sale/i.test(message)) return t("errors.productUnavailable"); if (/initialiser|initialize|paiement|payment/i.test(message)) return t("checkout.paymentFailed"); return t("errors.unknown"); }
function setupCheckout() {
  const product = findProduct(new URLSearchParams(location.search).get("id"));
  const summary = document.getElementById("checkout-summary");
  const form = document.getElementById("checkout-form");
  if (!product || !available(product)) {
    summary.innerHTML = `<h1>${t("checkout.unavailableTitle")}</h1><p>${t("checkout.unavailableText")}</p>`;
    form.remove();
    return;
  }
  summary.innerHTML = `<img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.nom)}"><p class="eyebrow">${t("checkout.summary")}</p><h2>${escapeHtml(product.nom)}</h2><strong>${formatPrice(product.prix)}</strong>`;
  if (form.dataset.bound) return;
  form.dataset.bound = "true";
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
      message.textContent = "Veuillez saisir un téléphone et un code pays valides.";
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
function setupCart() { const content = document.getElementById("cart-content"); const ids = readCart(); const items = ids.map(findProduct).filter(Boolean); if (!items.length) { content.innerHTML = `<p>${t("cart.empty")}</p><div class="cart-actions"><button class="button button-disabled" type="button" disabled>${t("cart.checkout")}</button><a class="button button-primary" href="boutique.html">${t("cart.discover")}</a></div>`; return; } const total = items.reduce((sum, product) => sum + product.prix, 0); const rows = items.map((product) => `<div class="cart-item"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.nom)}"><div><h2>${escapeHtml(product.nom)}</h2><strong>${formatPrice(product.prix)}</strong></div><button class="button button-small button-outline" type="button" data-remove="${product.id}">${t("cart.remove")}</button></div>`).join(""); const checkout = items.length === 1 ? `<a class="button button-primary" href="commande.html?id=${items[0].id}">${t("cart.checkout")}</a>` : `<div class="cart-order-options"><p class="form-message">${t("cart.groupUnavailable")}</p>${items.map((product) => `<a class="text-link" href="commande.html?id=${product.id}">${t("cart.singleCheckout")} : ${escapeHtml(product.nom)}</a>`).join("")}</div>`; content.innerHTML = `<div class="cart-items">${rows}</div><div class="cart-summary"><p>${t("cart.subtotal")} : <strong>${formatPrice(total)}</strong></p><p>${t("cart.total")} : <strong>${formatPrice(total)}</strong></p><div class="cart-actions">${checkout}<button class="button button-outline" type="button" data-clear-cart>${t("cart.clear")}</button></div></div>`; content.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => { writeCart(ids.filter((id) => id !== button.dataset.remove)); setupCart(); updateCartCount(); })); content.querySelector("[data-clear-cart]").addEventListener("click", () => { writeCart([]); setupCart(); updateCartCount(); }); }
async function setupResult() {
  const isSuccess = page === "success";
  document.title = t(`extra.${isSuccess ? "successTitle" : "cancelTitle"}`);
  const target = document.getElementById("result-content");

  if (!isSuccess) {
    target.innerHTML = `<p class="result-icon result-icon-error" aria-hidden="true">×</p><p class="eyebrow">${t("extra.cancelEyebrow")}</p><h1>${t("extra.cancelTitle")}</h1><p>${t("extra.cancelText")}</p><a class="button button-primary" href="boutique.html">${t("extra.backShop")}</a>`;
    return;
  }

  target.innerHTML = `<p class="result-icon" aria-hidden="true">✓</p><p class="eyebrow">PAIEMENT CONFIRMÉ</p><h1>Votre paiement a été effectué avec succès</h1><p class="result-intro">Le lien de votre produit vous sera envoyé par e-mail par Chariow. Vérifiez votre boîte de réception ainsi que vos courriers indésirables ou spams.</p><a class="button button-outline result-back" href="index.html">Retour à l'accueil</a>`;
}

function renderPage() { if (page === "home") setupHome(); if (page === "shop") setupShop(); if (page === "product") setupProduct(); if (page === "checkout") setupCheckout(); if (page === "cart") setupCart(); if (page === "success" || page === "cancel") setupResult(); }

renderChrome();
await initLanguage();
renderPage();
bindCheckoutCurrency();
document.addEventListener("languagechange", () => {
  renderPage();
  bindCheckoutCurrency();
});
