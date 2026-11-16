export const RATINGS_SCHEMA_VERSION = 1;
export const CHARIOW_PRODUCT_ID_PATTERN = /^prd_[A-Za-z0-9_-]{1,120}$/;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class RatingsModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RatingsModelError";
    this.code = code;
  }
}

export function validateChariowProductId(productId) {
  if (
    typeof productId !== "string" ||
    !CHARIOW_PRODUCT_ID_PATTERN.test(productId)
  ) {
    throw new RatingsModelError(
      "INVALID_CHARIOW_PRODUCT_ID",
      "A valid Chariow product ID is required."
    );
  }

  return productId;
}

export function validateRating(rating) {
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    throw new RatingsModelError(
      "INVALID_RATING",
      "A PGD rating must be an integer from zero through five."
    );
  }

  return rating;
}

export function validateRatings(ratings) {
  if (!isRecord(ratings)) {
    throw new RatingsModelError("INVALID_RATINGS", "Ratings must be an object.");
  }

  for (const [productId, rating] of Object.entries(ratings)) {
    validateChariowProductId(productId);
    validateRating(rating);
  }

  return ratings;
}
