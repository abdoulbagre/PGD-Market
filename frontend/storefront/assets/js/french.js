let translations = {};

function readPath(key) {
  return key.split(".").reduce((value, part) => value?.[part], translations);
}

export function t(key, variables = {}) {
  let value = readPath(key) ?? key;
  Object.entries(variables).forEach(([name, replacement]) => {
    value = value.replace(`{{${name}}}`, replacement);
  });
  return value;
}

function translatePage() {
  document.documentElement.lang = "fr";
  const titleKeys = {
    home: "titles.home",
    shop: "titles.shop",
    product: "titles.product",
    checkout: "titles.checkout",
    cart: "titles.cart",
    info: null
  };
  const fileName = location.pathname.split("/").pop();
  const infoTitleKeys = {
    "contact.html": "navigation.contact",
    "mentions-legales.html": "legal.title",
    "politique-confidentialite.html": "privacy.title"
  };
  const titleKey = infoTitleKeys[fileName] || titleKeys[document.body.dataset.page];
  if (titleKey) document.title = t(titleKey);
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.textContent = t(element.dataset.i18nTitle);
  });
}

export async function initFrench() {
  const response = await fetch(new URL("../../locales/fr.json", import.meta.url));
  if (!response.ok) {
    throw new Error("Les textes français du site sont indisponibles.");
  }
  translations = await response.json();
  translatePage();
}
