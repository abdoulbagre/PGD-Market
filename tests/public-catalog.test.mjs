import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicCatalogHandler
} from "../backend/functions/public-catalog.mjs";
import {
  CatalogStorageError,
  readRatings
} from "../backend/services/catalog/_catalog.mjs";
import { projectPublicProduct } from "../backend/services/chariow/public-products.mjs";

const firstProductId = "prd_product_one";
const secondProductId = "prd_product_two";
const chariowProduct = (overrides = {}) => ({
  id: firstProductId,
  name: "Produit Chariow",
  description: "Description Chariow",
  type: "downloadable",
  status: "published",
  is_free: false,
  has_variant_pricing: false,
  category: { value: "guides", label: "Guides" },
  pictures: {
    cover: "https://cdn.chariow.com/products/cover.jpg",
    thumbnail: "https://cdn.chariow.com/products/thumbnail.jpg"
  },
  pricing: {
    type: "fixed",
    current_price: { value: 4200.5, currency: "XOF" }
  },
  quantity: null,
  ...overrides
});

const handlerFor = (products, ratings = {}) => createPublicCatalogHandler({
  connectBlobs: () => {},
  fetchProducts: async () => products,
  readRatings: async () => ({ ratings })
});

test("public catalog publishes canonical Chariow IDs with their PGD rating", async () => {
  const source = chariowProduct();
  const response = await handlerFor([source], { [firstProductId]: 5 })();
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    success: true,
    count: 1,
    products: [{
      id: firstProductId,
      name: source.name,
      description: source.description,
      price: 4200.5,
      originalPrice: null,
      discountPercentage: null,
      currency: "XOF",
      image: source.pictures.cover,
      rating: 5,
      category: "Guides"
    }]
  });
  assert.doesNotMatch(JSON.stringify(body), /reviews|avis|rating_count/i);
});

test("public catalog publishes a valid Chariow original price only when it exceeds the current price", async () => {
  const discounted = chariowProduct({
    pricing: {
      type: "fixed",
      current_price: { value: 3000, currency: "XOF" },
      price: { value: 5000, currency: "XOF" },
      price_off: "40%"
    }
  });
  const response = await handlerFor([discounted])();
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.products[0].price, 3000);
  assert.equal(body.products[0].originalPrice, 5000);
  assert.equal(body.products[0].discountPercentage, "40%");
  assert.equal(body.products[0].currency, "XOF");
});

test("public catalog exposes only valid Chariow discount percentages", async () => {
  const productWithDiscount = (id, priceOff, includeOriginalPrice = true) => chariowProduct({
    id,
    pricing: {
      type: "fixed",
      current_price: { value: 3000, currency: "XOF" },
      ...(includeOriginalPrice ? { price: { value: 5000, currency: "XOF" } } : {}),
      price_off: priceOff
    }
  });
  const response = await handlerFor([
    productWithDiscount("prd_discount_40", "40%"),
    productWithDiscount("prd_discount_20", "20%"),
    productWithDiscount("prd_discount_zero", "0%"),
    productWithDiscount("prd_discount_invalid", "sale"),
    productWithDiscount("prd_discount_unverified", "40%", false)
  ])();
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.products.map((product) => product.discountPercentage), [
    "40%",
    "20%",
    null,
    null,
    null
  ]);
});

test("zero rating means no stars and an invalid Chariow image gets the generic fallback", () => {
  const projected = projectPublicProduct(chariowProduct({
    id: secondProductId,
    pictures: { cover: "http://insecure.example/image.jpg", thumbnail: null }
  }), 0);

  assert.equal(projected.id, secondProductId);
  assert.equal(projected.rating, 0);
  assert.equal(projected.image, "assets/Background/logo-bronze.png");
});

test("public catalog connects Lambda Blobs and publishes products without ratings", async () => {
  const calls = [];
  const ratingKeys = [];
  const store = {
    getWithMetadata: async (key) => {
      ratingKeys.push(key);
      return null;
    }
  };
  const event = {
    blobs: Buffer.from(JSON.stringify({
      url: "https://blobs.netlify.com",
      token: "test-netlify-token"
    })).toString("base64"),
    headers: {
      "x-nf-site-id": "test-site",
      "x-nf-deploy-id": "test-deploy"
    }
  };
  const handler = createPublicCatalogHandler({
    fetchProducts: async () => {
      calls.push("products");
      return [chariowProduct()];
    },
    readRatings: async () => {
      calls.push("ratings");
      return readRatings({ store });
    }
  });
  const response = await handler(event);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.count, 1);
  assert.equal(body.products[0].id, firstProductId);
  assert.equal(body.products[0].rating, 0);
  assert.deepEqual(calls, ["products", "ratings"]);
  assert.deepEqual(ratingKeys, ["ratings-v1"]);
});

test("invalid legacy product identifiers are never published as product IDs", async () => {
  const response = await handlerFor([
    chariowProduct({ id: "local-product-ref" }),
    chariowProduct({ id: "550e8400-e29b-41d4-a716-446655440000" }),
    chariowProduct({ id: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90" }),
    chariowProduct({ id: secondProductId })
  ])();
  const body = JSON.parse(response.body);

  assert.equal(body.count, 1);
  assert.equal(body.products[0].id, secondProductId);
});

test("empty Chariow catalog has the same stable response structure", async () => {
  const response = await handlerFor([])();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    success: true,
    count: 0,
    products: []
  });
});

test("unsupported Chariow products are omitted while valid products remain", async () => {
  const response = await handlerFor([
    chariowProduct({ status: "draft" }),
    chariowProduct({ id: secondProductId, has_variant_pricing: true }),
    chariowProduct({ id: "prd_new_product" })
  ])();
  const body = JSON.parse(response.body);

  assert.equal(body.count, 1);
  assert.equal(body.products[0].id, "prd_new_product");
});

test("public catalog and checkout share strict availability handling", async () => {
  const response = await handlerFor([
    chariowProduct({ quantity: { remaining: 2 } }),
    chariowProduct({ id: secondProductId, quantity: { remaining: { value: 3 } } }),
    chariowProduct({ id: "prd_out_of_stock", quantity: { remaining: 0 } }),
    chariowProduct({ id: "prd_invalid_stock", quantity: { remaining: { value: "3" } } })
  ])();

  assert.deepEqual(
    JSON.parse(response.body).products.map(({ id }) => id),
    [firstProductId, secondProductId]
  );
});

test("public catalog rejects missing or invalid current prices instead of falling back", async () => {
  const response = await handlerFor([
    chariowProduct({
      pricing: {
        type: "fixed",
        effective: { value: 4200, currency: "XOF" }
      }
    }),
    chariowProduct({
      id: secondProductId,
      pricing: {
        type: "fixed",
        current_price: { value: 0, currency: "XOF" },
        effective: { value: 4200, currency: "XOF" }
      }
    })
  ])();

  assert.deepEqual(JSON.parse(response.body).products, []);
});

test("rating storage failures stop publication instead of returning defaults", async () => {
  let chariowReads = 0;
  const response = await createPublicCatalogHandler({
    connectBlobs: () => {},
    readRatings: async () => {
      throw new CatalogStorageError("RATINGS_UNAVAILABLE", 503, "private storage detail");
    },
    fetchProducts: async () => {
      chariowReads += 1;
      return [chariowProduct()];
    }
  })();
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 503);
  assert.equal(body.error.code, "RATINGS_UNAVAILABLE");
  assert.equal(chariowReads, 1);
  assert.doesNotMatch(JSON.stringify(body), /private storage detail/i);
});
