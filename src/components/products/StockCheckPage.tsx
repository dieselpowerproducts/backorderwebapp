import { useEffect, useRef, useState } from "react";
import { getStockCheckProducts } from "../../services/api";
import type {
  Product,
  FollowUpOverrides,
  ProductStockUpdate,
  StockCheckSort,
  VendorEmailSentUpdate
} from "../../types";
import { Pagination } from "./Pagination";
import { ProductsTable } from "./ProductsTable";
import { applyProductStockUpdate } from "./productStockUpdates";

type StockCheckPageProps = {
  productStockUpdate: ProductStockUpdate | null;
  followUpOverrides: FollowUpOverrides;
  vendorEmailSentUpdate: VendorEmailSentUpdate | null;
  onOpenNotes: (sku: string) => void;
};

type StockCheckCacheEntry = {
  data: Product[];
  total: number;
};

const pageSize = 30;
const stockCheckSortOptions: Array<{ value: StockCheckSort; label: string }> = [
  { value: "yesterday", label: "Yesterday" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "no-follow-up", label: "No follow up" },
  { value: "all", label: "All" }
];

function getLocalDateText() {
  const now = new Date();

  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function addDaysToDateText(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);

  date.setDate(date.getDate() + days);

  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function matchesStockCheckFilter(product: Product, sort: StockCheckSort) {
  const followUpDate = product.followUpDate || "";
  const isStockCheckProduct =
    product.availability !== "Available" || Boolean(followUpDate);

  if (!isStockCheckProduct) {
    return false;
  }

  if (sort === "all") {
    return true;
  }

  if (sort === "no-follow-up") {
    return !followUpDate;
  }

  const offsetBySort: Record<"yesterday" | "today" | "tomorrow", number> = {
    yesterday: -1,
    today: 0,
    tomorrow: 1
  };

  return followUpDate === addDaysToDateText(getLocalDateText(), offsetBySort[sort]);
}

function applyAndFilterStockCheckProducts(
  products: Product[],
  productStockUpdate: ProductStockUpdate | null,
  followUpOverrides: FollowUpOverrides,
  sort: StockCheckSort,
  vendorEmailSentSkus: Set<string> = new Set()
) {
  return applyProductStockUpdate(products, productStockUpdate)
    .map((product) => {
      const overrideKey = product.sku.trim().toUpperCase();
      const vendorEmailSent = vendorEmailSentSkus.has(overrideKey)
        ? true
        : product.vendorEmailSent;

      if (!Object.prototype.hasOwnProperty.call(followUpOverrides, overrideKey)) {
        return {
          ...product,
          vendorEmailSent
        };
      }

      return {
        ...product,
        followUpDate: followUpOverrides[overrideKey] || "",
        vendorEmailSent
      };
    })
    .filter((product) => matchesStockCheckFilter(product, sort));
}

function getStockCheckCacheKey({
  page,
  referenceDate,
  sort
}: {
  page: number;
  referenceDate: string;
  sort: StockCheckSort;
}) {
  return `${referenceDate}:${sort}:${page}`;
}

export function StockCheckPage({
  productStockUpdate,
  followUpOverrides,
  vendorEmailSentUpdate,
  onOpenNotes
}: StockCheckPageProps) {
  const latestProductStockUpdate = useRef(productStockUpdate);
  const latestFollowUpOverrides = useRef(followUpOverrides);
  const stockCheckCache = useRef(new Map<string, StockCheckCacheEntry>());
  const vendorEmailSentSkus = useRef(new Set<string>());
  const [products, setProducts] = useState<Product[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<StockCheckSort>("all");

  useEffect(() => {
    latestProductStockUpdate.current = productStockUpdate;
  }, [productStockUpdate]);

  useEffect(() => {
    latestFollowUpOverrides.current = followUpOverrides;
  }, [followUpOverrides]);

  function applyLocalState(productsToApply: Product[], nextSort = sort) {
    return applyAndFilterStockCheckProducts(
      productsToApply,
      latestProductStockUpdate.current,
      latestFollowUpOverrides.current,
      nextSort,
      vendorEmailSentSkus.current
    );
  }

  useEffect(() => {
    let ignore = false;
    const referenceDate = getLocalDateText();
    const cacheKey = getStockCheckCacheKey({
      page: currentPage,
      referenceDate,
      sort
    });
    const cachedResult = stockCheckCache.current.get(cacheKey);

    async function loadStockCheckProducts() {
      if (cachedResult) {
        setError("");
        setIsLoading(false);
        setProducts(applyLocalState(cachedResult.data, sort));
        setTotalItems(cachedResult.total);
        return;
      }

      setIsLoading(true);
      setError("");

      try {
        const result = await getStockCheckProducts({
          page: currentPage,
          limit: pageSize,
          search: "",
          sort,
          referenceDate,
          bypassCache: false
        });

        if (!ignore) {
          stockCheckCache.current.set(cacheKey, {
            data: result.data,
            total: result.total
          });
          setProducts(applyLocalState(result.data, sort));
          setTotalItems(result.total);
        }
      } catch (err) {
        if (!ignore) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load stock check products."
          );
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }

    loadStockCheckProducts();

    return () => {
      ignore = true;
    };
  }, [currentPage, sort]);

  useEffect(() => {
    if (!productStockUpdate) {
      return;
    }

    setProducts((current) =>
      applyAndFilterStockCheckProducts(
        current,
        productStockUpdate,
        followUpOverrides,
        sort,
        vendorEmailSentSkus.current
      )
    );
  }, [followUpOverrides, productStockUpdate, sort]);

  useEffect(() => {
    if (!vendorEmailSentUpdate?.sku) {
      return;
    }

    const emailedSku = vendorEmailSentUpdate.sku.trim().toUpperCase();

    vendorEmailSentSkus.current.add(emailedSku);
    setProducts((current) =>
      current.map((product) =>
        product.sku.trim().toUpperCase() === emailedSku
          ? {
              ...product,
              vendorEmailSent: true
            }
          : product
      )
    );
  }, [vendorEmailSentUpdate]);

  const emptyMessageBySort: Record<StockCheckSort, string> = {
    yesterday: "No stock check products with follow-up dates from yesterday.",
    today: "No stock check products with follow-up dates from today.",
    tomorrow: "No stock check products with follow-up dates from tomorrow.",
    "no-follow-up": "No stock check products without follow-up dates.",
    all: "No backordered or follow-up products found."
  };

  return (
    <section className="page stock-check-page" aria-labelledby="stockCheckHeading">
      <div className="stock-check-toolbar">
        <h1 id="stockCheckHeading">Stock Check</h1>

        <label className="stock-check-sort-control">
          <span>Show</span>
          <select
            value={sort}
            aria-label="Sort stock check products"
            onChange={(event) => {
              setSort(event.target.value as StockCheckSort);
              setCurrentPage(1);
            }}
          >
            {stockCheckSortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="status-message error-message">{error}</p>}
      {isLoading && <p className="status-message">Loading stock check...</p>}

      <ProductsTable
        emptyMessage={emptyMessageBySort[sort]}
        products={products}
        onOpenNotes={onOpenNotes}
        showVendorEmailStatus
      />

      <Pagination
        currentPage={currentPage}
        limit={pageSize}
        totalItems={totalItems}
        onPageChange={setCurrentPage}
      />
    </section>
  );
}
