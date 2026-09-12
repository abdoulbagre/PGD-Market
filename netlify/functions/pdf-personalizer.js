const { PDFDocument, rgb, StandardFonts, degrees } = require("pdf-lib");

const toText = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const getNestedValue = (source, pathList) => {
  if (!source || typeof source !== "object") return "";
  let current = source;
  for (const key of pathList) {
    if (current === null || current === undefined || typeof current !== "object") return "";
    current = current[key];
  }
  return current;
};

const getDateValue = (payment) => {
  const dateValue =
    getNestedValue(payment, ["paid_at"]) ||
    getNestedValue(payment, ["paidAt"]) ||
    getNestedValue(payment, ["created_at"]) ||
    getNestedValue(payment, ["createdAt"]) ||
    getNestedValue(payment, ["date"]) ||
    getNestedValue(payment, ["created", "date"]) ||
    null;

  if (!dateValue) return null;
  const parsed = new Date(dateValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDateTime = (dateValue) => {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    throw new Error("DATE_ACHAT_MANQUANTE");
  }

  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Ouagadougou"
  }).format(date).replace(",", "");
};

const extractCustomerData = (payment, fallbackPaymentId = "") => {
  const customer = payment?.customer || payment?.payer || {};

  const firstName = toText(
    getNestedValue(customer, ["first_name"]) ||
    getNestedValue(customer, ["firstName"]) ||
    getNestedValue(payment, ["customer", "first_name"]) ||
    getNestedValue(payment, ["customer", "firstName"]) ||
    ""
  );

  const lastName = toText(
    getNestedValue(customer, ["last_name"]) ||
    getNestedValue(customer, ["lastName"]) ||
    getNestedValue(payment, ["customer", "last_name"]) ||
    getNestedValue(payment, ["customer", "lastName"]) ||
    ""
  );

  const email = toText(
    getNestedValue(customer, ["email"]) ||
    getNestedValue(payment, ["customer", "email"]) ||
    getNestedValue(payment, ["email"]) ||
    ""
  );

  const rawFullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (!email) {
    throw new Error("EMAIL_ACHETEUR_MANQUANT");
  }
  if (!rawFullName) {
    throw new Error("NOM_ACHETEUR_MANQUANT");
  }

  const purchaseDate = getDateValue(payment);
  if (!purchaseDate) {
    throw new Error("DATE_ACHAT_MANQUANTE");
  }

  const reference = toText(
    payment?.reference ||
    payment?.order_reference ||
    payment?.id ||
    fallbackPaymentId ||
    ""
  );

  if (!reference) {
    throw new Error("REFERENCE_ACHAT_MANQUANTE");
  }

  return {
    email,
    fullName: rawFullName,
    reference,
    purchaseDate,
    paymentId: toText(payment?.id || fallbackPaymentId || "")
  };
};

async function personalizePdfBuffer(pdfBuffer, payment, fallbackPaymentId = "") {
  if (!pdfBuffer || !pdfBuffer.length) {
    throw new Error("empty-pdf");
  }

  const { email, fullName, reference, purchaseDate } = extractCustomerData(payment, fallbackPaymentId);
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const watermarkText = `${email} — ${formatDateTime(purchaseDate)}`;
  const darkGray = rgb(0.15, 0.15, 0.15);
  const subtleGray = rgb(0.38, 0.38, 0.38);
  const gold = rgb(0.82, 0.68, 0.12);

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    const centerX = width / 2;
    const centerY = height / 2;
    const watermarkSize = 18;
    const watermarkAngle = 45;
    const watermarkWidth = font.widthOfTextAtSize(watermarkText, watermarkSize);
    const watermarkHeight = font.heightAtSize(watermarkSize);
    const angleRadians = (watermarkAngle * Math.PI) / 180;
    const watermarkX = centerX - (
      watermarkWidth * Math.cos(angleRadians) + watermarkHeight * Math.sin(angleRadians)
    ) / 2;
    const watermarkY = centerY - (
      watermarkWidth * Math.sin(angleRadians) + watermarkHeight * Math.cos(angleRadians)
    ) / 2;

    page.drawText(watermarkText, {
      x: watermarkX,
      y: watermarkY,
      size: watermarkSize,
      font,
      color: subtleGray,
      opacity: 0.38,
      rotate: degrees(watermarkAngle)
    });

    const footerPrefix = `Acheté par : ${fullName} | Réf. commande : ${reference} | `;
    const footerTextX = 24;
    const footerTextY = 18;
    const prefixWidth = font.widthOfTextAtSize(footerPrefix, 9);

    page.drawText(footerPrefix, {
      x: footerTextX,
      y: footerTextY,
      size: 9,
      font,
      color: darkGray
    });

    page.drawText("PGD", {
      x: footerTextX + prefixWidth + 4,
      y: footerTextY,
      size: 9,
      font,
      color: gold
    });
  });

  const personalizedBytes = await pdfDoc.save();
  return Buffer.from(personalizedBytes);
}

module.exports = {
  extractCustomerData,
  formatDateTime,
  personalizePdfBuffer
};
