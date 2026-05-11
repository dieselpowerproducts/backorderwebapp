import { useEffect, useState } from "react";
import {
  getVendorAutoInventorySettings,
  getVendorProducts,
  getVendors,
  updateVendorAutoInventorySettings,
  updateVendorSettings
} from "../../services/api";
import type {
  VendorAutoInventorySettings,
  VendorDetails,
  VendorProduct,
  VendorSummary
} from "../../types";
import { Pagination } from "../products/Pagination";
import { VendorProductsTable } from "./VendorProductsTable";
import { VendorsTable } from "./VendorsTable";

type VendorsPageProps = {
  selectedVendor: string;
  onBackToVendors: () => void;
  onSelectVendor: (vendor: string) => void;
};

const pageSize = 30;
const autoInventoryFocusRefreshMinMs = 60 * 1000;

function getDefaultAutoInventorySettings(
  vendorId: string
): VendorAutoInventorySettings {
  return {
    vendorId,
    enabled: false,
    senderEmail: "",
    skuHeader: "",
    inventoryHeader: "",
    subtractiveColumn: "",
    skuExceptions: [],
    inventoryMode: "numerical",
    inStockPhrases: [],
    outOfStockPhrases: [],
    lastImportedAt: ""
  };
}

function formatPhraseText(phrases: string[]) {
  return phrases.join(" : ");
}

