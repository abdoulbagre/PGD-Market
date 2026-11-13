const API_BASE_URL = "https://api.chariow.com/v1";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_CURSOR_LENGTH = 2048;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class ChariowApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ChariowApiError";
    this.status = status;
    this.code = code;
  }
}

const parseResponse = async (response) => {
  if (!response.ok) {
    if (response.status === 401) {
      throw new ChariowApiError(503, "CHARIOW_CREDENTIAL_INVALID", "Chariow authentication failed.");
    }
    if (response.status === 403) {
      throw new ChariowApiError(503, "CHARIOW_SCOPE_MISSING", "The Chariow key lacks products.read.");
    }
    if (response.status === 429) {
      throw new ChariowApiError(503, "CHARIOW_RATE_LIMITED", "Chariow rate limit reached.");
    }
    if (response.status === 404) {
      throw new ChariowApiError(404, "CHARIOW_PRODUCT_NOT_FOUND", "Chariow product not found.");
    }
    throw new ChariowApiError(502, "CHARIOW_UNAVAILABLE", "The Chariow API request failed.");
  }

  try {
    return await response.json();
  } catch {
    throw new ChariowApiError(502, "CHARIOW_INVALID_RESPONSE", "Chariow returned invalid JSON.");
  }
};

const requestPage = async ({
  fetchImpl,
  apiKey,
  cursor,
  timeoutMs
}) => {
  const url = new URL(`${API_BASE_URL}/products`);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  if (cursor) url.searchParams.set("cursor", cursor);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal,
        cache: "no-store"
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new ChariowApiError(504, "CHARIOW_TIMEOUT", "Chariow timed out.");
      }
      throw new ChariowApiError(502, "CHARIOW_UNAVAILABLE", "Chariow could not be reached.");
    }

    return await parseResponse(response);
  } finally {
    clearTimeout(timeout);
  }
};

const requestProduct = async ({
  fetchImpl,
  apiKey,
  productId,
  timeoutMs
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(
        `${API_BASE_URL}/products/${encodeURIComponent(productId)}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          signal: controller.signal,
          cache: "no-store"
        }
      );
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new ChariowApiError(504, "CHARIOW_TIMEOUT", "Chariow timed out.");
      }
      throw new ChariowApiError(502, "CHARIOW_UNAVAILABLE", "Chariow could not be reached.");
    }

    return await parseResponse(response);
  } finally {
    clearTimeout(timeout);
  }
};

const validateApiKey = (apiKey) => {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new ChariowApiError(503, "CHARIOW_CONFIGURATION_MISSING", "Chariow products are not configured.");
  }
  return apiKey.trim();
};

export async function fetchChariowProduct({
  apiKey,
  productId,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = 10000
} = {}) {
  const validApiKey = validateApiKey(apiKey);
  if (
    typeof productId !== "string" ||
    productId.length > 128 ||
    !/^prd_[A-Za-z0-9_-]+$/.test(productId)
  ) {
    throw new ChariowApiError(400, "INVALID_CHARIOW_PRODUCT_ID", "Invalid Chariow product ID.");
  }

  const body = await requestProduct({
    fetchImpl,
    apiKey: validApiKey,
    productId,
    timeoutMs
  });
  if (!isRecord(body?.data) || body.data.id !== productId) {
    throw new ChariowApiError(502, "CHARIOW_INVALID_RESPONSE", "Chariow returned invalid product data.");
  }
  return body.data;
}

export async function fetchChariowProducts({
  apiKey,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = 10000
} = {}) {
  const validApiKey = validateApiKey(apiKey);

  const products = [];
  const seenCursors = new Set();
  let cursor = "";

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await requestPage({
      fetchImpl,
      apiKey: validApiKey,
      cursor,
      timeoutMs
    });
    const pagination = body?.pagination;
    if (
      !Array.isArray(body?.data) ||
      body.data.length > PAGE_SIZE ||
      !body.data.every((product) => isRecord(product) && typeof product.id === "string") ||
      !isRecord(pagination) ||
      typeof pagination.has_more_pages !== "boolean"
    ) {
      throw new ChariowApiError(502, "CHARIOW_INVALID_RESPONSE", "Chariow returned invalid product pagination.");
    }
    products.push(...body.data);

    if (!pagination.has_more_pages) return products;

    const nextCursor = pagination.next_cursor;
    if (
      typeof nextCursor !== "string" ||
      nextCursor.length === 0 ||
      nextCursor.length > MAX_CURSOR_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(nextCursor) ||
      seenCursors.has(nextCursor)
    ) {
      throw new ChariowApiError(502, "CHARIOW_INVALID_RESPONSE", "Chariow returned an invalid cursor.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new ChariowApiError(502, "CHARIOW_PAGE_LIMIT", "Chariow returned too many product pages.");
}
