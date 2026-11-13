import { AuthAccessError, requireAdmin } from "./_auth.mjs";

const API_BASE_URL = "https://api.chariow.com/v1";
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_CURSOR_LENGTH = 2048;
const MAX_SEARCH_LENGTH = 255;
const PRODUCT_ID_PATTERN = /^prd_[A-Za-z0-9_-]{1,120}$/;
const SALE_ID_PATTERN = /^sal_[A-Za-z0-9_-]{1,120}$/;
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
};

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const pick = (value, fields) => {
  if (!isRecord(value)) return null;
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value, field))
    .map((field) => [field, value[field]]));
};

const projectStore = (store) => {
  if (!isRecord(store)) return null;
  const result = pick(store, [
    "id",
    "name",
    "description",
    "logo_url",
    "url",
    "social_links",
    "status",
    "stats"
  ]);
  if (result.social_links !== undefined) {
    result.social_links = pick(result.social_links, [
      "telegram",
      "instagram",
      "facebook",
      "x",
      "linkedin",
      "youtube",
      "tiktok",
      "discord"
    ]);
  }
  if (result.stats !== undefined) {
    result.stats = pick(result.stats, ["total_customers", "ratings"]);
    if (result.stats?.ratings) {
      result.stats.ratings = pick(result.stats.ratings, [
        "total_ratings",
        "thumbs_up_count",
        "thumbs_up_percentage"
      ]);
    }
  }
  return result;
};

const projectProduct = (product) => {
  if (!isRecord(product) || typeof product.id !== "string") return null;
  const result = pick(product, [
    "id",
    "name",
    "slug",
    "description",
    "type",
    "category",
    "status",
    "is_free",
    "pictures",
    "pricing",
    "has_variant_pricing",
    "quantity",
    "settings",
    "sales_count",
    "on_sale_until",
    "custom_cta_text"
  ]);
  if (result.category !== undefined) {
    result.category = pick(result.category, ["value", "label"]);
  }
  if (result.pictures !== undefined) {
    result.pictures = pick(result.pictures, ["thumbnail", "cover"]);
  }
  if (result.pricing !== undefined) {
    if (isRecord(result.pricing)) {
      result.pricing = pick(result.pricing, [
        "type",
        "current_price",
        "price",
        "effective",
        "sale_price",
        "minimum_price",
        "suggested_price",
        "price_off"
      ]);
      for (const field of [
        "current_price",
        "price",
        "effective",
        "sale_price",
        "minimum_price",
        "suggested_price",
        "price_off"
      ]) {
        if (result.pricing[field] !== undefined) {
          result.pricing[field] = isRecord(result.pricing[field])
            ? pick(result.pricing[field], ["value", "currency", "formatted"])
            : result.pricing[field];
        }
      }
    } else result.pricing = null;
  }
  if (result.quantity !== undefined && result.quantity !== null) {
    result.quantity = pick(result.quantity, ["value", "remaining", "sold", "total"]);
  }
  if (result.settings !== undefined) {
    result.settings = pick(result.settings, ["is_shipping_address_required"]);
  }
  if (result.sales_count !== undefined) {
    result.sales_count = isRecord(result.sales_count)
      ? pick(result.sales_count, ["value", "formatted"])
      : result.sales_count;
  }
  return result;
};

const projectAmount = (amount) => {
  if (!isRecord(amount)) return null;
  const result = {};
  if (typeof amount.value === "number" && Number.isFinite(amount.value)) {
    result.value = amount.value;
  }
  if (typeof amount.formatted === "string") result.formatted = amount.formatted;
  if (typeof amount.currency === "string") result.currency = amount.currency;
  return result;
};

const projectSale = (sale) => {
  if (!isRecord(sale) || typeof sale.id !== "string" || !sale.id) return null;
  const result = pick(sale, ["id", "status", "created_at", "completed_at"]);
  for (const field of ["status", "created_at", "completed_at"]) {
    if (result[field] !== undefined && typeof result[field] !== "string" &&
        !(field === "completed_at" && result[field] === null)) {
      delete result[field];
    }
  }
  for (const field of ["amount", "original_amount", "discount_amount"]) {
    if (Object.hasOwn(sale, field)) result[field] = projectAmount(sale[field]);
  }
  if (isRecord(sale.product)) {
    result.product = pick(sale.product, ["id", "name"]);
    for (const field of ["id", "name"]) {
      if (result.product[field] !== undefined && typeof result.product[field] !== "string") {
        delete result.product[field];
      }
    }
  } else if (sale.product === null) {
    result.product = null;
  }
  if (isRecord(sale.payment) &&
      (typeof sale.payment.status === "string" || sale.payment.status === null)) {
    result.payment = { status: sale.payment.status };
    if (Object.hasOwn(sale.payment, "amount")) {
      result.payment.amount = projectAmount(sale.payment.amount);
    }
  }
  return result;
};

