import {
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from "react";
import {
  assignProductVendor,
  createNote,
  deleteNote,
  getEmailTemplates,
  getNotesBootstrap,
  getProductDetails,
  getUsers,
  getNotes,
  getVendorContacts,
  getVendors,
  refreshProductDetails,
  saveEmailTemplate,
  sendVendorStockCheckEmail,
  setVendorDefaultContact,
  updateShopifyProductAvailability,
  updateProductFollowUp,
  updateProductVendorStock,
  updateNote
} from "../../services/api";
import { getMentionSeedUsers } from "../../data/mentionSeed";
import type {
  AuthUser,
  EmailTemplate,
  Note,
  ProductDetails,
  ProductKitChild,
  ProductParentKit,
  ProductStockUpdate,
  ShopifyAvailabilityStatus,
  VendorContact,
  VendorSummary,
  ProductVendor
} from "../../types";

type NotesModalProps = {
  closeLabel?: string;
  currentUser?: AuthUser | null;
  mode?: "modal" | "route";
  sku: string;
  onClose: () => void;
  onFollowUpSaved: () => void;
  onProductStockChanged?: (update: ProductStockUpdate) => void;
  onVendorEmailSent?: (sku: string) => void;
};

type ActiveMention = {
  start: number;
  end: number;
  query: string;
};

type EmailComposerState = {
  vendor: ProductVendor;
  contacts: VendorContact[];
  selectedContactEmail: string;
  selectedTemplateId: string;
  isNewTemplate: boolean;
  subject: string;
  body: string;
};

const newTemplateValue = "__new_template__";
const shopifyAvailabilityOptions: Array<{
  label: string;
  status: ShopifyAvailabilityStatus;
}> = [
  { label: "In Stock", status: "in_stock" },
  { label: "Out of Stock", status: "out_of_stock" },
  { label: "Backordered", status: "backordered" },
  { label: "Built to Order", status: "built_to_order" }
];
const shopifyAvailabilitySyncDelayMs = 30_000;

function formatFollowUpDate(value: string) {
  if (!value) {
    return "";
  }

  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) {
    return value;
  }

  return new Date(year, month - 1, day).toLocaleDateString();
}

