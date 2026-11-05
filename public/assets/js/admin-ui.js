const catalogEndpoint = "/.netlify/functions/catalog";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

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
    mutate,
    beginEdit,
    clearEdit,
    reloadEdit,
    get etag() {
      return etag;
    }
  };
}

function initializeAdminUI() {
  const authView = document.querySelector("[data-admin-auth]");
  const adminApp = document.querySelector("[data-admin-app]");
  const adminMessage = document.querySelector("[data-admin-message]");
  const screens = [...document.querySelectorAll("[data-admin-screen]")];
  const viewButtons = [...document.querySelectorAll("[data-admin-view]")];
  const productList = document.querySelector("[data-products-list]");
  const archivesList = document.querySelector("[data-archives-list]");
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
  const controller = createAdminCatalogController();
  let activeProducts = [];
  let archivedProducts = [];
  let editingProduct = null;
  let editingEtag = "";
  let editBlocked = false;
  let currentView = "products";

  if (!authView || !adminApp || !form) return;

  function setAuthenticated(isAdmin) {
    const allowed = isAdmin === true;
    authView.hidden = allowed;
    adminApp.hidden = !allowed;
    document.body.classList.toggle("admin-authenticated", allowed);
    if (!allowed) {
      return;
    }
    showView("products");
    void refreshProducts();
  }

  function showView(name, { loadData = true } = {}) {
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
    button.className = "button button-outline";
    button.type = "button";
    button.textContent = label;
    button.dataset.productAction = action;
    button.dataset.productId = product.id;
    return button;
  }

  function renderProductList(container, products, archived) {
    const query = archived ? "" : searchInput.value.trim().toLocaleLowerCase();
    const filtered = products.filter((product) => {
      const name = `${product.name.fr} ${product.name.en}`.toLocaleLowerCase();
      return !query || name.includes(query) || product.category.toLocaleLowerCase().includes(query);
    });
    container.replaceChildren();
    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.className = "admin-empty-state";
      empty.textContent = products.length
        ? "Aucun produit ne correspond à la recherche."
        : archived ? "Aucun produit archivé." : "Aucun produit dans le catalogue.";
      container.append(empty);
      return;
    }

    for (const product of filtered) {
      const card = document.createElement("article");
      card.className = "admin-product-card";
      const details = document.createElement("div");
      details.className = "admin-product-details";
      const title = document.createElement("h3");
      title.textContent = product.name.fr;
      const meta = document.createElement("p");
      meta.textContent = `${product.category || "Sans catégorie"} · ${product.price} ${product.currency}`;
      const states = document.createElement("p");
      states.className = "admin-product-states";
      states.textContent = archived
        ? "Archivé"
        : `${product.available ? "Disponible" : "Indisponible"} · ${product.published ? "Publié" : "Non publié"}`;
      details.append(title, meta, states);

      const actions = document.createElement("div");
      actions.className = "admin-product-actions";
      if (archived) {
        actions.append(makeButton("Restaurer", "restore", product));
        actions.append(makeButton("Supprimer définitivement", "delete", product));
      } else {
        actions.append(makeButton("Modifier", "edit", product));
        actions.append(makeButton(product.published ? "Dépublier" : "Publier", "publication", product));
        actions.append(makeButton(product.available ? "Rendre indisponible" : "Rendre disponible", "availability", product));
        actions.append(makeButton("Archiver", "archive", product));
      }
      card.append(details, actions);
      container.append(card);
    }
  }

  function renderProducts() {
    renderProductList(productList, activeProducts, false);
    productsStatus.textContent = `${activeProducts.length} produit${activeProducts.length === 1 ? "" : "s"}`;
  }

  function renderArchives() {
    renderProductList(archivesList, archivedProducts, true);
    archivesStatus.textContent = `${archivedProducts.length} produit${archivedProducts.length === 1 ? "" : "s"} archivé${archivedProducts.length === 1 ? "" : "s"}`;
  }

  async function refreshProducts() {
    productsStatus.textContent = "Chargement des produits…";
    try {
      const result = await controller.load();
      activeProducts = result.products.filter((product) => !product.archivedAt);
      renderProducts();
      clearAdminMessage();
      return result;
    } catch (error) {
      handleError(error, productsStatus);
      return null;
    }
  }

  async function refreshArchives() {
    archivesStatus.textContent = "Chargement des archives…";
    try {
      const result = await controller.load({ archived: true });
      archivedProducts = result.products.filter((product) => Boolean(product.archivedAt));
      renderArchives();
      clearAdminMessage();
      return result;
    } catch (error) {
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
    form.querySelectorAll("input, textarea, select").forEach((field) => {
      field.disabled = false;
    });
    submitButton.disabled = false;
    submitButton.textContent = "Créer le produit";
    reloadButton.hidden = true;
    formMessage.hidden = true;
    editorTitle.textContent = "Ajouter un produit";
    editorDescription.textContent = "Renseignez les informations en français et en anglais.";
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
      form.elements.namedItem("name-fr").value = product.name.fr;
      form.elements.namedItem("name-en").value = product.name.en;
      form.elements.namedItem("description-fr").value = product.description.fr;
      form.elements.namedItem("description-en").value = product.description.en;
      form.elements.namedItem("category").value = product.category;
      form.elements.namedItem("image").value = product.image;
      form.elements.namedItem("price").value = String(product.price);
      form.elements.namedItem("currency").value = product.currency;
      form.elements.namedItem("chariow-product-id").value = product.chariowProductId || "";
      form.elements.namedItem("available").checked = product.available;
      form.elements.namedItem("published").checked = product.published;
    }
    screens.forEach((screen) => { screen.hidden = true; });
    editor.hidden = false;
    form.elements.namedItem("name-fr").focus();
  }

  function createPayload() {
    const values = new FormData(form);
    const price = form.elements.namedItem("price").valueAsNumber;
    const image = String(values.get("image") || "");
    const chariowProductId = String(values.get("chariow-product-id") || "");
    const description = (value) => String(value || "").trim();
    const nameFr = String(values.get("name-fr") || "").trim();
    const nameEn = String(values.get("name-en") || "").trim();
    const descriptionFr = description(values.get("description-fr"));
    const descriptionEn = description(values.get("description-en"));
    if (!Number.isSafeInteger(price) || price <= 0) {
      throw new Error("Le prix doit être un nombre entier positif.");
    }
    if (!image.startsWith("assets/") || image.length > 512 || image.trim() !== image ||
        /[\u0000-\u001f\u007f]/.test(image) || image.includes("\\") ||
        image.includes("?") || image.includes("#") ||
        image.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("L’image doit être un chemin valide situé sous assets/.");
    }
    if (!/^prd_[A-Za-z0-9_-]+$/.test(chariowProductId)) {
      throw new Error("L’identifiant Chariow doit respecter le format prd_… .");
    }
    if (!nameFr || !nameEn || nameFr.length > 200 || nameEn.length > 200 ||
        !descriptionFr || !descriptionEn || descriptionFr.length > 20000 ||
        descriptionEn.length > 20000 ||
        [nameFr, nameEn, descriptionFr, descriptionEn].some((value) =>
          /[\u0000-\u001f\u007f]/.test(value)) ||
        [descriptionFr, descriptionEn].some((value) =>
          /[<>]/.test(value.replace(/<br\s*\/?>/gi, "")))) {
      throw new Error("Les noms et descriptions doivent être renseignés avec un texte valide.");
    }
    if (form.elements.namedItem("available").checked &&
        !form.elements.namedItem("published").checked) {
      throw new Error("Un produit disponible doit également être publié.");
    }
    return {
      name: {
        fr: nameFr,
        en: nameEn
      },
      description: {
        fr: descriptionFr,
        en: descriptionEn
      },
      category: String(values.get("category") || "").trim(),
      image,
      price,
      currency: String(values.get("currency") || ""),
      chariowProductId,
      available: form.elements.namedItem("available").checked,
      published: form.elements.namedItem("published").checked
    };
  }

  async function applyMutation(options, successMessage) {
    clearAdminMessage();
    try {
      const result = await controller.mutate(options);
      activeProducts = result.products.filter((product) => !product.archivedAt);
      archivedProducts = result.products.filter((product) => Boolean(product.archivedAt));
      renderProducts();
      renderArchives();
      showAdminMessage(successMessage, "success");
      return result;
    } catch (error) {
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
    reloadButton.disabled = true;
    showFormMessage("Rechargement de la version actuelle…", "info");
    try {
      const { product: latest, etag } = await controller.reloadEdit(editingProduct.id);
      editingProduct = latest;
      editingEtag = etag;
      for (const field of form.querySelectorAll("input, textarea, select")) field.disabled = false;
      submitButton.disabled = false;
      editBlocked = false;
      form.elements.namedItem("name-fr").value = latest.name.fr;
      form.elements.namedItem("name-en").value = latest.name.en;
      form.elements.namedItem("description-fr").value = latest.description.fr;
      form.elements.namedItem("description-en").value = latest.description.en;
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
    if (action === "edit") {
      openEditor(product);
      return;
    }
    if (action === "delete") {
      const confirmation = window.prompt(
        `La suppression est définitive. Saisissez exactement : DELETE PRODUCT ${product.id}`
      );
      if (confirmation !== `DELETE PRODUCT ${product.id}`) {
        showAdminMessage("Suppression annulée : la confirmation exacte n’a pas été saisie.");
        return;
      }
      await applyMutation({
        method: "DELETE",
        productId: product.id,
        body: { confirmation }
      }, "Produit supprimé définitivement.");
      return;
    }
    if (action === "archive" &&
        !window.confirm(`Archiver « ${product.name.fr} » ?`)) return;
    if (action === "archive" || action === "restore") {
      await applyMutation({
        method: "PATCH",
        productId: product.id,
        body: { action }
      }, action === "archive" ? "Produit archivé." : "Produit restauré.");
      return;
    }

    const body = {
      name: product.name,
      description: product.description,
      price: product.price,
      currency: product.currency,
      image: product.image,
      category: product.category,
      chariowProductId: product.chariowProductId,
      available: action === "availability" ? !product.available : product.available,
      published: action === "publication" ? !product.published : product.published
    };
    await applyMutation({
      method: "PUT",
      productId: product.id,
      body
    }, action === "availability" ? "Disponibilité mise à jour." : "Publication mise à jour.");
  }

  viewButtons.forEach((button) => button.addEventListener("click", () => {
    showView(button.dataset.adminView);
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
    let body;
    try {
      body = createPayload();
    } catch (error) {
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
  window.setAdminAuthenticated = setAuthenticated;
  window.clearAdminCatalogState = () => {
    resetEditor();
    controller.clearEdit();
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