const projectPagination = (pagination) => {
  if (!isRecord(pagination)) return null;
  const result = pick(pagination, [
    "count",
    "per_page",
    "next_cursor",
    "prev_cursor",
    "has_more_pages",
    "has_pages"
  ]);
  if (
    !Number.isInteger(result.count) ||
    result.count < 0 ||
    !Number.isInteger(result.per_page) ||
    result.per_page < 1 ||
    result.per_page > MAX_PAGE_SIZE ||
    typeof result.has_more_pages !== "boolean" ||
    ![null, undefined].includes(result.next_cursor) &&
      !isSafeCursor(result.next_cursor) ||
    ![null, undefined].includes(result.prev_cursor) &&
      !isSafeCursor(result.prev_cursor) ||
    result.has_more_pages && !isSafeCursor(result.next_cursor)
  ) {
    return null;
  }
  return result;
};

const projectionError = () =>
  jsonResponse(502, {
    error: "CHARIOW_INVALID_RESPONSE",
    message: "Chariow a renvoyé une réponse inattendue."
  });

const upstreamError = (response, resource) => {
  if (response.status === 404) {
    if (resource === "sale") {
      return jsonResponse(404, {
        error: "CHARIOW_SALE_NOT_FOUND",
        message: "Cette vente Chariow est introuvable."
      });
    }
    if (resource !== "product") {
      return jsonResponse(404, {
        error: "CHARIOW_RESOURCE_NOT_FOUND",
        message: "Cette ressource Chariow est introuvable."
      });
    }
    return jsonResponse(404, {
      error: "CHARIOW_PRODUCT_NOT_FOUND",
      message: "Ce produit Chariow est introuvable."
    });
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const safeRetryAfter = retryAfter && /^\d{1,6}$/.test(retryAfter)
      ? { "Retry-After": retryAfter }
      : {};
    return jsonResponse(429, {
      error: "CHARIOW_RATE_LIMITED",
      message: "La limite de requêtes Chariow est atteinte. Réessayez dans quelques instants."
    }, safeRetryAfter);
  }
  if (response.status === 401) {
    return jsonResponse(503, {
      error: "CHARIOW_CREDENTIAL_INVALID",
      message: "La clé API Chariow Admin est invalide ou expirée."
    });
  }
  if (response.status === 403) {
    return jsonResponse(503, {
      error: "CHARIOW_SCOPE_MISSING",
      message: "La clé API Chariow Admin n’a pas les permissions de lecture requises."
    });
  }
  if (response.status >= 500) {
    return jsonResponse(502, {
      error: "CHARIOW_UNAVAILABLE",
      message: "L’API Chariow est momentanément indisponible."
    });
  }
  return jsonResponse(502, {
    error: "CHARIOW_REQUEST_FAILED",
    message: "La requête vers Chariow n’a pas abouti."
  });
};

const isSafeCursor = (cursor) =>
  typeof cursor === "string" &&
  cursor.length > 0 &&
  cursor.length <= MAX_CURSOR_LENGTH &&
  !/[\u0000-\u001f\u007f]/.test(cursor);

const getPageSize = (value) => {
  if (value === null) return DEFAULT_PAGE_SIZE;
  if (!/^\d{1,3}$/.test(value)) return null;
  const size = Number(value);
  return Number.isInteger(size) && size >= 1 && size <= MAX_PAGE_SIZE
    ? size
    : null;
};

const allowedQueryKeys = {
  store: new Set(["resource"]),
  products: new Set(["resource", "per_page", "cursor", "search"]),
  product: new Set(["resource", "productId"]),
  sales: new Set(["resource", "per_page", "cursor", "search", "status", "from", "to", "period"]),
  sale: new Set(["resource", "saleId"])
};

