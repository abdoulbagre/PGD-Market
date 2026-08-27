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

const isSuccessfulStatus = (status) => ["success", "paid"].includes(String(status).toLowerCase());

const isPaymentForProduct = (payment, product) => {
  if (!payment || !product) return false;

  const metadata = payment.metadata || {};
  return (
    isSuccessfulStatus(payment.status) &&
    Number(payment.amount) === Number(product.prix) &&
    String(getCurrencyCode(payment.currency) || "").toUpperCase() === "XOF" &&
    String(metadata.produitId || "") === product.id
  );
};

module.exports = { getCurrencyCode, isPaymentForProduct, isSuccessfulStatus, verifyPayment };
