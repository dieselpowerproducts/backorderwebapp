import type {
  NotificationsResponse,
  AppVersionStatus,
  AuthSession,
  AuthUser,
  BackordersResponse,
  EmailTemplate,
  Note,
  NotesBootstrapResponse,
  ProductDetails,
  ProductsResponse,
  ShopifyAvailabilityResponse,
  ShopifyAvailabilityStatus,
  StockCheckSort,
  VendorAutoInventorySettings,
  VendorContact,
  VendorDetails,
  VendorProductsResponse,
  VendorsResponse
} from "../types";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;

    try {
      const body = (await response.json()) as { message?: string };

      if (body.message) {
        message = body.message;
      }
    } catch (err) {
      // Keep the status-based message when the response is not JSON.
    }

    throw new ApiError(message, response.status);
  }

  return response.json() as Promise<T>;
}

export async function getCurrentUser(): Promise<AuthSession> {
  try {
    return await request<AuthSession>("/auth/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { user: null };
    }

    throw err;
  }
}

export function signInWithGoogle(credential: string) {
  return request<{ user: AuthUser }>("/auth/google", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ credential })
  });
}

export function signOut() {
  return request<{ ok: boolean }>("/auth/logout", {
    method: "POST"
  });
}

export function getAppVersion() {
  return request<AppVersionStatus>("/status/version");
}

export function getUsers() {
  return request<AuthUser[]>("/users");
}

export function getNotifications({
  limit,
  sort,
  unreadOnly = false
}: {
  limit?: number;
  sort?: "newest";
  unreadOnly?: boolean;
} = {}) {
  const params = new URLSearchParams();

  if (limit) {
    params.set("limit", String(limit));
  }

  if (unreadOnly) {
    params.set("unreadOnly", "1");
  }

  if (sort) {
    params.set("sort", sort);
  }

  const query = params.toString();

  return request<NotificationsResponse>(
    query ? `/notifications?${query}` : "/notifications"
  );
}

export function markNotificationRead(id: string) {
  return request<{ updated: number }>(
    `/notifications/${encodeURIComponent(id)}/read`,
    {
      method: "POST"
    }
  );
}

export function getBackorders({
  page,
  limit,
  search
}: {
  page: number;
  limit: number;
  search: string;
}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    search
  });

  return request<BackordersResponse>(`/backorders?${params.toString()}`);
}

export function getProducts({
  page,
  limit,
  search
}: {
  page: number;
  limit: number;
  search: string;
}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    search
  });

  return request<ProductsResponse>(`/products?${params.toString()}`);
}

export function getStockCheckProducts({
  page,
  limit,
  search,
  sort,
  referenceDate,
  bypassCache = false
}: {
  page: number;
  limit: number;
  search: string;
  sort: StockCheckSort;
  referenceDate: string;
  bypassCache?: boolean;
}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    search,
    sort,
    referenceDate
  });

  if (bypassCache) {
    params.set("bypassCache", "1");
  }

  return request<ProductsResponse>(`/products/stock-check?${params.toString()}`);
}

export function getProductDetails(sku: string) {
  const params = new URLSearchParams({
    sku
  });

  return request<ProductDetails>(`/products/details?${params.toString()}`);
}

export function refreshProductDetails(
  sku: string,
  options: { includeWarehouse?: boolean } = {}
) {
  const body: { sku: string; includeWarehouse?: boolean } = { sku };

  if (typeof options.includeWarehouse === "boolean") {
    body.includeWarehouse = options.includeWarehouse;
  }

  return request<ProductDetails>("/products/details/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export function updateProductFollowUp({
  sku,
  followUpDate
}: {
  sku: string;
  followUpDate: string;
}) {
  return request<{ sku: string; followUpDate: string }>("/products/follow-up", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sku, followUpDate })
  });
}

export function updateProductVendorStock({
  sku,
  vendorId,
  vendorProductId,
  enabled
}: {
  sku: string;
  vendorId: string;
  vendorProductId: string;
  enabled: boolean;
}) {
  return request<{
    sku: string;
    vendorId: string;
    vendorProductId: string;
    quantity: number;
    enabled: boolean;
  }>("/products/vendor-stock", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sku, vendorId, vendorProductId, enabled })
  });
}

