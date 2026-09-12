const DISPLAY_CURRENCY_STORAGE_KEY = "pgd-display-currency";

// Configured display rates only; these are not live market or payment rates.
export const currencyOptions = [
  { flag: "", label: "Franc CFA", currency: "XOF" },
  { flag: "🇫🇷", label: "Euro", currency: "EUR" },
  { flag: "🇺🇸", label: "Dollar", currency: "USD" }
];

export const exchangeRates = {
  XOF: 1,
  EUR: 0.00152,
  USD: 0.00165
};

const supportedCurrencies = new Set(Object.keys(exchangeRates));
const defaultCurrency = "XOF";

const euroCountries = new Set([
  "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"
]);

const xofCountries = new Set(["BF", "BJ", "CI", "GW", "ML", "NE", "SN", "TG"]);

const getBrowserCountry = () => {
  if (typeof navigator === "undefined") return "";
  const languages = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  for (const language of languages) {
    const region = String(language || "").match(/[-_]([A-Za-z]{2}|\d{3})$/)?.[1]?.toUpperCase();
    if (region) return region;
  }
  return "";
};

export const detectCurrency = () => {
  const country = getBrowserCountry();
  if (country === "US") return "USD";
  if (euroCountries.has(country)) return "EUR";
  if (xofCountries.has(country)) return "XOF";
  return defaultCurrency;
};

export const convertPrice = (priceXOF, currency = defaultCurrency) => {
  const rate = exchangeRates[currency] || exchangeRates[defaultCurrency];
  return Number(priceXOF) * rate;
};

export const formatDisplayPrice = (priceXOF, currency = getSelectedCurrency()) => {
  const normalizedCurrency = supportedCurrencies.has(currency) ? currency : defaultCurrency;
  const amount = convertPrice(priceXOF, normalizedCurrency);
  if (normalizedCurrency === "USD") {
    return `$${new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount)}`;
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: normalizedCurrency,
    maximumFractionDigits: normalizedCurrency === "XOF" ? 0 : 2
  }).format(amount);
};

export const getSelectedCurrency = () => {
  try {
    const storedCurrency = localStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY);
    if (supportedCurrencies.has(storedCurrency)) return storedCurrency;
  } catch {
    // Use automatic detection when storage is unavailable.
  }

  return detectCurrency();
};

export const setSelectedCurrency = (currency) => {
  const nextCurrency = supportedCurrencies.has(currency) ? currency : defaultCurrency;
  try {
    localStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, nextCurrency);
  } catch {
    // The current page can still use the selected currency without storage.
  }
  return nextCurrency;
};
