const verifyPayment = async (paymentId) => {
  const secret = process.env.MONEROO_SECRET_KEY;
  if (!secret || !paymentId) return null;

  const response = await fetch(
    `https://api.moneroo.io/v1/payments/${encodeURIComponent(paymentId)}/verify`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${secret}`
      }
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || "La vérification Moneroo a échoué.");
    error.statusCode = response.status;
    throw error;
  }

  return payload?.data || null;
};

const getCurrencyCode = (currency) =>
  typeof currency === "string" ? currency : currency?.code;

const exchangeRates = { XOF: 1, EUR: 0.00152, USD: 0.00165 };
const supportedCurrencies = new Set(Object.keys(exchangeRates));

const normalizeCurrency = (currency) => {
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return supportedCurrencies.has(normalized) ? normalized : "";
};

const getExpectedAmount = (product, currency) => product.prix * exchangeRates[currency];

const isSuccessfulStatus = (status) => ["success", "paid"].includes(String(status).toLowerCase());

const isPaymentForProduct = (payment, product) => {
  if (!payment || !product) return false;

  const metadata = payment.metadata || {};
  const expectedCurrency = normalizeCurrency(metadata.currency);
  const paymentCurrency = normalizeCurrency(getCurrencyCode(payment.currency));
  return (
    isSuccessfulStatus(payment.status) &&
    expectedCurrency &&
    paymentCurrency === expectedCurrency &&
    Number(payment.amount) === getExpectedAmount(product, expectedCurrency) &&
    String(metadata.produitId || "") === product.id
  );
};

module.exports = {
  getCurrencyCode,
  getExpectedAmount,
  isPaymentForProduct,
  isSuccessfulStatus,
  normalizeCurrency,
  verifyPayment
};
