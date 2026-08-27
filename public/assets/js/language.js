const storageKey = "pgd-language";
const defaultLanguage = "fr";
let currentLanguage = defaultLanguage;
let translations = {};
let frenchTranslations = {};
const extraTranslations = {
  fr: { reviewsEyebrow: "Retours clients", reviewsTitle: "Ce que pensent nos clients", reviewsEmpty: "Les avis clients seront affichés ici lorsqu’ils seront disponibles.", successEyebrow: "Paiement confirmé", successTitle: "Paiement réussi | PGD Market", successText: "Votre paiement a été traité. Si votre produit est disponible, suivez les instructions de téléchargement reçues.", cancelEyebrow: "Paiement interrompu", cancelTitle: "Paiement annulé | PGD Market", cancelText: "Votre paiement n’a pas été finalisé. Vous pouvez revenir à la boutique et réessayer.", backShop: "Retour à la boutique" },
  en: { reviewsEyebrow: "Customer feedback", reviewsTitle: "What our customers think", reviewsEmpty: "Customer reviews will appear here when they become available.", successEyebrow: "Payment confirmed", successTitle: "Payment successful | PGD Market", successText: "Your payment was processed. If your product is available, follow the download instructions provided.", cancelEyebrow: "Payment interrupted", cancelTitle: "Payment cancelled | PGD Market", cancelText: "Your payment was not completed. You can return to the shop and try again.", backShop: "Back to shop" }
};

function readPath(source, key) {
  return key.split(".").reduce((value, part) => value?.[part], source);
}

export function t(key, variables = {}) {
  const extraKey = key.startsWith("extra.") ? key.slice(6) : null;
  let value = extraKey ? (extraTranslations[currentLanguage][extraKey] ?? extraTranslations.fr[extraKey]) : (readPath(translations, key) ?? readPath(frenchTranslations, key) ?? key);
  Object.entries(variables).forEach(([name, replacement]) => {
    value = value.replace(`{{${name}}}`, replacement);
  });
  return value;
}

function translatePage() {
  document.documentElement.lang = currentLanguage;
  const titleKeys = { home: "titles.home", shop: "titles.shop", product: "titles.product", checkout: "titles.checkout", cart: "titles.cart", info: null };
  const fileName = location.pathname.split("/").pop();
  const infoTitleKeys = { "contact.html": "navigation.contact", "mentions-legales.html": "legal.title", "politique-confidentialite.html": "privacy.title" };
  const titleKey = infoTitleKeys[fileName] || titleKeys[document.body.dataset.page];
  if (titleKey) document.title = t(titleKey);
  document.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => { element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel)); });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => { element.textContent = t(element.dataset.i18nTitle); });
}

function addSelector() {
  const nav = document.querySelector(".main-nav");
  if (!nav || nav.querySelector("[data-language-select]")) return;
  const wrapper = document.createElement("label");
  wrapper.className = "language-control";
  wrapper.innerHTML = `<span data-language-label>${t("navigation.language")}</span><select data-language-select aria-label="${t("navigation.language")}"><option value="fr">${t("language.french")}</option><option value="en">${t("language.english")}</option></select>`;
  nav.append(wrapper);
  const select = wrapper.querySelector("select");
  select.value = currentLanguage;
  select.addEventListener("change", async () => { await setLanguage(select.value); });
}

export async function setLanguage(language) {
  currentLanguage = language === "en" ? "en" : defaultLanguage;
  localStorage.setItem(storageKey, currentLanguage);
  const response = await fetch(new URL(`../../locales/${currentLanguage}.json`, import.meta.url));
  translations = await response.json();
  translatePage();
  const selector = document.querySelector("[data-language-select]");
  if (selector) { selector.value = currentLanguage; selector.setAttribute("aria-label", t("navigation.language")); selector.querySelector("option[value=fr]").textContent = t("language.french"); selector.querySelector("option[value=en]").textContent = t("language.english"); document.querySelector("[data-language-label]").textContent = t("navigation.language"); }
  document.dispatchEvent(new CustomEvent("languagechange"));
}

export async function initLanguage() {
  const frenchResponse = await fetch(new URL("../../locales/fr.json", import.meta.url));
  frenchTranslations = await frenchResponse.json();
  await setLanguage(localStorage.getItem(storageKey) || defaultLanguage);
  addSelector();
  translatePage();
}

export { addSelector };