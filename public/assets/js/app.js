import { products, findProduct, formatPrice } from "./products.js";
import { initLanguage, t } from "./language.js";

const page = document.body.dataset.page;
const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
const available = (product) => Boolean(product.fichier);
const productImage = (product) => new URL(`../../${product.image}`, import.meta.url).href;
const cartKey = "pgd-cart";
const readCart = () => { try { const cart = JSON.parse(localStorage.getItem(cartKey) || "[]"); return Array.isArray(cart) ? [...new Set(cart)] : []; } catch { return []; } };
const writeCart = (cart) => localStorage.setItem(cartKey, JSON.stringify([...new Set(cart)]));
function addToCart(productId, button) { const cart = readCart(); const alreadyAdded = cart.includes(productId); if (!alreadyAdded) { cart.push(productId); writeCart(cart); updateCartCount(); } const original = button.textContent; button.textContent = t(alreadyAdded ? "cart.alreadyAdded" : "cart.added"); button.disabled = true; setTimeout(() => { button.textContent = original; button.disabled = false; }, 1600); }

function renderChrome() {
  if (!document.querySelector("link[rel=icon]")) { const icon = document.createElement("link"); icon.rel = "icon"; icon.href = "../../assets/Background/logo.png"; document.head.append(icon); }
  document.querySelector("[data-header]").innerHTML = `<div class="header-inner"><a class="brand" href="index.html"><img src="../../assets/Background/logo.png" alt="PGD DIGITAL"><span>DIGITAL</span></a><button class="menu-toggle" type="button" aria-expanded="false" aria-controls="main-nav" data-i18n="navigation.menu"></button><nav id="main-nav" class="main-nav"><a href="index.html" data-i18n="navigation.home"></a><a href="boutique.html" data-i18n="navigation.shop"></a><a href="panier.html"><span data-i18n="navigation.cart"></span> <span class="cart-count" data-cart-count>0</span></a><a href="contact.html" data-i18n="navigation.contact"></a></nav></div>`;
  document.querySelector("[data-footer]").innerHTML == `<div class="footer-inner"><div><a class="brand footer-brand" href="index.html"><span>PGD</span><span>DIGITAL</span></a><p data-i18n="footer.description"></p></div><div><strong data-i18n="footer.information"></strong><a href="contact.html" data-i18n="navigation.contact"></a><a href="mentions-legales.html" data-i18n="legal.title"></a><a href="politique-confidentialite.html" data-i18n="footer.privacy"></a></div></div><div class="footer-bottom" data-i18n="footer.copyright"></div>`;
  const toggle = document.querySelector(".menu-toggle");
  toggle.addEventListener("click", () => { const open = toggle.getAttribute("aria-expanded") === "true"; toggle.setAttribute("aria-expanded", String(!open)); document.querySelector(".main-nav").classList.toggle("is-open", !open); });
  updateCartCount();
}

function productCard(product) {
  const state = available(product) ? `<span class="availability available">${t("product.available")}</span>` : `<span class="availability">${t("product.comingSoon")}</span>`;
  const action = available(product) ? `<div class="product-actions"><a class="button button-small button-outline" href="produit.html?id=${encodeURIComponent(product.id)}">${t("product.view")}</a><button class="button button-small button-primary" type="button" data-add-cart="${product.id}">${t("product.add")}</button></div>` : `<span class="button button-small button-disabled">${t("product.unavailable")}</span>`;
  return `<article class="product-card reveal"><a class="product-image" href="produit.html?id=${encodeURIComponent(product.id)}"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.nom)}" loading="lazy"></a><div class="product-card-body">${state}<h3>${escapeHtml(product.nom)}</h3><p class="product-description">${escapeHtml(product.description.replace(/<br\s*\/?>/gi, " ")).slice(0, 120)}...</p><div class="product-card-footer"><strong>${formatPrice(product.prix)}</strong>${action}</div></div></article>`;
}

