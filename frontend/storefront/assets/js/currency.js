const DISPLAY_CURRENCY_STORAGE_KEY = "pgd-display-currency";

export const CHECKOUT_CURRENCY = "XOF";

export const formatDisplayPrice = (price, currency) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
    currencyDisplay: "code"
  }).format(price);

export const sumPricesInSameCurrency = (products) => {
  if (!products.length) return null;

  const currency = products[0].currency;
  if (!products.every((product) => product.currency === currency)) return null;

  const amount = products.reduce((sum, product) => sum + product.price, 0);
  return Number.isSafeInteger(amount) ? { amount, currency } : null;
};

export const clearLegacyCurrencyPreference = () => {
  try {
    localStorage.removeItem(DISPLAY_CURRENCY_STORAGE_KEY);
  } catch {
    return false;
  }
  return true;
};
