const catalogEndpoint = "/.netlify/functions/catalog";
const catalogInitializationEndpoint = "/.netlify/functions/initialize-catalog";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const frenchText = (value) => typeof value === "string" ? value : value.fr;

export function getProductActions(product, archived = false) {
  if (archived) return ["restore", "delete"];
  return [
    "edit",
    "publication",
    ...(product.published ? ["availability"] : []),
    "archive"
  ];
}

export function getProductStatusTransition(product, action) {
  if (action === "publication") {
    return {
      published: !product.published,
      available: product.published ? false : product.available
    };
  }
  if (action === "availability" && product.published) {
    return { published: true, available: !product.available };
  }
  return null;
}

export function createAdminSessionLifecycle({ onExpire, onAuthenticate }) {
  let generation = 0;
  let authenticated = false;

  function isCurrent(session) {
    return authenticated && session === generation;
  }

  return {
    change(isAuthenticated) {
      const session = ++generation;
      authenticated = isAuthenticated === true;
      if (!authenticated) {
        onExpire();
        return { session, refresh: Promise.resolve(null) };
      }

      return {
        session,
        refresh: Promise.resolve(onAuthenticate(session))
          .then((result) => isCurrent(session) ? result : null)
      };
    },
    isCurrent,
    get currentSession() {
      return generation;
    }
  };
}

export class AdminCatalogError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.name = "AdminCatalogError";
    this.status = status;
    this.code = code;
  }
}

export function createAdminCatalogController(fetchImpl = (...args) => fetch(...args)) {
  let etag = "";
  let mutationInProgress = false;
  let editing = null;

  async function request(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...options
      });
    } catch {
      throw new AdminCatalogError(0, "Connexion impossible. Vérifiez votre connexion puis réessayez.");
    }

    if (!response.ok) {
      const messages = {
        401: "Votre session a expiré. Reconnectez-vous pour continuer.",
        403: "Accès administrateur refusé.",
        404: "Ce produit n’existe plus dans le catalogue.",
        409: "Le catalogue a changé ou l’opération n’est plus valide. Actualisez les données.",
        412: "Le catalogue a été modifié par un autre administrateur. Rechargez la version serveur avant de reprendre.",
        503: "Le catalogue central est indisponible. Réessayez ultérieurement."
      };
      let code = "";
      try {
        const body = await response.json();
        if (isRecord(body) && typeof body.error === "string") code = body.error;
      } catch {
        // The status code still provides a clear, actionable error.
      }
      throw new AdminCatalogError(
        response.status,
        messages[response.status] || "Le service du catalogue n’a pas pu traiter la demande.",
        code
      );
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new AdminCatalogError(0, "Le service du catalogue a renvoyé une réponse illisible.");
    }
    const responseEtag = response.headers.get("etag");
    if (!isRecord(result) || !Array.isArray(result.products) || !responseEtag) {
      throw new AdminCatalogError(0, "La réponse du catalogue ne contient pas les données ou la version attendues.");
    }
    return { result, etag: responseEtag };
  }

  async function load({ archived = false } = {}) {
    const url = archived ? `${catalogEndpoint}?status=archived` : catalogEndpoint;
    const { result, etag: nextEtag } = await request(url);
    etag = nextEtag;
    return { products: result.products, etag };
  }

  async function initializeCatalog() {
    let response;
    try {
      response = await fetchImpl(catalogInitializationEndpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store"
      });
    } catch {
      throw new AdminCatalogError(0, "Connexion impossible. Vérifiez votre connexion puis réessayez.");
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new AdminCatalogError(0, "Le service d’initialisation a renvoyé une réponse illisible.");
    }
    if (!response.ok) {
      const messages = {
        400: "La requête d’initialisation a été refusée.",
        401: "Votre session a expiré. Reconnectez-vous pour continuer.",
        403: "L’initialisation est autorisée uniquement pour un administrateur en production.",
        503: "L’initialisation du catalogue est indisponible. Vérifiez la configuration serveur puis réessayez."
      };
      throw new AdminCatalogError(
        response.status,
        messages[response.status] || "Le service d’initialisation n’a pas pu traiter la demande."
      );
    }
    if (!isRecord(result) || !["initialized", "already_exists"].includes(result.result)) {
      throw new AdminCatalogError(0, "Le service d’initialisation a renvoyé un résultat inattendu.");
    }
    return result.result;
  }

  function beginEdit(product) {
    if (!product || typeof product.id !== "string" || !etag) {
      throw new AdminCatalogError(0, "Actualisez le catalogue avant de modifier un produit.");
    }
    editing = { id: product.id, etag, blocked: false };
    return editing.etag;
  }

  function clearEdit() {
    editing = null;
  }

  function invalidate() {
    etag = "";
    editing = null;
  }

  async function reloadEdit(productId) {
    if (!editing || editing.id !== productId || !editing.blocked) {
      throw new AdminCatalogError(0, "Aucun rechargement de conflit n’est en attente.");
    }
    let result = await load();
    let product = result.products.find((candidate) => candidate.id === productId);
    if (!product) {
      result = await load({ archived: true });
      product = result.products.find((candidate) => candidate.id === productId);
    }
    if (!product) {
      throw new AdminCatalogError(404, "Le produit n’existe plus. Le formulaire reste bloqué.");
    }
    editing = { id: productId, etag: result.etag, blocked: false };
    return { product, etag: result.etag };
  }

  async function mutate({ method, productId, body, ifMatch = etag }) {
    if (mutationInProgress) {
      throw new AdminCatalogError(0, "Une modification est déjà en cours.");
    }
    if (!ifMatch) {
      throw new AdminCatalogError(0, "La version du catalogue manque. Actualisez avant de modifier.");
    }
    if (editing && editing.id === productId && editing.blocked) {
      throw new AdminCatalogError(
        412,
        "Le formulaire est bloqué après un conflit. Rechargez la version serveur avant de reprendre.",
        "CATALOG_CONFLICT"
      );
    }
    mutationInProgress = true;
    try {
      const url = productId
        ? `${catalogEndpoint}?id=${encodeURIComponent(productId)}`
        : catalogEndpoint;
      const { result, etag: nextEtag } = await request(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "If-Match": ifMatch
        },
        body: JSON.stringify(body)
      });
      etag = nextEtag;
      return { products: result.products, product: result.product, etag };
    } catch (error) {
      if (error instanceof AdminCatalogError && error.status === 412 &&
          editing && editing.id === productId) {
        editing.blocked = true;
      }
      throw error;
    } finally {
      mutationInProgress = false;
    }
  }

  return {
    load,
    initializeCatalog,
    mutate,
    beginEdit,
    clearEdit,
    invalidate,
    reloadEdit,
    get etag() {
      return etag;
    }
  };
}

const chariowAdminEndpoint = "/.netlify/functions/chariow-admin";
const pgdCatalogEndpoint = "/.netlify/functions/catalog";
const CHARIOW_PAGE_SIZE = 20;

export class ChariowAdminError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.name = "ChariowAdminError";
    this.status = status;
    this.code = code;
  }
}