function getValidDate(value: string) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function isSameDate(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatNoteDate(value: string) {
  const date = getValidDate(value);

  if (!date) {
    return "";
  }

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (isSameDate(date, today)) {
    return "Today";
  }

  if (isSameDate(date, yesterday)) {
    return "Yesterday";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatNoteTime(value: string) {
  const date = getValidDate(value);

  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "SB";
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function canManageNote(note: Note, currentUser: AuthUser | null) {
  if (!currentUser) {
    return false;
  }

  const noteAuthorSub = String(note.author?.sub || "").trim();
  const noteAuthorEmail = String(note.author?.email || "")
    .trim()
    .toLowerCase();
  const currentUserSub = String(currentUser.sub || "").trim();
  const currentUserEmail = String(currentUser.email || "")
    .trim()
    .toLowerCase();

  if (noteAuthorSub && currentUserSub) {
    return noteAuthorSub === currentUserSub;
  }

  if (noteAuthorEmail && currentUserEmail) {
    return noteAuthorEmail === currentUserEmail;
  }

  return false;
}

function applyVendorQuantityUpdates(
  vendors: ProductVendor[],
  quantitiesByVendorProductId: Map<string, number>
) {
  return vendors.map((vendor) =>
    vendor.stockSource === "vendor" &&
    quantitiesByVendorProductId.has(vendor.vendorProductId)
      ? {
          ...vendor,
          quantity: quantitiesByVendorProductId.get(vendor.vendorProductId) || 0
        }
      : vendor
  );
}

function canUpdateVendorStock(vendor: ProductVendor) {
  return vendor.stockSource === "vendor" && vendor.canUpdateStock;
}

function formatStockQuantity(value: number) {
  const quantity = Number(value || 0);

  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2
  }).format(Number.isFinite(quantity) ? Math.max(quantity, 0) : 0);
}

function getUnavailableAvailability(vendors: ProductVendor[]) {
  return vendors.some((vendor) => vendor.builtToOrder)
    ? "Built to Order"
    : "Backorder";
}

function getProductStockUpdate(
  productDetails: ProductDetails,
  vendors: ProductVendor[]
): ProductStockUpdate {
  if (productDetails.isKit) {
    return {
      sku: productDetails.sku,
      qtyAvailable: productDetails.qtyAvailable,
      availability: productDetails.availability,
      followUpDate: productDetails.followUpDate
    };
  }

  const qtyAvailable = vendors.reduce(
    (total, vendor) => total + Math.max(Number(vendor.quantity || 0), 0),
    0
  );

  return {
    sku: productDetails.sku,
    qtyAvailable,
    availability:
      qtyAvailable > 0 ? "Available" : getUnavailableAvailability(vendors),
    followUpDate: productDetails.followUpDate
  };
}

function getProductDetailsStockUpdate(
  productDetails: ProductDetails
): ProductStockUpdate {
  return {
    sku: productDetails.sku,
    qtyAvailable: productDetails.qtyAvailable,
    availability: productDetails.availability,
    followUpDate: productDetails.followUpDate
  };
}

function formatKitQuantityLabel(childProduct: ProductKitChild) {
  return childProduct.qtyRequired === 1
    ? "1 required"
    : `${childProduct.qtyRequired} required`;
}

function formatParentKitQuantityLabel(parentKit: ProductParentKit) {
  return parentKit.qtyRequired === 1
    ? "Uses 1"
    : `Uses ${parentKit.qtyRequired}`;
}

function getVendorDrivenAvailability(vendors: ProductVendor[]) {
  const qtyAvailable = vendors.reduce(
    (total, vendor) => total + Math.max(Number(vendor.quantity || 0), 0),
    0
  );

  return {
    qtyAvailable,
    availability:
      qtyAvailable > 0 ? "Available" : getUnavailableAvailability(vendors)
  } as const;
}

function getShopifyAvailabilityStatus(
  productDetails: ProductDetails,
  currentAvailability: ShopifyAvailabilityStatus | "" = ""
): ShopifyAvailabilityStatus {
  if (productDetails.qtyAvailable > 0) {
    return "in_stock";
  }

  if (
    currentAvailability === "out_of_stock" ||
    currentAvailability === "built_to_order"
  ) {
    return currentAvailability;
  }

  if (productDetails.availability === "Built to Order") {
    return "built_to_order";
  }

  return "backordered";
}

function getShopifyAvailabilityButtonClass(
  status: ShopifyAvailabilityStatus,
  activeStatus: ShopifyAvailabilityStatus | ""
) {
  const statusClass = status.replace(/_/g, "-");

  return [
    "shopify-availability-button",
    `availability-${statusClass}`,
    status === activeStatus ? "active" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeMentionQuery(value: string) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function compactMentionValue(value: string) {
  return normalizeMentionQuery(value).replace(/[^a-z0-9]/g, "");
}

function getActiveMention(value: string, caretIndex: number): ActiveMention | null {
  if (caretIndex < 0) {
    return null;
  }

  const beforeCaret = value.slice(0, caretIndex);
  const atIndex = beforeCaret.lastIndexOf("@");

  if (atIndex === -1) {
    return null;
  }

  if (atIndex > 0 && !/\s/.test(beforeCaret[atIndex - 1])) {
    return null;
  }

  const query = beforeCaret.slice(atIndex + 1);

  if (
    query.startsWith(" ") ||
    query.endsWith(" ") ||
    query.includes("@") ||
    /[\n\r,:;!?()[\]{}<>]/.test(query) ||
    !/^[a-z0-9._ -]*$/i.test(query)
  ) {
    return null;
  }

  return {
    start: atIndex,
    end: caretIndex,
    query
  };
}

function getMentionSuggestions(
  users: AuthUser[],
  query: string,
  currentUserSub = "",
  currentUserEmail = ""
) {
  const safeQuery = normalizeMentionQuery(query);
  const compactQuery = compactMentionValue(query);
  const normalizedCurrentUserEmail = String(currentUserEmail || "")
    .trim()
    .toLowerCase();

  return users
    .filter(
      (user) =>
        user.sub &&
        user.sub !== currentUserSub &&
        String(user.email || "").trim().toLowerCase() !== normalizedCurrentUserEmail
    )
    .filter((user) => {
      if (!safeQuery && !compactQuery) {
        return true;
      }

      const emailLocal = String(user.email || "")
        .toLowerCase()
        .split("@")[0];
      const values = [
        normalizeMentionQuery(user.name),
        normalizeMentionQuery(user.email),
        normalizeMentionQuery(emailLocal),
        compactMentionValue(user.name),
        compactMentionValue(emailLocal)
      ].filter(Boolean);

      return values.some(
        (value) =>
          (safeQuery && value.includes(safeQuery)) ||
          (compactQuery && value.includes(compactQuery))
      );
    })
    .slice(0, 6);
}

function renderTemplateText(value: string, sku: string) {
  return String(value || "").replace(/\{SKU\}/g, sku);
}

function formatContactLabel(contact: VendorContact) {
  const name = contact.name || contact.label || contact.email;

  return name && name !== contact.email ? `${name} <${contact.email}>` : contact.email;
}

export function NotesModal({
  closeLabel = "Close",
  currentUser = null,
  mode = "modal",
  sku,
  onClose,
  onFollowUpSaved,
  onProductStockChanged,
  onVendorEmailSent
}: NotesModalProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [productDetails, setProductDetails] = useState<ProductDetails | null>(
    null
  );
  const [newNote, setNewNote] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [followUpNoEta, setFollowUpNoEta] = useState(false);
  const [notesError, setNotesError] = useState("");
  const [detailsError, setDetailsError] = useState("");
  const [mentionUsers, setMentionUsers] = useState<AuthUser[]>([]);
  const [isMentionUsersLoading, setIsMentionUsersLoading] = useState(false);
  const [isFollowUpPickerOpen, setIsFollowUpPickerOpen] = useState(false);
  const [isFollowUpSaving, setIsFollowUpSaving] = useState(false);
  const [isProductDetailsLoading, setIsProductDetailsLoading] = useState(false);
  const [isProductRefreshing, setIsProductRefreshing] = useState(false);
  const [pendingVendorStock, setPendingVendorStock] = useState<
    Record<string, boolean>
  >({});
  const [isBulkVendorStockSaving, setIsBulkVendorStockSaving] = useState(false);
  const [isKitModalOpen, setIsKitModalOpen] = useState(false);
  const [isParentKitsModalOpen, setIsParentKitsModalOpen] = useState(false);
  const [selectedChildSku, setSelectedChildSku] = useState("");
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [emailComposer, setEmailComposer] = useState<EmailComposerState | null>(
    null
  );
  const [isEmailTemplatesLoading, setIsEmailTemplatesLoading] = useState(false);
  const [isVendorContactsLoading, setIsVendorContactsLoading] = useState(false);
  const [isEmailSending, setIsEmailSending] = useState(false);
  const [isDefaultContactSaving, setIsDefaultContactSaving] = useState(false);
  const [isVendorSearchOpen, setIsVendorSearchOpen] = useState(false);
  const [vendorSearchInput, setVendorSearchInput] = useState("");
  const [vendorSearchResults, setVendorSearchResults] = useState<VendorSummary[]>(
    []
  );
  const [isVendorSearchLoading, setIsVendorSearchLoading] = useState(false);
  const [isVendorAssigning, setIsVendorAssigning] = useState(false);
  const [vendorAssignStatus, setVendorAssignStatus] = useState("");
  const [isShopifyAvailabilitySaving, setIsShopifyAvailabilitySaving] =
    useState(false);
  const [shopifyAvailabilityStatus, setShopifyAvailabilityStatus] =
    useState("");
  const [
    currentShopifyAvailability,
    setCurrentShopifyAvailability
  ] = useState<ShopifyAvailabilityStatus | "">("");
  const [isBuiltToOrderLeadTimeOpen, setIsBuiltToOrderLeadTimeOpen] =
    useState(false);
  const [builtToOrderLeadTime, setBuiltToOrderLeadTime] = useState("");
  const [emailError, setEmailError] = useState("");
  const [emailStatus, setEmailStatus] = useState("");
  const [isTemplateNameModalOpen, setIsTemplateNameModalOpen] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [isTemplateSaving, setIsTemplateSaving] = useState(false);
  const followUpInputRef = useRef<HTMLInputElement | null>(null);
  const notesListRef = useRef<HTMLDivElement | null>(null);
  const noteInputRef = useRef<HTMLInputElement | null>(null);
  const mentionUsersLoadedRef = useRef(false);
  const mentionUsersLoadingRef = useRef(false);
  const pendingShopifySyncTimerRef = useRef<number | null>(null);
  const pendingShopifySyncDetailsRef = useRef<ProductDetails | null>(null);
  const pendingShopifySyncAvailabilityRef =
    useRef<ShopifyAvailabilityStatus | null>(null);
  const pendingShopifySyncTokenRef = useRef(0);
  const vendorAddResultsId = useId();

  const loadNotes = useCallback(async () => {
    setNotesError("");

    try {
      const result = await getNotes(sku);
      setNotes(result);
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : "Unable to load notes.");
    }
  }, [sku]);

  const loadProductDetails = useCallback(async () => {
    setDetailsError("");
    setIsProductDetailsLoading(true);

    try {
      const result = await getProductDetails(sku);
      setProductDetails(result);
      setFollowUpDate(result.followUpDate || "");
      setFollowUpNoEta(Boolean(result.followUpNoEta));
      setCurrentShopifyAvailability(result.shopifyAvailabilityStatus || "");
      onProductStockChanged?.(getProductDetailsStockUpdate(result));
    } catch (err) {
      setDetailsError(
        err instanceof Error ? err.message : "Unable to load product vendors."
      );
      setProductDetails(null);
      setFollowUpDate("");
      setFollowUpNoEta(false);
      setCurrentShopifyAvailability("");
    } finally {
      setIsProductDetailsLoading(false);
    }
  }, [onProductStockChanged, sku]);

  const loadNotesBootstrap = useCallback(async () => {
    setNotesError("");
    setDetailsError("");
    setIsProductDetailsLoading(true);

    try {
      const result = await getNotesBootstrap(sku);
      setNotes(result.notes);
      setProductDetails(result.productDetails);
      setFollowUpDate(result.productDetails.followUpDate || "");
      setFollowUpNoEta(Boolean(result.productDetails.followUpNoEta));
      setCurrentShopifyAvailability(
        result.productDetails.shopifyAvailabilityStatus || ""
      );
      onProductStockChanged?.(getProductDetailsStockUpdate(result.productDetails));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to load product notes.";
      setNotesError(message);
      setDetailsError(message);
      setProductDetails(null);
      setFollowUpDate("");
      setFollowUpNoEta(false);
      setCurrentShopifyAvailability("");
    } finally {
      setIsProductDetailsLoading(false);
    }
  }, [onProductStockChanged, sku]);

  const loadMentionUsers = useCallback(async () => {
    if (mentionUsersLoadedRef.current || mentionUsersLoadingRef.current) {
      return;
    }

    mentionUsersLoadingRef.current = true;
    setIsMentionUsersLoading(true);

    try {
      const result = await getUsers();
      setMentionUsers(result.length > 0 ? result : getMentionSeedUsers());
      mentionUsersLoadedRef.current = true;
    } catch {
      setMentionUsers(getMentionSeedUsers());
      mentionUsersLoadedRef.current = true;
    } finally {
      mentionUsersLoadingRef.current = false;
      setIsMentionUsersLoading(false);
    }
  }, []);

  const loadEmailTemplates = useCallback(async () => {
    setIsEmailTemplatesLoading(true);

    try {
      const result = await getEmailTemplates();
      setEmailTemplates(result);
    } catch (err) {
      setEmailError(
        err instanceof Error ? err.message : "Unable to load email templets."
      );
    } finally {
      setIsEmailTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotesBootstrap();
  }, [loadNotesBootstrap]);

  useEffect(() => {
    if (!activeMention) {
      return;
    }

    void loadMentionUsers();
  }, [activeMention, loadMentionUsers]);

  useEffect(() => {
    setIsKitModalOpen(false);
    setIsParentKitsModalOpen(false);
    setSelectedChildSku("");
    setActiveMention(null);
    setSelectedMentionIndex(0);
    setEmailComposer(null);
    setEmailError("");
    setEmailStatus("");
    setIsDefaultContactSaving(false);
    setIsTemplateNameModalOpen(false);
    setTemplateNameDraft("");
    setIsVendorSearchOpen(false);
    setVendorSearchInput("");
    setVendorSearchResults([]);
    setIsVendorSearchLoading(false);
    setIsVendorAssigning(false);
    setVendorAssignStatus("");
    setFollowUpNoEta(false);
    cancelScheduledShopifyAvailabilitySync();
    setIsShopifyAvailabilitySaving(false);
    setShopifyAvailabilityStatus("");
    setCurrentShopifyAvailability("");
    setIsBuiltToOrderLeadTimeOpen(false);
    setBuiltToOrderLeadTime("");
  }, [sku]);

  useEffect(() => {
    return () => {
      cancelScheduledShopifyAvailabilitySync();
    };
  }, [sku]);

  useEffect(() => {
    const search = vendorSearchInput.trim();

    if (!isVendorSearchOpen || !productDetails || !search) {
      setVendorSearchResults([]);
      setIsVendorSearchLoading(false);
      return;
    }

    let ignore = false;
    const timeout = window.setTimeout(
      async () => {
        setIsVendorSearchLoading(true);

        try {
          const result = await getVendors({
            page: 1,
            limit: 8,
            search
          });
          const assignedVendorIds = new Set(
            (productDetails.vendors || [])
              .filter((vendor) => vendor.stockSource === "vendor")
              .map((vendor) => vendor.id)
          );

          if (!ignore) {
            setVendorSearchResults(
              result.data.filter((vendor) => !assignedVendorIds.has(vendor.id))
            );
          }
        } catch (err) {
          if (!ignore) {
            setDetailsError(
              err instanceof Error
                ? err.message
                : "Unable to load vendors for assignment."
            );
          }
        } finally {
          if (!ignore) {
            setIsVendorSearchLoading(false);
          }
        }
      },
      search ? 250 : 0
    );

    return () => {
      ignore = true;
      window.clearTimeout(timeout);
    };
  }, [isVendorSearchOpen, productDetails, vendorSearchInput]);

  useEffect(() => {
    if (!isFollowUpPickerOpen) {
      return;
    }

    followUpInputRef.current?.focus();
    try {
      followUpInputRef.current?.showPicker?.();
    } catch {
      // Some browsers only allow showPicker during the direct click event.
    }
  }, [isFollowUpPickerOpen]);

  useEffect(() => {
    if (notes.length === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (notesListRef.current) {
        notesListRef.current.scrollTop = notesListRef.current.scrollHeight;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [notes]);

  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [activeMention?.query]);

  function updateMentionState(value: string, caretIndex: number) {
    setActiveMention(getActiveMention(value, caretIndex));
  }

  function handleNoteInputChange(value: string, caretIndex: number) {
    setNewNote(value);
    updateMentionState(value, caretIndex);
  }

  function insertMention(user: AuthUser) {
    if (!activeMention) {
      return;
    }

    const mentionLabel = `@${user.name}`;
    const nextValue = `${newNote.slice(0, activeMention.start)}${mentionLabel} ${newNote.slice(activeMention.end)}`;
    const nextCaretIndex = activeMention.start + mentionLabel.length + 1;

    setNewNote(nextValue);
    setActiveMention(null);
    setSelectedMentionIndex(0);

    window.requestAnimationFrame(() => {
      noteInputRef.current?.focus();
      noteInputRef.current?.setSelectionRange(nextCaretIndex, nextCaretIndex);
    });
  }

  async function handleAddNote() {
    const note = newNote.trim();

    if (!note) {
      return;
    }

    const createdNote = await createNote({ sku, note });
    setNewNote("");
    setActiveMention(null);
    setSelectedMentionIndex(0);
    setNotes((current) => [...current, createdNote]);
  }

  async function handleDeleteNote(id: string) {
    setNotesError("");

    try {
      await deleteNote(id);
      loadNotes();
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : "Unable to delete note.");
    }
  }

  async function handleEditNote(note: Note) {
    const nextNote = window.prompt("Edit note:", note.note);

    if (nextNote === null) {
      return;
    }

    setNotesError("");

    try {
      await updateNote(note.id, nextNote);
      loadNotes();
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : "Unable to update note.");
    }
  }

  function getShopifyFollowUpDate(
    nextProductDetails: ProductDetails,
    availability: ShopifyAvailabilityStatus
  ) {
    if (availability === "backordered" && nextProductDetails.followUpNoEta) {
      return "";
    }

    return nextProductDetails.followUpDate || "";
  }

  function getShopifyBuildToOrderMessage(
    nextProductDetails: ProductDetails,
    availability: ShopifyAvailabilityStatus
  ) {
    if (availability !== "built_to_order") {
      return "";
    }

    const builtToOrderProductVendor = nextProductDetails.vendors.find(
      (vendor) => vendor.stockSource === "vendor" && vendor.builtToOrder
    );

    const buildToOrderTime = String(
      builtToOrderProductVendor?.buildTime || builtToOrderLeadTime || ""
    ).trim();

    return buildToOrderTime
      ? `This product will ship in ${buildToOrderTime} from the manufacturer`
      : "";
  }

  async function syncShopifyAvailabilityFromDetails(
    nextProductDetails: ProductDetails,
    options: {
      availability?: ShopifyAvailabilityStatus;
      quiet?: boolean;
    } = {}
  ) {
    const availability =
      options.availability ||
      getShopifyAvailabilityStatus(
        nextProductDetails,
        currentShopifyAvailability || nextProductDetails.shopifyAvailabilityStatus || ""
      );

    try {
      const result = await updateShopifyProductAvailability({
        sku: nextProductDetails.sku,
        availability,
        buildToOrderMessage: getShopifyBuildToOrderMessage(
          nextProductDetails,
          availability
        ),
        followUpDate: getShopifyFollowUpDate(nextProductDetails, availability),
        productName: nextProductDetails.name || ""
      });

      setDisplayedShopifyAvailability(result.availability);

      if (!options.quiet) {
        setShopifyAvailabilityStatus(`Shopify set to ${result.availabilityText}.`);
      }
    } catch (err) {
      setDetailsError(
        err instanceof Error
          ? `StockBridge saved, but Shopify availability could not be updated: ${err.message}`
          : "StockBridge saved, but Shopify availability could not be updated."
      );
    }
  }

  function setDisplayedShopifyAvailability(
    availability: ShopifyAvailabilityStatus
  ) {
    setCurrentShopifyAvailability(availability);
    setProductDetails((current) =>
      current
        ? {
            ...current,
            shopifyAvailabilityStatus: availability
          }
        : current
    );
  }

  function cancelScheduledShopifyAvailabilitySync() {
    pendingShopifySyncTokenRef.current += 1;
    pendingShopifySyncDetailsRef.current = null;
    pendingShopifySyncAvailabilityRef.current = null;

    if (pendingShopifySyncTimerRef.current !== null) {
      window.clearTimeout(pendingShopifySyncTimerRef.current);
      pendingShopifySyncTimerRef.current = null;
    }
  }

  function scheduleShopifyAvailabilitySync(nextProductDetails: ProductDetails) {
    cancelScheduledShopifyAvailabilitySync();

    const syncToken = pendingShopifySyncTokenRef.current + 1;
    const availability = getShopifyAvailabilityStatus(
      nextProductDetails,
      currentShopifyAvailability || nextProductDetails.shopifyAvailabilityStatus || ""
    );

    pendingShopifySyncTokenRef.current = syncToken;
    pendingShopifySyncDetailsRef.current = nextProductDetails;
    pendingShopifySyncAvailabilityRef.current = availability;
    setShopifyAvailabilityStatus("");
    setDisplayedShopifyAvailability(availability);

    pendingShopifySyncTimerRef.current = window.setTimeout(() => {
      if (syncToken !== pendingShopifySyncTokenRef.current) {
        return;
      }

      const scheduledProductDetails = pendingShopifySyncDetailsRef.current;
      const scheduledAvailability = pendingShopifySyncAvailabilityRef.current;
      pendingShopifySyncTimerRef.current = null;
      pendingShopifySyncDetailsRef.current = null;
      pendingShopifySyncAvailabilityRef.current = null;

      if (scheduledProductDetails && scheduledAvailability) {
        void syncShopifyAvailabilityFromDetails(scheduledProductDetails, {
          availability: scheduledAvailability,
          quiet: false
        });
      }
    }, shopifyAvailabilitySyncDelayMs);
  }

  async function handleFollowUpDateChange(value: string) {
    setFollowUpDate(value);
    setDetailsError("");
    setShopifyAvailabilityStatus("");
    setIsFollowUpSaving(true);

    try {
      const result = await updateProductFollowUp({
        sku,
        followUpDate: value,
        followUpNoEta
      });

      setFollowUpDate(result.followUpDate || "");
      setFollowUpNoEta(Boolean(result.followUpNoEta));
      setProductDetails((current) =>
        current
          ? {
              ...current,
              followUpDate: result.followUpDate || "",
              followUpNoEta: Boolean(result.followUpNoEta)
            }
          : current
      );
      if (productDetails) {
        const nextProductDetails = {
          ...productDetails,
          followUpDate: result.followUpDate || "",
          followUpNoEta: Boolean(result.followUpNoEta)
        };

        onProductStockChanged?.({
          ...getProductDetailsStockUpdate(nextProductDetails),
          followUpDate: result.followUpDate || "",
          followUpSaved: true
        });
        scheduleShopifyAvailabilitySync(nextProductDetails);
      }
      onFollowUpSaved();
    } catch (err) {
      setDetailsError(
        err instanceof Error ? err.message : "Unable to save follow-up date."
      );
    } finally {
      setIsFollowUpSaving(false);
    }
  }

  async function handleFollowUpNoEtaChange(checked: boolean) {
    setFollowUpNoEta(checked);
    setDetailsError("");
    setShopifyAvailabilityStatus("");
    setIsFollowUpSaving(true);

    try {
      const result = await updateProductFollowUp({
        sku,
        followUpDate,
        followUpNoEta: checked
      });

      setFollowUpDate(result.followUpDate || "");
      setFollowUpNoEta(Boolean(result.followUpNoEta));
      setProductDetails((current) =>
        current
          ? {
              ...current,
              followUpDate: result.followUpDate || "",
              followUpNoEta: Boolean(result.followUpNoEta)
            }
          : current
      );

      if (productDetails) {
        const nextProductDetails = {
          ...productDetails,
          followUpDate: result.followUpDate || "",
          followUpNoEta: Boolean(result.followUpNoEta)
        };

        scheduleShopifyAvailabilitySync(nextProductDetails);
      }

      onFollowUpSaved();
    } catch (err) {
      setFollowUpNoEta(!checked);
      setDetailsError(
        err instanceof Error ? err.message : "Unable to save No ETA."
      );
    } finally {
      setIsFollowUpSaving(false);
    }
  }

  async function handleVendorStockChange(
    vendor: ProductVendor,
    enabled: boolean
  ) {
    if (!canUpdateVendorStock(vendor)) {
      return;
    }

    const isCurrentlyEnabled = vendor.quantity > 0;

    if (isCurrentlyEnabled === enabled || pendingVendorStock[vendor.vendorProductId]) {
      return;
    }

    setDetailsError("");
    setPendingVendorStock((current) => ({
      ...current,
      [vendor.vendorProductId]: true
    }));

    try {
      const result = await updateProductVendorStock({
        sku,
        vendorId: vendor.id,
        vendorProductId: vendor.vendorProductId,
        enabled
      });
      const quantitiesByVendorProductId = new Map([
        [result.vendorProductId, result.quantity]
      ]);
      const updatedVendors = applyVendorQuantityUpdates(
        vendors,
        quantitiesByVendorProductId
      );
      const fallbackDetails = productDetails
        ? {
            ...productDetails,
            ...(!productDetails.isKit
              ? getVendorDrivenAvailability(updatedVendors)
              : {}),
            vendors: applyVendorQuantityUpdates(
              productDetails.vendors,
              quantitiesByVendorProductId
            )
          }
        : null;
      const fallbackStockUpdate = productDetails
        ? getProductStockUpdate(productDetails, updatedVendors)
        : null;

      const nextProductDetails = await refreshDetailsAfterStockChange(
        fallbackDetails,
        fallbackStockUpdate
      );

      if (nextProductDetails) {
        scheduleShopifyAvailabilitySync(nextProductDetails);
      }

      onFollowUpSaved();
    } catch (err) {
      setDetailsError(
        err instanceof Error ? err.message : "Unable to update vendor stock."
      );
    } finally {
      setPendingVendorStock((current) => {
        const next = { ...current };

        delete next[vendor.vendorProductId];

        return next;
      });
    }
  }

  async function handleRefreshProduct() {
    setDetailsError("");
    setIsProductRefreshing(true);

    try {
      const result = await refreshProductDetails(sku);
      setProductDetails(result);
      setFollowUpDate(result.followUpDate || "");
      setFollowUpNoEta(Boolean(result.followUpNoEta));
      setCurrentShopifyAvailability(result.shopifyAvailabilityStatus || "");
      onProductStockChanged?.(getProductDetailsStockUpdate(result));
      scheduleShopifyAvailabilitySync(result);
      onFollowUpSaved();
    } catch (err) {
      setDetailsError(
        err instanceof Error ? err.message : "Unable to refresh this product."
      );
    } finally {
      setIsProductRefreshing(false);
    }
  }

  async function handleAssignVendor(vendor: VendorSummary) {
    if (isVendorAssigning) {
      return;
    }

    setDetailsError("");
    setVendorAssignStatus("");
    setIsVendorAssigning(true);

    try {
      const result = await assignProductVendor({
        sku,
        vendorId: vendor.id
      });
      const assignedVendor = result.vendors.find(
        (productVendor) => productVendor.id === vendor.id
      );

      if (!assignedVendor) {
        throw new Error(
          "SKU Nexus did not return this vendor assignment after refresh."
        );
      }

      setProductDetails(result);
      setFollowUpDate(result.followUpDate || "");
      setFollowUpNoEta(Boolean(result.followUpNoEta));
      setCurrentShopifyAvailability(result.shopifyAvailabilityStatus || "");
      setVendorSearchInput("");
      setVendorSearchResults([]);
      setIsVendorSearchOpen(false);
      setVendorAssignStatus(`${vendor.vendor} assigned.`);
      onProductStockChanged?.(getProductDetailsStockUpdate(result));
      scheduleShopifyAvailabilitySync(result);
      onFollowUpSaved();
    } catch (err) {
      setVendorAssignStatus("");
      setDetailsError(
        err instanceof Error ? err.message : "Unable to assign this vendor."
      );
    } finally {
      setIsVendorAssigning(false);
    }
  }

  function updateEmailComposer(patch: Partial<EmailComposerState>) {
    setEmailComposer((current) => (current ? { ...current, ...patch } : current));
  }

  async function refreshDetailsAfterStockChange(
    fallbackDetails: ProductDetails | null,
    fallbackStockUpdate: ProductStockUpdate | null
  ): Promise<ProductDetails | null> {
    try {
      const refreshedDetails = await refreshProductDetails(sku, {
        includeWarehouse: false
      });

      setProductDetails(refreshedDetails);
      setFollowUpDate(refreshedDetails.followUpDate || "");
      setFollowUpNoEta(Boolean(refreshedDetails.followUpNoEta));
      setCurrentShopifyAvailability(
        refreshedDetails.shopifyAvailabilityStatus || currentShopifyAvailability
      );
      onProductStockChanged?.(getProductDetailsStockUpdate(refreshedDetails));
      return refreshedDetails;
    } catch (err) {
      if (fallbackDetails) {
        setProductDetails(fallbackDetails);
        setFollowUpNoEta(Boolean(fallbackDetails.followUpNoEta));
        setCurrentShopifyAvailability(
          fallbackDetails.shopifyAvailabilityStatus || currentShopifyAvailability
        );
      }

      if (fallbackStockUpdate) {
        onProductStockChanged?.(fallbackStockUpdate);
      }

      setDetailsError(
        err instanceof Error
          ? `Stock saved, but product availability could not be refreshed: ${err.message}`
          : "Stock saved, but product availability could not be refreshed."
      );
      return fallbackDetails;
    }
  }

  async function handleOpenEmailComposer(vendor: ProductVendor) {
    if (vendor.stockSource !== "vendor") {
      return;
    }

    setEmailError("");
    setEmailStatus("");
    setIsDefaultContactSaving(false);
    setIsTemplateNameModalOpen(false);
    setTemplateNameDraft("");
    setEmailComposer({
      vendor,
      contacts: [],
      selectedContactEmail: "",
      selectedTemplateId: "",
      isNewTemplate: false,
      subject: "",
      body: ""
    });
    void loadEmailTemplates();
    setIsVendorContactsLoading(true);

    try {
      const contacts = await getVendorContacts(vendor.id);
      const defaultContact = contacts.find((contact) => contact.isDefault);

      setEmailComposer((current) =>
        current?.vendor.vendorProductId === vendor.vendorProductId
          ? {
              ...current,
              contacts,
              selectedContactEmail: defaultContact?.email || contacts[0]?.email || ""
            }
          : current
      );

      if (contacts.length === 0) {
        setEmailError("No vendor contacts with email addresses were found.");
      }
    } catch (err) {
      setEmailError(
        err instanceof Error ? err.message : "Unable to load vendor contacts."
      );
    } finally {
      setIsVendorContactsLoading(false);
    }
  }

  function handleCloseEmailComposer() {
    setEmailComposer(null);
    setEmailError("");
    setEmailStatus("");
    setIsDefaultContactSaving(false);
    setIsTemplateNameModalOpen(false);
    setTemplateNameDraft("");
  }

  async function handleSetDefaultContact() {
    if (!emailComposer || isDefaultContactSaving) {
      return;
    }

    const selectedContact = emailComposer.contacts.find(
      (contact) => contact.email === emailComposer.selectedContactEmail
    );

    if (!selectedContact) {
      setEmailError("Choose a vendor contact before setting a default.");
      return;
    }

    setEmailError("");
    setEmailStatus("");
    setIsDefaultContactSaving(true);

    try {
      const defaultContact = await setVendorDefaultContact({
        vendorId: emailComposer.vendor.id,
        contactId: selectedContact.id
      });

      setEmailComposer((current) =>
        current?.vendor.vendorProductId === emailComposer.vendor.vendorProductId
          ? {
              ...current,
              contacts: current.contacts.map((contact) => ({
                ...contact,
                isDefault: contact.id === defaultContact.id
              })),
              selectedContactEmail: defaultContact.email
            }
          : current
      );
      setEmailStatus("Default contact saved.");
    } catch (err) {
      setEmailError(
        err instanceof Error ? err.message : "Unable to save default contact."
      );
    } finally {
      setIsDefaultContactSaving(false);
    }
  }

  function handleTemplateSelect(value: string) {
    if (value === newTemplateValue) {
      updateEmailComposer({
        selectedTemplateId: newTemplateValue,
        isNewTemplate: true,
        subject: "",
        body: ""
      });
      setEmailError("");
      setEmailStatus("");
      return;
    }

    const template = emailTemplates.find((item) => item.id === value);

    if (!template) {
      updateEmailComposer({
        selectedTemplateId: "",
        isNewTemplate: false,
        subject: "",
        body: ""
      });
      return;
    }

    updateEmailComposer({
      selectedTemplateId: template.id,
      isNewTemplate: false,
      subject: renderTemplateText(template.subject, sku),
      body: renderTemplateText(template.body, sku)
    });
    setEmailError("");
    setEmailStatus("");
  }

  async function handleSendVendorEmail() {
    if (!emailComposer || isEmailSending) {
      return;
    }

    const subject = renderTemplateText(emailComposer.subject, sku).trim();
    const body = renderTemplateText(emailComposer.body, sku).trim();

    if (!emailComposer.selectedContactEmail) {
      setEmailError("Choose a vendor contact before sending.");
      return;
    }

    if (!subject || !body) {
      setEmailError("Add a subject and message before sending.");
      return;
    }

    setEmailError("");
    setEmailStatus("");
    setIsEmailSending(true);

    try {
      await sendVendorStockCheckEmail({
        sku,
        vendorId: emailComposer.vendor.id,
        vendorName: emailComposer.vendor.name,
        to: emailComposer.selectedContactEmail,
        subject,
        body
      });
      setEmailStatus("Email sent.");
      onVendorEmailSent?.(sku);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Unable to send email.");
    } finally {
      setIsEmailSending(false);
    }
  }

  function handleRequestSaveTemplate() {
    if (!emailComposer) {
      return;
    }

    if (!emailComposer.subject.trim() || !emailComposer.body.trim()) {
      setEmailError("Add a subject and message before saving the templet.");
      return;
    }

    setEmailError("");
    setTemplateNameDraft("");
    setIsTemplateNameModalOpen(true);
  }

  async function handleSaveTemplateName() {
    if (!emailComposer || isTemplateSaving) {
      return;
    }

    const name = templateNameDraft.trim();

    if (!name) {
      setEmailError("Add a templet name before saving.");
      return;
    }

    setEmailError("");
    setIsTemplateSaving(true);

    try {
      const savedTemplate = await saveEmailTemplate({
        name,
        subject: emailComposer.subject,
        body: emailComposer.body
      });
      setEmailTemplates((current) =>
        [
          ...current.filter(
            (template) =>
              template.id !== savedTemplate.id &&
              template.name.toLowerCase() !== savedTemplate.name.toLowerCase()
          ),
          savedTemplate
        ].sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
        )
      );
      setEmailComposer((current) =>
        current
          ? {
              ...current,
              selectedTemplateId: savedTemplate.id,
              isNewTemplate: false,
              subject: renderTemplateText(savedTemplate.subject, sku),
              body: renderTemplateText(savedTemplate.body, sku)
            }
          : current
      );
      setIsTemplateNameModalOpen(false);
      setTemplateNameDraft("");
      setEmailStatus("Templet saved.");
    } catch (err) {
      setEmailError(
        err instanceof Error ? err.message : "Unable to save this templet."
      );
    } finally {
      setIsTemplateSaving(false);
    }
  }

  const title = productDetails?.name || "";
  const selectedVendorContact =
    emailComposer?.contacts.find(
      (contact) => contact.email === emailComposer.selectedContactEmail
    ) || null;
  const isSelectedContactDefault = Boolean(selectedVendorContact?.isDefault);
  const modalTitle = title && title !== sku ? `${sku} | ${title}` : sku;
  const vendors = productDetails?.vendors || [];
  const vendorSearchText = vendorSearchInput.trim();
  const childProducts = productDetails?.childProducts || [];
  const parentKits = productDetails?.parentKits || [];
  const editableVendors = vendors.filter(canUpdateVendorStock);
  const builtToOrderVendor = vendors.find(
    (vendor) => vendor.stockSource === "vendor" && vendor.builtToOrder
  );
  const builtToOrderLeadTimeValue =
    builtToOrderVendor?.buildTime || builtToOrderLeadTime;
  const canShowKits = Boolean(productDetails?.isKit && childProducts.length > 0);
  const canShowParentKits = parentKits.length > 0;
  const isRouteMode = mode === "route";
  const mentionSuggestions = activeMention
    ? getMentionSuggestions(
        mentionUsers,
        activeMention.query,
        currentUser?.sub || "",
        currentUser?.email || ""
      )
    : [];
  const isMentionMenuOpen = Boolean(activeMention);

  function handleCloseChildNotes() {
    setSelectedChildSku("");
    void loadProductDetails();
  }

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (!isRouteMode && event.target === event.currentTarget) {
      onClose();
    }
  }

  function handleKitBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      setIsKitModalOpen(false);
    }
  }

  function handleParentKitsBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      setIsParentKitsModalOpen(false);
    }
  }

  async function handleAllVendorStockChange(
    enabled: boolean,
    options: { syncShopify?: boolean } = {}
  ): Promise<ProductDetails | null> {
    const shouldSyncShopify = options.syncShopify !== false;
    const vendorsToUpdate = editableVendors.filter(
      (vendor) =>
        (vendor.quantity > 0) !== enabled &&
        !pendingVendorStock[vendor.vendorProductId]
    );

    if (vendorsToUpdate.length === 0 || isBulkVendorStockSaving) {
      return productDetails;
    }

    setDetailsError("");
    setIsBulkVendorStockSaving(true);
    setPendingVendorStock((current) => ({
      ...current,
      ...Object.fromEntries(
        vendorsToUpdate.map((vendor) => [vendor.vendorProductId, true])
      )
    }));

    try {
      const results = await Promise.allSettled(
        vendorsToUpdate.map((vendor) =>
          updateProductVendorStock({
            sku,
            vendorId: vendor.id,
            vendorProductId: vendor.vendorProductId,
            enabled
          })
        )
      );
      const savedResults = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      const quantitiesByVendorProductId = new Map(
        savedResults.map((result) => [result.vendorProductId, result.quantity])
      );

      if (savedResults.length > 0) {
        const updatedVendors = applyVendorQuantityUpdates(
          vendors,
          quantitiesByVendorProductId
        );
        const fallbackDetails = productDetails
          ? {
              ...productDetails,
              ...(!productDetails.isKit
                ? getVendorDrivenAvailability(updatedVendors)
                : {}),
              vendors: applyVendorQuantityUpdates(
                productDetails.vendors,
                quantitiesByVendorProductId
              )
            }
          : null;
        const fallbackStockUpdate = productDetails
          ? getProductStockUpdate(productDetails, updatedVendors)
          : null;

        const nextProductDetails = await refreshDetailsAfterStockChange(
          fallbackDetails,
          fallbackStockUpdate
        );

        if (nextProductDetails && shouldSyncShopify) {
          scheduleShopifyAvailabilitySync(nextProductDetails);
        }

        onFollowUpSaved();

        return nextProductDetails;
      }

      if (savedResults.length !== results.length) {
        setDetailsError("Unable to update every assigned vendor stock value.");
      }
    } catch (err) {
      setDetailsError(
        err instanceof Error ? err.message : "Unable to update vendor stock."
      );
    } finally {
      setIsBulkVendorStockSaving(false);
      setPendingVendorStock((current) => {
        const next = { ...current };

        for (const vendor of vendorsToUpdate) {
          delete next[vendor.vendorProductId];
        }

        return next;
      });
    }

    return productDetails;
  }

  async function handleShopifyAvailabilityChange(
    availability: ShopifyAvailabilityStatus
  ) {
    if (!productDetails || isShopifyAvailabilitySaving) {
      return;
    }

    const isBuiltToOrder = availability === "built_to_order";
    const hasBuiltToOrderVendor = vendors.some(
      (vendor) => vendor.stockSource === "vendor" && vendor.builtToOrder
    );

    if (isBuiltToOrder && !hasBuiltToOrderVendor) {
      setIsBuiltToOrderLeadTimeOpen(true);
    }

    cancelScheduledShopifyAvailabilitySync();
    setDetailsError("");
    setShopifyAvailabilityStatus("");
    setDisplayedShopifyAvailability(availability);
    setIsShopifyAvailabilitySaving(true);

    try {
      const shouldEnableStock = availability === "in_stock";
      const nextProductDetails =
        availability === "in_stock"
          ? await handleAllVendorStockChange(true, { syncShopify: false })
          : await handleAllVendorStockChange(false, { syncShopify: false });
      const detailsForShopify = nextProductDetails || productDetails;
      // Re-apply after stock changes because the product refresh can return the
      // last saved Shopify value before the new push completes.
      setDisplayedShopifyAvailability(availability);
      const result = await updateShopifyProductAvailability({
        sku,
        availability,
        buildToOrderMessage: getShopifyBuildToOrderMessage(
          detailsForShopify,
          availability
        ),
        followUpDate: getShopifyFollowUpDate(detailsForShopify, availability),
        productName: detailsForShopify.name || ""
      });

      setDisplayedShopifyAvailability(result.availability);
      setShopifyAvailabilityStatus(
        `Shopify set to ${result.availabilityText} on ${
          result.productTitle || result.matchedSku
        } for ${result.updatedMetafieldOwnerCount} variant${
          result.updatedMetafieldOwnerCount === 1 ? "" : "s"
        }${
          result.duplicateSkuMatchCount > 1
            ? ` (${result.duplicateSkuMatchCount} SKU matches found)`
            : ""
        }${
          availability === "out_of_stock"
            ? ` and ${result.updatedInventoryPolicyCount} variant${
                result.updatedInventoryPolicyCount === 1 ? "" : "s"
              } set to stop overselling`
            : ""
        }.`
      );

      if (shouldEnableStock && nextProductDetails) {
        onProductStockChanged?.(getProductDetailsStockUpdate(nextProductDetails));
      }
    } catch (err) {
      setDetailsError(
        err instanceof Error
          ? `Unable to update Shopify availability: ${err.message}`
          : "Unable to update Shopify availability."
      );
    } finally {
      setIsShopifyAvailabilitySaving(false);
    }
  }

  return (
    <div
      className={isRouteMode ? "notes-route-shell" : "modal"}
      role={isRouteMode ? "region" : "dialog"}
      aria-modal={isRouteMode ? undefined : true}
      aria-labelledby="modalTitle"
      onClick={handleBackdropClick}
    >
      <div className="modal-content notes-modal-content">
        <header className="notes-modal-header">
          <h2 id="modalTitle">{modalTitle}</h2>
          <button id="closeModalButton" type="button" onClick={onClose}>
            {closeLabel}
          </button>
        </header>

        {detailsError && (
          <p className="status-message error-message">{detailsError}</p>
        )}
        {notesError && <p className="status-message error-message">{notesError}</p>}

        <div className="notes-modal-grid">
          <aside className="assigned-vendors-panel" aria-labelledby="assignedVendorsHeading">
            <div className="assigned-vendors-heading">
              <h3 id="assignedVendorsHeading">Assigned vendors</h3>
            </div>

            <div className="shopify-availability-panel">
              <div
                className="shopify-availability-actions"
                role="group"
                aria-label="Shopify product availability"
              >
                {shopifyAvailabilityOptions.map((option) => (
                  <button
                    key={option.status}
                    type="button"
                    className={getShopifyAvailabilityButtonClass(
                      option.status,
                      currentShopifyAvailability
                    )}
                    aria-pressed={option.status === currentShopifyAvailability}
                    disabled={
                      !productDetails ||
                      isShopifyAvailabilitySaving ||
                      isFollowUpSaving ||
                      isBulkVendorStockSaving
                    }
                    onClick={() => handleShopifyAvailabilityChange(option.status)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              {isBuiltToOrderLeadTimeOpen && !builtToOrderVendor && (
                <label className="built-to-order-lead-time">
                  <span>Lead time</span>
                  <input
                    type="text"
                    value={builtToOrderLeadTime}
                    placeholder="4-6 weeks"
                    onChange={(event) => setBuiltToOrderLeadTime(event.target.value)}
                  />
                </label>
              )}

              {builtToOrderVendor && builtToOrderLeadTimeValue && (
                <p className="shopify-availability-note">
                  Built to order lead time: {builtToOrderLeadTimeValue}
                </p>
              )}

              {isShopifyAvailabilitySaving && (
                <p className="shopify-availability-note">Updating Shopify...</p>
              )}

              {!isShopifyAvailabilitySaving && shopifyAvailabilityStatus && (
                <p className="shopify-availability-note success">
                  {shopifyAvailabilityStatus}
                </p>
              )}
            </div>

            <div className="vendor-add-control">
              <input
                type="search"
                className="vendor-add-input"
                value={vendorSearchInput}
                placeholder="Add Vendor"
                aria-label="Add Vendor"
                aria-controls={vendorAddResultsId}
                aria-expanded={isVendorSearchOpen}
                disabled={!productDetails || isProductDetailsLoading || isVendorAssigning}
                onChange={(event) => {
                  setVendorSearchInput(event.target.value);
                  setVendorAssignStatus("");
                  setDetailsError("");
                  setIsVendorSearchOpen(true);
                }}
                onFocus={() => setIsVendorSearchOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setIsVendorSearchOpen(false);
                  }
                }}
              />

              {isVendorSearchOpen && (
                <div id={vendorAddResultsId} className="vendor-add-results">
                  {isVendorSearchLoading ? (
                    <p className="vendor-add-empty">Loading vendors...</p>
                  ) : vendorSearchResults.length > 0 ? (
                    <ul>
                      {vendorSearchResults.map((vendor) => (
                        <li key={vendor.id}>
                          <button
                            type="button"
                            disabled={isVendorAssigning}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => handleAssignVendor(vendor)}
                          >
                            {vendor.vendor}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : vendorSearchText ? (
                    <p className="vendor-add-empty">No matching vendors.</p>
                  ) : null}
                </div>
              )}
            </div>

            {vendorAssignStatus && (
              <p className="vendor-add-status">{vendorAssignStatus}</p>
            )}

            {isProductDetailsLoading ? (
              <p className="status-message">Loading vendors...</p>
            ) : vendors.length === 0 ? (
              <p className="status-message">No vendors assigned.</p>
            ) : (
              <ul className="assigned-vendors-list">
                {vendors.map((vendor) => {
                  const stockEnabled = vendor.quantity > 0;
                  const canEditStock = canUpdateVendorStock(vendor);
                  const formattedQuantity = formatStockQuantity(vendor.quantity);
                  const isPending = Boolean(
                    pendingVendorStock[vendor.vendorProductId]
                  );

                  return (
                    <li className="assigned-vendor-item" key={vendor.vendorProductId}>
                      <div className="assigned-vendor-main">
                        <span className="assigned-vendor-name">{vendor.name}</span>

                        {vendor.stockSource === "vendor" && (
                          <button
                            type="button"
                            className="vendor-email-button"
                            aria-label={`Email ${vendor.name}`}
                            title={`Email ${vendor.name}`}
                            onClick={() => handleOpenEmailComposer(vendor)}
                          >
                            <svg
                              aria-hidden="true"
                              viewBox="0 0 24 24"
                              focusable="false"
                            >
                              <path d="M4 5h16c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2Zm0 3.2V17h16V8.2l-8 5-8-5Zm1.2-1.2 6.8 4.2L18.8 7H5.2Z" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {vendor.builtToOrder ? (
                        <div
                          className="vendor-build-time-display"
                          aria-label={`${vendor.name} build time`}
                          title={vendor.buildTime || "Build time not set"}
                        >
                          <span className="vendor-build-time-label">Build Time</span>
                          <span className="vendor-build-time-value">
                            {vendor.buildTime || "Not set"}
                          </span>
                        </div>
                      ) : canEditStock ? (
                        <div
                          className="vendor-stock-switch"
                          role="group"
                          aria-label={`${vendor.name} stock override`}
                          title={`Current quantity: ${formattedQuantity}`}
                        >
                          <button
                            type="button"
                            className={
                              stockEnabled
                                ? "vendor-stock-switch-option active"
                                : "vendor-stock-switch-option"
                            }
                            aria-label={`Turn on stock for ${vendor.name}`}
                            aria-pressed={stockEnabled}
                            disabled={isPending}
                            onClick={() => handleVendorStockChange(vendor, true)}
                          >
                            I
                          </button>
                          <button
                            type="button"
                            className={
                              stockEnabled
                                ? "vendor-stock-switch-option"
                                : "vendor-stock-switch-option active off"
                            }
                            aria-label={`Turn off stock for ${vendor.name}`}
                            aria-pressed={!stockEnabled}
                            disabled={isPending}
                            onClick={() => handleVendorStockChange(vendor, false)}
                          >
                            O
                          </button>
                        </div>
                      ) : (
                        <span
                          className="vendor-stock-readonly"
                          title={`Current quantity: ${formattedQuantity}`}
                        >
                          Qty {formattedQuantity}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <section className="notes-panel" aria-label="Notes">
            <div className="notes-panel-header">
              <div>
                <h3>Notes</h3>
                {followUpDate && (
                  <p className="follow-up-current">
                    Follow up: {formatFollowUpDate(followUpDate)}
                  </p>
                )}
              </div>

              <div className="notes-panel-actions">
                {canShowKits && (
                  <button
                    type="button"
                    className="follow-up-button"
                    onClick={() => setIsKitModalOpen(true)}
                  >
                    Kits
                  </button>
                )}
                {canShowParentKits && (
                  <button
                    type="button"
                    className="follow-up-button"
                    onClick={() => setIsParentKitsModalOpen(true)}
                  >
                    Kit Component
                  </button>
                )}
                <button
                  type="button"
                  className="follow-up-button"
                  disabled={isProductRefreshing}
                  onClick={handleRefreshProduct}
                >
                  {isProductRefreshing ? "Refreshing..." : "Refresh"}
                </button>
                <button
                  type="button"
                  className="follow-up-button"
                  onClick={() => setIsFollowUpPickerOpen((isOpen) => !isOpen)}
                >
                  Follow Up
                </button>
              </div>
            </div>

            {isFollowUpPickerOpen && (
              <div className="follow-up-picker">
                <input
                  ref={followUpInputRef}
                  type="date"
                  value={followUpDate}
                  aria-label="Follow-up date"
                  onChange={(event) => handleFollowUpDateChange(event.target.value)}
                />
                <label className="follow-up-no-eta">
                  <input
                    type="checkbox"
                    checked={followUpNoEta}
                    disabled={isFollowUpSaving || !followUpDate}
                    onChange={(event) =>
                      handleFollowUpNoEtaChange(event.target.checked)
                    }
                  />
                  <span>No ETA</span>
                </label>
              </div>
            )}

            <div id="notesList" className="notes-list" ref={notesListRef}>
              {notes.length === 0 ? (
                <p className="status-message">No notes yet.</p>
              ) : (
                notes.map((note, index) => {
                  const authorName = note.author?.name || "StockBridge";
                  const canManageCurrentNote = canManageNote(note, currentUser);
                  const dateLabel = formatNoteDate(note.created_at);
                  const previousDateLabel =
                    index > 0 ? formatNoteDate(notes[index - 1].created_at) : "";
                  const showDateLabel = dateLabel && dateLabel !== previousDateLabel;
                  const noteTime = formatNoteTime(note.created_at);

                  return (
                    <div className="note-group" key={note.id}>
                      {showDateLabel && (
                        <div className="note-date-divider">
                          <span>{dateLabel}</span>
                        </div>
                      )}

                      <article className="note-item">
                        <div className="note-avatar" aria-hidden="true">
                          {note.author?.picture ? (
                            <img src={note.author.picture} alt="" />
                          ) : (
                            <span>{getInitials(authorName)}</span>
                          )}
                        </div>

                        <div className="note-card">
                          <header className="note-card-header">
                            <strong>{authorName}</strong>

                            <div className="note-card-meta">
                              {noteTime && (
                                <time dateTime={note.created_at}>{noteTime}</time>
                              )}

                              {canManageCurrentNote && (
                                <div className="note-icon-actions">
                                  <button
                                    type="button"
                                    aria-label="Edit note"
                                    title="Edit note"
                                    onClick={() => handleEditNote(note)}
                                  >
                                    <svg
                                      aria-hidden="true"
                                      viewBox="0 0 24 24"
                                      focusable="false"
                                    >
                                      <path d="M4 16.7V20h3.3L17.1 10.2l-3.3-3.3L4 16.7Zm15.7-9.1c.4-.4.4-1 0-1.4l-1.9-1.9c-.4-.4-1-.4-1.4 0l-1.5 1.5 3.3 3.3 1.5-1.5Z" />
                                    </svg>
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="Delete note"
                                    title="Delete note"
                                    onClick={() => handleDeleteNote(note.id)}
                                  >
                                    <svg
                                      aria-hidden="true"
                                      viewBox="0 0 24 24"
                                      focusable="false"
                                    >
                                      <path d="M8 5V4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v1h4v2H4V5h4Zm2 0h4V4h-4v1Zm-3 4h10l-.7 11.1c-.1 1.1-1 1.9-2 1.9H9.7c-1.1 0-1.9-.8-2-1.9L7 9Zm3 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z" />
                                    </svg>
                                  </button>
                                </div>
                              )}
                            </div>
                          </header>

                          <p className="note-text">{note.note}</p>
                        </div>
                      </article>
                    </div>
                  );
                })
              )}
            </div>

            <div className="note-input-container">
              {isMentionMenuOpen && (
                <div className="mention-suggestions" role="listbox" aria-label="Mention people">
                  {isMentionUsersLoading ? (
                    <p className="mention-status">Loading people...</p>
                  ) : mentionSuggestions.length === 0 ? (
                    <p className="mention-status">No matching people.</p>
                  ) : (
                    mentionSuggestions.map((user, index) => {
                      const isActive = index === selectedMentionIndex;
                      const emailLocal = user.email.split("@")[0] || user.email;

                      return (
                        <button
                          key={user.sub}
                          type="button"
                          className={`mention-suggestion-item${isActive ? " active" : ""}`}
                          role="option"
                          aria-selected={isActive}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            insertMention(user);
                          }}
                        >
                          <span className="mention-suggestion-avatar" aria-hidden="true">
                            {user.picture ? (
                              <img src={user.picture} alt="" />
                            ) : (
                              <span>{getInitials(user.name)}</span>
                            )}
                          </span>
                          <span className="mention-suggestion-copy">
                            <strong>{user.name}</strong>
                            <small>@{emailLocal}</small>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}

              <div className="note-input-row">
                <input
                  ref={noteInputRef}
                  type="text"
                  value={newNote}
                  placeholder="Add note or @mention someone..."
                  aria-label="Add note"
                  onChange={(event) =>
                    handleNoteInputChange(
                      event.target.value,
                      event.target.selectionStart ?? event.target.value.length
                    )
                  }
                  onClick={(event) =>
                    updateMentionState(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart ?? event.currentTarget.value.length
                    )
                  }
                  onKeyUp={(event) =>
                    updateMentionState(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart ?? event.currentTarget.value.length
                    )
                  }
                  onBlur={() => {
                    window.setTimeout(() => {
                      setActiveMention(null);
                    }, 0);
                  }}
                  onKeyDown={(event) => {
                    if (isMentionMenuOpen) {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setSelectedMentionIndex((current) =>
                          mentionSuggestions.length === 0
                            ? 0
                            : (current + 1) % mentionSuggestions.length
                        );
                        return;
                      }

                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setSelectedMentionIndex((current) =>
                          mentionSuggestions.length === 0
                            ? 0
                            : (current - 1 + mentionSuggestions.length) %
                              mentionSuggestions.length
                        );
                        return;
                      }

                      if (
                        (event.key === "Enter" || event.key === "Tab") &&
                        mentionSuggestions.length > 0
                      ) {
                        event.preventDefault();
                        insertMention(
                          mentionSuggestions[
                            Math.min(selectedMentionIndex, mentionSuggestions.length - 1)
                          ]
                        );
                        return;
                      }

                      if (event.key === "Escape") {
                        event.preventDefault();
                        setActiveMention(null);
                        return;
                      }
                    }

                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleAddNote();
                    }
                  }}
                />
                <button className="send-btn" type="button" onClick={handleAddNote}>
                  Send
                </button>
              </div>
            </div>
          </section>
        </div>

        {emailComposer && (
          <section
            className="vendor-email-composer"
            aria-labelledby="vendorEmailTitle"
          >
            <header className="vendor-email-composer-header">
              <h3 id="vendorEmailTitle">New Message</h3>
              <button
                type="button"
                aria-label="Close email composer"
                title="Close"
                onClick={handleCloseEmailComposer}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
                  <path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
                </svg>
              </button>
            </header>

            <div className="vendor-email-fields">
              <div className="vendor-email-row vendor-email-contact-row">
                <span>To</span>
                <select
                  aria-label="Vendor contact"
                  value={emailComposer.selectedContactEmail}
                  disabled={isVendorContactsLoading || emailComposer.contacts.length === 0}
                  onChange={(event) =>
                    updateEmailComposer({
                      selectedContactEmail: event.target.value
                    })
                  }
                >
                  {isVendorContactsLoading ? (
                    <option value="">Loading contacts...</option>
                  ) : emailComposer.contacts.length === 0 ? (
                    <option value="">No contacts found</option>
                  ) : (
                    emailComposer.contacts.map((contact) => (
                      <option key={contact.id} value={contact.email}>
                        {formatContactLabel(contact)}
                        {contact.isDefault ? " (Default)" : ""}
                      </option>
                    ))
                  )}
                </select>
                {!isSelectedContactDefault && (
                  <button
                    type="button"
                    className="vendor-email-default-button"
                    disabled={
                      isVendorContactsLoading ||
                      !selectedVendorContact ||
                      isDefaultContactSaving
                    }
                    onClick={handleSetDefaultContact}
                  >
                    {isDefaultContactSaving ? "Saving..." : "Set as Default"}
                  </button>
                )}
                {isSelectedContactDefault && (
                  <span
                    className="vendor-email-default-badge"
                    title="Default contact"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
                      <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />
                    </svg>
                    <span>Default contact</span>
                  </span>
                )}
              </div>

              <div className="vendor-email-row vendor-email-subject-row">
                <select
                  aria-label="Email templet"
                  value={emailComposer.selectedTemplateId}
                  disabled={isEmailTemplatesLoading}
                  onChange={(event) => handleTemplateSelect(event.target.value)}
                >
                  <option value="">
                    {isEmailTemplatesLoading ? "Loading templets..." : "Subject"}
                  </option>
                  {emailTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                  <option value={newTemplateValue}>New Templet</option>
                </select>

                <input
                  type="text"
                  value={emailComposer.subject}
                  placeholder="Subject"
                  aria-label="Email subject"
                  onChange={(event) =>
                    updateEmailComposer({
                      subject: event.target.value,
                      selectedTemplateId: emailComposer.isNewTemplate
                        ? newTemplateValue
                        : ""
                    })
                  }
                />

                {emailComposer.isNewTemplate && (
                  <button
                    type="button"
                    className="vendor-email-save-template"
                    onClick={handleRequestSaveTemplate}
                  >
                    Save Templet
                  </button>
                )}
              </div>
            </div>

            <textarea
              className="vendor-email-body"
              value={emailComposer.body}
              placeholder={`Ask ${emailComposer.vendor.name} to check stock for ${sku}`}
              aria-label="Email message"
              onChange={(event) =>
                updateEmailComposer({
                  body: event.target.value,
                  selectedTemplateId: emailComposer.isNewTemplate
                    ? newTemplateValue
                    : ""
                })
              }
            />

            <footer className="vendor-email-footer">
              <button
                type="button"
                className="vendor-email-send"
                disabled={
                  isEmailSending ||
                  isVendorContactsLoading ||
                  !emailComposer.selectedContactEmail
                }
                onClick={handleSendVendorEmail}
              >
                {isEmailSending ? "Sending..." : "Send"}
              </button>

              <div className="vendor-email-message" aria-live="polite">
                {emailError && <p className="error-message">{emailError}</p>}
                {!emailError && emailStatus && <p>{emailStatus}</p>}
              </div>
            </footer>

            {isTemplateNameModalOpen && (
              <div
                className="template-name-modal-backdrop"
                role="dialog"
                aria-modal="true"
                aria-labelledby="templateNameTitle"
                onClick={(event) => {
                  if (event.target === event.currentTarget) {
                    setIsTemplateNameModalOpen(false);
                  }
                }}
              >
                <div className="template-name-modal">
                  <h4 id="templateNameTitle">Name templet</h4>
                  <input
                    type="text"
                    value={templateNameDraft}
                    placeholder="Templet name"
                    aria-label="Templet name"
                    autoFocus
                    onChange={(event) => setTemplateNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleSaveTemplateName();
                      }
                    }}
                  />
                  <div className="template-name-actions">
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() => setIsTemplateNameModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="vendor-email-send"
                      disabled={isTemplateSaving}
                      onClick={handleSaveTemplateName}
                    >
                      {isTemplateSaving ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {isKitModalOpen && (
          <div
            className="notes-submodal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kitModalTitle"
            onClick={handleKitBackdropClick}
          >
            <div className="kit-products-modal">
              <div className="kit-products-modal-header">
                <h3 id="kitModalTitle">Kits</h3>
                <button type="button" onClick={() => setIsKitModalOpen(false)}>
                  Close
                </button>
              </div>

              {childProducts.length === 0 ? (
                <p className="status-message">No child products found.</p>
              ) : (
                <ul className="kit-products-list">
                  {childProducts.map((childProduct) => (
                    <li className="kit-products-list-item" key={childProduct.sku}>
                      <button
                        type="button"
                        className="kit-products-copy kit-products-open"
                        onClick={() => setSelectedChildSku(childProduct.sku)}
                        aria-label={`Open notes for ${childProduct.sku}`}
                      >
                        <strong>{childProduct.sku}</strong>
                        <span>{childProduct.name}</span>
                      </button>

                      <div className="kit-products-meta">
                        <span className="kit-products-qty">
                          {formatKitQuantityLabel(childProduct)}
                        </span>
                        <span
                          className={`availability-badge ${
                            childProduct.availability === "Available"
                              ? "availability-available"
                              : "availability-backorder"
                          }`}
                          title={`Quantity available: ${childProduct.qtyAvailable}`}
                        >
                          {childProduct.availability}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {isParentKitsModalOpen && (
          <div
            className="notes-submodal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="parentKitsModalTitle"
            onClick={handleParentKitsBackdropClick}
          >
            <div className="kit-products-modal">
              <div className="kit-products-modal-header">
                <h3 id="parentKitsModalTitle">Kit Component</h3>
                <button
                  type="button"
                  onClick={() => setIsParentKitsModalOpen(false)}
                >
                  Close
                </button>
              </div>

              {parentKits.length === 0 ? (
                <p className="status-message">No parent kits found.</p>
              ) : (
                <ul className="kit-products-list">
                  {parentKits.map((parentKit) => (
                    <li className="kit-products-list-item" key={parentKit.sku}>
                      <button
                        type="button"
                        className="kit-products-copy kit-products-open"
                        onClick={() => {
                          setIsParentKitsModalOpen(false);
                          setSelectedChildSku(parentKit.sku);
                        }}
                        aria-label={`Open notes for kit ${parentKit.sku}`}
                      >
                        <strong>{parentKit.sku}</strong>
                        <span>{parentKit.name}</span>
                      </button>

                      <div className="kit-products-meta">
                        <span className="kit-products-qty">
                          {formatParentKitQuantityLabel(parentKit)}
                        </span>
                        {parentKit.followUpDate && (
                          <span className="kit-products-qty">
                            Follow up: {formatFollowUpDate(parentKit.followUpDate)}
                          </span>
                        )}
                        <span
                          className={`availability-badge ${
                            parentKit.availability === "Available"
                              ? "availability-available"
                              : "availability-backorder"
                          }`}
                          title={`Quantity available: ${parentKit.qtyAvailable}`}
                        >
                          {parentKit.availability}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {selectedChildSku && (
          <NotesModal
            currentUser={currentUser}
            sku={selectedChildSku}
            onClose={handleCloseChildNotes}
            onFollowUpSaved={onFollowUpSaved}
            onProductStockChanged={onProductStockChanged}
            onVendorEmailSent={onVendorEmailSent}
          />
        )}
      </div>
    </div>
  );
}