function bindCartButtons(root = document) { root.querySelectorAll("[data-add-cart]").forEach((button) => button.addEventListener("click", () => addToCart(button.dataset.addCart, button))); }
function updateCartCount() { const cart = readCart(); document.querySelectorAll("[data-cart-count]").forEach((element) => { element.textContent = cart.length; }); }
function setupShop() { const output = document.getElementById("shop-products"); const search = document.getElementById("search"); const category = document.getElementById("category"); const sort = document.getElementById("sort");[...new Set(products.map((product) => product.categorie).filter(Boolean))].forEach((value) => category.add(new Option(value, value))); const render = () => { let result = products.filter((product) => product.nom.toLowerCase().includes(search.value.toLowerCase()) && (!category.value || product.categorie === category.value)); if (sort.value === "name") result.sort((a, b) => a.nom.localeCompare(b.nom)); if (sort.value === "price-up") result.sort((a, b) => a.prix - b.prix); if (sort.value === "price-down") result.sort((a, b) => b.prix - a.prix); output.innerHTML = result.map(productCard).join(""); document.getElementById("result-count").textContent = `${result.length} ${result.length > 1 ? t("shop.resultMany") : t("shop.resultOne")}`; bindCartButtons(output); };[search, category, sort].forEach((element) => element.addEventListener("input", render)); sort.addEventListener("change", render); render(); }
function setupHome() { const output = document.getElementById("featured-products"); output.innerHTML = products.slice(0, 3).map(productCard).join(""); bindCartButtons(output); }
function setupProduct() { const product = findProduct(new URLSearchParams(location.search).get("id")); const target = document.getElementById("product-detail"); if (!product) { target.innerHTML = `<p>${t("product.notFound")}</p>`; document.title = t("titles.product"); return; } document.title = `${product.nom} | ${t("siteName")}`; target.innerHTML = `<div class="product-visual"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.nom)}"></div><div class="product-info"><span class="availability ${available(product) ? "available" : ""}">${available(product) ? t("product.available") : t("product.comingSoon")}</span><h1>${escapeHtml(product.nom)}</h1><p class="product-price">${formatPrice(product.prix)}</p><div class="rich-description">${product.description}</div>${available(product) ? `<div class="product-actions"><button class="button button-outline" type="button" data-add-cart="${product.id}">${t("product.add")}</button><a class="button button-primary" href="commande.html?id=${encodeURIComponent(product.id)}">${t("product.order")}</a></div>` : `<span class="button button-disabled">${t("product.unavailable")}</span>`}</div>`; bindCartButtons(target); }
function mapPaymentError(error) { const message = String(error?.message || ""); if (/indisponible|unavailable|vente|sale/i.test(message)) return t("errors.productUnavailable"); if (/initialiser|initialize|paiement|payment/i.test(message)) return t("checkout.paymentFailed"); return t("errors.unknown"); }
function setupCheckout() { const product = findProduct(new URLSearchParams(location.search).get("id")); const summary = document.getElementById("checkout-summary"); const form = document.getElementById("checkout-form"); if (!product || !available(product)) { summary.innerHTML = `<h1>${t("checkout.unavailableTitle")}</h1><p>${t("checkout.unavailableText")}</p>`; form.remove(); return; } summary.innerHTML = `<img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.nom)}"><p class="eyebrow">${t("checkout.summary")}</p><h2>${escapeHtml(product.nom)}</h2><strong>${formatPrice(product.prix)}</strong>`; if (form.dataset.bound) return; form.dataset.bound = "true"; form.addEventListener("submit", async (event) => { event.preventDefault(); const button = form.querySelector("button"); const message = document.getElementById("payment-message"); const name = document.getElementById("nom").value.trim(); const email = document.getElementById("email").value.trim(); message.textContent = ""; if (!name) { message.textContent = t("checkout.nameRequired"); document.getElementById("nom").focus(); return; } if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { message.textContent = t("checkout.emailInvalid"); document.getElementById("email").focus(); return; } button.disabled = true; message.textContent = t("checkout.preparing"); try { const response = await fetch("/.netlify/functions/create-payment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nom: name, email, produitId: product.id }) }); let data; try { data = await response.json(); } catch { throw new Error("invalid-json"); } if (!response.ok) throw new Error(data.error || "server-error"); const paymentId = data.paymentId || ""; const url = data.checkout_url || ""; if (!url || !paymentId) throw new Error("missing-payment-data"); localStorage.setItem("pgd_last_payment_id", paymentId); localStorage.setItem("pgd_last_product_id", product.id); location.href = url; } catch (error) { const knownErrors = ["invalid-json", "missing-payment-data", "server-error"]; message.textContent = knownErrors.includes(error.message) ? (error.message === "invalid-json" ? t("checkout.paymentFailed") : t("checkout.paymentLinkMissing")) : error.message; button.disabled = false; } }); }
function setupCart() { const content = document.getElementById("cart-content"); const ids = readCart(); const items = ids.map(findProduct).filter(Boolean); if (!items.length) { content.innerHTML = `<p>${t("cart.empty")}</p><div class="cart-actions"><button class="button button-disabled" type="button" disabled>${t("cart.checkout")}</button><a class="button button-primary" href="boutique.html">${t("cart.discover")}</a></div>`; return; } const total = items.reduce((sum, product) => sum + product.prix, 0); const rows = items.map((product) => `<div class="cart-item"><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.nom)}"><div><h2>${escapeHtml(product.nom)}</h2><strong>${formatPrice(product.prix)}</strong></div><button class="button button-small button-outline" type="button" data-remove="${product.id}">${t("cart.remove")}</button></div>`).join(""); const checkout = items.length === 1 ? `<a class="button button-primary" href="commande.html?id=${items[0].id}">${t("cart.checkout")}</a>` : `<div class="cart-order-options"><p class="form-message">${t("cart.groupUnavailable")}</p>${items.map((product) => `<a class="text-link" href="commande.html?id=${product.id}">${t("cart.singleCheckout")} : ${escapeHtml(product.nom)}</a>`).join("")}</div>`; content.innerHTML = `<div class="cart-items">${rows}</div><div class="cart-summary"><p>${t("cart.subtotal")} : <strong>${formatPrice(total)}</strong></p><p>${t("cart.total")} : <strong>${formatPrice(total)}</strong></p><div class="cart-actions">${checkout}<button class="button button-outline" type="button" data-clear-cart>${t("cart.clear")}</button></div></div>`; content.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => { writeCart(ids.filter((id) => id !== button.dataset.remove)); setupCart(); updateCartCount(); })); content.querySelector("[data-clear-cart]").addEventListener("click", () => { writeCart([]); setupCart(); updateCartCount(); }); }
const downloadUrl = (paymentId, productId, file) => `/.netlify/functions/download?paymentId=${encodeURIComponent(paymentId)}&produitId=${encodeURIComponent(productId)}&file=${encodeURIComponent(file)}`;
const downloadErrorMessage = (error) => {
  const message = String(error?.message || "");
  if (/introuvable/i.test(message)) return "Fichier introuvable.";
  if (/non v[ée]rifiable/i.test(message)) return "Paiement non vérifiable.";
  if (/refus|non autoris[ée]|incoh[ée]rent/i.test(message)) return "Accès refusé.";
  return "Le téléchargement a échoué. Veuillez réessayer.";
};

function showDownloadError(button, message) {
  let error = button.parentElement.querySelector("[data-download-error]");
  if (!error) {
    error = document.createElement("p");
    error.className = "form-message download-error";
    error.dataset.downloadError = "true";
    error.setAttribute("role", "alert");
    button.insertAdjacentElement("afterend", error);
  }
  error.textContent = message;
}

async function downloadFile(paymentId, productId, file, button) {
  if (!button || !paymentId || !productId || !file) {
    if (button) showDownloadError(button, "Le téléchargement a échoué. Veuillez réessayer.");
    return;
  }

  const originalText = button.textContent;
  const error = button.parentElement.querySelector("[data-download-error]");
  if (error) error.textContent = "";
  button.disabled = true;
  button.textContent = "Téléchargement...";

  try {
    const response = await fetch(downloadUrl(paymentId, productId, file));
    if (!response.ok) {
      let data = {};
      try { data = await response.json(); } catch { /* The generic message is safer for non-JSON errors. */ }
      throw new Error(data.error || data.message || "server-error");
    }

    const blob = await response.blob();
    if (!blob.size) throw new Error("empty-file");

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = file;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    button.textContent = originalText;
  } catch (error) {
    showDownloadError(button, downloadErrorMessage(error));
    button.textContent = originalText;
  } finally {
    button.disabled = false;
  }
}

async function setupResult() {
  const isSuccess = page === "success";
  document.title = t(`extra.${isSuccess ? "successTitle" : "cancelTitle"}`);
  const target = document.getElementById("result-content");
  const params = new URLSearchParams(location.search);
  const productId = params.get("produitId") || localStorage.getItem("pgd_last_product_id") || "";
  const paymentId = params.get("paymentId") || params.get("monerooPaymentId") || localStorage.getItem("pgd_last_payment_id") || "";

  if (!isSuccess) {
    target.innerHTML = `<p class="result-icon result-icon-error" aria-hidden="true">×</p><p class="eyebrow">${t("extra.cancelEyebrow")}</p><h1>${t("extra.cancelTitle")}</h1><p>${t("extra.cancelText")}</p><a class="button button-primary" href="boutique.html">${t("extra.backShop")}</a>`;
    return;
  }

  target.innerHTML = `<div class="result-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span><p>Vérification de votre paiement...</p></div>`;

  if (!productId || !paymentId) {
    target.innerHTML = `<p class="result-icon result-icon-error" aria-hidden="true">!</p><p class="eyebrow">Paiement non confirmé</p><h1>Vos fichiers ne sont pas encore disponibles</h1><p>Nous n’avons pas pu vérifier votre paiement. Aucun téléchargement n’a été lancé.</p><a class="button button-primary" href="boutique.html">${t("extra.backShop")}</a>`;
    return;
  }

  try {
    const response = await fetch(`/.netlify/functions/check-access?paymentId=${encodeURIComponent(paymentId)}&produitId=${encodeURIComponent(productId)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.authorized) throw new Error(payload.message || "Paiement non confirmé");

    const files = Array.isArray(payload.files) ? payload.files.filter((file) => typeof file === "string" && file.trim()) : [];
    if (!files.length) throw new Error("Aucun fichier disponible");

    const cards = files.map((file) => `<article class="download-card"><span class="pdf-icon" aria-hidden="true">PDF</span><div class="download-card-info"><h2>${escapeHtml(file)}</h2><p>Fichier disponible</p></div><button class="button button-primary download-button" type="button" data-download-file="${escapeHtml(file)}">Télécharger</button></article>`).join("");
    target.innerHTML = `<p class="result-icon" aria-hidden="true">✓</p><p class="eyebrow">PAIEMENT CONFIRMÉ</p><h1>Vos fichiers sont prêts</h1><p class="result-intro">Votre paiement a été confirmé par Moneroo. Vos fichiers sont prêts. Cliquez sur Télécharger pour récupérer chaque fichier.</p><section class="downloads-section" aria-labelledby="downloads-title"><h2 id="downloads-title">Vos fichiers</h2><div class="download-list">${cards}</div></section><a class="button button-outline result-back" href="boutique.html">${t("extra.backShop")}</a>`;
    target.querySelectorAll("[data-download-file]").forEach((button) => button.addEventListener("click", () => downloadFile(paymentId, productId, button.dataset.downloadFile, button)));
  } catch (error) {
    console.error("Access check failed:", error);
    target.innerHTML = `<p class="result-icon result-icon-error" aria-hidden="true">!</p><p class="eyebrow">Paiement non confirmé</p><h1>Vos fichiers ne sont pas disponibles</h1><p>Votre paiement n’a pas encore pu être confirmé par le serveur. Aucun téléchargement n’a été lancé.</p><a class="button button-primary" href="boutique.html">${t("extra.backShop")}</a>`;
  }
}

function renderPage() { if (page === "home") setupHome(); if (page === "shop") setupShop(); if (page === "product") setupProduct(); if (page === "checkout") setupCheckout(); if (page === "cart") setupCart(); if (page === "success" || page === "cancel") setupResult(); }

renderChrome();
await initLanguage();
renderPage();
document.addEventListener("languagechange", renderPage);