function parsePhraseText(value: string) {
  return value
    .split(/[,:]/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

function formatSkuExceptions(skus: string[]) {
  return skus.join(", ");
}

function parseSkuExceptions(value: string) {
  return value
    .split(",")
    .map((sku) => sku.trim())
    .filter(Boolean);
}

export function VendorsPage({
  selectedVendor,
  onBackToVendors,
  onSelectVendor
}: VendorsPageProps) {
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [products, setProducts] = useState<VendorProduct[]>([]);
  const [selectedVendorDetails, setSelectedVendorDetails] =
    useState<VendorDetails | null>(null);
  const [autoInventorySettings, setAutoInventorySettings] =
    useState<VendorAutoInventorySettings | null>(null);
  const [autoInventoryDraft, setAutoInventoryDraft] =
    useState<VendorAutoInventorySettings | null>(null);
  const [buildTimeDraft, setBuildTimeDraft] = useState("");
  const [inStockPhraseDraft, setInStockPhraseDraft] = useState("");
  const [outOfStockPhraseDraft, setOutOfStockPhraseDraft] = useState("");
  const [skuExceptionsDraft, setSkuExceptionsDraft] = useState("");
  const [vendorCurrentPage, setVendorCurrentPage] = useState(1);
  const [vendorSearchInput, setVendorSearchInput] = useState("");
  const [vendorSearchQuery, setVendorSearchQuery] = useState("");
  const [vendorTotalItems, setVendorTotalItems] = useState(0);
  const [productCurrentPage, setProductCurrentPage] = useState(1);
  const [productSearchInput, setProductSearchInput] = useState("");
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [productTotalItems, setProductTotalItems] = useState(0);
  const [isVendorsLoading, setIsVendorsLoading] = useState(false);
  const [isProductsLoading, setIsProductsLoading] = useState(false);
  const [isVendorSettingsSaving, setIsVendorSettingsSaving] = useState(false);
  const [isAutoInventorySaving, setIsAutoInventorySaving] = useState(false);
  const [vendorSettingsStatus, setVendorSettingsStatus] = useState("");
  const [autoInventoryStatus, setAutoInventoryStatus] = useState("");
  const [isAutoInventoryModalOpen, setIsAutoInventoryModalOpen] = useState(false);
  const [productRefreshNonce, setProductRefreshNonce] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setVendorSearchQuery(vendorSearchInput);
      setVendorCurrentPage(1);
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [vendorSearchInput]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setProductSearchQuery(productSearchInput);
      setProductCurrentPage(1);
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [productSearchInput]);

  useEffect(() => {
    let ignore = false;

    async function loadVendors() {
      if (selectedVendor) {
        setIsVendorsLoading(false);
        return;
      }

      setIsVendorsLoading(true);
      setError("");

      try {
        const result = await getVendors({
          page: vendorCurrentPage,
          limit: pageSize,
          search: vendorSearchQuery
        });

        if (!ignore) {
          setVendors(result.data);
          setVendorTotalItems(result.total);
        }
      } catch (err) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Unable to load vendors.");
        }
      } finally {
        if (!ignore) {
          setIsVendorsLoading(false);
        }
      }
    }

    loadVendors();

    return () => {
      ignore = true;
    };
  }, [selectedVendor, vendorCurrentPage, vendorSearchQuery]);

  useEffect(() => {
    setSelectedVendorDetails(null);
    setAutoInventorySettings(null);
    setAutoInventoryDraft(null);
    setBuildTimeDraft("");
    setInStockPhraseDraft("");
    setOutOfStockPhraseDraft("");
    setSkuExceptionsDraft("");
    setVendorSettingsStatus("");
    setAutoInventoryStatus("");
    setIsAutoInventoryModalOpen(false);
    setProductCurrentPage(1);
    setProductSearchInput("");
    setProductSearchQuery("");
  }, [selectedVendor]);

  useEffect(() => {
    let ignore = false;

    async function loadVendorProducts() {
      if (!selectedVendor) {
        setProducts([]);
        setSelectedVendorDetails(null);
        setProductTotalItems(0);
        setIsProductsLoading(false);
        return;
      }

      setIsProductsLoading(true);
      setError("");

      try {
        const result = await getVendorProducts({
          vendorId: selectedVendor,
          page: productCurrentPage,
          limit: pageSize,
          search: productSearchQuery
        });

        if (!ignore) {
          setProducts(result.data);
          setSelectedVendorDetails(result.vendor);
          setBuildTimeDraft(result.vendor.buildTime || "");
          setProductTotalItems(result.total);
        }
      } catch (err) {
        if (!ignore) {
          setError(
            err instanceof Error ? err.message : "Unable to load vendor products."
          );
        }
      } finally {
        if (!ignore) {
          setIsProductsLoading(false);
        }
      }
    }

    loadVendorProducts();

    return () => {
      ignore = true;
    };
  }, [selectedVendor, productCurrentPage, productRefreshNonce, productSearchQuery]);

  useEffect(() => {
    let ignore = false;
    let lastLoadedAt = 0;

    if (!selectedVendor) {
      setAutoInventorySettings(null);
      return () => {
        ignore = true;
      };
    }

    async function loadAutoInventorySettings() {
      try {
        lastLoadedAt = Date.now();
        const settings = await getVendorAutoInventorySettings(selectedVendor);

        if (!ignore) {
          setAutoInventorySettings(settings);
        }
      } catch (err) {
        if (!ignore) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load auto inventory settings."
          );
        }
      }
    }

    void loadAutoInventorySettings();
    const loadStaleAutoInventorySettings = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastLoadedAt >= autoInventoryFocusRefreshMinMs
      ) {
        void loadAutoInventorySettings();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadStaleAutoInventorySettings();
      }
    };

    window.addEventListener("focus", loadStaleAutoInventorySettings);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      ignore = true;
      window.removeEventListener("focus", loadStaleAutoInventorySettings);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [selectedVendor]);

  async function saveVendorDetails(nextBuiltToOrder: boolean, nextBuildTime: string) {
    if (!selectedVendor) {
      return;
    }

    setIsVendorSettingsSaving(true);
    setVendorSettingsStatus("Saving vendor settings...");
    setError("");

    try {
      const result = await updateVendorSettings({
        vendorId: selectedVendor,
        builtToOrder: nextBuiltToOrder,
        buildTime: nextBuildTime
      });

      setSelectedVendorDetails(result);
      setBuildTimeDraft(result.buildTime || "");
      setVendorSettingsStatus("Vendor settings saved.");
      setProductRefreshNonce((current) => current + 1);
    } catch (err) {
      setVendorSettingsStatus("");
      setError(
        err instanceof Error ? err.message : "Unable to save vendor settings."
      );
    } finally {
      setIsVendorSettingsSaving(false);
    }
  }

  function handleBuiltToOrderChange(checked: boolean) {
    void saveVendorDetails(checked, buildTimeDraft);
  }

  function handleBuildTimeBlur() {
    if (!selectedVendorDetails?.builtToOrder) {
      return;
    }

    if (buildTimeDraft === selectedVendorDetails.buildTime) {
      return;
    }

    void saveVendorDetails(true, buildTimeDraft);
  }

  function handleOpenAutoInventoryModal() {
    const draft =
      autoInventorySettings || getDefaultAutoInventorySettings(selectedVendor);
    const nextDraft = {
      ...draft,
      enabled: draft.enabled || !autoInventorySettings?.enabled
    };

    setAutoInventoryDraft(nextDraft);
    setInStockPhraseDraft(formatPhraseText(nextDraft.inStockPhrases));
    setOutOfStockPhraseDraft(formatPhraseText(nextDraft.outOfStockPhrases));
    setSkuExceptionsDraft(formatSkuExceptions(nextDraft.skuExceptions || []));
    setAutoInventoryStatus("");
    setError("");
    setIsAutoInventoryModalOpen(true);
  }

  function handleCloseAutoInventoryModal() {
    if (isAutoInventorySaving) {
      return;
    }

    setIsAutoInventoryModalOpen(false);
    setAutoInventoryDraft(null);
    setInStockPhraseDraft("");
    setOutOfStockPhraseDraft("");
    setSkuExceptionsDraft("");
    setAutoInventoryStatus("");
  }

  function updateAutoInventoryDraft(
    patch: Partial<VendorAutoInventorySettings>
  ) {
    setAutoInventoryDraft((current) =>
      current ? { ...current, ...patch } : current
    );
  }

  async function handleSaveAutoInventorySettings() {
    if (!selectedVendor || !autoInventoryDraft || isAutoInventorySaving) {
      return;
    }

    setIsAutoInventorySaving(true);
    setAutoInventoryStatus("Saving auto inventory settings...");
    setError("");

    try {
      const result = await updateVendorAutoInventorySettings({
        vendorId: selectedVendor,
        settings: {
          enabled: autoInventoryDraft.enabled,
          senderEmail: autoInventoryDraft.senderEmail,
          skuHeader: autoInventoryDraft.skuHeader,
          inventoryHeader: autoInventoryDraft.inventoryHeader,
          subtractiveColumn: autoInventoryDraft.subtractiveColumn,
          skuExceptions: parseSkuExceptions(skuExceptionsDraft),
          inventoryMode: autoInventoryDraft.inventoryMode,
          inStockPhrases: parsePhraseText(inStockPhraseDraft),
          outOfStockPhrases: parsePhraseText(outOfStockPhraseDraft)
        }
      });

      setAutoInventorySettings(result);
      setAutoInventoryDraft(result);
      setInStockPhraseDraft(formatPhraseText(result.inStockPhrases));
      setOutOfStockPhraseDraft(formatPhraseText(result.outOfStockPhrases));
      setSkuExceptionsDraft(formatSkuExceptions(result.skuExceptions || []));
      setAutoInventoryStatus("Auto inventory settings saved.");
      setIsAutoInventoryModalOpen(false);
    } catch (err) {
      setAutoInventoryStatus("");
      setError(
        err instanceof Error
          ? err.message
          : "Unable to save auto inventory settings."
      );
    } finally {
      setIsAutoInventorySaving(false);
    }
  }

  const activeVendor: VendorDetails = selectedVendorDetails || {
    id: selectedVendor,
    vendor: selectedVendor,
    builtToOrder: false,
    buildTime: ""
  };

  return (
    <section className="page" aria-labelledby="vendorsHeading">
      {error && <p className="status-message error-message">{error}</p>}
      {isVendorsLoading && <p className="status-message">Loading vendors...</p>}
      {isProductsLoading && (
        <p className="status-message">Loading vendor products...</p>
      )}

      {selectedVendor ? (
        <>
          <VendorProductsTable
            vendor={activeVendor}
            products={products}
            totalItems={productTotalItems}
            searchValue={productSearchInput}
            buildTimeValue={buildTimeDraft}
            isSavingSettings={isVendorSettingsSaving}
            settingsStatus={vendorSettingsStatus}
            autoInventoryEnabled={Boolean(autoInventorySettings?.enabled)}
            autoInventoryLastImportedAt={autoInventorySettings?.lastImportedAt || ""}
            onSearchChange={setProductSearchInput}
            onBuiltToOrderChange={handleBuiltToOrderChange}
            onBuildTimeChange={setBuildTimeDraft}
            onBuildTimeBlur={handleBuildTimeBlur}
            onOpenAutoInventory={handleOpenAutoInventoryModal}
            onBackToVendors={onBackToVendors}
          />

          <Pagination
            currentPage={productCurrentPage}
            limit={pageSize}
            totalItems={productTotalItems}
            onPageChange={setProductCurrentPage}
          />
        </>
      ) : (
        <>
          <h1 id="vendorsHeading">Vendors</h1>

          <input
            type="text"
            value={vendorSearchInput}
            placeholder="Search vendors..."
            className="search-bar"
            aria-label="Search vendors"
            onChange={(event) => setVendorSearchInput(event.target.value)}
          />

          <VendorsTable vendors={vendors} onSelectVendor={onSelectVendor} />

          <Pagination
            currentPage={vendorCurrentPage}
            limit={pageSize}
            totalItems={vendorTotalItems}
            onPageChange={setVendorCurrentPage}
          />
        </>
      )}

      {isAutoInventoryModalOpen && autoInventoryDraft && (
        <div
          className="modal auto-inventory-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="autoInventoryTitle"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCloseAutoInventoryModal();
            }
          }}
        >
          <section className="modal-content auto-inventory-modal">
            <header className="auto-inventory-modal-header">
              <h2 id="autoInventoryTitle">Auto Inventory Settings</h2>
              <button
                type="button"
                aria-label="Close auto inventory settings"
                onClick={handleCloseAutoInventoryModal}
              >
                x
              </button>
            </header>

            <label className="auto-inventory-enable">
              <input
                type="checkbox"
                checked={autoInventoryDraft.enabled}
                disabled={isAutoInventorySaving}
                onChange={(event) =>
                  updateAutoInventoryDraft({ enabled: event.target.checked })
                }
              />
              <span>Enable auto inventory for this vendor</span>
            </label>

            <div className="auto-inventory-form-grid">
              <label>
                <span>Sender Email</span>
                <input
                  type="email"
                  value={autoInventoryDraft.senderEmail}
                  placeholder="inventory@vendor.com"
                  disabled={isAutoInventorySaving}
                  onChange={(event) =>
                    updateAutoInventoryDraft({ senderEmail: event.target.value })
                  }
                />
              </label>

              <label>
                <span>SKU Header</span>
                <input
                  type="text"
                  value={autoInventoryDraft.skuHeader}
                  placeholder="SKU"
                  disabled={isAutoInventorySaving}
                  onChange={(event) =>
                    updateAutoInventoryDraft({ skuHeader: event.target.value })
                  }
                />
              </label>

              <label>
                <span>Inventory Header</span>
                <input
                  type="text"
                  value={autoInventoryDraft.inventoryHeader}
                  placeholder="Inventory"
                  disabled={isAutoInventorySaving}
                  onChange={(event) =>
                    updateAutoInventoryDraft({
                      inventoryHeader: event.target.value
                    })
                  }
                />
              </label>

              <label>
                <span>Subtractive Column</span>
                <input
                  type="text"
                  value={autoInventoryDraft.subtractiveColumn || ""}
                  placeholder="Allocated"
                  disabled={isAutoInventorySaving}
                  onChange={(event) =>
                    updateAutoInventoryDraft({
                      subtractiveColumn: event.target.value
                    })
                  }
                />
              </label>
            </div>

            <fieldset className="auto-inventory-mode">
              <legend>Inventory Value</legend>
              <label>
                <input
                  type="checkbox"
                  checked={autoInventoryDraft.inventoryMode === "numerical"}
                  disabled={isAutoInventorySaving}
                  onChange={() =>
                    updateAutoInventoryDraft({ inventoryMode: "numerical" })
                  }
                />
                <span>Numerical</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={autoInventoryDraft.inventoryMode === "alphabetical"}
                  disabled={isAutoInventorySaving}
                  onChange={() =>
                    updateAutoInventoryDraft({ inventoryMode: "alphabetical" })
                  }
                />
                <span>Alphabetical</span>
              </label>
            </fieldset>

            {autoInventoryDraft.inventoryMode === "alphabetical" && (
              <div className="auto-inventory-form-grid">
                <label>
                  <span>In Stock Message</span>
                  <input
                    type="text"
                    value={inStockPhraseDraft}
                    placeholder="In Stock : Low Stock"
                    disabled={isAutoInventorySaving}
                    onChange={(event) => setInStockPhraseDraft(event.target.value)}
                  />
                </label>

                <label>
                  <span>Out of Stock Message</span>
                  <input
                    type="text"
                    value={outOfStockPhraseDraft}
                    placeholder="Out of Stock : Discontinued"
                    disabled={isAutoInventorySaving}
                    onChange={(event) =>
                      setOutOfStockPhraseDraft(event.target.value)
                    }
                  />
                </label>
              </div>
            )}

            <div className="auto-inventory-form-grid">
              <label>
                <span>SKU exceptions</span>
                <input
                  type="text"
                  value={skuExceptionsDraft}
                  placeholder="ABC-123456, XYZ-78910"
                  disabled={isAutoInventorySaving}
                  onChange={(event) => setSkuExceptionsDraft(event.target.value)}
                />
              </label>
            </div>

            {autoInventoryStatus && (
              <p className="vendor-settings-status">{autoInventoryStatus}</p>
            )}

            <footer className="auto-inventory-modal-actions">
              <button
                type="button"
                className="secondary-action"
                disabled={isAutoInventorySaving}
                onClick={handleCloseAutoInventoryModal}
              >
                Cancel
              </button>
              <button
                type="button"
                className="send-btn"
                disabled={isAutoInventorySaving}
                onClick={handleSaveAutoInventorySettings}
              >
                {isAutoInventorySaving ? "Saving..." : "Save"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