const SALE_STATUSES = new Set([
  "initiated",
  "awaiting_payment",
  "completed",
  "failed",
  "abandoned",
  "settled"
]);
const SALE_PERIODS = new Set([
  "today",
  "yesterday",
  "last7days",
  "last30days",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "lastMonth",
  "thisYear",
  "lastYear"
]);
const isCalendarDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const buildApiRequest = (url) => {
  const resource = url.searchParams.get("resource");
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return null;
  if (!Object.hasOwn(allowedQueryKeys, resource)) return null;
  if (keys.some((key) => !allowedQueryKeys[resource].has(key))) {
    return null;
  }

  if (resource === "store") {
    return { resource, path: "/store" };
  }
  if (resource === "product") {
    const productId = url.searchParams.get("productId") || "";
    if (!PRODUCT_ID_PATTERN.test(productId)) return null;
    return { resource, path: `/products/${encodeURIComponent(productId)}` };
  }
  if (resource === "sale") {
    const saleId = url.searchParams.get("saleId") || "";
    if (!SALE_ID_PATTERN.test(saleId)) return null;
    return { resource, path: `/sales/${encodeURIComponent(saleId)}` };
  }

  const perPage = getPageSize(url.searchParams.get("per_page"));
  const cursor = url.searchParams.get("cursor");
  const search = url.searchParams.get("search");
  const status = url.searchParams.get("status");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const period = url.searchParams.get("period");
  if (
    perPage === null ||
    (cursor !== null && !isSafeCursor(cursor)) ||
    (search !== null && search.length > MAX_SEARCH_LENGTH) ||
    (resource === "sales" && status !== null && !SALE_STATUSES.has(status)) ||
    (resource === "sales" && from !== null && !isCalendarDate(from)) ||
    (resource === "sales" && to !== null && !isCalendarDate(to)) ||
    (resource === "sales" && period !== null && !SALE_PERIODS.has(period)) ||
    (resource === "sales" && period !== null && (from !== null || to !== null)) ||
    (resource === "sales" && from !== null && to !== null && to < from)
  ) {
    return null;
  }

  const query = new URLSearchParams({ per_page: String(perPage) });
  if (cursor) query.set("cursor", cursor);
  if (search?.trim()) query.set("search", search.trim());
  if (resource === "sales") {
    if (status) query.set("status", status);
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (period) query.set("period", period);
  }
  return {
    resource,
    perPage,
    path: `/${resource}?${query}`
  };
};

export function createChariowAdminHandler({
  authorizeAdmin = requireAdmin,
  fetchImpl = (...args) => fetch(...args),
  env = process.env,
  timeoutMs = 10000
} = {}) {
  return async function chariowAdminHandler(request) {
    try {
      await authorizeAdmin();
    } catch (error) {
      if (error instanceof AuthAccessError) {
        return jsonResponse(error.status, {
          error: error.code,
          message: error.code === "ADMIN_ROLE_REQUIRED"
            ? "Un rôle administrateur est requis."
            : error.code === "AUTHENTICATION_REQUIRED"
              ? "Connectez-vous pour continuer."
              : "Le service d’authentification est indisponible."
        });
      }
      return jsonResponse(503, {
        error: "AUTH_UNAVAILABLE",
        message: "Le service d’authentification est indisponible."
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(405, {
        error: "METHOD_NOT_ALLOWED",
        message: "Seules les requêtes GET sont autorisées."
      }, { Allow: "GET" });
    }

    const apiRequest = buildApiRequest(new URL(request.url));
    if (!apiRequest) {
      return jsonResponse(400, {
        error: "INVALID_REQUEST",
        message: "La ressource ou les paramètres demandés sont invalides."
      });
    }

    const apiKey = env.CHARIOW_ADMIN_API_KEY?.trim();
    if (!apiKey) {
      return jsonResponse(503, {
        error: "CHARIOW_CONFIGURATION_MISSING",
        message: "La clé API Chariow Admin n’est pas configurée côté serveur."
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API_BASE_URL}${apiRequest.path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal,
        cache: "no-store"
      });
      if (!response.ok) return upstreamError(response, apiRequest.resource);

      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          return jsonResponse(504, {
            error: "CHARIOW_TIMEOUT",
            message: "Chariow met trop de temps à répondre. Réessayez."
          });
        }
        return projectionError();
      }

      if (apiRequest.resource === "store") {
        const store = projectStore(body?.data);
        return store
          ? jsonResponse(200, { data: store })
          : projectionError();
      }

      if (apiRequest.resource === "product") {
        const product = projectProduct(body?.data);
        return product
          ? jsonResponse(200, { data: product })
          : projectionError();
      }

      if (apiRequest.resource === "sale") {
        const sale = projectSale(body?.data);
        return sale
          ? jsonResponse(200, { data: sale })
          : projectionError();
      }

      const projectItem = apiRequest.resource === "sales"
        ? projectSale
        : projectProduct;
      if (
        !Array.isArray(body?.data) ||
        body.data.length > apiRequest.perPage ||
        !body.data.every((item) => projectItem(item))
      ) {
        return projectionError();
      }

      const pagination = projectPagination(body?.pagination);
      if (!pagination) return projectionError();

      return jsonResponse(200, {
        data: body.data.map(projectItem),
        pagination
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        return jsonResponse(504, {
          error: "CHARIOW_TIMEOUT",
          message: "Chariow met trop de temps à répondre. Réessayez."
        });
      }
      return jsonResponse(502, {
        error: "CHARIOW_UNAVAILABLE",
        message: "Impossible de joindre l’API Chariow pour le moment."
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}

export default createChariowAdminHandler();