export function createChariowAdminClient(fetchImpl = (...args) => fetch(...args)) {
  return {
    async request(params) {
      const query = new URLSearchParams(params);
      let response;
      try {
        response = await fetchImpl(`${chariowAdminEndpoint}?${query}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
      } catch {
        throw new ChariowAdminError(0, "Connexion impossible. Vérifiez votre connexion puis réessayez.");
      }

      let result;
      try {
        result = await response.json();
      } catch {
        throw new ChariowAdminError(0, "Le service Chariow a renvoyé une réponse illisible.");
      }

      if (!response.ok) {
        const messages = {
          401: "Votre session administrateur a expiré. Reconnectez-vous.",
          400: "La requête envoyée à Chariow est invalide.",
          429: "La limite de requêtes Chariow est atteinte. Réessayez dans quelques instants.",
          502: "L’API Chariow est momentanément indisponible.",
          503: "La configuration serveur Chariow est invalide ou incomplète.",
          504: "Chariow met trop de temps à répondre. Réessayez."
        };
        throw new ChariowAdminError(
          response.status,
          isRecord(result) && typeof result.message === "string"
            ? result.message
            : messages[response.status] || "La requête Chariow n’a pas abouti.",
          isRecord(result) && typeof result.error === "string" ? result.error : ""
        );
      }

      if (!isRecord(result)) {
        throw new ChariowAdminError(0, "Le service Chariow a renvoyé une réponse inattendue.");
      }
      return result;
    }
  };
}

export function createChariowAdminUI({
  document: documentRef,
  fetchImpl = (...args) => fetch(...args),
  onSessionExpired = () => {}
}) {
  const client = createChariowAdminClient(fetchImpl);
  const tabs = [...documentRef.querySelectorAll("[data-chariow-tab]")];
  const panels = [...documentRef.querySelectorAll("[data-chariow-panel]")];
  const refreshButton = documentRef.querySelector("[data-chariow-refresh]");
  const overviewStatus = documentRef.querySelector("[data-chariow-overview-status]");
  const storeCard = documentRef.querySelector("[data-chariow-store]");
  const storeLogo = documentRef.querySelector("[data-chariow-logo]");
  const storeName = documentRef.querySelector("[data-chariow-name]");
  const storeUrl = documentRef.querySelector("[data-chariow-url]");
  const storeStatus = documentRef.querySelector("[data-chariow-store-status]");
  const storeDescription = documentRef.querySelector("[data-chariow-description]");
  const statsPanel = documentRef.querySelector("[data-chariow-stats]");
  const customersStat = documentRef.querySelector("[data-chariow-stat-customers]");
  const totalCustomers = documentRef.querySelector("[data-chariow-total-customers]");
  const ratingsStat = documentRef.querySelector("[data-chariow-stat-ratings]");
  const totalRatings = documentRef.querySelector("[data-chariow-total-ratings]");
  const positiveRating = documentRef.querySelector("[data-chariow-rating-positive]");
  const updatedTime = documentRef.querySelector("[data-chariow-updated]");
  const searchInput = documentRef.querySelector("[data-chariow-search]");
  const salesSearchInput = documentRef.querySelector("[data-chariow-sales-search]");
  const productsStatus = documentRef.querySelector("[data-chariow-products-status]");
  const productsList = documentRef.querySelector("[data-chariow-products]");
  const productsEmpty = documentRef.querySelector("[data-chariow-products-empty]");
  const previousButton = documentRef.querySelector("[data-chariow-previous]");
  const nextButton = documentRef.querySelector("[data-chariow-next]");
  const pageStatus = documentRef.querySelector("[data-chariow-page-status]");
  const salesStatus = documentRef.querySelector("[data-chariow-sales-status]");
  const salesList = documentRef.querySelector("[data-chariow-sales]");
  const salesEmpty = documentRef.querySelector("[data-chariow-sales-empty]");
  const salesPreviousButton = documentRef.querySelector("[data-chariow-sales-previous]");
  const salesNextButton = documentRef.querySelector("[data-chariow-sales-next]");
  const salesPageStatus = documentRef.querySelector("[data-chariow-sales-page-status]");
  const detailsDialog = documentRef.querySelector("[data-chariow-dialog]");
  const detailsTitle = documentRef.querySelector("[data-chariow-dialog-title]");
  const detailBody = documentRef.querySelector("[data-chariow-detail-body]");
  const closeDetailsButtons = [...documentRef.querySelectorAll("[data-chariow-dialog-close]")];
  let overviewLoaded = false;
  let productsLoaded = false;
  let salesLoaded = false;
  let activeTab = "overview";
  let overviewRequest = 0;
  let pgdProducts = null;
  let pgdCatalogError = "";
  let pgdCatalogRequest = 0;
  let pgdCatalogPromise = null;
  let pageInfo = null;
  let productsRequest = 0;
  let salesPageInfo = null;
  let salesRequest = 0;
  let searchTimer = null;
  let salesSearchTimer = null;
  let detailRequest = 0;

  const setStatus = (element, message, state = "") => {
    element.textContent = message;
    if (state) element.dataset.state = state;
    else delete element.dataset.state;
  };

  const safeHttpsUrl = (value) => {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  };

  const formatCount = (value) =>
    Number.isSafeInteger(value) && value >= 0
      ? new Intl.NumberFormat("fr-FR").format(value)
      : "";

  const safePrice = (product) =>
    product?.pricing?.current_price ||
    product?.pricing?.effective ||
    product?.pricing?.price ||
    null;

  const priceLabel = (product) => {
    if (product?.is_free === true) return "Gratuit";
    if (product?.has_variant_pricing === true) return "Prix selon variante";
    const price = safePrice(product);
    if (!price) return "Prix non renseigné";
    const formatted = typeof price.formatted === "string" ? price.formatted : "";
    const currency = typeof price.currency === "string" ? price.currency : "";
    const numeric = typeof price.value === "number"
      ? new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(price.value)
      : "";
    const amount = formatted || numeric;
    if (!amount) return "Prix non renseigné";
    return currency && !formatted.toUpperCase().includes(currency.toUpperCase())
      ? `${amount} ${currency}`
      : currency
        ? `${amount} · ${currency}`
        : amount;
  };

  const saleAmountLabel = (amount) => {
    if (!isRecord(amount)) return "Montant non renseigné";
    const formatted = typeof amount.formatted === "string" && amount.formatted
      ? amount.formatted
      : typeof amount.value === "number" && Number.isFinite(amount.value)
        ? String(amount.value)
        : "";
    if (!formatted) return "Montant non renseigné";
    const currency = typeof amount.currency === "string" ? amount.currency : "";
    return currency && !formatted.toUpperCase().includes(currency.toUpperCase())
      ? `${formatted} · ${currency}`
      : formatted;
  };

  const saleDateLabel = (value) => {
    if (typeof value !== "string" || !value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  };

  const productStatusLabel = (status) => ({
    published: "Publié",
    draft: "Brouillon",
    active: "Actif",
    suspended: "Suspendu"
  })[status] || (typeof status === "string" && status ? status : "Non renseigné");

  const clearImage = (image) => {
    image.removeAttribute("src");
    image.hidden = true;
  };

  function renderStore(store) {
    storeCard.hidden = false;
    storeName.textContent = typeof store.name === "string" ? store.name : "Nom non renseigné";
    const safeStoreUrl = safeHttpsUrl(store.url);
    storeUrl.hidden = !safeStoreUrl;
    if (safeStoreUrl) {
      storeUrl.href = safeStoreUrl;
      storeUrl.textContent = store.url;
    } else {
      storeUrl.removeAttribute("href");
      storeUrl.textContent = "";
    }

    const status = typeof store.status === "string" ? store.status : "Statut non renseigné";
    storeStatus.textContent = productStatusLabel(status);
    storeStatus.className = "admin-state-badge chariow-store-status";
    if (status === "active") storeStatus.classList.add("admin-state-available");
    else if (status === "suspended" || status === "archived") {
      storeStatus.classList.add("admin-state-unavailable");
    }

    if (typeof store.description === "string" && store.description) {
      storeDescription.textContent = store.description;
      storeDescription.hidden = false;
    } else {
      storeDescription.textContent = "";
      storeDescription.hidden = true;
    }

    const safeLogoUrl = safeHttpsUrl(store.logo_url);
    if (safeLogoUrl) {
      storeLogo.src = safeLogoUrl;
      storeLogo.hidden = false;
    } else {
      clearImage(storeLogo);
    }

    const stats = isRecord(store.stats) ? store.stats : {};
    const ratings = isRecord(stats.ratings) ? stats.ratings : {};
    const hasCustomers = Number.isSafeInteger(stats.total_customers) &&
      stats.total_customers >= 0;
    const hasRatings = Number.isSafeInteger(ratings.total_ratings) &&
      ratings.total_ratings >= 0;
    customersStat.hidden = !hasCustomers;
    totalCustomers.textContent = hasCustomers ? formatCount(stats.total_customers) : "";
    ratingsStat.hidden = !hasRatings;
    totalRatings.textContent = hasRatings ? formatCount(ratings.total_ratings) : "";
    positiveRating.textContent = typeof ratings.thumbs_up_percentage === "string"
      ? `${ratings.thumbs_up_percentage} d’avis positifs`
      : "";
    statsPanel.hidden = !hasCustomers && !hasRatings;
    updatedTime.dateTime = new Date().toISOString();
    updatedTime.textContent = new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date());
  }

  async function loadOverview(force = false) {
    if (overviewLoaded && !force) return;
    const requestId = ++overviewRequest;
    setStatus(overviewStatus, overviewLoaded ? "Actualisation des données…" : "Chargement de la boutique…", "loading");
    refreshButton.disabled = true;
    try {
      const result = await client.request({ resource: "store" });
      if (requestId !== overviewRequest) return;
      if (!isRecord(result.data) || typeof result.data.name !== "string") {
        throw new ChariowAdminError(502, "Les informations de boutique reçues sont incomplètes.");
      }
      renderStore(result.data);
      overviewLoaded = true;
      setStatus(overviewStatus, "");
    } catch (error) {
      if (requestId !== overviewRequest) return;
      if (error.status === 401) {
        onSessionExpired();
        return;
      }
      setStatus(overviewStatus, error.message || "Impossible de charger la boutique Chariow.", "error");
    } finally {
      if (requestId === overviewRequest) refreshButton.disabled = false;
    }
  }

  function resetPgdCatalog() {
    pgdCatalogRequest += 1;
    pgdCatalogPromise = null;
    pgdProducts = null;
    pgdCatalogError = "";
  }

  function loadPgdCatalog() {
    if (pgdProducts !== null || pgdCatalogError) return;
    if (pgdCatalogPromise) return pgdCatalogPromise;
    const requestId = pgdCatalogRequest;
    pgdCatalogPromise = (async () => {
      try {
        const response = await fetchImpl(pgdCatalogEndpoint, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        if (!response.ok) {
          throw new Error(response.status === 403
            ? "Le catalogue PGD n’est pas accessible dans ce contexte."
            : "Le catalogue PGD n’a pas pu être lu.");
        }
        const result = await response.json();
        if (!isRecord(result) || !Array.isArray(result.products)) {
          throw new Error("La réponse du catalogue PGD est invalide.");
        }
        if (requestId !== pgdCatalogRequest) return;
        pgdProducts = result.products.filter((product) =>
          isRecord(product) && typeof product.chariowProductId === "string"
        );
      } catch (error) {
        if (requestId === pgdCatalogRequest) {
          pgdCatalogError = error.message || "La comparaison avec le catalogue PGD est indisponible.";
        }
      } finally {
        if (requestId === pgdCatalogRequest) pgdCatalogPromise = null;
      }
    })();
    return pgdCatalogPromise;
  }

  function createProductImage(product, compact = false) {
    const imageUrl = safeHttpsUrl(
      product?.pictures?.thumbnail || product?.pictures?.cover
    );
    const image = documentRef.createElement("img");
    image.className = compact
      ? "chariow-product-image"
      : "chariow-product-image";
    image.alt = "";
    image.loading = "lazy";
    if (imageUrl) {
      image.src = imageUrl;
      image.addEventListener("error", () => clearImage(image), { once: true });
    } else {
      image.classList.add("chariow-product-placeholder");
      image.alt = "Image indisponible";
      image.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23f8f7f1'/%3E%3Cpath d='M18 45h28M22 39l7-9 5 6 4-5 7 8' fill='none' stroke='%2352645a' stroke-width='2'/%3E%3C/svg%3E";
    }
    return image;
  }

  function localProductFor(chariowProductId) {
    if (!Array.isArray(pgdProducts)) return [];
    return pgdProducts.filter((product) =>
      product.chariowProductId === chariowProductId
    );
  }

  function makeMatchBlock(product) {
    const match = documentRef.createElement("div");
    match.className = "chariow-product-match";
    const title = documentRef.createElement("strong");
    const description = documentRef.createElement("p");
    const badge = documentRef.createElement("span");
    badge.className = "chariow-match-state";

    if (pgdCatalogError) {
      title.textContent = "Comparaison PGD indisponible";
      description.textContent = pgdCatalogError;
      badge.textContent = "Non vérifiée";
    } else {
      const matches = localProductFor(product.id);
      if (matches.length > 1) {
        title.textContent = "Correspondance PGD ambiguë";
        description.textContent = `${matches.length} produits PGD utilisent cet identifiant Chariow.`;
        badge.textContent = "À vérifier";
        badge.classList.add("is-different");
      } else if (matches.length === 0) {
        title.textContent = "Aucun lien dans le catalogue PGD";
        description.textContent = "Aucun produit actif du catalogue PGD ne référence cet identifiant.";
        badge.textContent = "Non lié";
        badge.classList.add("is-missing");
      } else {
        const pgdProduct = matches[0];
        const chariowPrice = safePrice(product);
        const samePrice = chariowPrice && typeof chariowPrice.value === "number" &&
          pgdProduct.price === chariowPrice.value;
        const sameCurrency = chariowPrice &&
          typeof chariowPrice.currency === "string" &&
          pgdProduct.currency === chariowPrice.currency;
        const pgdName = typeof pgdProduct.name === "string"
          ? pgdProduct.name
          : pgdProduct.name?.fr;
        title.textContent = pgdName || "Produit PGD lié";
        const pgdPrice = typeof pgdProduct.price === "number" &&
          Number.isFinite(pgdProduct.price)
          ? new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(pgdProduct.price)
          : "Prix non renseigné";
        description.textContent =
          `ID PGD : ${pgdProduct.id} · ${pgdPrice} ${pgdProduct.currency || ""}`.trim();
        if (
          !chariowPrice ||
          typeof chariowPrice.value !== "number" ||
          typeof chariowPrice.currency !== "string" ||
          typeof pgdProduct.price !== "number" ||
          typeof pgdProduct.currency !== "string"
        ) {
          badge.textContent = "Comparaison incomplète";
        } else if (samePrice && sameCurrency) {
          badge.textContent = "Prix et devise identiques";
          badge.classList.add("is-match");
        } else if (samePrice || sameCurrency) {
          badge.textContent = "Écart de prix ou devise";
          badge.classList.add("is-different");
        } else {
          badge.textContent = chariowPrice ? "Écart de prix et devise" : "Comparaison impossible";
          if (chariowPrice) badge.classList.add("is-different");
        }
      }
    }

    match.append(title, description, badge);
    return match;
  }

  function renderProducts(products) {
    productsList.replaceChildren();
    productsList.setAttribute("aria-busy", "false");
    productsEmpty.hidden = products.length > 0;
    productsEmpty.textContent = products.length ? "" : "Aucun produit Chariow ne correspond à cette recherche.";

    products.forEach((product) => {
      const card = documentRef.createElement("article");
      card.className = "chariow-product-card";
      card.setAttribute("role", "listitem");

      const identity = documentRef.createElement("div");
      identity.className = "chariow-product-identity";
      identity.append(createProductImage(product));
      const nameBlock = documentRef.createElement("div");
      const name = documentRef.createElement("h4");
      name.textContent = typeof product.name === "string" ? product.name : "Produit sans nom";
      const id = documentRef.createElement("p");
      id.textContent = product.id;
      nameBlock.append(name, id);
      identity.append(nameBlock);

      const meta = documentRef.createElement("div");
      meta.className = "chariow-product-meta";
      const price = documentRef.createElement("strong");
      price.textContent = priceLabel(product);
      const status = documentRef.createElement("span");
      status.textContent = productStatusLabel(product.status);
      const type = documentRef.createElement("span");
      type.textContent = typeof product.type === "string" ? product.type : "Type non renseigné";
      meta.append(price, status, type);
      if (product.quantity && isRecord(product.quantity.remaining)) {
        const stock = documentRef.createElement("p");
        stock.textContent = `Stock restant : ${formatCount(product.quantity.remaining.value) || "non renseigné"}`;
        meta.append(stock);
      } else if (product.quantity === null) {
        const stock = documentRef.createElement("p");
        stock.textContent = "Stock illimité";
        meta.append(stock);
      }

      const match = makeMatchBlock(product);
      const detailsButton = documentRef.createElement("button");
      detailsButton.className = "button button-outline chariow-detail-button";
      detailsButton.type = "button";
      detailsButton.textContent = "Voir les détails";
      detailsButton.dataset.chariowDetail = product.id;
      detailsButton.setAttribute("aria-label", `Voir les détails de ${name.textContent}`);
      card.append(identity, meta, match, detailsButton);
      productsList.append(card);
    });
  }

  async function loadProducts({ cursor = "", search = "", force = false } = {}) {
    if (productsLoaded && !force && cursor === "" && search === searchInput.value.trim()) return;
    const requestId = ++productsRequest;
    setStatus(productsStatus, "Chargement des produits Chariow…", "loading");
    productsList.setAttribute("aria-busy", "true");
    productsEmpty.hidden = true;
    previousButton.disabled = true;
    nextButton.disabled = true;
    refreshButton.disabled = false;

    const params = {
      resource: "products",
      per_page: String(CHARIOW_PAGE_SIZE)
    };
    if (cursor) params.cursor = cursor;
    if (search) params.search = search;

    try {
      const [result] = await Promise.all([
        client.request(params),
        loadPgdCatalog()
      ]);
      if (requestId !== productsRequest) return;
      if (
        !Array.isArray(result.data) ||
        !isRecord(result.pagination) ||
        typeof result.pagination.has_more_pages !== "boolean"
      ) {
        throw new ChariowAdminError(502, "La liste de produits Chariow est incomplète.");
      }
      pageInfo = result.pagination;
      productsLoaded = true;
      renderProducts(result.data);
      previousButton.disabled = !pageInfo.prev_cursor;
      nextButton.disabled = !pageInfo.next_cursor;
      pageStatus.textContent = `${result.data.length} produit${result.data.length === 1 ? "" : "s"} sur cette page${pageInfo.has_more_pages ? " · d’autres pages sont disponibles" : ""}`;
      setStatus(productsStatus, pgdCatalogError
        ? `Comparaison non disponible : ${pgdCatalogError}`
        : "");
    } catch (error) {
      if (requestId !== productsRequest) return;
      if (error.status === 401) {
        onSessionExpired();
        return;
      }
      productsList.replaceChildren();
      productsList.setAttribute("aria-busy", "false");
      productsEmpty.hidden = true;
      pageStatus.textContent = "";
      setStatus(productsStatus, error.message || "Impossible de charger les produits Chariow.", "error");
    }
  }

  function renderSales(sales) {
    salesList.replaceChildren();
    salesList.setAttribute("aria-busy", "false");
    salesEmpty.hidden = sales.length > 0;
    salesEmpty.textContent = sales.length
      ? ""
      : salesSearchInput.value.trim()
        ? "Aucune vente Chariow ne correspond à cette recherche."
        : "Aucune vente n’a été renvoyée par l’API Chariow.";

    sales.forEach((sale) => {
      const card = documentRef.createElement("article");
      card.className = "chariow-sale-card";
      card.setAttribute("role", "listitem");

      const identity = documentRef.createElement("div");
      identity.className = "chariow-sale-identity";
      const id = documentRef.createElement("h4");
      id.textContent = sale.id;
      const productName = documentRef.createElement("p");
      productName.textContent = isRecord(sale.product) &&
        typeof sale.product.name === "string"
        ? sale.product.name
        : "Produit non renseigné";
      identity.append(id, productName);
      if (isRecord(sale.product) && typeof sale.product.id === "string") {
        const productId = documentRef.createElement("p");
        productId.textContent = `ID produit : ${sale.product.id}`;
        identity.append(productId);
      }
      const date = documentRef.createElement("time");
      date.className = "chariow-sale-date";
      date.textContent = saleDateLabel(sale.created_at) || "Date non renseignée";
      if (typeof sale.created_at === "string") date.dateTime = sale.created_at;
      identity.append(date);

      const meta = documentRef.createElement("div");
      meta.className = "chariow-sale-meta";
      const amount = documentRef.createElement("strong");
      amount.textContent = saleAmountLabel(sale.amount);
      const status = documentRef.createElement("span");
      status.className = "chariow-sale-status";
      status.textContent = typeof sale.status === "string" && sale.status
        ? sale.status
        : "Statut non renseigné";
      meta.append(amount, status);

      const detailsButton = documentRef.createElement("button");
      detailsButton.className = "button button-outline chariow-detail-button";
      detailsButton.type = "button";
      detailsButton.textContent = "Voir les détails";
      detailsButton.dataset.chariowSaleDetail = sale.id;
      detailsButton.setAttribute("aria-label", `Voir les détails de la vente ${sale.id}`);
      card.append(identity, meta, detailsButton);
      salesList.append(card);
    });
  }

  async function loadSales({ cursor = "", search = "", force = false } = {}) {
    if (salesLoaded && !force && cursor === "" &&
        search === salesSearchInput.value.trim()) return;
    const requestId = ++salesRequest;
    setStatus(salesStatus, "Chargement des ventes Chariow…", "loading");
    salesList.setAttribute("aria-busy", "true");
    salesEmpty.hidden = true;
    salesPreviousButton.disabled = true;
    salesNextButton.disabled = true;

    const params = {
      resource: "sales",
      per_page: String(CHARIOW_PAGE_SIZE)
    };
    if (cursor) params.cursor = cursor;
    if (search) params.search = search;

    try {
      const result = await client.request(params);
      if (requestId !== salesRequest) return;
      if (
        !Array.isArray(result.data) ||
        !isRecord(result.pagination) ||
        typeof result.pagination.has_more_pages !== "boolean"
      ) {
        throw new ChariowAdminError(502, "La liste des ventes Chariow est incomplète.");
      }
      salesPageInfo = result.pagination;
      salesLoaded = true;
      renderSales(result.data);
      salesPreviousButton.disabled = !salesPageInfo.prev_cursor;
      salesNextButton.disabled = !salesPageInfo.next_cursor;
      salesPageStatus.textContent = `${result.data.length} vente${result.data.length === 1 ? "" : "s"} sur cette page${salesPageInfo.has_more_pages ? " · d’autres pages sont disponibles" : ""}`;
      setStatus(salesStatus, "");
    } catch (error) {
      if (requestId !== salesRequest) return;
      if (error.status === 401) {
        onSessionExpired();
        return;
      }
      salesList.replaceChildren();
      salesList.setAttribute("aria-busy", "false");
      salesEmpty.hidden = true;
      salesPageStatus.textContent = "";
      setStatus(salesStatus, error.message || "Impossible de charger les ventes Chariow.", "error");
    }
  }

  function renderDetailFields(product) {
    const fields = documentRef.createElement("div");
    fields.className = "chariow-detail-fields";
    const price = safePrice(product);
    const values = [
      ["Identifiant Chariow", product.id],
      ["Type", product.type],
      ["Statut", productStatusLabel(product.status)],
      ["Prix", priceLabel(product)],
      ["Devise", price?.currency],
      ["Prix formaté", price?.formatted],
      ["Ventes affichées par Chariow", product.sales_count?.formatted],
      ["Stock", product.quantity === null
        ? "Illimité"
        : product.quantity?.remaining?.value !== undefined
          ? String(product.quantity.remaining.value)
          : "Non renseigné"]
    ];
    values.forEach(([label, value]) => {
      if (typeof value !== "string" || !value) return;
      const field = documentRef.createElement("div");
      field.className = "chariow-detail-field";
      const fieldLabel = documentRef.createElement("span");
      fieldLabel.textContent = label;
      const fieldValue = documentRef.createElement("strong");
      fieldValue.textContent = value;
      field.append(fieldLabel, fieldValue);
      fields.append(field);
    });
    return fields;
  }

  async function showProductDetails(productId, button) {
    const requestId = ++detailRequest;
    button.disabled = true;
    detailsTitle.textContent = "Détails du produit";
    detailBody.replaceChildren();
    const loading = documentRef.createElement("p");
    loading.textContent = "Chargement des détails…";
    detailBody.append(loading);
    detailsDialog.showModal();
    try {
      const result = await client.request({ resource: "product", productId });
      if (requestId !== detailRequest || !isRecord(result.data)) return;
      const product = result.data;
      const summary = documentRef.createElement("div");
      summary.className = "chariow-detail-summary";
      summary.append(createProductImage(product, true));
      const identity = documentRef.createElement("div");
      const name = documentRef.createElement("h3");
      name.textContent = typeof product.name === "string" ? product.name : "Produit sans nom";
      const type = documentRef.createElement("p");
      type.textContent = product.type || "Type non renseigné";
      const comparison = makeMatchBlock(product);
      identity.append(name, type);
      summary.append(identity);
      detailBody.replaceChildren(summary, renderDetailFields(product), comparison);
    } catch (error) {
      if (requestId !== detailRequest) return;
      if (error.status === 401) {
        onSessionExpired();
        return;
      }
      const message = documentRef.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent = error.message || "Impossible de charger les détails du produit.";
      detailBody.replaceChildren(message);
    } finally {
      button.disabled = false;
    }
  }

  function renderSaleDetailFields(sale) {
    const fields = documentRef.createElement("div");
    fields.className = "chariow-detail-fields";
    const product = isRecord(sale.product) ? sale.product : {};
    const payment = isRecord(sale.payment) ? sale.payment : {};
    const values = [
      ["Identifiant Chariow", sale.id],
      ["Statut", sale.status],
      ["Produit", product.name],
      ["Identifiant produit", product.id],
      ["Montant", saleAmountLabel(sale.amount)],
      ["Date", saleDateLabel(sale.created_at)],
      ["Date de finalisation", saleDateLabel(sale.completed_at)],
      ["Statut du paiement", payment.status],
      ["Montant initial", sale.original_amount ? saleAmountLabel(sale.original_amount) : ""],
      ["Réduction", sale.discount_amount ? saleAmountLabel(sale.discount_amount) : ""]
    ];
    values.forEach(([label, value]) => {
      if (typeof value !== "string" || !value) return;
      const field = documentRef.createElement("div");
      field.className = "chariow-detail-field";
      const fieldLabel = documentRef.createElement("span");
      fieldLabel.textContent = label;
      const fieldValue = documentRef.createElement("strong");
      fieldValue.textContent = value;
      field.append(fieldLabel, fieldValue);
      fields.append(field);
    });
    return fields;
  }

  async function showSaleDetails(saleId, button) {
    const requestId = ++detailRequest;
    button.disabled = true;
    detailsTitle.textContent = "Détails de la vente";
    detailBody.replaceChildren();
    const loading = documentRef.createElement("p");
    loading.textContent = "Chargement des détails…";
    detailBody.append(loading);
    detailsDialog.showModal();
    try {
      const result = await client.request({ resource: "sale", saleId });
      if (requestId !== detailRequest || !isRecord(result.data)) return;
      const sale = result.data;
      const summary = documentRef.createElement("div");
      summary.className = "chariow-sale-detail-summary";
      const id = documentRef.createElement("h3");
      id.textContent = typeof sale.id === "string" ? sale.id : saleId;
      const product = documentRef.createElement("p");
      product.textContent = isRecord(sale.product) &&
        typeof sale.product.name === "string"
        ? sale.product.name
        : "Produit non renseigné";
      summary.append(id, product);
      detailBody.replaceChildren(summary, renderSaleDetailFields(sale));
    } catch (error) {
      if (requestId !== detailRequest) return;
      if (error.status === 401) {
        onSessionExpired();
        return;
      }
      const message = documentRef.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent = error.message || "Impossible de charger les détails de la vente.";
      detailBody.replaceChildren(message);
    } finally {
      button.disabled = false;
    }
  }

  function setTab(tabName, focusTab = false) {
    if (!["overview", "products", "sales"].includes(tabName)) return;
    activeTab = tabName;
    tabs.forEach((tab) => {
      const selected = tab.dataset.chariowTab === tabName;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.chariowPanel !== tabName;
    });
    if (focusTab) tabs.find((tab) => tab.dataset.chariowTab === tabName)?.focus();
    if (tabName === "overview") void loadOverview();
    else if (tabName === "products" && !productsLoaded) {
      void loadProducts({ search: searchInput.value.trim(), force: true });
    } else if (tabName === "sales" && !salesLoaded) {
      void loadSales({ search: salesSearchInput.value.trim(), force: true });
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setTab(tab.dataset.chariowTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = tabs.indexOf(tab);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
      setTab(tabs[nextIndex].dataset.chariowTab, true);
    });
  });

  refreshButton.addEventListener("click", () => {
    if (activeTab === "overview") void loadOverview(true);
    else if (activeTab === "products") {
      productsLoaded = false;
      pageInfo = null;
      resetPgdCatalog();
      void loadProducts({ search: searchInput.value.trim(), force: true });
    } else {
      salesLoaded = false;
      salesPageInfo = null;
      void loadSales({ search: salesSearchInput.value.trim(), force: true });
    }
  });

  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      productsLoaded = false;
      pageInfo = null;
      void loadProducts({ search: searchInput.value.trim(), force: true });
    }, 300);
  });

  previousButton.addEventListener("click", () => {
    if (pageInfo?.prev_cursor) {
      void loadProducts({
        cursor: pageInfo.prev_cursor,
        search: searchInput.value.trim(),
        force: true
      });
    }
  });
  nextButton.addEventListener("click", () => {
    if (pageInfo?.next_cursor) {
      void loadProducts({
        cursor: pageInfo.next_cursor,
        search: searchInput.value.trim(),
        force: true
      });
    }
  });

  salesSearchInput.addEventListener("input", () => {
    window.clearTimeout(salesSearchTimer);
    salesRequest += 1;
    salesSearchTimer = window.setTimeout(() => {
      salesLoaded = false;
      salesPageInfo = null;
      void loadSales({ search: salesSearchInput.value.trim(), force: true });
    }, 300);
  });

  salesPreviousButton.addEventListener("click", () => {
    if (salesPageInfo?.prev_cursor) {
      void loadSales({
        cursor: salesPageInfo.prev_cursor,
        search: salesSearchInput.value.trim(),
        force: true
      });
    }
  });
  salesNextButton.addEventListener("click", () => {
    if (salesPageInfo?.next_cursor) {
      void loadSales({
        cursor: salesPageInfo.next_cursor,
        search: salesSearchInput.value.trim(),
        force: true
      });
    }
  });

  productsList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chariow-detail]");
    if (button) void showProductDetails(button.dataset.chariowDetail, button);
  });
  salesList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chariow-sale-detail]");
    if (button) void showSaleDetails(button.dataset.chariowSaleDetail, button);
  });
  closeDetailsButtons.forEach((button) => {
    button.addEventListener("click", () => detailsDialog.close());
  });

  return {
    activate() {
      setTab(activeTab);
    },
    clear() {
      overviewLoaded = false;
      overviewRequest += 1;
      productsLoaded = false;
      salesLoaded = false;
      resetPgdCatalog();
      pageInfo = null;
      salesPageInfo = null;
      productsRequest += 1;
      salesRequest += 1;
      detailRequest += 1;
      window.clearTimeout(salesSearchTimer);
      if (detailsDialog.open) detailsDialog.close();
      storeCard.hidden = true;
      statsPanel.hidden = true;
      storeName.textContent = "";
      storeUrl.removeAttribute("href");
      storeUrl.textContent = "";
      storeDescription.textContent = "";
      clearImage(storeLogo);
      setStatus(overviewStatus, "");
      setStatus(productsStatus, "");
      setStatus(salesStatus, "");
      productsList.replaceChildren();
      productsList.setAttribute("aria-busy", "false");
      salesList.replaceChildren();
      salesList.setAttribute("aria-busy", "false");
      productsEmpty.hidden = true;
      salesEmpty.hidden = true;
      pageStatus.textContent = "";
      salesPageStatus.textContent = "";
      previousButton.disabled = true;
      nextButton.disabled = true;
      salesPreviousButton.disabled = true;
      salesNextButton.disabled = true;
      detailBody.replaceChildren();
      updatedTime.removeAttribute("datetime");
      updatedTime.textContent = "Pas encore actualisé";
    }
  };
}

function initializeAdminUI() {
  const authView = document.querySelector("[data-admin-auth]");
  const adminApp = document.querySelector("[data-admin-app]");
  const adminMessage = document.querySelector("[data-admin-message]");
  const overviewPanel = document.querySelector("[data-admin-overview-panel]");
  const overviewTitle = document.querySelector("[data-overview-title]");
  const overviewDescription = document.querySelector("[data-overview-description]");
  const catalogOverviewStats = document.querySelector("[data-catalog-overview-stats]");
  const initializeCatalogButton = document.querySelector("[data-catalog-initialize]");
  const screens = [...document.querySelectorAll("[data-admin-screen]")];
  const viewButtons = [...document.querySelectorAll("[data-admin-view]")];
  const productFilterButtons = [...document.querySelectorAll("[data-product-filter]")];
  const productList = document.querySelector("[data-products-list]");
  const archivesList = document.querySelector("[data-archives-list]");
  const productsEmpty = document.querySelector("[data-products-empty]");
  const archivesEmpty = document.querySelector("[data-archives-empty]");
  const productsStatus = document.querySelector("[data-products-status]");
  const archivesStatus = document.querySelector("[data-archives-status]");
  const searchInput = document.querySelector("[data-product-search]");
  const form = document.querySelector("[data-product-form]");
  const editor = document.querySelector("[data-product-editor]");
  const editorTitle = document.querySelector("#product-editor-title");
  const editorDescription = document.querySelector("[data-editor-description]");
  const formMessage = document.querySelector("[data-form-message]");
  const submitButton = document.querySelector("[data-product-submit]");
  const reloadButton = document.querySelector("[data-conflict-reload]");
  const sidebar = document.querySelector(".admin-sidebar");
  const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
  const sidebarScrim = document.querySelector("[data-sidebar-close]");
  const mobileNavQuery = window.matchMedia("(max-width: 960px)");
  const confirmDialog = document.querySelector("[data-confirm-dialog]");
  const confirmForm = document.querySelector("[data-confirm-form]");
  const confirmTitle = document.querySelector("[data-confirm-title]");
  const confirmDescription = document.querySelector("[data-confirm-description]");
  const confirmInputWrap = document.querySelector("[data-confirm-input-wrap]");
  const confirmInput = document.querySelector("[data-confirm-input]");
  const confirmInputError = document.querySelector("[data-confirm-input-error]");
  const confirmSubmit = document.querySelector("[data-confirm-submit]");
  const confirmCancelButtons = [...document.querySelectorAll("[data-confirm-cancel]")];
  const controller = createAdminCatalogController();
  const chariowController = createChariowAdminUI({
    document,
    onSessionExpired() {
      setAuthenticated(false);
      document.dispatchEvent(new CustomEvent("admin:session-expired"));
    }
  });
  let activeProducts = [];
  let archivedProducts = [];
  let editingProduct = null;
  let editingEtag = "";
  let editBlocked = false;
  let currentView = "products";
  let productFilter = "all";
  let confirmationResolve = null;
  let confirmationReturnFocus = null;
  let requiredConfirmationText = "";

  if (!authView || !adminApp || !form) return;

  function setSidebarOpen(open, restoreFocus = true) {
    if (!sidebar || !sidebarToggle) return;
    const shouldOpen = mobileNavQuery.matches && open;
    sidebar.classList.toggle("is-open", shouldOpen);
    sidebarToggle.setAttribute("aria-expanded", String(shouldOpen));
    sidebarToggle.setAttribute(
      "aria-label",
      shouldOpen ? "Fermer la navigation" : "Ouvrir la navigation"
    );
    if (mobileNavQuery.matches) {
      sidebar.inert = !shouldOpen;
      sidebar.setAttribute("aria-hidden", String(!shouldOpen));
    } else {
      sidebar.inert = false;
      sidebar.removeAttribute("aria-hidden");
    }
    if (sidebarScrim) sidebarScrim.hidden = !shouldOpen;
    document.body.classList.toggle("admin-nav-open", shouldOpen);
    if (shouldOpen) {
      sidebar.querySelector(".admin-sidebar-link")?.focus();
    } else if (restoreFocus && mobileNavQuery.matches) {
      sidebarToggle.focus();
    }
  }

  function syncSidebarBreakpoint() {
    setSidebarOpen(false, false);
  }

  syncSidebarBreakpoint();
  window.addEventListener("resize", syncSidebarBreakpoint);
  sidebarToggle?.addEventListener("click", () => {
    setSidebarOpen(!sidebar.classList.contains("is-open"));
  });
  sidebarScrim?.addEventListener("click", () => setSidebarOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobileNavQuery.matches &&
        sidebar?.classList.contains("is-open") && !confirmDialog.open) {
      setSidebarOpen(false);
    }
  });

  const sessionLifecycle = createAdminSessionLifecycle({
    onExpire() {
      controller.invalidate();
      chariowController.clear();
      resetEditor();
      activeProducts = [];
      archivedProducts = [];
      delete productsStatus.dataset.state;
      delete archivesStatus.dataset.state;
      renderProducts();
      renderArchives();
    },
    onAuthenticate(session) {
      showView("products", { loadData: false });
      return Promise.all([
        refreshProducts(session),
        refreshArchives(session)
      ]);
    }
  });

  function setAuthenticated(isAdmin) {
    const allowed = isAdmin === true;
    authView.hidden = allowed;
    adminApp.hidden = !allowed;
    document.body.classList.toggle("admin-authenticated", allowed);
    void sessionLifecycle.change(allowed).refresh;
  }

  initializeCatalogButton?.addEventListener("click", async () => {
    const { confirmed } = await showConfirmation({
      title: "Initialiser le catalogue central ?",
      message: "Cette opération crée le catalogue à partir des données historiques et ne peut être effectuée qu’une seule fois.",
      buttonLabel: "Initialiser le catalogue",
      destructive: false
    });
    if (!confirmed) return;

    initializeCatalogButton.disabled = true;
    clearAdminMessage();
    try {
      const result = await controller.initializeCatalog();
      if (result === "initialized") {
        await refreshProducts();
        showAdminMessage("Catalogue initialisé avec succès.", "success");
        return;
      }
      showAdminMessage("Le catalogue existe déjà. Aucune modification n’a été effectuée.", "info");
    } catch (error) {
      if (error instanceof AdminCatalogError && error.status === 401) {
        setAuthenticated(false);
        document.dispatchEvent(new CustomEvent("admin:session-expired"));
      } else {
        showAdminMessage(
          error.message || "L’initialisation du catalogue a échoué.",
          "error"
        );
      }
    } finally {
      initializeCatalogButton.disabled = false;
    }
  });

  function showView(name, { loadData = true, focusHeading = false } = {}) {
    currentView = name;
    screens.forEach((screen) => {
      screen.hidden = screen.dataset.adminScreen !== name;
    });
    viewButtons.forEach((button) => {
      const selected = button.dataset.adminView === name;
      button.classList.toggle("is-active", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    editor.hidden = true;
    overviewPanel.hidden = false;
    catalogOverviewStats.hidden = name === "chariow";
    if (name === "chariow") {
      overviewTitle.textContent = "Chariow";
      overviewDescription.textContent = "Consultez les informations de la boutique et ses produits sans modifier les données Chariow.";
    } else if (name === "archives") {
      overviewTitle.textContent = "Archives du catalogue";
      overviewDescription.textContent = "Restaurez un produit ou supprimez-le définitivement.";
    } else {
      overviewTitle.textContent = "Gestion du catalogue";
      overviewDescription.textContent = "Suivez vos produits et leur présence dans la boutique.";
    }
    if (sidebar.classList.contains("is-open")) setSidebarOpen(false, !focusHeading);
    if (focusHeading) {
      requestAnimationFrame(() => {
        document.querySelector(
          name === "archives"
            ? "#archives-heading"
            : name === "chariow"
              ? "#chariow-heading"
              : "#products-heading"
        )?.focus();
      });
    }
    if (loadData && name === "chariow") chariowController.activate();
    if (loadData && name === "archives" && archivedProducts.length === 0) {
      void refreshArchives().catch(() => {});
    }
    if (loadData && name === "products" && activeProducts.length === 0) {
      void refreshProducts().catch(() => {});
    }
  }

  function showAdminMessage(message, state = "error") {
    adminMessage.textContent = message;
    adminMessage.dataset.state = state;
    adminMessage.hidden = false;
  }

  function clearAdminMessage() {
    adminMessage.hidden = true;
    adminMessage.textContent = "";
    delete adminMessage.dataset.state;
  }

  function showFormMessage(message, state = "error") {
    formMessage.textContent = message;
    formMessage.dataset.state = state;
    formMessage.hidden = false;
  }

  function showConfirmation({
    title,
    message,
    buttonLabel = "Confirmer",
    expectedText = "",
    destructive = true
  }) {
    if (!confirmDialog || confirmDialog.open || confirmationResolve) {
      throw new Error("Une confirmation est déjà ouverte ou indisponible.");
    }
    confirmationReturnFocus = document.activeElement;
    requiredConfirmationText = expectedText;
    confirmTitle.textContent = title;
    confirmDescription.textContent = message;
    confirmInputWrap.hidden = !expectedText;
    confirmInput.value = "";
    confirmInput.required = Boolean(expectedText);
    confirmInput.removeAttribute("aria-invalid");
    confirmInputError.hidden = true;
    confirmInputError.textContent = "";
    confirmSubmit.textContent = buttonLabel;
    confirmSubmit.classList.toggle("button-danger", destructive);
    confirmSubmit.classList.toggle("button-primary", !destructive);

    return new Promise((resolve) => {
      confirmationResolve = resolve;
      confirmDialog.showModal();
      if (expectedText) confirmInput.focus();
      else confirmCancelButtons[0]?.focus();
    });
  }

  confirmForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (requiredConfirmationText && confirmInput.value !== requiredConfirmationText) {
      confirmInput.setAttribute("aria-invalid", "true");
      confirmInputError.textContent = "La phrase saisie ne correspond pas. Vérifiez-la puis réessayez.";
      confirmInputError.hidden = false;
      confirmInput.focus();
      return;
    }
    confirmDialog.close("confirm");
  });
  confirmInput.addEventListener("input", () => {
    confirmInput.removeAttribute("aria-invalid");
    confirmInputError.hidden = true;
    confirmInputError.textContent = "";
  });
  confirmCancelButtons.forEach((button) => {
    button.addEventListener("click", () => confirmDialog.close("cancel"));
  });
  confirmDialog.addEventListener("close", () => {
    const result = {
      confirmed: confirmDialog.returnValue === "confirm",
      confirmation: confirmInput.value
    };
    const resolve = confirmationResolve;
    const returnFocus = confirmationReturnFocus;
    confirmationResolve = null;
    confirmationReturnFocus = null;
    requiredConfirmationText = "";
    confirmInput.value = "";
    confirmInput.removeAttribute("aria-invalid");
    confirmInputError.hidden = true;
    if (resolve) resolve(result);
    requestAnimationFrame(() => {
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected &&
          !returnFocus.closest("[hidden]")) {
        returnFocus.focus();
      } else {
        document.querySelector(
          '[data-admin-screen="archives"]:not([hidden]) h2, [data-admin-screen="products"]:not([hidden]) h2'
        )?.focus();
      }
    });
  });

  function handleError(error, statusElement) {
    if (error instanceof AdminCatalogError && error.status === 401) {
      setAuthenticated(false);
      document.dispatchEvent(new CustomEvent("admin:session-expired"));
      return;
    }
    statusElement.textContent = error.message || "Une erreur est survenue.";
    statusElement.dataset.state = "error";
  }

  function makeButton(label, action, product) {
    const button = document.createElement("button");
    button.className = action === "delete"
      ? "button button-outline button-danger"
      : "button button-outline";
    button.type = "button";
    button.textContent = label;
    button.dataset.productAction = action;
    button.dataset.productId = product.id;
    return button;
  }

  function positionActionMenu(menu) {
    const summary = menu.querySelector("summary");
    const items = menu.querySelector(".admin-action-menu-items");
    menu.classList.remove("opens-up", "align-left");
    const summaryBounds = summary.getBoundingClientRect();
    const menuBounds = items.getBoundingClientRect();
    if (menuBounds.bottom > window.innerHeight - 12 &&
        summaryBounds.top > menuBounds.height + 16) {
      menu.classList.add("opens-up");
    }
    if (menuBounds.right > window.innerWidth - 12) {
      menu.classList.add("align-left");
    }
  }

  function renderProductSkeletons(container) {
    const emptyState = container === archivesList ? archivesEmpty : productsEmpty;
    container.replaceChildren();
    container.setAttribute("aria-busy", "true");
    emptyState.hidden = true;
    for (let index = 0; index < 3; index += 1) {
      const skeleton = document.createElement("div");
      skeleton.className = "admin-product-skeleton";
      skeleton.setAttribute("role", "presentation");
      skeleton.setAttribute("aria-hidden", "true");
      skeleton.innerHTML = "<span></span><span></span><span></span><span></span>";
      container.append(skeleton);
    }
  }

  function renderProductList(container, products, archived) {
    const emptyState = archived ? archivesEmpty : productsEmpty;
    const columnIds = [...container.closest(".admin-product-table")
      .querySelector(".admin-product-table-head").children]
      .map((heading) => heading.id);
    const idPrefix = archived ? "archive" : "product";
    const query = archived ? "" : searchInput.value.trim().toLocaleLowerCase();
    const filtered = products.filter((product) => {
      const name = frenchText(product.name).toLocaleLowerCase();
      const matchesSearch = !query ||
        name.includes(query) ||
        String(product.category || "").toLocaleLowerCase().includes(query);
      const matchesFilter = archived ||
        productFilter === "all" ||
        (productFilter === "published" && product.published) ||
        (productFilter === "available" && product.available);
      return matchesSearch && matchesFilter;
    });
    container.replaceChildren();
    container.setAttribute("aria-busy", "false");
    if (filtered.length === 0) {
      emptyState.textContent = products.length
        ? "Aucun produit ne correspond à la recherche."
        : archived ? "Aucun produit archivé." : "Aucun produit dans le catalogue.";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    emptyState.textContent = "";

    let rowIndex = 0;
    for (const product of filtered) {
      const card = document.createElement("div");
      card.className = "admin-product-card";
      card.setAttribute("role", "row");
      const identity = document.createElement("div");
      identity.className = "admin-product-identity";
      identity.setAttribute("role", "cell");
      const image = document.createElement("img");
      image.className = "admin-product-image";
      image.src = new URL(`../../${product.image}`, import.meta.url).href;
      image.alt = "";
      image.loading = "lazy";
      const details = document.createElement("div");
      details.className = "admin-product-details";
      const title = document.createElement("h3");
      title.id = `admin-${idPrefix}-title-${rowIndex}`;
      title.textContent = frenchText(product.name);
      const meta = document.createElement("p");
      meta.textContent = product.category || "Sans catégorie";
      details.append(title, meta);
      identity.append(image, details);
      identity.setAttribute("aria-labelledby", `${columnIds[0]} ${title.id}`);

      const price = document.createElement("strong");
      price.className = "admin-product-price";
      price.id = `admin-${idPrefix}-price-${rowIndex}`;
      price.setAttribute("role", "cell");
      price.textContent = `${new Intl.NumberFormat("fr-FR").format(product.price)} ${product.currency}`;
      price.setAttribute("aria-labelledby", `${columnIds[1]} ${price.id}`);

      const states = document.createElement("p");
      states.className = "admin-product-states";
      states.id = `admin-${idPrefix}-state-${rowIndex}`;
      states.setAttribute("role", "cell");
      const stateBadges = archived
        ? [["Archivé", "archived"]]
        : [
            [product.published ? "Publié" : "Non publié", product.published ? "published" : "unpublished"],
            [product.available ? "Disponible" : "Indisponible", product.available ? "available" : "unavailable"]
          ];
      for (const [label, state] of stateBadges) {
        const badge = document.createElement("span");
        badge.className = `admin-state-badge admin-state-${state}`;
        badge.textContent = label;
        states.append(badge);
      }
      states.setAttribute("aria-labelledby", `${columnIds[2]} ${states.id}`);

      const actions = document.createElement("div");
      actions.className = "admin-product-actions";
      actions.setAttribute("role", "cell");
      const menu = document.createElement("details");
      menu.className = "admin-action-menu";
      const menuButton = document.createElement("summary");
      menuButton.id = `admin-${idPrefix}-action-button-${rowIndex}`;
      menuButton.setAttribute("aria-label", `Actions pour ${frenchText(product.name)}`);
      menuButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
      const menuItems = document.createElement("div");
      menuItems.className = "admin-action-menu-items";
      menuItems.id = `admin-${idPrefix}-actions-${rowIndex}`;
      menuButton.setAttribute("aria-controls", menuItems.id);
      menu.id = `admin-${idPrefix}-menu-${rowIndex}`;
      actions.setAttribute("aria-labelledby", `${columnIds[3]} ${menuButton.id}`);
      menu.addEventListener("toggle", () => {
        if (menu.open) requestAnimationFrame(() => positionActionMenu(menu));
        else menu.classList.remove("opens-up", "align-left");
      });
      for (const action of getProductActions(product, archived)) {
        const label = {
          edit: "Modifier",
          publication: product.published ? "Dépublier" : "Publier",
          availability: product.available ? "Rendre indisponible" : "Rendre disponible",
          archive: "Archiver",
          restore: "Restaurer",
          delete: "Supprimer définitivement"
        }[action];
        menuItems.append(makeButton(label, action, product));
      }
      menu.append(menuButton, menuItems);
      actions.append(menu);
      card.append(identity, price, states, actions);
      container.append(card);
      rowIndex += 1;
    }
  }

  document.addEventListener("pointerdown", (event) => {
    document.querySelectorAll(".admin-action-menu[open]").forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || confirmDialog.open) return;
    const openMenu = document.querySelector(".admin-action-menu[open]");
    if (openMenu) {
      event.preventDefault();
      openMenu.open = false;
      openMenu.querySelector("summary").focus();
    }
  });

  function renderDashboardStats() {
    document.querySelector("[data-stat-total]").textContent =
      String(activeProducts.length + archivedProducts.length);
    document.querySelector("[data-stat-published]").textContent =
      String(activeProducts.filter((product) => product.published).length);
    document.querySelector("[data-stat-available]").textContent =
      String(activeProducts.filter((product) => product.available).length);
    document.querySelector("[data-stat-archived]").textContent =
      String(archivedProducts.length);
  }

  function renderProducts() {
    renderProductList(productList, activeProducts, false);
    productsStatus.textContent = `${activeProducts.length} produit${activeProducts.length === 1 ? "" : "s"}`;
    renderDashboardStats();
  }

  function renderArchives() {
    renderProductList(archivesList, archivedProducts, true);
    archivesStatus.textContent = `${archivedProducts.length} produit${archivedProducts.length === 1 ? "" : "s"} archivé${archivedProducts.length === 1 ? "" : "s"}`;
    renderDashboardStats();
  }

  async function refreshProducts(session = sessionLifecycle.currentSession) {
    productsStatus.textContent = "Chargement des produits…";
    productsStatus.dataset.state = "loading";
    renderProductSkeletons(productList);
    try {
      const result = await controller.load();
      if (!sessionLifecycle.isCurrent(session)) return null;
      delete productsStatus.dataset.state;
      activeProducts = result.products.filter((product) => !product.archivedAt);
      renderProducts();
      clearAdminMessage();
      return result;
    } catch (error) {
      if (!sessionLifecycle.isCurrent(session)) return null;
      productList.replaceChildren();
      productList.setAttribute("aria-busy", "false");
      if (activeProducts.length) {
        renderProductList(productList, activeProducts, false);
      } else {
        productsEmpty.hidden = true;
      }
      handleError(error, productsStatus);
      return null;
    }
  }

  async function refreshArchives(session = sessionLifecycle.currentSession) {
    archivesStatus.textContent = "Chargement des archives…";
    archivesStatus.dataset.state = "loading";
    renderProductSkeletons(archivesList);
    try {
      const result = await controller.load({ archived: true });
      if (!sessionLifecycle.isCurrent(session)) return null;
      delete archivesStatus.dataset.state;
      archivedProducts = result.products.filter((product) => Boolean(product.archivedAt));
      renderArchives();
      clearAdminMessage();
      return result;
    } catch (error) {
      if (!sessionLifecycle.isCurrent(session)) return null;
      archivesList.replaceChildren();
      archivesList.setAttribute("aria-busy", "false");
      if (archivedProducts.length) {
        renderProductList(archivesList, archivedProducts, true);
      } else {
        archivesEmpty.hidden = true;
      }
      handleError(error, archivesStatus);
      return null;
    }
  }

  function resetEditor() {
    editingProduct = null;
    editingEtag = "";
    editBlocked = false;
    controller.clearEdit();
    form.reset();
    clearProductFieldErrors();
    form.querySelectorAll("input, textarea, select").forEach((field) => {
      field.disabled = false;
    });
    form.elements.namedItem("chariow-product-id").readOnly = false;
    document.querySelector("[data-chariow-lock]").hidden = true;
    submitButton.disabled = false;
    submitButton.textContent = "Créer le produit";
    reloadButton.hidden = true;
    formMessage.hidden = true;
    delete formMessage.dataset.state;
    editorTitle.textContent = "Ajouter un produit";
    editorDescription.textContent = "Renseignez les informations du produit.";
  }

  function openEditor(product = null) {
    clearAdminMessage();
    resetEditor();
    editingProduct = product;
    editingEtag = product ? controller.beginEdit(product) : "";
    if (product) {
      editorTitle.textContent = "Modifier un produit";
      editorDescription.textContent = "Les anciennes valeurs ne seront pas réappliquées après un conflit.";
      submitButton.textContent = "Enregistrer les modifications";
      form.elements.namedItem("name").value = frenchText(product.name);
      form.elements.namedItem("description").value = frenchText(product.description);
      form.elements.namedItem("category").value = product.category;
      form.elements.namedItem("image").value = product.image;
      form.elements.namedItem("price").value = String(product.price);
      form.elements.namedItem("currency").value = product.currency;
      form.elements.namedItem("chariow-product-id").value = product.chariowProductId || "";
      form.elements.namedItem("chariow-product-id").readOnly = true;
      document.querySelector("[data-chariow-lock]").hidden = false;
      form.elements.namedItem("available").checked = product.available;
      form.elements.namedItem("published").checked = product.published;
    }
    overviewPanel.hidden = true;
    screens.forEach((screen) => { screen.hidden = true; });
    editor.hidden = false;
    form.elements.namedItem("name").focus();
  }

  function productFieldError(fieldName, message) {
    const error = new Error(message);
    error.field = fieldName;
    return error;
  }

  function clearProductFieldErrors() {
    form.querySelectorAll("[data-product-error]").forEach((errorElement) => {
      const field = form.elements.namedItem(errorElement.dataset.productError);
      field?.removeAttribute("aria-invalid");
      errorElement.hidden = true;
      errorElement.textContent = "";
    });
  }

  function showProductFieldError(fieldName, message) {
    const field = form.elements.namedItem(fieldName);
    const errorElement = form.querySelector(`[data-product-error="${fieldName}"]`);
    if (!field || !errorElement) return;
    field.setAttribute("aria-invalid", "true");
    errorElement.textContent = message;
    errorElement.hidden = false;
    field.focus();
  }

  function createPayload() {
    const values = new FormData(form);
    const price = form.elements.namedItem("price").valueAsNumber;
    const image = String(values.get("image") || "");
    const chariowProductId = String(values.get("chariow-product-id") || "");
    const description = (value) => String(value || "").trim();
    const name = String(values.get("name") || "").trim();
    const productDescription = description(values.get("description"));
    const currency = String(values.get("currency") || "");
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw productFieldError("name", "Saisissez un nom de produit valide.");
    }
    if (!productDescription || productDescription.length > 20000 ||
        /[\u0000-\u001f\u007f]/.test(productDescription) ||
        /[<>]/.test(productDescription.replace(/<br\s*\/?>/gi, ""))) {
      throw productFieldError("description", "Saisissez une description valide.");
    }
    if (!Number.isSafeInteger(price) || price <= 0) {
      throw productFieldError("price", "Saisissez un prix entier supérieur à zéro.");
    }
    if (!image.startsWith("assets/") || image.length > 512 || image.trim() !== image ||
        /[\u0000-\u001f\u007f]/.test(image) || image.includes("\\") ||
        image.includes("?") || image.includes("#") ||
        image.split("/").some((part) => !part || part === "." || part === "..")) {
      throw productFieldError("image", "Saisissez un chemin d’image valide situé sous assets/.");
    }
    if (!/^prd_[A-Za-z0-9_-]+$/.test(chariowProductId)) {
      throw productFieldError("chariow-product-id", "L’identifiant doit commencer par prd_ et contenir uniquement des lettres, chiffres, tirets ou soulignements.");
    }
    if (!["XOF", "EUR", "USD"].includes(currency)) {
      throw productFieldError("currency", "Choisissez une devise proposée.");
    }
    if (form.elements.namedItem("available").checked &&
        !form.elements.namedItem("published").checked) {
      throw productFieldError("available", "Publiez le produit avant de le rendre disponible à la vente.");
    }
    return {
      name,
      description: productDescription,
      category: String(values.get("category") || "").trim(),
      image,
      price,
      currency,
      chariowProductId,
      available: form.elements.namedItem("available").checked,
      published: form.elements.namedItem("published").checked
    };
  }

  async function applyMutation(options, successMessage) {
    clearAdminMessage();
    const session = sessionLifecycle.currentSession;
    try {
      const result = await controller.mutate(options);
      if (!sessionLifecycle.isCurrent(session)) return null;
      activeProducts = result.products.filter((product) => !product.archivedAt);
      archivedProducts = result.products.filter((product) => Boolean(product.archivedAt));
      renderProducts();
      renderArchives();
      showAdminMessage(successMessage, "success");
      return result;
    } catch (error) {
      if (!sessionLifecycle.isCurrent(session)) return null;
      if (error instanceof AdminCatalogError && error.status === 412 && editingProduct) {
        editBlocked = true;
        form.querySelectorAll("input, textarea, select").forEach((field) => {
          field.disabled = true;
        });
        submitButton.disabled = true;
        reloadButton.hidden = false;
        showFormMessage(`${error.message} Le formulaire est bloqué; les valeurs saisies ne seront pas renvoyées.`);
        return null;
      }
      handleError(error, adminMessage);
      adminMessage.hidden = false;
      return null;
    }
  }

  async function reloadAfterConflict() {
    if (!editBlocked || !editingProduct || reloadButton.disabled) return;
    const session = sessionLifecycle.currentSession;
    reloadButton.disabled = true;
    showFormMessage("Rechargement de la version actuelle…", "info");
    try {
      const { product: latest, etag } = await controller.reloadEdit(editingProduct.id);
      if (!sessionLifecycle.isCurrent(session)) return;
      editingProduct = latest;
      editingEtag = etag;
      for (const field of form.querySelectorAll("input, textarea, select")) field.disabled = false;
      submitButton.disabled = false;
      editBlocked = false;
      form.elements.namedItem("name").value = frenchText(latest.name);
      form.elements.namedItem("description").value = frenchText(latest.description);
      form.elements.namedItem("category").value = latest.category;
      form.elements.namedItem("image").value = latest.image;
      form.elements.namedItem("price").value = String(latest.price);
      form.elements.namedItem("currency").value = latest.currency;
      form.elements.namedItem("chariow-product-id").value = latest.chariowProductId || "";
      form.elements.namedItem("available").checked = latest.available;
      form.elements.namedItem("published").checked = latest.published;
      reloadButton.hidden = true;
      showFormMessage("Version actuelle rechargée. Les valeurs précédentes ont été remplacées; reprenez votre modification à partir de ces données.", "success");
    } catch (error) {
      if (!sessionLifecycle.isCurrent(session)) return;
      showFormMessage(`${error.message || "Le rechargement a échoué."} Le formulaire reste bloqué.`);
    } finally {
      reloadButton.disabled = false;
    }
  }

  async function handleProductAction(event) {
    const button = event.target.closest("[data-product-action]");
    if (!button) return;
    const product = [...activeProducts, ...archivedProducts]
      .find((candidate) => candidate.id === button.dataset.productId);
    if (!product) return;
    const action = button.dataset.productAction;
    button.closest("details")?.removeAttribute("open");
    if (action === "edit") {
      openEditor(product);
      return;
    }
    if (action === "delete") {
      const expectedText = `DELETE PRODUCT ${product.id}`;
      const { confirmed, confirmation } = await showConfirmation({
        title: "Supprimer définitivement ce produit ?",
        message: `Cette action est irréversible pour « ${frenchText(product.name)} ». Saisissez exactement : ${expectedText}`,
        buttonLabel: "Supprimer définitivement",
        expectedText,
        destructive: true
      });
      if (!confirmed || confirmation !== expectedText) return;
      await applyMutation({
        method: "DELETE",
        productId: product.id,
        body: { confirmation }
      }, "Produit supprimé définitivement.");
      return;
    }
    if (action === "archive") {
      const { confirmed } = await showConfirmation({
        title: "Archiver ce produit ?",
        message: `« ${frenchText(product.name)} » ne sera plus dans le catalogue actif. Vous pourrez le restaurer depuis les archives.`,
        buttonLabel: "Archiver le produit",
        destructive: false
      });
      if (!confirmed) return;
    }
    if (action === "archive" || action === "restore") {
      await applyMutation({
        method: "PATCH",
        productId: product.id,
        body: { action }
      }, action === "archive" ? "Produit archivé." : "Produit restauré.");
      return;
    }

    const statusTransition = getProductStatusTransition(product, action);
    if (!statusTransition) return;
    const body = {
      name: product.name,
      description: product.description,
      price: product.price,
      currency: product.currency,
      image: product.image,
      category: product.category,
      chariowProductId: product.chariowProductId,
      ...statusTransition
    };
    await applyMutation({
      method: "PUT",
      productId: product.id,
      body
    }, action === "availability" ? "Disponibilité mise à jour." : "Publication mise à jour.");
  }

  viewButtons.forEach((button) => button.addEventListener("click", () => {
    showView(button.dataset.adminView, { focusHeading: true });
  }));
  document.querySelector("[data-admin-archives]").addEventListener("click", () => {
    showView("archives", { focusHeading: true });
  });
  productFilterButtons.forEach((button) => button.addEventListener("click", () => {
    productFilter = button.dataset.productFilter;
    productFilterButtons.forEach((filterButton) => {
      const selected = filterButton === button;
      filterButton.classList.toggle("is-active", selected);
      filterButton.setAttribute("aria-pressed", String(selected));
    });
    renderProducts();
  }));
  document.querySelector("[data-product-create]").addEventListener("click", () => openEditor());
  document.querySelector("[data-editor-cancel]").addEventListener("click", () => {
    resetEditor();
    showView(currentView);
  });
  document.querySelector("[data-products-refresh]").addEventListener("click", () => {
    void refreshProducts().catch(() => {});
  });
  document.querySelector("[data-archives-refresh]").addEventListener("click", () => {
    void refreshArchives().catch(() => {});
  });
  searchInput.addEventListener("input", renderProducts);
  productList.addEventListener("click", (event) => { void handleProductAction(event); });
  archivesList.addEventListener("click", (event) => { void handleProductAction(event); });
  reloadButton.addEventListener("click", () => { void reloadAfterConflict(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (editBlocked || submitButton.disabled) return;
    formMessage.hidden = true;
    clearProductFieldErrors();
    let body;
    try {
      body = createPayload();
    } catch (error) {
      if (error.field) {
        showProductFieldError(error.field, error.message);
        showFormMessage("Corrigez le champ signalé puis réessayez.");
        return;
      }
      showFormMessage(error.message);
      return;
    }
    const editing = editingProduct !== null;
    const result = await applyMutation({
      method: editing ? "PUT" : "POST",
      productId: editing ? editingProduct.id : undefined,
      body,
      ifMatch: editing ? editingEtag : controller.etag
    }, editing ? "Produit modifié." : "Produit créé.");
    if (result) {
      resetEditor();
      showView("products", { loadData: false });
    }
  });

  form.addEventListener("input", (event) => {
    const field = event.target;
    const errorElement = form.querySelector(`[data-product-error="${field.name}"]`);
    if (errorElement && field.getAttribute("aria-invalid") === "true") {
      field.removeAttribute("aria-invalid");
      errorElement.hidden = true;
      errorElement.textContent = "";
    }
    if (["available", "published"].includes(field.name) &&
        (!form.elements.namedItem("available").checked ||
          form.elements.namedItem("published").checked)) {
      const available = form.elements.namedItem("available");
      const availableError = form.querySelector('[data-product-error="available"]');
      available.removeAttribute("aria-invalid");
      availableError.hidden = true;
      availableError.textContent = "";
    }
    if (formMessage.dataset.state === "error" &&
        formMessage.textContent === "Corrigez le champ signalé puis réessayez.") {
      formMessage.hidden = true;
      formMessage.textContent = "";
      delete formMessage.dataset.state;
    }
  });
  window.setAdminAuthenticated = setAuthenticated;
  window.clearAdminCatalogState = () => {
    resetEditor();
    controller.clearEdit();
    chariowController.clear();
    activeProducts = [];
    archivedProducts = [];
    renderProducts();
    renderArchives();
  };
}

if (typeof document !== "undefined") initializeAdminUI();

export function setAuthenticated(isAdmin) {
  if (typeof window !== "undefined" && typeof window.setAdminAuthenticated === "function") {
    window.setAdminAuthenticated(isAdmin);
  }
}
