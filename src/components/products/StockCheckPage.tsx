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
  isLastPage: boolean;
  total: number;
  totalPages: number;
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

function normalizeSku(value: string) {
  return value.trim().toUpperCase();
}

function isFlowThroughStockCheckSort(sort: StockCheckSort) {
  return sort === "yesterday" || sort === "today" || sort === "tomorrow";
}

function compareStockCheckProducts(left: Product, right: Product) {
  const leftDate = left.followUpDate || "";
  const rightDate = right.followUpDate || "";

  if (leftDate && rightDate && leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  if (leftDate && !rightDate) {
    return -1;
  }

  if (!leftDate && rightDate) {
    return 1;
  }

  return left.sku.localeCompare(right.sku, undefined, {
    sensitivity: "base"
  });
}

function applyAndFilterStockCheckProducts(
  products: Product[],
  productStockUpdate: ProductStockUpdate | null,
  followUpOverrides: FollowUpOverrides,
  sort: StockCheckSort,
  vendorEmailSentSkus: Set<string> = new Set(),
  excludedSkus: Set<string> = new Set()
) {
  return applyProductStockUpdate(products, productStockUpdate)
    .map((product) => {
      const overrideKey = normalizeSku(product.sku);
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
    .filter((product) => matchesStockCheckFilter(product, sort))
    .filter((product) => !excludedSkus.has(normalizeSku(product.sku)))
    .sort(compareStockCheckProducts);
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
  const borrowedSkusByCacheKey = useRef(new Map<string, Set<string>>());
  const removedSkusBySortKey = useRef(new Map<string, Set<string>>());
  const vendorEmailSentSkus = useRef(new Set<string>());
  const productsRef = useRef<Product[]>([]);
  const currentPageRef = useRef(1);
  const sortRef = useRef<StockCheckSort>("all");
  const totalItemsRef = useRef(0);
  const handledRefreshToken = useRef(0);
  const [products, setProducts] = useState<Product[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<StockCheckSort>("all");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    latestProductStockUpdate.current = productStockUpdate;
  }, [productStockUpdate]);

  useEffect(() => {
    latestFollowUpOverrides.current = followUpOverrides;
  }, [followUpOverrides]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    sortRef.current = sort;
  }, [sort]);

  function updateProducts(nextProducts: Product[]) {
    productsRef.current = nextProducts;
    setProducts(nextProducts);
  }

  function updateTotalItems(nextTotalItems: number) {
    totalItemsRef.current = nextTotalItems;
    setTotalItems(nextTotalItems);
  }

  function getBorrowedSkus(cacheKey: string) {
    return borrowedSkusByCacheKey.current.get(cacheKey) || new Set<string>();
  }

  function getSortDateKey(nextSort: StockCheckSort, referenceDate: string) {
    return `${referenceDate}:${nextSort}`;
  }

  function getAdjustedTotal(total: number, nextSort: StockCheckSort, referenceDate: string) {
    if (!isFlowThroughStockCheckSort(nextSort)) {
      return total;
    }

    const removedSkus =
      removedSkusBySortKey.current.get(getSortDateKey(nextSort, referenceDate)) ||
      new Set<string>();

    return Math.max(0, total - removedSkus.size);
  }

  function applyLocalState(
    productsToApply: Product[],
    nextSort = sort,
    page = currentPage,
    referenceDate = getLocalDateText()
  ) {
    const cacheKey = getStockCheckCacheKey({
      page,
      referenceDate,
      sort: nextSort
    });

    return applyAndFilterStockCheckProducts(
      productsToApply,
      latestProductStockUpdate.current,
      latestFollowUpOverrides.current,
      nextSort,
      vendorEmailSentSkus.current,
      getBorrowedSkus(cacheKey)
    );
  }

  async function getCachedOrRemotePage(
    page: number,
    nextSort: StockCheckSort,
    referenceDate: string
  ) {
    const cacheKey = getStockCheckCacheKey({
      page,
      referenceDate,
      sort: nextSort
    });
    const cachedResult = stockCheckCache.current.get(cacheKey);

    if (cachedResult) {
      return cachedResult;
    }

    const result = await getStockCheckProducts({
      page,
      limit: pageSize,
      search: "",
      sort: nextSort,
      referenceDate,
      bypassCache: false
    });
    const cacheEntry = {
      data: result.data,
      isLastPage: result.isLastPage,
      total: result.total,
      totalPages: result.totalPages
    };

    stockCheckCache.current.set(cacheKey, cacheEntry);
    return cacheEntry;
  }

  async function fillCurrentPageFromFollowingPages({
    baseProducts,
    expectedTotal,
    page,
    referenceDate,
    sort: nextSort
  }: {
    baseProducts: Product[];
    expectedTotal: number;
    page: number;
    referenceDate: string;
    sort: StockCheckSort;
  }) {
    if (!isFlowThroughStockCheckSort(nextSort)) {
      return;
    }

    const pageStartIndex = (page - 1) * pageSize;
    const seenSkus = new Set(baseProducts.map((product) => normalizeSku(product.sku)));
    const filledProducts = [...baseProducts];
    let nextPage = page + 1;
    const maxPage = Math.ceil(expectedTotal / pageSize) + 1;

    while (
      filledProducts.length < pageSize &&
      pageStartIndex + filledProducts.length < expectedTotal &&
      nextPage <= maxPage
    ) {
      let nextEntry: StockCheckCacheEntry;

      try {
        nextEntry = await getCachedOrRemotePage(nextPage, nextSort, referenceDate);
      } catch (err) {
        console.warn("Unable to fill stock check page from next page.", err);
        return;
      }

      const nextCacheKey = getStockCheckCacheKey({
        page: nextPage,
        referenceDate,
        sort: nextSort
      });
      const nextPageProducts = applyLocalState(
        nextEntry.data,
        nextSort,
        nextPage,
        referenceDate
      );

      for (const product of nextPageProducts) {
        const productSku = normalizeSku(product.sku);

        if (seenSkus.has(productSku)) {
          continue;
        }

        filledProducts.push(product);
        seenSkus.add(productSku);

        const borrowedSkus =
          borrowedSkusByCacheKey.current.get(nextCacheKey) || new Set<string>();
        borrowedSkus.add(productSku);
        borrowedSkusByCacheKey.current.set(nextCacheKey, borrowedSkus);

        if (filledProducts.length >= pageSize) {
          break;
        }
      }

      if (nextEntry.isLastPage) {
        break;
      }

      nextPage += 1;
    }

    if (
      currentPageRef.current === page &&
      sortRef.current === nextSort &&
      filledProducts.length > baseProducts.length
    ) {
      const currentCacheKey = getStockCheckCacheKey({
        page,
        referenceDate,
        sort: nextSort
      });
      const currentEntry = stockCheckCache.current.get(currentCacheKey);

      if (currentEntry) {
        stockCheckCache.current.set(currentCacheKey, {
          ...currentEntry,
          data: filledProducts
        });
      }

      updateProducts(filledProducts);
    }
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
    const shouldBypassCache = refreshToken !== handledRefreshToken.current;

    async function loadStockCheckProducts() {
      if (!shouldBypassCache && cachedResult) {
        setError("");
        setIsLoading(false);
        const nextProducts = applyLocalState(
          cachedResult.data,
          sort,
          currentPage,
          referenceDate
        );
        const adjustedTotal = getAdjustedTotal(
          cachedResult.total,
          sort,
          referenceDate
        );

        updateProducts(nextProducts);
        updateTotalItems(adjustedTotal);
        void fillCurrentPageFromFollowingPages({
          baseProducts: nextProducts,
          expectedTotal: adjustedTotal,
          page: currentPage,
          referenceDate,
          sort
        });
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
          bypassCache: shouldBypassCache
        });

        if (!ignore) {
          stockCheckCache.current.set(cacheKey, {
            data: result.data,
            isLastPage: result.isLastPage,
            total: result.total,
            totalPages: result.totalPages
          });
          const nextProducts = applyLocalState(
            result.data,
            sort,
            currentPage,
            referenceDate
          );
          const adjustedTotal = getAdjustedTotal(result.total, sort, referenceDate);

          updateProducts(nextProducts);
          updateTotalItems(adjustedTotal);
          void fillCurrentPageFromFollowingPages({
            baseProducts: nextProducts,
            expectedTotal: adjustedTotal,
            page: currentPage,
            referenceDate,
            sort
          });
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
          handledRefreshToken.current = refreshToken;
          setIsLoading(false);
        }
      }
    }

    loadStockCheckProducts();

    return () => {
      ignore = true;
    };
  }, [currentPage, refreshToken, sort]);

  useEffect(() => {
    if (!productStockUpdate) {
      return;
    }

    const currentSort = sortRef.current;
    const currentPageNumber = currentPageRef.current;
    const currentProducts = productsRef.current;
    const nextProducts = applyAndFilterStockCheckProducts(
      currentProducts,
      productStockUpdate,
      followUpOverrides,
      currentSort,
      vendorEmailSentSkus.current
    );
    const referenceDate = getLocalDateText();
    const removedSkus = currentProducts
      .filter(
        (product) =>
          !nextProducts.some(
            (nextProduct) => normalizeSku(nextProduct.sku) === normalizeSku(product.sku)
          )
      )
      .map((product) => normalizeSku(product.sku));
    let nextTotal = totalItemsRef.current;

    if (isFlowThroughStockCheckSort(currentSort) && removedSkus.length > 0) {
      const sortDateKey = getSortDateKey(currentSort, referenceDate);
      const removedSkusForSort =
        removedSkusBySortKey.current.get(sortDateKey) || new Set<string>();
      let newRemovedCount = 0;

      for (const removedSku of removedSkus) {
        if (!removedSkusForSort.has(removedSku)) {
          removedSkusForSort.add(removedSku);
          newRemovedCount += 1;
        }
      }

      removedSkusBySortKey.current.set(sortDateKey, removedSkusForSort);
      nextTotal = Math.max(0, totalItemsRef.current - newRemovedCount);
      updateTotalItems(nextTotal);
    }

    updateProducts(nextProducts);

    if (productStockUpdate.followUpDate !== undefined) {
      stockCheckCache.current.clear();
      borrowedSkusByCacheKey.current.clear();
      setRefreshToken((current) => current + 1);
    }

    if (
      isFlowThroughStockCheckSort(currentSort) &&
      nextProducts.length < pageSize &&
      (currentPageNumber - 1) * pageSize + nextProducts.length < nextTotal
    ) {
      void fillCurrentPageFromFollowingPages({
        baseProducts: nextProducts,
        expectedTotal: nextTotal,
        page: currentPageNumber,
        referenceDate,
        sort: currentSort
      });
    }
  }, [followUpOverrides, productStockUpdate]);

  useEffect(() => {
    if (!vendorEmailSentUpdate?.sku) {
      return;
    }

    const emailedSku = normalizeSku(vendorEmailSentUpdate.sku);

    vendorEmailSentSkus.current.add(emailedSku);
    updateProducts(
      productsRef.current.map((product) =>
        normalizeSku(product.sku) === emailedSku
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
