import { useCallback, useEffect, useState } from "react";
import { LoginPage } from "./components/auth/LoginPage";
import { NotificationsMenu } from "./components/layout/NotificationsMenu";
import { Sidebar } from "./components/layout/Sidebar";
import { NotesModal } from "./components/notes/NotesModal";
import { ProductsPage } from "./components/products/ProductsPage";
import { StockCheckPage } from "./components/products/StockCheckPage";
import { VendorsPage } from "./components/vendors/VendorsPage";
import { getAppVersion, getCurrentUser, signOut } from "./services/api";
import type {
  AppRoute,
  AuthUser,
  FollowUpOverrides,
  PageName,
  ProductStockUpdate,
  VendorEmailSentUpdate
} from "./types";

const appVersionFocusRefreshMinMs = 60 * 60 * 1000;

function parseRoute(): AppRoute {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  const page = parts[0] || "products";
  const routeValue =
    parts.length > 1 ? decodeURIComponent(parts.slice(1).join("/")) : "";

  if (page === "notes") {
    return routeValue
      ? { page: "notes", sku: routeValue, vendor: "" }
      : { page: "products", sku: "", vendor: "" };
  }

  if (page === "vendors" || page === "products" || page === "stock-check") {
    return { page, sku: "", vendor: page === "vendors" ? routeValue : "" };
  }

  return { page: "products", sku: "", vendor: "" };
}

function setHashRoute(page: PageName, vendor = "") {
  const nextHash = vendor
    ? `#/${page}/${encodeURIComponent(vendor)}`
    : `#/${page}`;

  if (window.location.hash === nextHash) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }

  window.location.hash = nextHash;
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute());
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authStatus, setAuthStatus] = useState<"checking" | "ready">(
    "checking"
  );
  const [selectedSku, setSelectedSku] = useState("");
  const [productRefreshKey, setProductRefreshKey] = useState(0);
  const [productStockUpdate, setProductStockUpdate] =
    useState<ProductStockUpdate | null>(null);
  const [followUpOverrides, setFollowUpOverrides] = useState<FollowUpOverrides>(
    {}
  );
  const [vendorEmailSentUpdate, setVendorEmailSentUpdate] =
    useState<VendorEmailSentUpdate | null>(null);

  useEffect(() => {
    const handleHashChange = () => setRoute(parseRoute());

    window.addEventListener("hashchange", handleHashChange);

    if (!window.location.hash) {
      setHashRoute("products");
    }

    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    let ignore = false;

    async function loadSession() {
      try {
        const session = await getCurrentUser();

        if (!ignore) {
          setAuthUser(session.user);
        }
      } catch (err) {
        if (!ignore) {
          console.error("Unable to check the current session.", err);
          setAuthUser(null);
        }
      } finally {
        if (!ignore) {
          setAuthStatus("ready");
        }
      }
    }

    loadSession();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (authStatus !== "ready" || !authUser) {
      return;
    }

    let ignore = false;
    let currentVersion = "";
    let lastVersionCheckedAt = 0;

    async function checkVersion() {
      if (document.visibilityState !== "visible") {
        return;
      }

      try {
        lastVersionCheckedAt = Date.now();
        const result = await getAppVersion();
        const nextVersion = String(result.version || "").trim();

        if (!nextVersion || ignore) {
          return;
        }

        if (!currentVersion) {
          currentVersion = nextVersion;
          return;
        }

        if (nextVersion !== currentVersion) {
          window.location.reload();
        }
      } catch (err) {
        console.warn("Unable to check StockBridge version.", err);
      }
    }

    void checkVersion();
    const checkStaleVersion = () => {
      if (Date.now() - lastVersionCheckedAt >= appVersionFocusRefreshMinMs) {
        void checkVersion();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkStaleVersion();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", checkStaleVersion);

    return () => {
      ignore = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", checkStaleVersion);
    };
  }, [authStatus, authUser]);

  async function handleLogout() {
    try {
      await signOut();
    } finally {
      setAuthUser(null);
      setSelectedSku("");
    }
  }

  function handleCloseNotesRoute() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: "stockbridge:close-notes" }, "*");
      return;
    }

    window.close();

    window.setTimeout(() => {
      if (!window.closed) {
        setHashRoute("products");
      }
    }, 0);
  }

  function handleVendorEmailSent(emailedSku: string) {
    setVendorEmailSentUpdate({
      sku: emailedSku,
      token: Date.now()
    });
  }

  const handleProductStockChanged = useCallback((update: ProductStockUpdate) => {
    setProductStockUpdate(update);

    if (update.followUpDate === undefined) {
      return;
    }

    setFollowUpOverrides((current) => ({
      ...current,
      [update.sku.trim().toUpperCase()]: update.followUpDate || ""
    }));
  }, []);

  if (authStatus === "checking") {
    return (
      <main className="auth-page" aria-label="Loading StockBridge">
        <section className="auth-panel">
          <p className="eyebrow">StockBridge</p>
          <h1>Loading...</h1>
        </section>
      </main>
    );
  }

  if (!authUser) {
    return <LoginPage onLogin={setAuthUser} />;
  }

  if (route.page === "notes") {
    const isEmbeddedRoute = window.parent !== window;

    return (
      <main
        className={`notes-popup-page${isEmbeddedRoute ? " embedded" : ""}`}
        aria-label="StockBridge notes"
      >
        <NotesModal
          mode="route"
          currentUser={authUser}
          sku={route.sku}
          onClose={handleCloseNotesRoute}
          onFollowUpSaved={() => setProductRefreshKey((key) => key + 1)}
          onProductStockChanged={handleProductStockChanged}
          onVendorEmailSent={handleVendorEmailSent}
        />
      </main>
    );
  }

  return (
    <div className="container">
      <Sidebar
        currentPage={route.page}
        user={authUser}
        onNavigate={(page) => setHashRoute(page)}
        onLogout={handleLogout}
      />

      <div className="app-main-shell">
        <div className="app-topbar">
          <NotificationsMenu onOpenSku={setSelectedSku} />
        </div>

        <main className="main">
          {route.page === "products" && (
            <ProductsPage
              productStockUpdate={productStockUpdate}
              onOpenNotes={setSelectedSku}
            />
          )}

          {route.page === "vendors" && (
            <VendorsPage
              selectedVendor={route.vendor}
              onBackToVendors={() => setHashRoute("vendors")}
              onSelectVendor={(vendorId) => setHashRoute("vendors", vendorId)}
            />
          )}

          {route.page === "stock-check" && (
            <StockCheckPage
              productStockUpdate={productStockUpdate}
              followUpOverrides={followUpOverrides}
              vendorEmailSentUpdate={vendorEmailSentUpdate}
              refreshKey={productRefreshKey}
              onOpenNotes={setSelectedSku}
            />
          )}
        </main>
      </div>

      {selectedSku && (
        <NotesModal
          currentUser={authUser}
          sku={selectedSku}
          onClose={() => setSelectedSku("")}
          onFollowUpSaved={() => setProductRefreshKey((key) => key + 1)}
          onProductStockChanged={handleProductStockChanged}
          onVendorEmailSent={handleVendorEmailSent}
        />
      )}
    </div>
  );
}
