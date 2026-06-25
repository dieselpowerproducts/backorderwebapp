export type PageName = "products" | "stock-check" | "vendors" | "notifications";
export type RoutePageName = PageName | "notes";

export type AppRoute = {
  page: RoutePageName;
  sku: string;
  vendor: string;
};

export type AuthUser = {
  sub: string;
  email: string;
  name: string;
  picture: string;
  hd: string;
};

export type AuthSession = {
  user: AuthUser | null;
};

export type AppVersionStatus = {
  version: string;
};

export type AppNotification = {
  id: string;
  sku: string;
  noteId: string;
  notePreview: string;
  sender: {
    sub: string;
    email: string;
    name: string;
    picture: string;
  };
  created_at: string;
  read_at: string;
};

export type NotificationsResponse = {
  items: AppNotification[];
  unreadCount: number;
};

export type Backorder = {
  id: number;
  sku: string;
  vendor: string | null;
  notes?: string;
  status: string;
  updated_at: string;
};

export type BackordersResponse = {
  data: Backorder[];
  total: number;
};

export type ProductAvailability = "Available" | "Backorder" | "Built to Order";
export type ShopifyAvailabilityStatus =
  | "in_stock"
  | "out_of_stock"
  | "backordered"
  | "built_to_order";
export type StockCheckSort =
  | "yesterday"
  | "today"
  | "tomorrow"
  | "no-follow-up"
  | "all";

export type Product = {
  id: string;
  sku: string;
  name: string;
  qtyAvailable: number;
  availability: ProductAvailability;
  followUpDate: string;
  isKit: boolean;
  vendorEmailSent?: boolean;
};

export type VendorEmailSentUpdate = {
  sku: string;
  token: number;
};

export type ProductStockUpdate = {
  sku: string;
  qtyAvailable: number;
  availability: ProductAvailability;
  followUpDate?: string;
  followUpSaved?: boolean;
};

export type FollowUpOverrides = Record<string, string>;

export type ProductsResponse = {
  data: Product[];
  total: number;
  totalPages: number;
  isLastPage: boolean;
};

export type ShopifyAvailabilityResponse = {
  availability: ShopifyAvailabilityStatus;
  availabilityText: string;
  matchedSku: string;
  productId: string;
  productTitle: string;
  updatedInventoryPolicyCount: number;
};

export type Note = {
  id: string;
  sku: string;
  note: string;
  author: {
    sub: string;
    email: string;
    name: string;
    picture: string;
  };
  created_at: string;
  updated_at?: string;
};

export type ProductVendor = {
  id: string;
  vendorProductId: string;
  name: string;
  quantity: number;
  stockSource: "vendor" | "warehouse";
  stockType: string;
  canUpdateStock: boolean;
  builtToOrder: boolean;
  buildTime: string;
};

export type VendorContact = {
  id: string;
  vendorId: string;
  name: string;
  email: string;
  phone: string;
  label: string;
  isDefault?: boolean;
};

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

export type ProductKitChild = {
  sku: string;
  name: string;
  qtyRequired: number;
  qtyAvailable: number;
  availability: ProductAvailability;
  isKit: boolean;
};

export type ProductParentKit = {
  sku: string;
  name: string;
  qtyRequired: number;
  qtyAvailable: number;
  availability: ProductAvailability;
  followUpDate: string;
};

export type ProductDetails = {
  id: string;
  sku: string;
  name: string;
  qtyAvailable: number;
  availability: ProductAvailability;
  isKit: boolean;
  followUpDate: string;
  childProducts: ProductKitChild[];
  parentKits: ProductParentKit[];
  vendors: ProductVendor[];
};

export type NotesBootstrapResponse = {
  notes: Note[];
  productDetails: ProductDetails;
};

export type VendorSummary = {
  id: string;
  vendor: string;
};

export type VendorDetails = {
  id: string;
  vendor: string;
  builtToOrder: boolean;
  buildTime: string;
};

export type VendorAutoInventoryMode = "numerical" | "alphabetical";

export type VendorAutoInventorySettings = {
  vendorId: string;
  enabled: boolean;
  senderEmail: string;
  skuHeader: string;
  inventoryHeader: string;
  subtractiveColumn: string;
  skuExceptions: string[];
  inventoryMode: VendorAutoInventoryMode;
  inStockPhrases: string[];
  outOfStockPhrases: string[];
  lastImportedAt: string;
};

export type VendorsResponse = {
  data: VendorSummary[];
  total: number;
  totalPages: number;
  isLastPage: boolean;
};

export type VendorProduct = {
  id: string;
  vendorProductId: string;
  sku: string;
  name: string;
  qtyAvailable: number;
  availability: ProductAvailability;
};

export type VendorProductsResponse = {
  vendor: VendorDetails;
  data: VendorProduct[];
  total: number;
  totalPages: number;
  isLastPage: boolean;
};
