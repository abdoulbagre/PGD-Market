const DISPLAY_CURRENCY_STORAGE_KEY = "pgd-display-currency";

export const formatDisplayPrice = (price, currency) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
    currencyDisplay: "code"
  }).format(price);

export const clearLegacyCurrencyPreference = () => {
  try {
    localStorage.removeItem(DISPLAY_CURRENCY_STORAGE_KEY);
  } catch {
    return false;
  }
  return true;
};