export function assignProductVendor({
  sku,
  vendorId
}: {
  sku: string;
  vendorId: string;
}) {
  return request<ProductDetails>("/products/vendors", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sku, vendorId })
  });
}

export function updateShopifyProductAvailability({
  availability,
  followUpDate,
  sku
}: {
  availability: ShopifyAvailabilityStatus;
  followUpDate: string;
  sku: string;
}) {
  return request<ShopifyAvailabilityResponse>("/shopify/products/availability", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ availability, followUpDate, sku })
  });
}

export function getVendorContacts(vendorId: string) {
  return request<VendorContact[]>(
    `/vendors/${encodeURIComponent(vendorId)}/contacts`
  );
}

export function setVendorDefaultContact({
  vendorId,
  contactId
}: {
  vendorId: string;
  contactId: string;
}) {
  return request<VendorContact>(
    `/vendors/${encodeURIComponent(vendorId)}/default-contact`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ contactId })
    }
  );
}

export function getEmailTemplates() {
  return request<EmailTemplate[]>("/email/templates");
}

export function saveEmailTemplate({
  name,
  subject,
  body
}: {
  name: string;
  subject: string;
  body: string;
}) {
  return request<EmailTemplate>("/email/templates", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, subject, body })
  });
}

export function sendVendorStockCheckEmail({
  sku,
  vendorId,
  vendorName,
  to,
  subject,
  body
}: {
  sku: string;
  vendorId: string;
  vendorName: string;
  to: string;
  subject: string;
  body: string;
}) {
  return request<{ messageId: string; accepted: string[]; sku: string }>(
    "/email/vendor-stock-check",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sku, vendorId, vendorName, to, subject, body })
    }
  );
}

export function importBackorders(formData: FormData) {
  return request<{ message: string; imported: number }>("/import", {
    method: "POST",
    body: formData
  });
}

export function getNotes(sku: string) {
  return request<Note[]>(`/notes/${encodeURIComponent(sku)}`);
}

export function getNotesBootstrap(sku: string) {
  return request<NotesBootstrapResponse>(
    `/notes/${encodeURIComponent(sku)}/bootstrap`
  );
}

export function createNote({ sku, note }: { sku: string; note: string }) {
  return request<Note>("/notes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sku, note })
  });
}

export function deleteNote(id: string) {
  return request<{ deleted: number }>(`/notes/${id}`, {
    method: "DELETE"
  });
}

export function updateNote(id: string, note: string) {
  return request<{ updated: number }>(`/notes/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ note })
  });
}

export function updateStatus(id: number, status: string) {
  return request<{ updated: number }>(`/status/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ status })
  });
}

export function getVendors({
  page,
  limit,
  search
}: {
  page: number;
  limit: number;
  search: string;
}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    search
  });

  return request<VendorsResponse>(`/vendors?${params.toString()}`);
}

export function getVendorProducts({
  vendorId,
  page,
  limit,
  search
}: {
  vendorId: string;
  page: number;
  limit: number;
  search: string;
}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    search
  });

  return request<VendorProductsResponse>(
    `/vendors/${encodeURIComponent(vendorId)}/products?${params.toString()}`
  );
}

export function updateVendorSettings({
  vendorId,
  builtToOrder,
  buildTime
}: {
  vendorId: string;
  builtToOrder: boolean;
  buildTime: string;
}) {
  return request<VendorDetails>(`/vendors/${encodeURIComponent(vendorId)}/settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ builtToOrder, buildTime })
  });
}

export function getVendorAutoInventorySettings(vendorId: string) {
  return request<VendorAutoInventorySettings>(
    `/vendors/${encodeURIComponent(vendorId)}/auto-inventory`
  );
}

export function updateVendorAutoInventorySettings({
  vendorId,
  settings
}: {
  vendorId: string;
  settings: Omit<VendorAutoInventorySettings, "vendorId" | "lastImportedAt">;
}) {
  return request<VendorAutoInventorySettings>(
    `/vendors/${encodeURIComponent(vendorId)}/auto-inventory`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(settings)
    }
  );
}
