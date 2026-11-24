import {
  SupplierSchema,
  SupplierListResponseSchema,
  SupplierReceiptsResponseSchema,
  SupplierPurchaseSchema,
  SupplierPurchasesResponseSchema,
  SupplierPurchaseItemsResponseSchema,
  SupplierPaymentSchema,
  SupplierPaymentsResponseSchema,
  SupplierDuesResponseSchema,
  SupplierReminderSchema,
  SupplierRemindersResponseSchema,
  DeleteSupplierReminderResponseSchema,
  type Supplier,
  type SupplierListResponse,
  type SupplierReceiptsResponse,
  type SupplierStatus,
  type CreateSupplierRequest,
  type UpdateSupplierRequest,
  type RecordSupplierPurchaseRequest,
  type SupplierPurchase,
  type SupplierPurchasesResponse,
  type SupplierPurchaseItemsResponse,
  type RecordSupplierPaymentRequest,
  type SupplierPayment,
  type SupplierPaymentsResponse,
  type SupplierDuesResponse,
  type CreateSupplierReminderRequest,
  type UpdateSupplierReminderRequest,
  type SupplierReminder,
  type SupplierRemindersResponse,
} from "../../../src/contracts/management/suppliers";
export type {
  Supplier,
  SupplierSummary,
  SupplierStatus,
  SupplierListResponse,
  SupplierReceipt,
  SupplierReceiptsResponse,
  CreateSupplierRequest,
  UpdateSupplierRequest,
  RecordSupplierPurchaseRequest,
  SupplierPurchase,
  SupplierPurchaseItem,
  SupplierPurchasesResponse,
  SupplierPurchaseItemsResponse,
  RecordSupplierPaymentRequest,
  SupplierPayment,
  SupplierPaymentsResponse,
  SupplierDue,
  SupplierDuesResponse,
  CreateSupplierReminderRequest,
  UpdateSupplierReminderRequest,
  SupplierReminder,
  SupplierReminderStatus,
  SupplierRemindersResponse,
} from "../../../src/contracts/management/suppliers";
export interface SupplierListQuery {
  search?: string;
  status?: SupplierStatus;
  limit?: number;
  cursor?: string;
}
export interface SupplierReceiptsQuery {
  limit?: number;
  cursor?: string;
}
export interface SupplierPurchasesQuery extends SupplierReceiptsQuery {
  supplierId?: string;
}
export interface SupplierRemindersQuery {
  supplierId?: string;
  status?: "pending" | "done";
  dueOnly?: boolean;
}
export type CreateSupplierInput = CreateSupplierRequest & IdempotentWrite;
export type UpdateSupplierInput = UpdateSupplierRequest & IdempotentWrite & { supplierId: string };
export type RecordSupplierPurchaseInput = RecordSupplierPurchaseRequest & IdempotentWrite;
export type RecordSupplierPaymentInput = RecordSupplierPaymentRequest &
  IdempotentWrite & { supplierId: string };
export type RecordCustomerPaymentInput = RecordCustomerPaymentRequest &
  IdempotentWrite & { customerId: string };
export type CreateSupplierReminderInput = CreateSupplierReminderRequest & IdempotentWrite;
export type UpdateSupplierReminderInput = UpdateSupplierReminderRequest &
  IdempotentWrite & { reminderId: string };
import {
  StaffDetailSchema,
  StaffListResponseSchema,
  EligibleIdentitiesResponseSchema,
  AssignableStaffRolesResponseSchema,
  AssignableStaffScopesResponseSchema,
  type StaffDetail,
  type StaffListResponse,
  type StaffStatus,
  type EligibleIdentitiesResponse,
  type AssignableStaffRolesResponse,
  type AssignableStaffScopesResponse,
  type CreateStaffRequest,
  type CreateStaffWithoutLoginRequest,
  type CreateStaffLoginRequest,
  type UpdateStaffStatusRequest,
  type UpdateStaffProfileRequest,
  type AssignStaffRoleRequest,
} from "../../../src/contracts/management/staff";
export type {
  StaffSummary,
  StaffDetail,
  StaffStatus,
  StaffStatusTarget,
  StaffRoleRef,
  StaffScopeTarget,
  StaffAssignment,
  StaffListResponse,
  EligibleIdentity,
  EligibleIdentitiesResponse,
  AssignableStaffRole,
  AssignableStaffRolesResponse,
  AssignableStaffScopeTarget,
  AssignableStaffScope,
  AssignableStaffScopesResponse,
  CreateStaffRequest,
  CreateStaffWithoutLoginRequest,
  CreateStaffLoginRequest,
  UpdateStaffStatusRequest,
  UpdateStaffProfileRequest,
  AssignStaffRoleRequest,
  UnassignStaffRoleRequest,
} from "../../../src/contracts/management/staff";
export interface StaffListQuery {
  search?: string;
  status?: StaffStatus;
  roleId?: string;
  limit?: number;
  cursor?: string;
}
/**
 * Add-Staff identity resolution is an EXACT-email lookup, not a directory search — the only input is the
 * email of the account to link. There is deliberately no name, partial, or wildcard search and no
 * pagination.
 */
export interface EligibleStaffIdentityLookup {
  email: string;
}
/**
 * The assignment catalogs are the canonical server-backed source of the role ids and access-scope ids
 * `assignStaffRole` accepts. Do NOT derive selectable options from other staff members' assignments:
 * that yields nothing on a fresh tenant and silently hides valid-but-unused roles and scopes. There is
 * no search or filter — the sets are small, server-ordered by name, and only paged.
 */
export interface AssignmentCatalogQuery {
  limit?: number;
  cursor?: string;
}
export type CreateStaffInput = CreateStaffRequest & IdempotentWrite;
export type CreateStaffWithoutLoginInput = CreateStaffWithoutLoginRequest & IdempotentWrite;
/** Provision an email-less staff login (external account + identity + membership + initial assignment). */
export type CreateStaffLoginInput = CreateStaffLoginRequest & IdempotentWrite;
/** Set or rotate a staff member's offline-unlock PIN (independent of their Clerk online password). */
export type SetStaffOfflinePinInput = SetStaffOfflinePinRequest &
  IdempotentWrite & { membershipId: string };
export type UpdateStaffStatusInput = UpdateStaffStatusRequest &
  IdempotentWrite & { membershipId: string };
export type UpdateStaffProfileInput = UpdateStaffProfileRequest &
  IdempotentWrite & { membershipId: string };
/** Provision a pos_pin login (server-minted subject + online PIN verifier + membership + POS UI access). */
export type CreatePosLoginInput = CreatePosLoginRequest & IdempotentWrite;
export type UpdatePosLoginInput = UpdatePosLoginRequest &
  IdempotentWrite & { membershipId: string };
export type SetPosLoginPinInput = SetPosLoginPinRequest &
  IdempotentWrite & { membershipId: string };
export type AssignStaffRoleInput = AssignStaffRoleRequest &
  IdempotentWrite & { membershipId: string };
export interface UnassignStaffRoleInput extends IdempotentWrite {
  membershipId: string;
  assignmentId: string;
  reason?: string;
}
import {
  AttendanceClockResponseSchema,
  MyAttendanceResponseSchema,
  AttendanceListResponseSchema,
  type AttendanceClockResponse,
  type MyAttendanceResponse,
  type AttendanceListResponse,
} from "../../../src/contracts/management/attendance";
export type {
  AttendanceEntry,
  AttendanceClockResponse,
  MyAttendanceResponse,
  AttendanceListResponse,
} from "../../../src/contracts/management/attendance";
/** Clock-in records the signed-in member's start; `branchId` optionally tags the POS register's branch. */
export interface ClockInInput {
  branchId?: string | null;
}
export interface MyAttendanceQuery {
  limit?: number;
}
export interface AttendanceListQuery {
  membershipId?: string;
  branchId?: string;
  limit?: number;
  cursor?: string;
}
import {
  PayrollReportResponseSchema,
  PayrollSettingsSchema,
  EmployeeCompensationSchema,
  AdjustmentSchema,
  AdjustmentListResponseSchema,
  LeaveListResponseSchema,
  LeaveClockResponseSchema,
  AttendanceDeletedResponseSchema,
  type PayrollReportResponse,
  type PayrollSettings,
  type EmployeeCompensation,
  type Adjustment,
  type AdjustmentListResponse,
  type LeaveListResponse,
  type LeaveClockResponse,
  type SetCompensationRequest,
  type UpdatePayrollSettingsRequest,
  type CreateAdjustmentRequest,
  type CreateAttendanceEntryRequest,
  type UpdateAttendanceEntryRequest,
} from "../../../src/contracts/management/attendance-payroll";
import {
  PayrollCycleSettingsSchema,
  PayrollDueSchema,
  type PayrollCycleSettings,
  type PayrollDue,
  type MarkPayrollPaidRequest,
} from "../../../src/contracts/management/payroll-cycle";
export type {
  PayrollCycleSettings,
  PayrollCyclePayment,
  PayrollDue,
  MarkPayrollPaidRequest,
} from "../../../src/contracts/management/payroll-cycle";
export type {
  PayrollRow,
  PayrollTotals,
  PayrollReportResponse,
  PayrollSettings,
  EmployeeCompensation,
  AdjustmentType,
  Adjustment,
  AdjustmentListResponse,
  LeaveEntry,
  LeaveListResponse,
  LeaveClockResponse,
  SetCompensationRequest,
  UpdatePayrollSettingsRequest,
  CreateAdjustmentRequest,
  CreateAttendanceEntryRequest,
  UpdateAttendanceEntryRequest,
} from "../../../src/contracts/management/attendance-payroll";
/** Inclusive [from, to] calendar-date window (YYYY-MM-DD) for payroll / adjustments / leave reads. */
export interface AttendanceDateRange {
  from: string;
  to: string;
}
export type SetCompensationInput = SetCompensationRequest & { membershipId: string };
export type CreateAdjustmentInput = CreateAdjustmentRequest;
export type UpdateAttendanceEntryInput = UpdateAttendanceEntryRequest & { entryId: string };
import {
  CheckoutResultSchema,
  type CheckoutRequest,
  type CheckoutResult,
} from "../../../src/contracts/storefront/checkout";
export type {
  CheckoutRequest,
  CheckoutResult,
  OrderCommerceDetails,
} from "../../../src/contracts/storefront/checkout";
import {
  StorefrontQuoteResponseSchema,
  PosQuoteResponseSchema,
  PromotionDetailSchema,
  DeletePromotionResponseSchema,
  PromotionListResponseSchema,
  PromotionChannelPoliciesResponseSchema,
  OfflineVoucherExceptionListResponseSchema,
  IngestOfflineCustomerResponseSchema,
  IngestOfflineSaleHoldResponseSchema,
  PosOverridePasswordResponseSchema,
  EnrollOfflinePinResponseSchema,
  RevokeOfflinePinEnrollmentsResponseSchema,
  type EnrollOfflinePinRequest,
  type EnrollOfflinePinResponse,
  type RevokeOfflinePinEnrollmentsRequest,
  type RevokeOfflinePinEnrollmentsResponse,
  type PromotionChannelPoliciesResponse,
  type OfflineVoucherExceptionListResponse,
  type UpsertPromotionChannelPolicyRequest,
  type IngestOfflineCustomerRequest,
  type IngestOfflineCustomerResponse,
  type IngestOfflineSaleHoldRequest,
  type IngestOfflineSaleHoldResponse,
  type SetPosOverridePasswordRequest,
  type PosOverridePasswordResponse,
  type StorefrontQuoteRequest,
  type StorefrontQuoteResponse,
  type PosQuoteRequest,
  type PosQuoteResponse,
  type PromotionDetail,
  type PromotionListResponse,
  type CreatePromotionRequest,
  type UpdatePromotionRequest,
  type DeletePromotionResponse,
  type CreatePromotionCodeRequest,
} from "../../../src/contracts";
export type {
  StorefrontQuoteRequest,
  StorefrontQuoteResponse,
  PosQuoteRequest,
  PosQuoteResponse,
  PricingBreakdown,
  AppliedPromotion,
  PromotionDetail,
  PromotionSummary,
  PromotionListResponse,
  CreatePromotionRequest,
  UpdatePromotionRequest,
  DeletePromotionResponse,
  CreatePromotionCodeRequest,
  PromotionChannel,
  PromotionChannelPolicy,
  PromotionChannelPoliciesResponse,
  UpsertPromotionChannelPolicyRequest,
  OfflineVoucherExceptionListResponse,
  OfflineVoucherGrant,
  OfflineVoucherTerms,
  OfflineOverrideRosterEntry,
  OfflineAdminAssertion,
  OfflineSaleVoucher,
  OfflineSaleCachedVoucher,
  OfflineVoucherPolicy,
  OfflineCustomerCommand,
  IngestOfflineCustomerRequest,
  IngestOfflineCustomerResponse,
  IngestOfflineSaleHoldRequest,
  IngestOfflineSaleHoldResponse,
  OfflineSaleHoldCommand,
  SetPosOverridePasswordRequest,
  PosOverridePasswordResponse,
  OfflinePinAuthorization,
  EnrollOfflinePinRequest,
  EnrollOfflinePinResponse,
  RevokeOfflinePinEnrollmentsRequest,
  RevokeOfflinePinEnrollmentsResponse,
} from "../../../src/contracts";
import {
  SaleSchema,
  SaleListResponseSchema,
  DeleteSaleResponseSchema,
  StorefrontContentSchema,
  StorefrontHeroImageIntentSchema,
  PublicStorefrontContentSchema,
  StorefrontSiteTextSchema,
  PublicStorefrontSiteTextSchema,
  CatalogImageIntentSchema,
  SetCollectionImageResponseSchema,
  SetCategoryImageResponseSchema,
  ProductMediaListResponseSchema,
  UpdateProductMediaResponseSchema,
  ReorderProductMediaResponseSchema,
  type CatalogImageIntent,
  type CatalogImageInput,
  type CreateCatalogImageIntentRequest,
  type SetCollectionImageResponse,
  type SetCategoryImageResponse,
  type ProductMediaListResponse,
  type UpdateProductMediaResponse,
  type ReorderProductMediaResponse,
  type StorefrontSiteText,
  type PublicStorefrontSiteText,
  type SiteText,
  type Sale,
  type SaleListResponse,
  type DeleteSaleResponse,
  type CreateSaleRequest,
  type UpdateSaleRequest,
  type StorefrontContent,
  type UpdateStorefrontContentRequest,
  type CreateStorefrontHeroImageIntentRequest,
  type StorefrontHeroImageIntent,
  type PublicStorefrontContent,
} from "../../../src/contracts";
export type {
  Sale,
  SaleStatus,
  SaleScope,
  SaleBenefitType,
  SaleListResponse,
  DeleteSaleResponse,
  CreateSaleRequest,
  UpdateSaleRequest,
  StorefrontContent,
  StorefrontHero,
  StorefrontHeroImage,
  UpdateStorefrontContentRequest,
  CreateStorefrontHeroImageIntentRequest,
  StorefrontHeroImageIntent,
  PublicStorefrontContent,
  PublicStorefrontHero,
  StorefrontSiteText,
  PublicStorefrontSiteText,
  SiteText,
  SiteTextFaqItem,
  SiteTextSection,
  UpdateStorefrontSiteTextRequest,
  CatalogImage,
  CatalogImageInput,
  CatalogImageIntent,
  CreateCatalogImageIntentRequest,
  ProductMediaItem,
  ProductMediaListResponse,
  UpdateProductMediaResponse,
  ReorderProductMediaResponse,
  SetCollectionImageResponse,
  SetCategoryImageResponse,
  PublicProductOffer,
  PublicProductPrice,
} from "../../../src/contracts";
export type CreateSaleInput = CreateSaleRequest & { idempotencyKey: string };
export type UpdateSaleInput = UpdateSaleRequest & { saleId: string; idempotencyKey: string };
export interface SetSaleStatusInput {
  saleId: string;
  status: "active" | "inactive";
  idempotencyKey: string;
}
export type UpdateStorefrontContentInput = UpdateStorefrontContentRequest & {
  idempotencyKey: string;
};
/** SDK 0.53: website images and photo editing. */
export interface SetCollectionImageInput {
  collectionId: string;
  image: CatalogImageInput | null;
  idempotencyKey: string;
}
export interface SetCategoryImageInput {
  categoryId: string;
  image: CatalogImageInput | null;
  idempotencyKey: string;
}
export interface UpdateProductMediaInput {
  productId: string;
  mediaId: string;
  /** null or "" clears the description. */
  altText?: string | null;
  isPrimary?: true;
  idempotencyKey: string;
}
export interface ReorderProductMediaInput {
  productId: string;
  mediaIds: string[];
  idempotencyKey: string;
}
/** SDK 0.52: replace the whole site text document (null/missing keys = the website's built-in text). */
export interface UpdateStorefrontSiteTextInput {
  siteText: SiteText;
  idempotencyKey: string;
}
export interface PublicStorefrontContentQuery {
  tenantId: string;
  brandId?: string;
}
export interface PromotionListQueryInput {
  limit?: number;
  offset?: number;
}
export type CreatePromotionInput = CreatePromotionRequest & { idempotencyKey: string };
export type UpdatePromotionInput = UpdatePromotionRequest & {
  promotionId: string;
  idempotencyKey: string;
};
export interface UpsertPromotionChannelPolicyInput
  extends Partial<UpsertPromotionChannelPolicyRequest>, IdempotentWrite {
  promotionId: string;
  channel: "pos" | "online";
  usageLimit: number | null;
}
export interface UpsertPromotionCodeChannelLimitInput extends IdempotentWrite {
  codeId: string;
  channel: "pos" | "online";
  usageLimit: number | null;
}
export interface IngestOfflineCustomerInput extends IngestOfflineCustomerRequest, IdempotentWrite {}
export interface IngestOfflineSaleHoldInput extends IngestOfflineSaleHoldRequest, IdempotentWrite {}
export interface SetPosOverridePasswordInput
  extends SetPosOverridePasswordRequest, IdempotentWrite {}
export interface EnrollOfflinePinInput extends EnrollOfflinePinRequest, IdempotentWrite {}
export interface RevokeOfflinePinEnrollmentsInput
  extends RevokeOfflinePinEnrollmentsRequest, IdempotentWrite {}
export interface ClearStaffOverridePasswordInput extends IdempotentWrite {
  membershipId: string;
}

export interface SetPromotionStatusInput {
  promotionId: string;
  status: "active" | "inactive";
  idempotencyKey: string;
}
export type CreatePromotionCodeInput = CreatePromotionCodeRequest & {
  promotionId: string;
  idempotencyKey: string;
};
export interface SetPromotionCodeStatusInput {
  codeId: string;
  status: "active" | "disabled";
  idempotencyKey: string;
}
// ---- Phase 2Q reporting (read-only, tenant-wide, reports.read) ----
import {
  ReportSummaryResponseSchema,
  SalesReportResponseSchema,
  ProductsReportResponseSchema,
  InventoryReportResponseSchema,
  ReturnsReportResponseSchema,
  PromotionsReportResponseSchema,
  SuppliersReportResponseSchema,
  type ReportSummaryResponse,
  type SalesReportResponse,
  type ProductsReportResponse,
  type InventoryReportResponse,
  type ReturnsReportResponse,
  type PromotionsReportResponse,
  type SuppliersReportResponse,
  type SalesView,
  type SalesBucket,
  type ProductLevel,
  type ProductView,
  type InventoryView,
  type ReturnsView,
} from "../../../src/contracts/management/reporting";
export type {
  ReportPeriod,
  ReportSummaryResponse,
  SalesReportResponse,
  SalesReportItem,
  ProductsReportResponse,
  ProductReportItem,
  InventoryReportResponse,
  InventoryReportItem,
  ReturnsReportResponse,
  ReturnsReportItem,
  PromotionsReportResponse,
  PromotionsReportItem,
  SuppliersReportResponse,
  SuppliersReportItem,
  SalesView,
  SalesBucket,
  ProductLevel,
  ProductView,
  InventoryView,
  ReturnsView,
} from "../../../src/contracts/management/reporting";
/** Inclusive tenant-local calendar dates (YYYY-MM-DD); the server resolves them to a UTC range. */
export interface ReportPeriodQuery {
  startDate: string;
  endDate: string;
}
export interface SalesReportQuery extends ReportPeriodQuery {
  view?: SalesView;
  bucket?: SalesBucket;
}
export interface ProductsReportQuery extends ReportPeriodQuery {
  level?: ProductLevel;
  view?: ProductView;
  limit?: number;
  cursor?: string;
}
export interface InventoryReportQuery {
  view?: InventoryView;
  /** Required for every view except `balances` (current state, no period). */
  startDate?: string;
  endDate?: string;
  limit?: number;
  cursor?: string;
}
export interface ReturnsReportQuery extends ReportPeriodQuery {
  view?: ReturnsView;
  limit?: number;
  cursor?: string;
}
export type PromotionsReportQuery = ReportPeriodQuery;
export interface SuppliersReportQuery extends ReportPeriodQuery {
  limit?: number;
  cursor?: string;
}
import {
  ReportExportDatasetSchema,
  type ReportExportDataset,
} from "../../../src/contracts/management/reporting-export";
export { ReportExportDatasetSchema };
export type { ReportExportDataset } from "../../../src/contracts/management/reporting-export";
/**
 * Bounded CSV export request. `dataset` selects the canonical dataset; `startDate`/`endDate` are the SAME
 * inclusive tenant-local calendar dates as the JSON reports; `level` applies only to sales-products.
 */
export interface ReportExportQuery extends ReportPeriodQuery {
  dataset: ReportExportDataset;
  level?: "product" | "variant";
}
/** A downloaded export: the CSV body plus the metadata Admin needs to save it (no URL construction). */
export interface ReportExportResult {
  body: string;
  mediaType: string;
  filename: string;
}
// ---- Phase 2R operational settings (tenant-wide, settings.read / settings.manage) ----
import {
  BusinessSettingsSchema,
  BrandSchema,
  BrandListResponseSchema,
  BranchSchema,
  BranchListResponseSchema,
  WarehouseSchema,
  WarehouseListResponseSchema,
  InventoryLocationSchema,
  InventoryLocationListResponseSchema,
  RegisterSchema,
  RegisterListResponseSchema,
  StorefrontSettingsSchema,
  StorefrontSettingsListResponseSchema,
  ReturnSettingsSchema,
  DeviceSchema,
  DeviceListResponseSchema,
  type BusinessSettings,
  type Brand,
  type BrandListResponse,
  type Branch,
  type BranchListResponse,
  type Warehouse,
  type WarehouseListResponse,
  type InventoryLocation,
  type InventoryLocationListResponse,
  type Register,
  type RegisterListResponse,
  type StorefrontSettings,
  type StorefrontSettingsListResponse,
  type ReturnSettings,
  type Device,
  type DeviceListResponse,
  type LifecycleStatus,
  type CreateBrandRequest,
  type UpdateBrandRequest,
  type CreateBranchRequest,
  type UpdateBranchRequest,
  type SetBranchBrandsRequest,
  type CreateWarehouseRequest,
  type UpdateWarehouseRequest,
  type CreateInventoryLocationRequest,
  type UpdateInventoryLocationRequest,
  type CreateRegisterRequest,
  type UpdateRegisterRequest,
  type UpsertStorefrontSettingsRequest,
  type UpdateBusinessRequest,
  type UpdateReturnSettingsRequest,
  type RevokeDeviceRequest,
  type AssignDeviceRequest,
} from "../../../src/contracts/management/settings";
import {
  StorefrontDeliverySettingsSchema,
  PublicDeliveryOptionsSchema,
  type StorefrontDeliverySettings,
  type UpdateStorefrontDeliveryRequest,
  type PublicDeliveryOptions,
} from "../../../src/contracts/storefront/delivery";
export type {
  BusinessSettings,
  UpdateBusinessRequest,
  Brand,
  CreateBrandRequest,
  UpdateBrandRequest,
  BrandListResponse,
  Branch,
  CreateBranchRequest,
  UpdateBranchRequest,
  SetBranchBrandsRequest,
  BranchListResponse,
  Warehouse,
  CreateWarehouseRequest,
  UpdateWarehouseRequest,
  WarehouseListResponse,
  InventoryLocation,
  CreateInventoryLocationRequest,
  UpdateInventoryLocationRequest,
  InventoryLocationListResponse,
  Register,
  CreateRegisterRequest,
  UpdateRegisterRequest,
  RegisterListResponse,
  StorefrontSettings,
  UpsertStorefrontSettingsRequest,
  StorefrontSettingsListResponse,
  ReturnSettings,
  UpdateReturnSettingsRequest,
  Device,
  DeviceListResponse,
  RevokeDeviceRequest,
  AssignDeviceRequest,
  LifecycleStatus,
} from "../../../src/contracts/management/settings";

export interface LifecycleListQuery {
  status?: LifecycleStatus;
  limit?: number;
  cursor?: string;
}
export interface RegisterListQuery extends LifecycleListQuery {
  branchId?: string;
}
export interface InventoryLocationListQuery extends LifecycleListQuery {
  branchId?: string;
  warehouseId?: string;
}
export interface DeviceListQuery {
  status?: "enrolled" | "active" | "revoked";
  limit?: number;
  cursor?: string;
}
export type UpdateBusinessInput = UpdateBusinessRequest & IdempotentWrite;
export type CreateBrandInput = CreateBrandRequest & IdempotentWrite;
export type UpdateBrandInput = UpdateBrandRequest & IdempotentWrite & { brandId: string };
export type CreateBranchInput = CreateBranchRequest & IdempotentWrite;
export type UpdateBranchInput = UpdateBranchRequest & IdempotentWrite & { branchId: string };
export type SetBranchBrandsInput = SetBranchBrandsRequest & IdempotentWrite & { branchId: string };
export type CreateWarehouseInput = CreateWarehouseRequest & IdempotentWrite;
export type UpdateWarehouseInput = UpdateWarehouseRequest &
  IdempotentWrite & { warehouseId: string };
export type CreateInventoryLocationInput = CreateInventoryLocationRequest & IdempotentWrite;
export type UpdateInventoryLocationInput = UpdateInventoryLocationRequest &
  IdempotentWrite & { locationId: string };
export type CreateRegisterInput = CreateRegisterRequest & IdempotentWrite;
export type UpdateRegisterInput = UpdateRegisterRequest & IdempotentWrite & { registerId: string };
export type UpsertStorefrontSettingsInput = UpsertStorefrontSettingsRequest &
  IdempotentWrite & { brandId: string };
export type UpdateStorefrontDeliveryInput = UpdateStorefrontDeliveryRequest &
  IdempotentWrite & { brandId: string };
export interface PublicDeliveryOptionsQuery {
  tenantId: string;
  brandId: string;
}
export type UpdateReturnSettingsInput = UpdateReturnSettingsRequest & IdempotentWrite;
export type RevokeDeviceInput = RevokeDeviceRequest & IdempotentWrite & { deviceId: string };
export type AssignDeviceInput = AssignDeviceRequest & IdempotentWrite & { deviceId: string };
import {
  AllocateInventoryChannelsResponseSchema,
  InitializeInventoryChannelsResponseSchema,
  InventoryChannelStateResponseSchema,
  type AllocateInventoryChannelsResponse,
  type InitializeInventoryChannelsResponse,
  type InventoryChannelStateResponse,
} from "../../../src/contracts/management/inventory-channels";
import {
  AdjustInventoryResponseSchema,
  ApiErrorSchema,
  HealthResponseSchema,
  InventoryListResponseSchema,
  MeContextResponseSchema,
  MeTenantsResponseSchema,
  OrderDetailResponseSchema,
  OrderListResponseSchema,
  type FulfillOrderRequest,
  type CancelOrderRequest,
  CustomerListResponseSchema,
  CustomerDetailResponseSchema,
  CustomerOrdersResponseSchema,
  CustomerLookupResponseSchema,
  RecordCustomerPaymentResponseSchema,
  CustomerPaymentsResponseSchema,
  CustomerDuesResponseSchema,
  ProductDetailResponseSchema,
  ProductListResponseSchema,
  PosContextResponseSchema,
  PosAvailabilityResponseSchema,
  ListPosSyncConflictsResponseSchema,
  CreatePosSaleResponseSchema,
  PosDeviceResponseSchema,
  OfflineBootstrapResponseSchema,
  IngestOfflineSaleResponseSchema,
  IngestOfflineCustomerPaymentResponseSchema,
  IngestOfflineAttendanceResponseSchema,
  IngestOfflineIntentResponseSchema,
  OfflineReturnGrantResponseSchema,
  IngestOfflineReturnResponseSchema,
  SetStaffOfflinePinResponseSchema,
  PosLoginResponseSchema,
  SetPosLoginPinResponseSchema,
  PosLoginListResponseSchema,
  ReceiveInventoryResponseSchema,
  TransferInventoryResponseSchema,
  ProductWriteResponseSchema,
  ProductUpdatedResponseSchema,
  PublishProductResponseSchema,
  UnpublishProductResponseSchema,
  CreateVariantResponseSchema,
  SetVariantPriceResponseSchema,
  SetVariantCostResponseSchema,
  MediaUploadIntentResponseSchema,
  RegisterProductMediaResponseSchema,
  ArchiveProductMediaResponseSchema,
  PublicProductListResponseSchema,
  PublicProductDetailResponseSchema,
  CollectionListResponseSchema,
  CollectionDetailResponseSchema,
  CollectionWriteResponseSchema,
  CollectionUpdatedResponseSchema,
  SetCollectionProductsResponseSchema,
  PublicCollectionListResponseSchema,
  PublicCollectionDetailResponseSchema,
  SetVariantOptionsResponseSchema,
  UpdateOptionValuesResponseSchema,
  CategoryListResponseSchema,
  CategoryWriteResponseSchema,
  CategoryUpdatedResponseSchema,
  SetProductCategoriesResponseSchema,
  PublicCategoryListResponseSchema,
  SetCategorySizeGuideResponseSchema,
  VendorListResponseSchema,
  VendorWriteResponseSchema,
  VendorUpdatedResponseSchema,
  SetProductVendorResponseSchema,
  PublicVendorListResponseSchema,
  PublicBestSellersResponseSchema,
  StorefrontSubscribeResponseSchema,
  SubscriberListResponseSchema,
  StorefrontTrackedOrderSchema,
  StorefrontReturnPolicySchema,
  type StorefrontReturnPolicy,
  StorefrontReturnRequestResponseSchema,
  ReturnRequestSchema,
  ReturnRequestListResponseSchema,
  type StorefrontTrackedOrder,
  type StorefrontReturnRequestResponse,
  type ReturnRequest,
  type ReturnRequestListResponse,
  type StorefrontSubscribeResponse,
  type SubscriberListResponse,
  type SetCategorySizeGuideResponse,
  type VendorListResponse,
  type VendorWriteResponse,
  type VendorUpdatedResponse,
  type SetProductVendorResponse,
  type PublicVendorListResponse,
  type CreateVendorRequest,
  type UpdateVendorRequest,
  type VendorStatus,
  type PublicBestSellersResponse,
  type SizeGuide,
  type VariantOptionSelection,
  type SetVariantOptionsResponse,
  type UpdateOptionValuesRequest,
  type UpdateOptionValuesResponse,
  type CategoryListResponse,
  type CategoryWriteResponse,
  type CategoryUpdatedResponse,
  type CreateCategoryRequest,
  type UpdateCategoryRequest,
  type SetCategoryStatusRequest,
  type SetProductCategoriesResponse,
  type PublicCategoryListResponse,
  type CollectionListResponse,
  type CollectionDetailResponse,
  type CollectionWriteResponse,
  type CollectionUpdatedResponse,
  type SetCollectionProductsResponse,
  type CreateCollectionRequest,
  type UpdateCollectionRequest,
  type SetCollectionStatusRequest,
  type CollectionStatus,
  type PublicCollectionSummary,
  type PublicCollectionListResponse,
  type PublicCollectionDetail,
  type PublicCollectionDetailResponse,
  type ProductWriteResponse,
  type ProductUpdatedResponse,
  type PublishProductResponse,
  type UnpublishProductResponse,
  type CreateVariantResponse,
  type SetVariantPriceResponse,
  type SetVariantCostRequest,
  type SetVariantCostResponse,
  type MediaUploadIntentResponse,
  type RegisterProductMediaResponse,
  type ArchiveProductMediaResponse,
  type PublicProduct,
  type PublicProductListResponse,
  type PublicProductDetailResponse,
  type StorefrontStatus,
  type AdjustInventoryResponse,
  type HealthResponse,
  type InventoryListResponse,
  type MeContextResponse,
  type MeTenantsResponse,
  type OrderChannel,
  type OrderDetailResponse,
  type OrderListResponse,
  type OrderSummary,
  type CustomerSummary,
  type CustomerListResponse,
  type CustomerDetailResponse,
  type CustomerOrdersResponse,
  type CustomerLookupResponse,
  type RecordCustomerPaymentRequest,
  type RecordCustomerPaymentResponse,
  type CustomerPayment,
  type CustomerPaymentsResponse,
  type CustomerDue,
  type CustomerDuesResponse,
  type OrderStatus,
  type ProductDetailResponse,
  type ProductListResponse,
  type ProductStatus,
  type PosContextResponse,
  type PosAvailabilityResponse,
  type PosSyncConflict,
  type PosSyncConflictKind,
  type ListPosSyncConflictsResponse,
  type CreatePosSaleResponse,
  type EnrollPosDeviceRequest,
  type PosDeviceResponse,
  type OfflineBootstrapRequest,
  type OfflineBootstrapResponse,
  type OfflineStockGrant,
  type OfflineSaleCommand,
  type IngestOfflineSaleRequest,
  type IngestOfflineSaleResponse,
  type OfflineCustomerPaymentCommand,
  type IngestOfflineCustomerPaymentRequest,
  type IngestOfflineCustomerPaymentResponse,
  type OfflineAttendanceEventType,
  type OfflineAttendanceCommand,
  type IngestOfflineAttendanceRequest,
  type IngestOfflineAttendanceResponse,
  type OfflineIntentOperation,
  type OfflineIntentCommand,
  type IngestOfflineIntentRequest,
  type IngestOfflineIntentResponse,
  type OfflineIntentDisposition,
  type OfflineReturnGrantLine,
  type IssueOfflineReturnGrantRequest,
  type OfflineReturnGrantResponse,
  type OfflineReturnCommand,
  type IngestOfflineReturnRequest,
  type OfflineReturnReconciliation,
  type IngestOfflineReturnResponse,
  type OfflineStaffRosterEntry,
  type StaffPinVerifier,
  type SetStaffOfflinePinRequest,
  type SetStaffOfflinePinResponse,
  type PosLoginRequest,
  type PosLoginResponse,
  type CreatePosLoginRequest,
  type UpdatePosLoginRequest,
  type SetPosLoginPinRequest,
  type SetPosLoginPinResponse,
  type PosLoginListResponse,
  type ReceiveInventoryResponse,
  type TransferInventoryResponse,
} from "../../../src/contracts";
export type {
  PosLoginRequest,
  PosLoginResponse,
  PosOperator,
  CreatePosLoginRequest,
  UpdatePosLoginRequest,
  SetPosLoginPinRequest,
  SetPosLoginPinResponse,
  PosLoginSummary,
  PosLoginListResponse,
} from "../../../src/contracts";
export {
  canonicalizeOfflineSaleCommand,
  canonicalizeOfflineCustomerPaymentCommand,
  canonicalizeOfflineAttendanceCommand,
  canonicalizeOfflineIntentCommand,
  canonicalizeOfflineReturnCommand,
  canonicalizeOfflineCustomerCommand,
  canonicalizeOfflineSaleHoldCommand,
} from "../../../src/contracts";
export type {
  StorefrontDeliverySettings,
  UpdateStorefrontDeliveryRequest,
  PublicDeliveryOptions,
  StorefrontDeliveryQuote,
  StorefrontDeliveryZone,
  DeliveryZoneRef,
  VariantOptionSelection,
  SetVariantOptionsResponse,
  UpdateOptionValuesRequest,
  UpdateOptionValuesResponse,
  CategoryListResponse,
  CategorySummary,
  CategoryStatus,
  CategoryWriteResponse,
  CategoryUpdatedResponse,
  CreateCategoryRequest,
  UpdateCategoryRequest,
  SetCategoryStatusRequest,
  SetProductCategoriesResponse,
  PublicCategory,
  PublicCategoryListResponse,
  SizeGuide,
  SetCategorySizeGuideRequest,
  SetCategorySizeGuideResponse,
  VendorListResponse,
  VendorSummary,
  VendorStatus,
  VendorWriteResponse,
  VendorUpdatedResponse,
  CreateVendorRequest,
  UpdateVendorRequest,
  SetProductVendorResponse,
  PublicVendor,
  PublicVendorListResponse,
  PublicProductVendor,
  PublicBestSellersResponse,
  StorefrontSubscribeRequest,
  StorefrontSubscribeResponse,
  StorefrontTrackOrderRequest,
  StorefrontTrackedOrder,
  StorefrontReturnPolicy,
  StorefrontReturnRequest,
  StorefrontReturnRequestResponse,
  TrackingStage,
  ReturnRequestReason,
  ReturnRequestStatus,
  ReturnRequestPreference,
  ReturnRequestRefusal,
  ReturnRequest,
  ReturnRequestListResponse,
  ReturnRequestListQuery,
  UpdateReturnRequestStatus,
  SubscriberSummary,
  SubscriberListResponse,
  PublicProductOption,
  PublicProductCategory,
  PublicVariantOptionValue,
} from "../../../src/contracts";
import packageMetadata from "../package.json";
import type { z } from "zod";

export interface ListPosSyncConflictsInput {
  readonly registerId?: string;
  readonly kind?: PosSyncConflictKind;
  readonly status?: "open" | "informational";
  readonly limit?: number;
}

export const SDK_VERSION = packageMetadata.version;

export type ClientType = "pos-desktop" | "storefront" | "admin-mobile";

export interface ClientMetadata {
  type: ClientType;
  version: string;
}

/** Injection seam for the Clerk user/session token. The SDK never owns Clerk UI or session state. */
export type TokenProvider = () => Promise<string | null | undefined> | string | null | undefined;

export interface CommerceClientOptions {
  baseUrl: string;
  client?: ClientMetadata;
  getToken?: TokenProvider;
  fetch?: typeof globalThis.fetch;
}

export interface ProductListQuery {
  brandId?: string;
  status?: ProductStatus;
  limit?: number;
  cursor?: string;
}

export interface InventoryListQuery {
  inventoryLocationId?: string;
  variantId?: string;
  limit?: number;
  cursor?: string;
}

export interface OrderListQuery {
  channel?: OrderChannel;
  brandId?: string;
  branchId?: string;
  status?: OrderStatus;
  limit?: number;
  cursor?: string;
}

export interface CustomerListQuery {
  search?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Idempotency is a required, explicit part of every inventory write. The caller supplies a stable key
 * per logical intent; the SDK sends it as the Idempotency-Key header. A replay with the same key and
 * body is not applied twice; the same key with a different body is rejected by the API with a 409.
 */
export interface IdempotentWrite {
  idempotencyKey: string;
}

export interface ReceiveInventoryInput extends IdempotentWrite {
  supplierId?: string;
  supplierReference?: string;
  variantId: string;
  inventoryLocationId: string;
  quantity: number;
  note?: string;
}

export interface InitializeInventoryChannelsInput extends IdempotentWrite {
  inventoryLocationId: string;
}

export interface AllocateInventoryChannelsInput extends IdempotentWrite {
  inventoryLocationId: string;
  reason: string;
  lines: Array<{
    variantId: string;
    websiteQuantity: number;
    posQuantity: number;
    /** ADR-042 §3.5: both versions are required; a stale one makes the whole request a 409. */
    expectedBalanceVersion: number;
    expectedAllocationVersion: number;
  }>;
}

export interface AdjustInventoryInput extends IdempotentWrite {
  variantId: string;
  inventoryLocationId: string;
  countedQuantity: number;
  expectedVersion: number;
  note?: string;
}

export interface TransferInventoryInput extends IdempotentWrite {
  variantId: string;
  sourceInventoryLocationId: string;
  destinationInventoryLocationId: string;
  quantity: number;
  note?: string;
}

export interface CreatePosSaleInput extends IdempotentWrite {
  registerId: string;
  expectedTotalMinor: number;
  // Settle by a single cash amount (cashReceivedMinor) OR an explicit split of tenders that sum to
  // the net total. Provide exactly one. cashReceivedMinor stays for the common cash-only sale.
  cashReceivedMinor?: number;
  tenders?: ReadonlyArray<{
    method: "cash" | "card" | "instapay" | "wallet";
    amountMinor: number;
    cashReceivedMinor?: number;
  }>;
  lines: ReadonlyArray<{ variantId: string; quantity: number }>;
  // Optional entered promotion code (trimmed, uppercased server-side); mirrors CreatePosSaleRequestSchema.
  promotionCode?: string | null;
  // Optional customer captured at the register. The server matches/creates by normalized phone and
  // snapshots the contact onto the order. Omit for an anonymous sale.
  customer?: { name: string; phone: string };
  // Installment deposit. Omit to settle in full. When below expectedTotalMinor the remainder becomes a
  // customer debt, so a positive deposit and a customer are required.
  amountPaidMinor?: number;
}

export interface EnrollPosDeviceInput extends EnrollPosDeviceRequest, IdempotentWrite {}
export interface RotatePosDeviceCredentialInput extends IdempotentWrite {
  deviceId: string;
  registerId: string;
  publicKey: { algorithm: "Ed25519"; encoding: "spki_der_base64"; value: string };
}
export interface RevokePosDeviceInput extends IdempotentWrite {
  deviceId: string;
  registerId: string;
  reason: string;
}
export interface OfflineBootstrapInput extends OfflineBootstrapRequest, IdempotentWrite {}
export interface IngestOfflineSaleInput extends IngestOfflineSaleRequest, IdempotentWrite {}
export interface IngestOfflineCustomerPaymentInput
  extends IngestOfflineCustomerPaymentRequest, IdempotentWrite {}
export interface IngestOfflineAttendanceInput
  extends IngestOfflineAttendanceRequest, IdempotentWrite {}

export type IngestOfflineIntentInput = IngestOfflineIntentRequest & IdempotentWrite;
export interface IssueOfflineReturnGrantInput
  extends IssueOfflineReturnGrantRequest, IdempotentWrite {}
export interface IngestOfflineReturnInput extends IngestOfflineReturnRequest, IdempotentWrite {}

// ---- Phase 2J catalog management inputs ----
export interface CreateProductInput extends IdempotentWrite {
  brandId: string;
  name: string;
  slug: string;
  styleCode?: string;
  description?: string;
}
export interface UpdateProductInput extends IdempotentWrite {
  productId: string;
  name: string;
  slug: string;
  styleCode?: string;
  description?: string;
}
export interface SetProductStatusInput extends IdempotentWrite {
  productId: string;
  status: ProductStatus;
  archiveReason?: string;
}
export interface PublishProductInput extends IdempotentWrite {
  productId: string;
}
export interface CreateVariantInput extends IdempotentWrite {
  productId: string;
  sku: string;
  displayName?: string;
  /** Create the variant with these option values (e.g. Size M, Colour Black) atomically. */
  options?: VariantOptionSelection[];
}
export interface SetVariantOptionsInput extends IdempotentWrite {
  productId: string;
  variantId: string;
  /** The complete selection; an empty array clears the variant's options. */
  options: VariantOptionSelection[];
}
export interface UpdateOptionValuesInput extends IdempotentWrite, UpdateOptionValuesRequest {
  productId: string;
}

// ---- Categories management inputs ----
export interface CreateCategoryInput extends IdempotentWrite, CreateCategoryRequest {}
export interface UpdateCategoryInput extends IdempotentWrite, UpdateCategoryRequest {
  categoryId: string;
}
export interface SetCategoryStatusInput extends IdempotentWrite, SetCategoryStatusRequest {
  categoryId: string;
}
export interface SetProductCategoriesInput extends IdempotentWrite {
  productId: string;
  categoryIds: string[];
}

// ---- Vendors (SDK 0.50): the labels the tenant sells, shown as "Brand" ----
export interface CreateVendorInput extends IdempotentWrite, CreateVendorRequest {}
export interface UpdateVendorInput extends IdempotentWrite, UpdateVendorRequest {
  vendorId: string;
}
export interface SetVendorStatusInput extends IdempotentWrite {
  vendorId: string;
  status: VendorStatus;
}
export interface SetProductVendorInput extends IdempotentWrite {
  productId: string;
  /** The vendor id, or null to clear it. */
  vendorId: string | null;
}
export interface PublicVendorListQuery {
  tenantId: string;
}
export interface SetVariantPriceInput extends IdempotentWrite {
  variantId: string;
  currency: string;
  amountMinor: number;
}
export interface SetVariantCostInput extends IdempotentWrite, SetVariantCostRequest {
  variantId: string;
}
export interface CreateProductMediaUploadIntentInput {
  productId: string;
  variantId?: string;
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  fileName?: string;
}
export interface RegisterProductMediaInput extends IdempotentWrite {
  productId: string;
  variantId?: string;
  bucket: string;
  path: string;
  altText?: string;
  position?: number;
  isPrimary?: boolean;
}
export interface ArchiveProductMediaInput extends IdempotentWrite {
  productId: string;
  mediaId: string;
}

// ---- Collections management inputs ----
export interface CreateCollectionInput extends IdempotentWrite, CreateCollectionRequest {}
export interface UpdateCollectionInput extends IdempotentWrite, UpdateCollectionRequest {
  collectionId: string;
}
export interface SetCollectionStatusInput extends IdempotentWrite, SetCollectionStatusRequest {
  collectionId: string;
}
export interface SetCollectionProductsInput extends IdempotentWrite {
  collectionId: string;
  productIds: string[];
}

export interface PublicCatalogListQuery {
  tenantId: string;
  brandId?: string;
  limit?: number;
}
export interface PublicProductQuery {
  tenantId: string;
  slug: string;
}
export interface PublicCollectionListQuery {
  tenantId: string;
  limit?: number;
}
export interface PublicCollectionQuery {
  tenantId: string;
  slug: string;
}
export interface PublicCategoryListQuery {
  tenantId: string;
}
export interface SetCategorySizeGuideInput extends IdempotentWrite {
  categoryId: string;
  /** The complete size chart, or null to remove it. */
  sizeGuide: SizeGuide | null;
}
export interface StorefrontSubscribeInput {
  tenantId: string;
  brandId?: string;
  email: string;
  /** Where the sign-up came from, kebab-case (e.g. "home"). */
  source?: string;
}

/** SDK 0.48: identify an online order with its number + the phone given at checkout. */
export interface StorefrontOrderLookup {
  tenantId: string;
  brandId?: string;
  orderReference: string;
  phone: string;
}
export interface StorefrontReturnRequestInput extends StorefrontOrderLookup {
  preference?: "refund" | "exchange";
  note?: string;
  lines: {
    lineNumber: number;
    quantity: number;
    reason:
      | "too_small"
      | "too_big"
      | "not_as_pictured"
      | "damaged"
      | "wrong_item"
      | "changed_mind"
      | "other";
  }[];
}
export interface ReturnRequestListInput {
  status?: "open" | "requested" | "approved" | "declined" | "completed" | "all";
  orderId?: string;
  limit?: number;
}
export interface UpdateReturnRequestStatusInput extends IdempotentWrite {
  requestId: string;
  status: "approved" | "declined" | "completed";
  note?: string;
}

export interface PublicBestSellersQuery {
  tenantId: string;
  brandId?: string;
  /** Look-back window in days (1-365, default 90). */
  days?: number;
  /** How many ids to return (1-50, default 12). */
  limit?: number;
}

/** Tenant-scoped management surface, obtained via `client.withTenant(tenantId)`. */
export interface TenantCommerceClient {
  readonly tenantId: string;
  getContext(): Promise<MeContextResponse>;
  listProducts(query?: ProductListQuery): Promise<ProductListResponse>;
  getProduct(productId: string): Promise<ProductDetailResponse>;
  createProduct(input: CreateProductInput): Promise<ProductWriteResponse>;
  updateProduct(input: UpdateProductInput): Promise<ProductUpdatedResponse>;
  setProductStatus(input: SetProductStatusInput): Promise<ProductWriteResponse>;
  publishProduct(input: PublishProductInput): Promise<PublishProductResponse>;
  unpublishProduct(input: PublishProductInput): Promise<UnpublishProductResponse>;
  createVariant(input: CreateVariantInput): Promise<CreateVariantResponse>;
  setVariantPrice(input: SetVariantPriceInput): Promise<SetVariantPriceResponse>;
  setVariantCost(input: SetVariantCostInput): Promise<SetVariantCostResponse>;
  createProductMediaUploadIntent(
    input: CreateProductMediaUploadIntentInput,
  ): Promise<MediaUploadIntentResponse>;
  registerProductMedia(input: RegisterProductMediaInput): Promise<RegisterProductMediaResponse>;
  archiveProductMedia(input: ArchiveProductMediaInput): Promise<ArchiveProductMediaResponse>;
  listCollections(): Promise<CollectionListResponse>;
  getCollection(collectionId: string): Promise<CollectionDetailResponse>;
  createCollection(input: CreateCollectionInput): Promise<CollectionWriteResponse>;
  updateCollection(input: UpdateCollectionInput): Promise<CollectionUpdatedResponse>;
  setCollectionStatus(input: SetCollectionStatusInput): Promise<CollectionWriteResponse>;
  setCollectionProducts(input: SetCollectionProductsInput): Promise<SetCollectionProductsResponse>;
  setVariantOptions(input: SetVariantOptionsInput): Promise<SetVariantOptionsResponse>;
  updateOptionValues(input: UpdateOptionValuesInput): Promise<UpdateOptionValuesResponse>;
  listCategories(): Promise<CategoryListResponse>;
  createCategory(input: CreateCategoryInput): Promise<CategoryWriteResponse>;
  updateCategory(input: UpdateCategoryInput): Promise<CategoryUpdatedResponse>;
  setCategoryStatus(input: SetCategoryStatusInput): Promise<CategoryWriteResponse>;
  /** SDK 0.46: replace or clear the size chart for a category (and its descendants). */
  setCategorySizeGuide(input: SetCategorySizeGuideInput): Promise<SetCategorySizeGuideResponse>;
  /** SDK 0.47: storefront email sign-ups, newest first (orders.read). */
  listSubscribers(query?: { limit?: number }): Promise<SubscriberListResponse>;
  /** SDK 0.48: customer return requests from the Storefront (returns.read). Default: open ones. */
  listReturnRequests(query?: ReturnRequestListInput): Promise<ReturnRequestListResponse>;
  /** SDK 0.48: approve / decline / complete a return request (returns.create). */
  updateReturnRequestStatus(input: UpdateReturnRequestStatusInput): Promise<ReturnRequest>;
  setProductCategories(input: SetProductCategoriesInput): Promise<SetProductCategoriesResponse>;
  /** SDK 0.50: the labels the tenant sells (shown as "Brand"), any status (catalog.author). */
  listVendors(): Promise<VendorListResponse>;
  createVendor(input: CreateVendorInput): Promise<VendorWriteResponse>;
  updateVendor(input: UpdateVendorInput): Promise<VendorUpdatedResponse>;
  setVendorStatus(input: SetVendorStatusInput): Promise<VendorWriteResponse>;
  /** SDK 0.50: set or clear (null) the label a product is made by. */
  setProductVendor(input: SetProductVendorInput): Promise<SetProductVendorResponse>;
  listInventory(query?: InventoryListQuery): Promise<InventoryListResponse>;
  listSuppliers(query?: SupplierListQuery): Promise<SupplierListResponse>;
  getSupplier(supplierId: string): Promise<Supplier>;
  createSupplier(input: CreateSupplierInput): Promise<Supplier>;
  updateSupplier(input: UpdateSupplierInput): Promise<Supplier>;
  listSupplierReceipts(
    supplierId: string,
    query?: SupplierReceiptsQuery,
  ): Promise<SupplierReceiptsResponse>;
  recordSupplierPurchase(input: RecordSupplierPurchaseInput): Promise<SupplierPurchase>;
  listSupplierPurchases(query?: SupplierPurchasesQuery): Promise<SupplierPurchasesResponse>;
  supplierPurchaseItems(purchaseId: string): Promise<SupplierPurchaseItemsResponse>;
  recordSupplierPayment(input: RecordSupplierPaymentInput): Promise<SupplierPayment>;
  listSupplierPayments(
    supplierId: string,
    query?: SupplierReceiptsQuery,
  ): Promise<SupplierPaymentsResponse>;
  supplierDues(): Promise<SupplierDuesResponse>;
  listSupplierReminders(query?: SupplierRemindersQuery): Promise<SupplierRemindersResponse>;
  createSupplierReminder(input: CreateSupplierReminderInput): Promise<SupplierReminder>;
  updateSupplierReminder(input: UpdateSupplierReminderInput): Promise<SupplierReminder>;
  deleteSupplierReminder(input: {
    reminderId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  listStaff(query?: StaffListQuery): Promise<StaffListResponse>;
  findEligibleStaffIdentitiesByEmail(
    lookup: EligibleStaffIdentityLookup,
  ): Promise<EligibleIdentitiesResponse>;
  listAssignableStaffRoles(query?: AssignmentCatalogQuery): Promise<AssignableStaffRolesResponse>;
  listAssignableStaffScopes(query?: AssignmentCatalogQuery): Promise<AssignableStaffScopesResponse>;
  getStaffMember(membershipId: string): Promise<StaffDetail>;
  createStaff(input: CreateStaffInput): Promise<StaffDetail>;
  createStaffWithoutLogin(input: CreateStaffWithoutLoginInput): Promise<StaffDetail>;
  /**
   * Provision a brand-new, email-less staff login and link it as active staff in one step. The server
   * mints the external account; the caller supplies only the display name, username, PIN, and the initial
   * role + scope.
   */
  createStaffLogin(input: CreateStaffLoginInput): Promise<StaffDetail>;
  /** Admin "Team" surface for pos_pin accounts (the POS-native login the floor uses). */
  listPosLogins(): Promise<PosLoginListResponse>;
  createPosLogin(input: CreatePosLoginInput): Promise<StaffDetail>;
  updatePosLogin(input: UpdatePosLoginInput): Promise<StaffDetail>;
  setPosLoginPin(input: SetPosLoginPinInput): Promise<SetPosLoginPinResponse>;
  /**
   * Set or rotate a staff member's OFFLINE-unlock PIN — a credential independent of their Clerk online
   * password, used by the POS offline cashier. The server seals the PIN; the offline bootstrap later emits
   * a device-bound verifier derived from it.
   */
  setStaffOfflinePin(input: SetStaffOfflinePinInput): Promise<SetStaffOfflinePinResponse>;
  updateStaffStatus(input: UpdateStaffStatusInput): Promise<StaffDetail>;
  updateStaffProfile(input: UpdateStaffProfileInput): Promise<StaffDetail>;
  assignStaffRole(input: AssignStaffRoleInput): Promise<StaffDetail>;
  unassignStaffRole(input: UnassignStaffRoleInput): Promise<StaffDetail>;
  /** Clock the signed-in member in (attendance.record). Fails if they already have an open entry. */
  clockIn(input?: ClockInInput): Promise<AttendanceClockResponse>;
  /** Clock the signed-in member out of their open entry (attendance.record). */
  clockOut(): Promise<AttendanceClockResponse>;
  /** The signed-in member's own attendance: current open entry + recent entries (attendance.record). */
  getMyAttendance(query?: MyAttendanceQuery): Promise<MyAttendanceResponse>;
  /** Tenant-wide workforce attendance, keyset-paginated (attendance.read). */
  listAttendance(query?: AttendanceListQuery): Promise<AttendanceListResponse>;
  /** Computed payroll for a date range (attendance.read). */
  getPayrollReport(range: AttendanceDateRange): Promise<PayrollReportResponse>;
  /** Tenant payroll settings: normal-hours threshold + shift-duration divisor (read/manage). */
  getPayrollSettings(): Promise<PayrollSettings>;
  updatePayrollSettings(input: UpdatePayrollSettingsRequest): Promise<PayrollSettings>;
  getPayrollCycleSettings(): Promise<PayrollCycleSettings>;
  updatePayrollCycleSettings(input: PayrollCycleSettings): Promise<PayrollCycleSettings>;
  getPayrollDue(): Promise<PayrollDue>;
  markPayrollPaid(input?: MarkPayrollPaidRequest): Promise<PayrollDue>;
  /** A member's current compensation, or null if none is set (attendance.read). */
  getCompensation(membershipId: string): Promise<EmployeeCompensation | null>;
  setCompensation(input: SetCompensationInput): Promise<EmployeeCompensation>;
  /** Dated bonus/deduction adjustments (read list / manage create+remove). */
  listAdjustments(range: AttendanceDateRange): Promise<AdjustmentListResponse>;
  createAdjustment(input: CreateAdjustmentInput): Promise<Adjustment>;
  removeAdjustment(adjustmentId: string): Promise<{ id: string }>;
  /** Manager-sanctioned manual attendance entries (attendance.manage). */
  addAttendanceEntry(input: CreateAttendanceEntryRequest): Promise<AttendanceClockResponse>;
  updateAttendanceEntry(input: UpdateAttendanceEntryInput): Promise<AttendanceClockResponse>;
  removeAttendanceEntry(entryId: string): Promise<{ id: string }>;
  /** Mid-shift leave log (attendance.read) + self-service start/end (attendance.record). */
  listLeaves(range: AttendanceDateRange): Promise<LeaveListResponse>;
  startLeave(input?: ClockInInput): Promise<LeaveClockResponse>;
  endLeave(): Promise<LeaveClockResponse>;
  receiveInventory(input: ReceiveInventoryInput): Promise<ReceiveInventoryResponse>;
  adjustInventory(input: AdjustInventoryInput): Promise<AdjustInventoryResponse>;
  /** ADR-042: Website/POS stock split of one inventory location (empty items while legacy). */
  getInventoryChannels(query: {
    inventoryLocationId: string;
  }): Promise<InventoryChannelStateResponse>;
  /** ADR-042: legacy → shadow; all stock starts unallocated. Repeat calls return initialized=false. */
  initializeInventoryChannels(
    input: InitializeInventoryChannelsInput,
  ): Promise<InitializeInventoryChannelsResponse>;
  /** ADR-042: set absolute Website/POS quantities per variant; unallocated is the remainder. */
  allocateInventoryChannels(
    input: AllocateInventoryChannelsInput,
  ): Promise<AllocateInventoryChannelsResponse>;
  transferInventory(input: TransferInventoryInput): Promise<TransferInventoryResponse>;
  listOrders(query?: OrderListQuery): Promise<OrderListResponse>;
  getOrder(orderId: string): Promise<OrderDetailResponse>;
  /**
   * Fulfil lines of an ONLINE order (orders.fulfill + inventory.issue). The server takes stock from the
   * location the order's reservations hold; returns the refreshed order detail. Idempotent per key.
   */
  fulfillOrder(input: FulfillOrderInput): Promise<OrderDetailResponse>;
  /** Cancel an unfulfilled ONLINE order (orders.cancel); releases its reservations. Idempotent. */
  cancelOrder(input: CancelOrderInput): Promise<OrderDetailResponse>;
  /** Customers (commerce contacts). Gated on orders.read; search matches name or phone. */
  listCustomers(query?: CustomerListQuery): Promise<CustomerListResponse>;
  getCustomer(customerId: string): Promise<CustomerDetailResponse>;
  listCustomerOrders(
    customerId: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<CustomerOrdersResponse>;
  /** Match an existing customer by phone (normalized server-side); null when none. */
  lookupCustomerByPhone(phone: string): Promise<CustomerLookupResponse>;
  /** Installments / accounts receivable. Reads gated on orders.read; recording a paydown on payments.capture. */
  recordCustomerPayment(input: RecordCustomerPaymentInput): Promise<RecordCustomerPaymentResponse>;
  listCustomerPayments(customerId: string): Promise<CustomerPaymentsResponse>;
  listCustomerDues(): Promise<CustomerDuesResponse>;
  getReturnEligibility(orderId: string): Promise<ReturnEligibilityResponse>;
  listReturns(
    orderId: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<ReturnHistoryResponse>;
  getReturn(returnId: string): Promise<ReturnDetailResponse>;
  createReturn(input: CreateReturnInput): Promise<ReturnDetailResponse>;
  settleRefund(input: SettleRefundInput): Promise<ReturnDetailResponse>;
  getPosContext(): Promise<PosContextResponse>;
  getPosAvailability(registerId: string): Promise<PosAvailabilityResponse>;
  /**
   * ADR-042 §13.5 — read-only post-sync conflict report (shared-stock shortfall, voucher, duplicate customer,
   * stale debt, attendance, dependency, integrity). Pass `registerId` from a till (register permissions),
   * omit it for the tenant-wide view (orders.read). Never an approval queue; never mutates a record.
   */
  listPosSyncConflicts(query?: ListPosSyncConflictsInput): Promise<ListPosSyncConflictsResponse>;
  posQuote(input: PosQuoteRequest): Promise<PosQuoteResponse>;
  createPosSale(input: CreatePosSaleInput): Promise<CreatePosSaleResponse>;
  listPromotions(query?: PromotionListQueryInput): Promise<PromotionListResponse>;
  getPromotion(promotionId: string): Promise<PromotionDetail>;
  createPromotion(input: CreatePromotionInput): Promise<PromotionDetail>;
  updatePromotion(input: UpdatePromotionInput): Promise<PromotionDetail>;
  /** Deletes a never-used promotion, or archives one with sale-time history (promotions.manage). */
  deletePromotion(promotionId: string): Promise<DeletePromotionResponse>;
  setPromotionStatus(input: SetPromotionStatusInput): Promise<PromotionDetail>;
  createPromotionCode(input: CreatePromotionCodeInput): Promise<PromotionDetail>;
  setPromotionCodeStatus(input: SetPromotionCodeStatusInput): Promise<PromotionDetail>;
  /** ADR-042 §5: the voucher's per-channel limits and POS offline terms (promotions.read). */
  getPromotionChannelPolicies(promotionId: string): Promise<PromotionChannelPoliciesResponse>;
  /** ADR-042 §5: set one channel's limit; POS may add offline terms incl. the D-7 caps (promotions.manage). */
  upsertPromotionChannelPolicy(
    input: UpsertPromotionChannelPolicyInput,
  ): Promise<PromotionChannelPoliciesResponse>;
  upsertPromotionCodeChannelLimit(
    input: UpsertPromotionCodeChannelLimitInput,
  ): Promise<PromotionChannelPoliciesResponse>;
  /** ADR-042 D-2 report: offline voucher discounts honoured without a valid reservation. */
  listOfflineVoucherExceptions(query?: {
    limit?: number;
    offset?: number;
  }): Promise<OfflineVoucherExceptionListResponse>;
  /** ADR-042 D-6: set or change your own POS override password (re-enter POS username + PIN). */
  setPosOverridePassword(input: SetPosOverridePasswordInput): Promise<PosOverridePasswordResponse>;
  /** Offline PIN v2: enrol the caller on a device (no PIN is sent). */
  enrollOfflinePin(input: EnrollOfflinePinInput): Promise<EnrollOfflinePinResponse>;
  revokeOfflinePinEnrollments(
    input: RevokeOfflinePinEnrollmentsInput,
  ): Promise<RevokeOfflinePinEnrollmentsResponse>;
  /** ADR-042 D-6: clear a staff member's override password (staff.manage). */
  clearStaffOverridePassword(
    input: ClearStaffOverridePasswordInput,
  ): Promise<PosOverridePasswordResponse>;
  /**
   * Catalog sales (promotions.read / promotions.manage): per-unit ONLINE price reductions on all items,
   * one collection, or selected products. The lowest matching sale price wins; never stacked.
   */
  listSales(): Promise<SaleListResponse>;
  getSale(saleId: string): Promise<Sale>;
  createSale(input: CreateSaleInput): Promise<Sale>;
  updateSale(input: UpdateSaleInput): Promise<Sale>;
  setSaleStatus(input: SetSaleStatusInput): Promise<Sale>;
  deleteSale(saleId: string): Promise<DeleteSaleResponse>;
  /** Storefront home-page content: hero + featured picks (catalog.author). */
  getStorefrontContent(): Promise<StorefrontContent>;
  updateStorefrontContent(input: UpdateStorefrontContentInput): Promise<StorefrontContent>;
  createStorefrontHeroImageIntent(
    input: CreateStorefrontHeroImageIntentRequest,
  ): Promise<StorefrontHeroImageIntent>;
  /** SDK 0.53: collection covers, category images and product photo editing (catalog.author). */
  createCatalogImageIntent(input: CreateCatalogImageIntentRequest): Promise<CatalogImageIntent>;
  setCollectionImage(input: SetCollectionImageInput): Promise<SetCollectionImageResponse>;
  setCategoryImage(input: SetCategoryImageInput): Promise<SetCategoryImageResponse>;
  listProductMedia(productId: string): Promise<ProductMediaListResponse>;
  updateProductMedia(input: UpdateProductMediaInput): Promise<UpdateProductMediaResponse>;
  reorderProductMedia(input: ReorderProductMediaInput): Promise<ReorderProductMediaResponse>;
  /** SDK 0.52: all other website copy (promo bar, section titles, footer, SEO, contact, pages). */
  getStorefrontSiteText(): Promise<StorefrontSiteText>;
  updateStorefrontSiteText(input: UpdateStorefrontSiteTextInput): Promise<StorefrontSiteText>;
  /** Operational reporting (read-only, tenant-wide, requires reports.read). */
  getReportSummary(query: ReportPeriodQuery): Promise<ReportSummaryResponse>;
  getSalesReport(query: SalesReportQuery): Promise<SalesReportResponse>;
  getProductsReport(query: ProductsReportQuery): Promise<ProductsReportResponse>;
  getInventoryReport(query?: InventoryReportQuery): Promise<InventoryReportResponse>;
  getReturnsReport(query: ReturnsReportQuery): Promise<ReturnsReportResponse>;
  getPromotionsReport(query: PromotionsReportQuery): Promise<PromotionsReportResponse>;
  getSuppliersReport(query: SuppliersReportQuery): Promise<SuppliersReportResponse>;
  /**
   * Downloads a bounded CSV export of one canonical dataset (reports.read). Returns the CSV body plus its
   * media type and filename; the caller saves it directly and never constructs a URL or parses the body.
   */
  exportReport(query: ReportExportQuery): Promise<ReportExportResult>;
  /** Operational settings (tenant-wide; reads require settings.read, writes settings.manage). */
  getBusinessSettings(): Promise<BusinessSettings>;
  updateBusinessSettings(input: UpdateBusinessInput): Promise<BusinessSettings>;
  listBrands(query?: LifecycleListQuery): Promise<BrandListResponse>;
  getBrand(brandId: string): Promise<Brand>;
  createBrand(input: CreateBrandInput): Promise<Brand>;
  updateBrand(input: UpdateBrandInput): Promise<Brand>;
  listBranches(query?: LifecycleListQuery): Promise<BranchListResponse>;
  getBranch(branchId: string): Promise<Branch>;
  createBranch(input: CreateBranchInput): Promise<Branch>;
  updateBranch(input: UpdateBranchInput): Promise<Branch>;
  setBranchBrands(input: SetBranchBrandsInput): Promise<Branch>;
  listWarehouses(query?: LifecycleListQuery): Promise<WarehouseListResponse>;
  getWarehouse(warehouseId: string): Promise<Warehouse>;
  createWarehouse(input: CreateWarehouseInput): Promise<Warehouse>;
  updateWarehouse(input: UpdateWarehouseInput): Promise<Warehouse>;
  listInventoryLocations(
    query?: InventoryLocationListQuery,
  ): Promise<InventoryLocationListResponse>;
  getInventoryLocation(locationId: string): Promise<InventoryLocation>;
  createInventoryLocation(input: CreateInventoryLocationInput): Promise<InventoryLocation>;
  updateInventoryLocation(input: UpdateInventoryLocationInput): Promise<InventoryLocation>;
  listRegisters(query?: RegisterListQuery): Promise<RegisterListResponse>;
  getRegister(registerId: string): Promise<Register>;
  createRegister(input: CreateRegisterInput): Promise<Register>;
  updateRegister(input: UpdateRegisterInput): Promise<Register>;
  listStorefrontSettings(): Promise<StorefrontSettingsListResponse>;
  getStorefrontSettings(brandId: string): Promise<StorefrontSettings>;
  upsertStorefrontSettings(input: UpsertStorefrontSettingsInput): Promise<StorefrontSettings>;
  /** Delivery areas + free-delivery threshold of a brand's Storefront (settings.read). */
  getStorefrontDeliverySettings(brandId: string): Promise<StorefrontDeliverySettings>;
  /** Replace the delivery areas and threshold (settings.manage). */
  updateStorefrontDeliverySettings(
    input: UpdateStorefrontDeliveryInput,
  ): Promise<StorefrontDeliverySettings>;
  getReturnSettings(): Promise<ReturnSettings>;
  updateReturnSettings(input: UpdateReturnSettingsInput): Promise<ReturnSettings>;
  listDevices(query?: DeviceListQuery): Promise<DeviceListResponse>;
  getDevice(deviceId: string): Promise<Device>;
  revokeDevice(input: RevokeDeviceInput): Promise<Device>;
  assignDevice(input: AssignDeviceInput): Promise<Device>;
  enrollPosDevice(input: EnrollPosDeviceInput): Promise<PosDeviceResponse>;
  rotatePosDeviceCredential(input: RotatePosDeviceCredentialInput): Promise<PosDeviceResponse>;
  revokePosDevice(input: RevokePosDeviceInput): Promise<PosDeviceResponse>;
  createOfflineBootstrap(input: OfflineBootstrapInput): Promise<OfflineBootstrapResponse>;
  ingestOfflineCustomerPayment(
    input: IngestOfflineCustomerPaymentInput,
  ): Promise<IngestOfflineCustomerPaymentResponse>;
  ingestOfflineSale(input: IngestOfflineSaleInput): Promise<IngestOfflineSaleResponse>;
  ingestOfflineAttendance(
    input: IngestOfflineAttendanceInput,
  ): Promise<IngestOfflineAttendanceResponse>;
  /** Device-signed offline operation intent; the server returns its final automatic disposition. */
  ingestOfflineIntent(input: IngestOfflineIntentInput): Promise<IngestOfflineIntentResponse>;
  issueOfflineReturnGrant(input: IssueOfflineReturnGrantInput): Promise<OfflineReturnGrantResponse>;
  ingestOfflineReturn(input: IngestOfflineReturnInput): Promise<IngestOfflineReturnResponse>;
  /** ADR-042 §8: device-signed new customer captured offline (duplicates flagged, never merged). */
  ingestOfflineCustomer(input: IngestOfflineCustomerInput): Promise<IngestOfflineCustomerResponse>;
  /** ADR-042 §4.6: terminal hold for an offline sale whose new customer was rejected. */
  ingestOfflineSaleHold(input: IngestOfflineSaleHoldInput): Promise<IngestOfflineSaleHoldResponse>;
}

export interface CommerceClient {
  /**
   * POS-native (pos_pin) connected sign-in: username + PIN. Public — no tenant context or bearer token is
   * required (the credential IS the authentication). Returns a short-lived access token the POS then feeds
   * to `getToken`, plus the operator to render and the tenant it resolved to.
   */
  posPinLogin(input: PosLoginRequest): Promise<PosLoginResponse>;
  checkout(input: CheckoutRequest & { idempotencyKey: string }): Promise<CheckoutResult>;
  /** Non-consuming Storefront pricing quote (no order, no reservation, no redemption). */
  quote(input: StorefrontQuoteRequest): Promise<StorefrontQuoteResponse>;
  getHealth(): Promise<HealthResponse>;
  /** Identity bootstrap: the caller's own selectable tenants (no tenant context required). */
  getMyTenants(): Promise<MeTenantsResponse>;
  /** Returns an immutable client bound to a tenant; the original is unchanged. */
  withTenant(tenantId: string): TenantCommerceClient;
  /**
   * Public Storefront catalog reads. Unauthenticated: no session and no tenant context header. The
   * tenant the storefront serves is an explicit query parameter and only published products are
   * returned.
   */
  listPublishedProducts(query: PublicCatalogListQuery): Promise<PublicProductListResponse>;
  getPublishedProduct(query: PublicProductQuery): Promise<PublicProductDetailResponse>;
  /** Public Storefront collection reads. Unauthenticated; tenant is an explicit query parameter. */
  listPublishedCollections(query: PublicCollectionListQuery): Promise<PublicCollectionListResponse>;
  getPublishedCollection(query: PublicCollectionQuery): Promise<PublicCollectionDetailResponse>;
  /** Public Storefront category tree (active categories with publicly visible products). */
  listStorefrontCategories(query: PublicCategoryListQuery): Promise<PublicCategoryListResponse>;
  /** SDK 0.50: public "shop by brand" list (active vendors with publicly visible products). */
  listStorefrontVendors(query: PublicVendorListQuery): Promise<PublicVendorListResponse>;
  /** SDK 0.46: publicly visible product ids ranked by recent units sold (best first). */
  listStorefrontBestSellers(query: PublicBestSellersQuery): Promise<PublicBestSellersResponse>;
  /** SDK 0.47: public drop-alert sign-up; same answer whether or not already listed. */
  subscribeToStorefront(input: StorefrontSubscribeInput): Promise<StorefrontSubscribeResponse>;
  /** SDK 0.48: public order tracking by number + checkout phone (404 ORDER_NOT_FOUND / 429). */
  trackStorefrontOrder(input: StorefrontOrderLookup): Promise<StorefrontTrackedOrder>;
  /** SDK 0.49: whether the store accepts returns and its admin-editable window (days). */
  getStorefrontReturnPolicy(query: { tenantId: string }): Promise<StorefrontReturnPolicy>;
  /** SDK 0.48: public return request for delivered items; staff decide. */
  requestStorefrontReturn(
    input: StorefrontReturnRequestInput,
  ): Promise<StorefrontReturnRequestResponse>;
  /** Public Storefront home-page content (hero + featured picks). Unauthenticated. */
  getPublicStorefrontContent(query: PublicStorefrontContentQuery): Promise<PublicStorefrontContent>;
  /** SDK 0.52: public editable site text. Missing keys = the website's built-in text. */
  getPublicStorefrontSiteText(query: { tenantId: string }): Promise<PublicStorefrontSiteText>;
  /** Public delivery areas, fees and free-delivery threshold for a Storefront brand. */
  getStorefrontDeliveryOptions(query: PublicDeliveryOptionsQuery): Promise<PublicDeliveryOptions>;
}

export class CommerceSdkError extends Error {}

export class ApiNetworkError extends CommerceSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiNetworkError";
  }
}

export class ApiHttpError extends CommerceSdkError {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
    readonly details?: ReadonlyArray<{
      path: ReadonlyArray<string | number>;
      message: string;
      value?: number;
    }>,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export class ApiContractError extends CommerceSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiContractError";
  }
}

function clientHeaders(client?: ClientMetadata): Record<string, string> {
  return {
    Accept: "application/json",
    ...(client
      ? {
          "X-Client-Type": client.type,
          "X-Client-Version": client.version,
        }
      : {}),
  };
}

function buildQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const serialized = params.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

async function parseHttpError(response: Response): Promise<ApiHttpError> {
  let code = "HTTP_ERROR";
  let message = `Request failed with status ${response.status}`;
  let requestId = response.headers.get("X-Request-Id");
  let details: ApiHttpError["details"];
  try {
    const parsed = ApiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
      requestId = parsed.data.error.requestId;
      details = parsed.data.error.details;
    }
  } catch {
    // Non-JSON or empty error body: keep the status-derived defaults.
  }
  return new ApiHttpError(message, response.status, code, requestId, details);
}

export function createCommerceClient({
  baseUrl,
  client,
  getToken,
  fetch: fetchImplementation = globalThis.fetch,
}: CommerceClientOptions): CommerceClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function authHeaders(): Promise<Record<string, string>> {
    if (getToken === undefined) {
      return {};
    }
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      tenantId?: string;
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...clientHeaders(client),
      ...(await authHeaders()),
      ...(options.tenantId ? { "X-Tenant-Id": options.tenantId } : {}),
      ...(options.idempotencyKey !== undefined
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    };

    let response: Response;
    try {
      response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new ApiNetworkError("Unable to reach the Commerce API", { cause: error });
    }

    if (!response.ok) {
      throw await parseHttpError(response);
    }

    try {
      return schema.parse(await response.json());
    } catch (error) {
      throw new ApiContractError("Response violated the API contract", { cause: error });
    }
  }

  /**
   * Fetches a downloadable document (e.g. a CSV export). Unlike `request`, the successful body is opaque
   * text; the media type and download filename are read from the response headers. Errors still flow
   * through the standard typed error envelope.
   */
  async function requestDocument(
    path: string,
    tenantId: string,
    accept: string,
  ): Promise<ReportExportResult> {
    const headers: Record<string, string> = {
      ...clientHeaders(client),
      ...(await authHeaders()),
      "X-Tenant-Id": tenantId,
      Accept: accept,
    };

    let response: Response;
    try {
      response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
        method: "GET",
        headers,
      });
    } catch (error) {
      throw new ApiNetworkError("Unable to reach the Commerce API", { cause: error });
    }

    if (!response.ok) {
      throw await parseHttpError(response);
    }

    const contentType = response.headers.get("Content-Type") ?? accept;
    const mediaType = contentType.split(";", 1)[0]!.trim();
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filenameMatch = /filename="?([^"]+)"?/u.exec(disposition);
    return {
      body: await response.text(),
      mediaType,
      filename: filenameMatch?.[1] ?? "",
    };
  }

  function withTenant(tenantId: string): TenantCommerceClient {
    return {
      tenantId,
      getContext: () => request("/api/v1/me/context", MeContextResponseSchema, { tenantId }),
      listProducts: (query = {}) =>
        request(
          `/api/v1/products${buildQuery({
            brandId: query.brandId,
            status: query.status,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          ProductListResponseSchema,
          { tenantId },
        ),
      getProduct: (productId: string) =>
        request(`/api/v1/products/${encodeURIComponent(productId)}`, ProductDetailResponseSchema, {
          tenantId,
        }),
      createProduct: ({ idempotencyKey, ...body }: CreateProductInput) =>
        request("/api/v1/products", ProductWriteResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateProduct: ({ idempotencyKey, productId, ...body }: UpdateProductInput) =>
        request(`/api/v1/products/${encodeURIComponent(productId)}`, ProductUpdatedResponseSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      setProductStatus: ({ idempotencyKey, productId, ...body }: SetProductStatusInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/status`,
          ProductWriteResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      publishProduct: ({ idempotencyKey, productId }: PublishProductInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/publication`,
          PublishProductResponseSchema,
          { tenantId, method: "POST", body: {}, idempotencyKey },
        ),
      unpublishProduct: ({ idempotencyKey, productId }: PublishProductInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/publication`,
          UnpublishProductResponseSchema,
          { tenantId, method: "DELETE", body: {}, idempotencyKey },
        ),
      createVariant: ({ idempotencyKey, productId, ...body }: CreateVariantInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/variants`,
          CreateVariantResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      setVariantPrice: ({ idempotencyKey, variantId, ...body }: SetVariantPriceInput) =>
        request(
          `/api/v1/variants/${encodeURIComponent(variantId)}/price`,
          SetVariantPriceResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      setVariantCost: ({ idempotencyKey, variantId, ...body }: SetVariantCostInput) =>
        request(
          `/api/v1/variants/${encodeURIComponent(variantId)}/cost`,
          SetVariantCostResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      createProductMediaUploadIntent: ({
        productId,
        ...body
      }: CreateProductMediaUploadIntentInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media/upload-intent`,
          MediaUploadIntentResponseSchema,
          { tenantId, method: "POST", body },
        ),
      registerProductMedia: ({ idempotencyKey, productId, ...body }: RegisterProductMediaInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media`,
          RegisterProductMediaResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      archiveProductMedia: ({ idempotencyKey, productId, mediaId }: ArchiveProductMediaInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(mediaId)}`,
          ArchiveProductMediaResponseSchema,
          { tenantId, method: "DELETE", body: {}, idempotencyKey },
        ),
      listCollections: () =>
        request("/api/v1/collections", CollectionListResponseSchema, { tenantId }),
      getCollection: (collectionId: string) =>
        request(
          `/api/v1/collections/${encodeURIComponent(collectionId)}`,
          CollectionDetailResponseSchema,
          { tenantId },
        ),
      createCollection: ({ idempotencyKey, ...body }: CreateCollectionInput) =>
        request("/api/v1/collections", CollectionWriteResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateCollection: ({ idempotencyKey, collectionId, ...body }: UpdateCollectionInput) =>
        request(
          `/api/v1/collections/${encodeURIComponent(collectionId)}`,
          CollectionUpdatedResponseSchema,
          { tenantId, method: "PATCH", body, idempotencyKey },
        ),
      setCollectionStatus: ({ idempotencyKey, collectionId, ...body }: SetCollectionStatusInput) =>
        request(
          `/api/v1/collections/${encodeURIComponent(collectionId)}/status`,
          CollectionWriteResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      setCollectionProducts: ({
        idempotencyKey,
        collectionId,
        ...body
      }: SetCollectionProductsInput) =>
        request(
          `/api/v1/collections/${encodeURIComponent(collectionId)}/products`,
          SetCollectionProductsResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      setVariantOptions: ({
        idempotencyKey,
        productId,
        variantId,
        ...body
      }: SetVariantOptionsInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}/options`,
          SetVariantOptionsResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      updateOptionValues: ({ idempotencyKey, productId, ...body }: UpdateOptionValuesInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/option-values`,
          UpdateOptionValuesResponseSchema,
          { tenantId, method: "PATCH", body, idempotencyKey },
        ),
      listCategories: () => request("/api/v1/categories", CategoryListResponseSchema, { tenantId }),
      createCategory: ({ idempotencyKey, ...body }: CreateCategoryInput) =>
        request("/api/v1/categories", CategoryWriteResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateCategory: ({ idempotencyKey, categoryId, ...body }: UpdateCategoryInput) =>
        request(
          `/api/v1/categories/${encodeURIComponent(categoryId)}`,
          CategoryUpdatedResponseSchema,
          { tenantId, method: "PATCH", body, idempotencyKey },
        ),
      setCategoryStatus: ({ idempotencyKey, categoryId, ...body }: SetCategoryStatusInput) =>
        request(
          `/api/v1/categories/${encodeURIComponent(categoryId)}/status`,
          CategoryWriteResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      setCategorySizeGuide: ({ idempotencyKey, categoryId, ...body }: SetCategorySizeGuideInput) =>
        request(
          `/api/v1/categories/${encodeURIComponent(categoryId)}/size-guide`,
          SetCategorySizeGuideResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      listSubscribers: (query: { limit?: number } = {}) =>
        request(
          `/api/v1/subscribers${buildQuery({ limit: query.limit })}`,
          SubscriberListResponseSchema,
          { tenantId },
        ),
      listReturnRequests: (query: ReturnRequestListInput = {}) =>
        request(
          `/api/v1/return-requests${buildQuery({
            status: query.status,
            orderId: query.orderId,
            limit: query.limit,
          })}`,
          ReturnRequestListResponseSchema,
          { tenantId },
        ),
      updateReturnRequestStatus: ({
        idempotencyKey,
        requestId,
        ...body
      }: UpdateReturnRequestStatusInput) =>
        request(
          `/api/v1/return-requests/${encodeURIComponent(requestId)}/status`,
          ReturnRequestSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      setProductCategories: ({ idempotencyKey, productId, ...body }: SetProductCategoriesInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/categories`,
          SetProductCategoriesResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      listVendors: () => request("/api/v1/vendors", VendorListResponseSchema, { tenantId }),
      createVendor: ({ idempotencyKey, ...body }: CreateVendorInput) =>
        request("/api/v1/vendors", VendorWriteResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateVendor: ({ idempotencyKey, vendorId, ...body }: UpdateVendorInput) =>
        request(`/api/v1/vendors/${encodeURIComponent(vendorId)}`, VendorUpdatedResponseSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      setVendorStatus: ({ idempotencyKey, vendorId, ...body }: SetVendorStatusInput) =>
        request(
          `/api/v1/vendors/${encodeURIComponent(vendorId)}/status`,
          VendorWriteResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      setProductVendor: ({ idempotencyKey, productId, ...body }: SetProductVendorInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/vendor`,
          SetProductVendorResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      listInventory: (query = {}) =>
        request(
          `/api/v1/inventory${buildQuery({
            inventoryLocationId: query.inventoryLocationId,
            variantId: query.variantId,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          InventoryListResponseSchema,
          { tenantId },
        ),
      listSuppliers: (query: SupplierListQuery = {}) =>
        request(
          `/api/v1/suppliers${buildQuery({ search: query.search, status: query.status, limit: query.limit, cursor: query.cursor })}`,
          SupplierListResponseSchema,
          { tenantId },
        ),
      getSupplier: (supplierId: string) =>
        request(`/api/v1/suppliers/${encodeURIComponent(supplierId)}`, SupplierSchema, {
          tenantId,
        }),
      createSupplier: ({ idempotencyKey, ...body }: CreateSupplierInput) =>
        request("/api/v1/suppliers", SupplierSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateSupplier: ({ supplierId, idempotencyKey, ...body }: UpdateSupplierInput) =>
        request(`/api/v1/suppliers/${encodeURIComponent(supplierId)}`, SupplierSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      listSupplierReceipts: (supplierId: string, query: SupplierReceiptsQuery = {}) =>
        request(
          `/api/v1/suppliers/${encodeURIComponent(supplierId)}/receipts${buildQuery({ limit: query.limit, cursor: query.cursor })}`,
          SupplierReceiptsResponseSchema,
          { tenantId },
        ),
      recordSupplierPurchase: ({ idempotencyKey, ...body }: RecordSupplierPurchaseInput) =>
        request("/api/v1/suppliers/purchases", SupplierPurchaseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      listSupplierPurchases: (query: SupplierPurchasesQuery = {}) =>
        request(
          `/api/v1/suppliers/purchases${buildQuery({ supplierId: query.supplierId, limit: query.limit, cursor: query.cursor })}`,
          SupplierPurchasesResponseSchema,
          { tenantId },
        ),
      supplierPurchaseItems: (purchaseId: string) =>
        request(
          `/api/v1/suppliers/purchases/${encodeURIComponent(purchaseId)}/items`,
          SupplierPurchaseItemsResponseSchema,
          { tenantId },
        ),
      recordSupplierPayment: ({
        supplierId,
        idempotencyKey,
        ...body
      }: RecordSupplierPaymentInput) =>
        request(
          `/api/v1/suppliers/${encodeURIComponent(supplierId)}/payments`,
          SupplierPaymentSchema,
          {
            tenantId,
            method: "POST",
            body,
            idempotencyKey,
          },
        ),
      listSupplierPayments: (supplierId: string, query: SupplierReceiptsQuery = {}) =>
        request(
          `/api/v1/suppliers/${encodeURIComponent(supplierId)}/payments${buildQuery({ limit: query.limit, cursor: query.cursor })}`,
          SupplierPaymentsResponseSchema,
          { tenantId },
        ),
      supplierDues: () =>
        request("/api/v1/suppliers/dues", SupplierDuesResponseSchema, { tenantId }),
      listSupplierReminders: (query: SupplierRemindersQuery = {}) =>
        request(
          `/api/v1/suppliers/reminders${buildQuery({ supplierId: query.supplierId, status: query.status, dueOnly: query.dueOnly === undefined ? undefined : query.dueOnly ? "true" : "false" })}`,
          SupplierRemindersResponseSchema,
          { tenantId },
        ),
      createSupplierReminder: ({ idempotencyKey, ...body }: CreateSupplierReminderInput) =>
        request("/api/v1/suppliers/reminders", SupplierReminderSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateSupplierReminder: ({
        reminderId,
        idempotencyKey,
        ...body
      }: UpdateSupplierReminderInput) =>
        request(
          `/api/v1/suppliers/reminders/${encodeURIComponent(reminderId)}`,
          SupplierReminderSchema,
          {
            tenantId,
            method: "PATCH",
            body,
            idempotencyKey,
          },
        ),
      deleteSupplierReminder: ({
        reminderId,
        idempotencyKey,
      }: {
        reminderId: string;
        idempotencyKey: string;
      }) =>
        request(
          `/api/v1/suppliers/reminders/${encodeURIComponent(reminderId)}`,
          DeleteSupplierReminderResponseSchema,
          { tenantId, method: "DELETE", body: {}, idempotencyKey },
        ),
      listStaff: (query: StaffListQuery = {}) =>
        request(
          `/api/v1/staff${buildQuery({ search: query.search, status: query.status, roleId: query.roleId, limit: query.limit, cursor: query.cursor })}`,
          StaffListResponseSchema,
          { tenantId },
        ),
      findEligibleStaffIdentitiesByEmail: (lookup: EligibleStaffIdentityLookup) =>
        request(
          `/api/v1/staff/eligible-identities${buildQuery({ email: lookup.email })}`,
          EligibleIdentitiesResponseSchema,
          { tenantId },
        ),
      listAssignableStaffRoles: (query: AssignmentCatalogQuery = {}) =>
        request(
          `/api/v1/staff/assignable-roles${buildQuery({ limit: query.limit, cursor: query.cursor })}`,
          AssignableStaffRolesResponseSchema,
          { tenantId },
        ),
      listAssignableStaffScopes: (query: AssignmentCatalogQuery = {}) =>
        request(
          `/api/v1/staff/assignable-scopes${buildQuery({ limit: query.limit, cursor: query.cursor })}`,
          AssignableStaffScopesResponseSchema,
          { tenantId },
        ),
      getStaffMember: (membershipId: string) =>
        request(`/api/v1/staff/${encodeURIComponent(membershipId)}`, StaffDetailSchema, {
          tenantId,
        }),
      createStaff: ({ idempotencyKey, ...body }: CreateStaffInput) =>
        request("/api/v1/staff", StaffDetailSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      createStaffWithoutLogin: ({ idempotencyKey, ...body }: CreateStaffWithoutLoginInput) =>
        request("/api/v1/staff/without-login", StaffDetailSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      createStaffLogin: ({ idempotencyKey, ...body }: CreateStaffLoginInput) =>
        request("/api/v1/staff/logins", StaffDetailSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      listPosLogins: () =>
        request("/api/v1/pos/staff-logins", PosLoginListResponseSchema, { tenantId }),
      createPosLogin: ({ idempotencyKey, ...body }: CreatePosLoginInput) =>
        request("/api/v1/pos/staff-logins", StaffDetailSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updatePosLogin: ({ membershipId, idempotencyKey, ...body }: UpdatePosLoginInput) =>
        request(`/api/v1/pos/staff-logins/${encodeURIComponent(membershipId)}`, StaffDetailSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      setPosLoginPin: ({ membershipId, idempotencyKey, ...body }: SetPosLoginPinInput) =>
        request(
          `/api/v1/pos/staff-logins/${encodeURIComponent(membershipId)}/pin`,
          SetPosLoginPinResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      setStaffOfflinePin: ({ membershipId, idempotencyKey, ...body }: SetStaffOfflinePinInput) =>
        request(
          `/api/v1/staff/${encodeURIComponent(membershipId)}/offline-pin`,
          SetStaffOfflinePinResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      updateStaffStatus: ({ membershipId, idempotencyKey, ...body }: UpdateStaffStatusInput) =>
        request(`/api/v1/staff/${encodeURIComponent(membershipId)}`, StaffDetailSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      updateStaffProfile: ({ membershipId, idempotencyKey, ...body }: UpdateStaffProfileInput) =>
        request(`/api/v1/staff/${encodeURIComponent(membershipId)}/profile`, StaffDetailSchema, {
          tenantId,
          method: "PUT",
          body,
          idempotencyKey,
        }),
      assignStaffRole: ({ membershipId, idempotencyKey, ...body }: AssignStaffRoleInput) =>
        request(
          `/api/v1/staff/${encodeURIComponent(membershipId)}/role-assignments`,
          StaffDetailSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      unassignStaffRole: ({
        membershipId,
        assignmentId,
        idempotencyKey,
        ...body
      }: UnassignStaffRoleInput) =>
        request(
          `/api/v1/staff/${encodeURIComponent(membershipId)}/role-assignments/${encodeURIComponent(assignmentId)}`,
          StaffDetailSchema,
          { tenantId, method: "DELETE", body, idempotencyKey },
        ),
      clockIn: (input: ClockInInput = {}) =>
        request("/api/v1/attendance/clock-in", AttendanceClockResponseSchema, {
          tenantId,
          method: "POST",
          body: input,
        }),
      clockOut: () =>
        request("/api/v1/attendance/clock-out", AttendanceClockResponseSchema, {
          tenantId,
          method: "POST",
          body: {},
        }),
      getMyAttendance: (query: MyAttendanceQuery = {}) =>
        request(
          `/api/v1/attendance/me${buildQuery({ limit: query.limit })}`,
          MyAttendanceResponseSchema,
          { tenantId },
        ),
      listAttendance: (query: AttendanceListQuery = {}) =>
        request(
          `/api/v1/attendance${buildQuery({ membershipId: query.membershipId, branchId: query.branchId, limit: query.limit, cursor: query.cursor })}`,
          AttendanceListResponseSchema,
          { tenantId },
        ),
      getPayrollReport: (range: AttendanceDateRange) =>
        request(
          `/api/v1/attendance/payroll${buildQuery({ from: range.from, to: range.to })}`,
          PayrollReportResponseSchema,
          { tenantId },
        ),
      getPayrollSettings: () =>
        request("/api/v1/attendance/settings", PayrollSettingsSchema, { tenantId }),
      updatePayrollSettings: (input: UpdatePayrollSettingsRequest) =>
        request("/api/v1/attendance/settings", PayrollSettingsSchema, {
          tenantId,
          method: "PUT",
          body: input,
        }),
      getPayrollCycleSettings: () =>
        request("/api/v1/attendance/payroll-cycle", PayrollCycleSettingsSchema, { tenantId }),
      updatePayrollCycleSettings: (input: PayrollCycleSettings) =>
        request("/api/v1/attendance/payroll-cycle", PayrollCycleSettingsSchema, {
          tenantId,
          method: "PUT",
          body: input,
        }),
      getPayrollDue: () =>
        request("/api/v1/attendance/payroll-cycle/due", PayrollDueSchema, { tenantId }),
      markPayrollPaid: (input: MarkPayrollPaidRequest = {}) =>
        request("/api/v1/attendance/payroll-cycle/pay", PayrollDueSchema, {
          tenantId,
          method: "POST",
          body: input,
        }),
      getCompensation: (membershipId: string) =>
        request(
          `/api/v1/attendance/compensation/${encodeURIComponent(membershipId)}`,
          EmployeeCompensationSchema.nullable(),
          { tenantId },
        ),
      setCompensation: ({ membershipId, ...body }: SetCompensationInput) =>
        request(
          `/api/v1/attendance/compensation/${encodeURIComponent(membershipId)}`,
          EmployeeCompensationSchema,
          { tenantId, method: "PUT", body },
        ),
      listAdjustments: (range: AttendanceDateRange) =>
        request(
          `/api/v1/attendance/adjustments${buildQuery({ from: range.from, to: range.to })}`,
          AdjustmentListResponseSchema,
          { tenantId },
        ),
      createAdjustment: (input: CreateAdjustmentInput) =>
        request("/api/v1/attendance/adjustments", AdjustmentSchema, {
          tenantId,
          method: "POST",
          body: input,
        }),
      removeAdjustment: (adjustmentId: string) =>
        request(
          `/api/v1/attendance/adjustments/${encodeURIComponent(adjustmentId)}`,
          AttendanceDeletedResponseSchema,
          { tenantId, method: "DELETE", body: {} },
        ),
      addAttendanceEntry: (input: CreateAttendanceEntryRequest) =>
        request("/api/v1/attendance/entries", AttendanceClockResponseSchema, {
          tenantId,
          method: "POST",
          body: input,
        }),
      updateAttendanceEntry: ({ entryId, ...body }: UpdateAttendanceEntryInput) =>
        request(
          `/api/v1/attendance/entries/${encodeURIComponent(entryId)}`,
          AttendanceClockResponseSchema,
          { tenantId, method: "PATCH", body },
        ),
      removeAttendanceEntry: (entryId: string) =>
        request(
          `/api/v1/attendance/entries/${encodeURIComponent(entryId)}`,
          AttendanceDeletedResponseSchema,
          { tenantId, method: "DELETE", body: {} },
        ),
      listLeaves: (range: AttendanceDateRange) =>
        request(
          `/api/v1/attendance/leaves${buildQuery({ from: range.from, to: range.to })}`,
          LeaveListResponseSchema,
          { tenantId },
        ),
      startLeave: (input: ClockInInput = {}) =>
        request("/api/v1/attendance/leave/start", LeaveClockResponseSchema, {
          tenantId,
          method: "POST",
          body: input,
        }),
      endLeave: () =>
        request("/api/v1/attendance/leave/end", LeaveClockResponseSchema, {
          tenantId,
          method: "POST",
          body: {},
        }),
      receiveInventory: ({ idempotencyKey, ...body }: ReceiveInventoryInput) =>
        request("/api/v1/inventory/receipts", ReceiveInventoryResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      adjustInventory: ({ idempotencyKey, ...body }: AdjustInventoryInput) =>
        request("/api/v1/inventory/adjustments", AdjustInventoryResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      getInventoryChannels: (query: { inventoryLocationId: string }) =>
        request(
          `/api/v1/inventory/channels${buildQuery({ inventoryLocationId: query.inventoryLocationId })}`,
          InventoryChannelStateResponseSchema,
          { tenantId },
        ),
      initializeInventoryChannels: ({
        idempotencyKey,
        ...body
      }: InitializeInventoryChannelsInput) =>
        request(
          "/api/v1/inventory/channels/initialize",
          InitializeInventoryChannelsResponseSchema,
          {
            tenantId,
            method: "POST",
            body,
            idempotencyKey,
          },
        ),
      allocateInventoryChannels: ({ idempotencyKey, ...body }: AllocateInventoryChannelsInput) =>
        request("/api/v1/inventory/channels/allocations", AllocateInventoryChannelsResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      transferInventory: ({ idempotencyKey, ...body }: TransferInventoryInput) =>
        request("/api/v1/inventory/transfers", TransferInventoryResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      listOrders: (query = {}) =>
        request(
          `/api/v1/orders${buildQuery({
            channel: query.channel,
            brandId: query.brandId,
            branchId: query.branchId,
            status: query.status,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          OrderListResponseSchema,
          { tenantId },
        ),
      getOrder: (orderId: string) =>
        request(`/api/v1/orders/${encodeURIComponent(orderId)}`, OrderDetailResponseSchema, {
          tenantId,
        }),
      fulfillOrder: ({ orderId, idempotencyKey, ...body }: FulfillOrderInput) =>
        request(
          `/api/v1/orders/${encodeURIComponent(orderId)}/fulfillments`,
          OrderDetailResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      cancelOrder: ({ orderId, idempotencyKey, ...body }: CancelOrderInput) =>
        request(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, OrderDetailResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      listCustomers: (query = {}) =>
        request(
          `/api/v1/customers${buildQuery({
            search: query.search,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          CustomerListResponseSchema,
          { tenantId },
        ),
      getCustomer: (customerId: string) =>
        request(
          `/api/v1/customers/${encodeURIComponent(customerId)}`,
          CustomerDetailResponseSchema,
          { tenantId },
        ),
      listCustomerOrders: (customerId: string, query = {}) =>
        request(
          `/api/v1/customers/${encodeURIComponent(customerId)}/orders${buildQuery(query)}`,
          CustomerOrdersResponseSchema,
          { tenantId },
        ),
      lookupCustomerByPhone: (phone: string) =>
        request(`/api/v1/customers/lookup${buildQuery({ phone })}`, CustomerLookupResponseSchema, {
          tenantId,
        }),
      recordCustomerPayment: ({
        customerId,
        idempotencyKey,
        ...body
      }: RecordCustomerPaymentInput) =>
        request(
          `/api/v1/customers/${encodeURIComponent(customerId)}/payments`,
          RecordCustomerPaymentResponseSchema,
          {
            tenantId,
            method: "POST",
            body,
            idempotencyKey,
          },
        ),
      listCustomerPayments: (customerId: string) =>
        request(
          `/api/v1/customers/${encodeURIComponent(customerId)}/payments`,
          CustomerPaymentsResponseSchema,
          { tenantId },
        ),
      listCustomerDues: () =>
        request("/api/v1/customers/dues", CustomerDuesResponseSchema, { tenantId }),
      getPosContext: () => request("/api/v1/pos/context", PosContextResponseSchema, { tenantId }),
      listPosSyncConflicts: (query: ListPosSyncConflictsInput = {}) =>
        request(
          `/api/v1/pos/sync-conflicts${buildQuery({
            registerId: query.registerId,
            kind: query.kind,
            status: query.status,
            limit: query.limit,
          })}`,
          ListPosSyncConflictsResponseSchema,
          { tenantId },
        ),
      getPosAvailability: (registerId: string) =>
        request(
          `/api/v1/pos/availability?registerId=${encodeURIComponent(registerId)}`,
          PosAvailabilityResponseSchema,
          { tenantId },
        ),
      getReturnEligibility: (orderId: string) =>
        request(
          `/api/v1/orders/${encodeURIComponent(orderId)}/return-eligibility`,
          ReturnEligibilityResponseSchema,
          { tenantId },
        ),
      listReturns: (orderId: string, query = {}) =>
        request(
          `/api/v1/orders/${encodeURIComponent(orderId)}/returns${buildQuery(query)}`,
          ReturnHistoryResponseSchema,
          { tenantId },
        ),
      getReturn: (returnId: string) =>
        request(`/api/v1/returns/${encodeURIComponent(returnId)}`, ReturnDetailResponseSchema, {
          tenantId,
        }),
      createReturn: ({ orderId, idempotencyKey, ...body }: CreateReturnInput) =>
        request(
          `/api/v1/orders/${encodeURIComponent(orderId)}/returns`,
          ReturnDetailResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      settleRefund: ({ returnId, idempotencyKey, ...body }: SettleRefundInput) =>
        request(
          `/api/v1/returns/${encodeURIComponent(returnId)}/refund`,
          ReturnDetailResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      posQuote: (body: PosQuoteRequest) =>
        request("/api/v1/pos/quote", PosQuoteResponseSchema, { tenantId, method: "POST", body }),
      createPosSale: ({ idempotencyKey, ...body }: CreatePosSaleInput) =>
        request("/api/v1/pos/sales", CreatePosSaleResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      listPromotions: (query: PromotionListQueryInput = {}) =>
        request(
          `/api/v1/promotions${buildQuery({ limit: query.limit, offset: query.offset })}`,
          PromotionListResponseSchema,
          { tenantId },
        ),
      getPromotion: (promotionId: string) =>
        request(`/api/v1/promotions/${encodeURIComponent(promotionId)}`, PromotionDetailSchema, {
          tenantId,
        }),
      createPromotion: ({ idempotencyKey, ...body }: CreatePromotionInput) =>
        request("/api/v1/promotions", PromotionDetailSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updatePromotion: ({ promotionId, idempotencyKey, ...body }: UpdatePromotionInput) =>
        request(`/api/v1/promotions/${encodeURIComponent(promotionId)}`, PromotionDetailSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      deletePromotion: (promotionId: string) =>
        request(
          `/api/v1/promotions/${encodeURIComponent(promotionId)}`,
          DeletePromotionResponseSchema,
          { tenantId, method: "DELETE" },
        ),
      setPromotionStatus: ({ promotionId, idempotencyKey, ...body }: SetPromotionStatusInput) =>
        request(
          `/api/v1/promotions/${encodeURIComponent(promotionId)}/status`,
          PromotionDetailSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      createPromotionCode: ({ promotionId, idempotencyKey, ...body }: CreatePromotionCodeInput) =>
        request(
          `/api/v1/promotions/${encodeURIComponent(promotionId)}/codes`,
          PromotionDetailSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      getPromotionChannelPolicies: (promotionId: string) =>
        request(
          `/api/v1/promotions/${encodeURIComponent(promotionId)}/channel-policies`,
          PromotionChannelPoliciesResponseSchema,
          { tenantId },
        ),
      upsertPromotionChannelPolicy: ({
        promotionId,
        channel,
        idempotencyKey,
        ...body
      }: UpsertPromotionChannelPolicyInput) =>
        request(
          `/api/v1/promotions/${encodeURIComponent(promotionId)}/channel-policies/${encodeURIComponent(channel)}`,
          PromotionChannelPoliciesResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      upsertPromotionCodeChannelLimit: ({
        codeId,
        channel,
        idempotencyKey,
        ...body
      }: UpsertPromotionCodeChannelLimitInput) =>
        request(
          `/api/v1/promotions/codes/${encodeURIComponent(codeId)}/channel-limits/${encodeURIComponent(channel)}`,
          PromotionChannelPoliciesResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      listOfflineVoucherExceptions: (query: { limit?: number; offset?: number } = {}) =>
        request(
          `/api/v1/promotions/offline-exceptions${buildQuery({ limit: query.limit, offset: query.offset })}`,
          OfflineVoucherExceptionListResponseSchema,
          { tenantId },
        ),
      enrollOfflinePin: ({ idempotencyKey, ...body }: EnrollOfflinePinInput) =>
        request("/api/v1/pos/offline-pin-enrollments", EnrollOfflinePinResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      revokeOfflinePinEnrollments: ({
        idempotencyKey,
        ...body
      }: RevokeOfflinePinEnrollmentsInput) =>
        request(
          "/api/v1/pos/offline-pin-enrollments/revoke",
          RevokeOfflinePinEnrollmentsResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      setPosOverridePassword: ({ idempotencyKey, ...body }: SetPosOverridePasswordInput) =>
        request("/api/v1/pos/override-password", PosOverridePasswordResponseSchema, {
          tenantId,
          method: "PUT",
          body,
          idempotencyKey,
        }),
      clearStaffOverridePassword: ({
        membershipId,
        idempotencyKey,
      }: ClearStaffOverridePasswordInput) =>
        request(
          `/api/v1/staff/${encodeURIComponent(membershipId)}/override-password`,
          PosOverridePasswordResponseSchema,
          { tenantId, method: "DELETE", body: {}, idempotencyKey },
        ),
      setPromotionCodeStatus: ({ codeId, idempotencyKey, ...body }: SetPromotionCodeStatusInput) =>
        request(
          `/api/v1/promotions/codes/${encodeURIComponent(codeId)}/status`,
          PromotionDetailSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      listSales: () => request("/api/v1/sales", SaleListResponseSchema, { tenantId }),
      getSale: (saleId: string) =>
        request(`/api/v1/sales/${encodeURIComponent(saleId)}`, SaleSchema, { tenantId }),
      createSale: ({ idempotencyKey, ...body }: CreateSaleInput) =>
        request("/api/v1/sales", SaleSchema, { tenantId, method: "POST", body, idempotencyKey }),
      updateSale: ({ saleId, idempotencyKey, ...body }: UpdateSaleInput) =>
        request(`/api/v1/sales/${encodeURIComponent(saleId)}`, SaleSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      setSaleStatus: ({ saleId, idempotencyKey, ...body }: SetSaleStatusInput) =>
        request(`/api/v1/sales/${encodeURIComponent(saleId)}/status`, SaleSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      deleteSale: (saleId: string) =>
        request(`/api/v1/sales/${encodeURIComponent(saleId)}`, DeleteSaleResponseSchema, {
          tenantId,
          method: "DELETE",
        }),
      getStorefrontContent: () =>
        request("/api/v1/storefront-content", StorefrontContentSchema, { tenantId }),
      updateStorefrontContent: ({ idempotencyKey, ...body }: UpdateStorefrontContentInput) =>
        request("/api/v1/storefront-content", StorefrontContentSchema, {
          tenantId,
          method: "PUT",
          body,
          idempotencyKey,
        }),
      createCatalogImageIntent: (body: CreateCatalogImageIntentRequest) =>
        request("/api/v1/catalog-images/upload-intent", CatalogImageIntentSchema, {
          tenantId,
          method: "POST",
          body,
        }),
      setCollectionImage: ({ collectionId, image, idempotencyKey }: SetCollectionImageInput) =>
        request(
          `/api/v1/collections/${encodeURIComponent(collectionId)}/image`,
          SetCollectionImageResponseSchema,
          { tenantId, method: "PUT", body: { image }, idempotencyKey },
        ),
      setCategoryImage: ({ categoryId, image, idempotencyKey }: SetCategoryImageInput) =>
        request(
          `/api/v1/categories/${encodeURIComponent(categoryId)}/image`,
          SetCategoryImageResponseSchema,
          { tenantId, method: "PUT", body: { image }, idempotencyKey },
        ),
      listProductMedia: (productId: string) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media`,
          ProductMediaListResponseSchema,
          { tenantId },
        ),
      updateProductMedia: ({
        productId,
        mediaId,
        idempotencyKey,
        ...body
      }: UpdateProductMediaInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(mediaId)}`,
          UpdateProductMediaResponseSchema,
          { tenantId, method: "PATCH", body, idempotencyKey },
        ),
      reorderProductMedia: ({ productId, mediaIds, idempotencyKey }: ReorderProductMediaInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media/order`,
          ReorderProductMediaResponseSchema,
          { tenantId, method: "PUT", body: { mediaIds }, idempotencyKey },
        ),
      getStorefrontSiteText: () =>
        request("/api/v1/storefront-site-text", StorefrontSiteTextSchema, { tenantId }),
      updateStorefrontSiteText: ({ idempotencyKey, siteText }: UpdateStorefrontSiteTextInput) =>
        request("/api/v1/storefront-site-text", StorefrontSiteTextSchema, {
          tenantId,
          method: "PUT",
          body: { siteText },
          idempotencyKey,
        }),
      createStorefrontHeroImageIntent: (body: CreateStorefrontHeroImageIntentRequest) =>
        request("/api/v1/storefront-content/hero-image-intent", StorefrontHeroImageIntentSchema, {
          tenantId,
          method: "POST",
          body,
        }),
      getReportSummary: (query: ReportPeriodQuery) =>
        request(
          `/api/v1/reports/summary${buildQuery({ startDate: query.startDate, endDate: query.endDate })}`,
          ReportSummaryResponseSchema,
          { tenantId },
        ),
      getSalesReport: (query: SalesReportQuery) =>
        request(
          `/api/v1/reports/sales${buildQuery({
            startDate: query.startDate,
            endDate: query.endDate,
            view: query.view,
            bucket: query.bucket,
          })}`,
          SalesReportResponseSchema,
          { tenantId },
        ),
      getProductsReport: (query: ProductsReportQuery) =>
        request(
          `/api/v1/reports/products${buildQuery({
            startDate: query.startDate,
            endDate: query.endDate,
            level: query.level,
            view: query.view,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          ProductsReportResponseSchema,
          { tenantId },
        ),
      getInventoryReport: (query: InventoryReportQuery = {}) =>
        request(
          `/api/v1/reports/inventory${buildQuery({
            view: query.view,
            startDate: query.startDate,
            endDate: query.endDate,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          InventoryReportResponseSchema,
          { tenantId },
        ),
      getReturnsReport: (query: ReturnsReportQuery) =>
        request(
          `/api/v1/reports/returns${buildQuery({
            startDate: query.startDate,
            endDate: query.endDate,
            view: query.view,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          ReturnsReportResponseSchema,
          { tenantId },
        ),
      getPromotionsReport: (query: PromotionsReportQuery) =>
        request(
          `/api/v1/reports/promotions${buildQuery({ startDate: query.startDate, endDate: query.endDate })}`,
          PromotionsReportResponseSchema,
          { tenantId },
        ),
      getSuppliersReport: (query: SuppliersReportQuery) =>
        request(
          `/api/v1/reports/suppliers${buildQuery({
            startDate: query.startDate,
            endDate: query.endDate,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          SuppliersReportResponseSchema,
          { tenantId },
        ),
      exportReport: (query: ReportExportQuery) =>
        requestDocument(
          `/api/v1/reports/export${buildQuery({
            dataset: query.dataset,
            startDate: query.startDate,
            endDate: query.endDate,
            level: query.level,
          })}`,
          tenantId,
          "text/csv",
        ),
      getBusinessSettings: () =>
        request("/api/v1/settings/business", BusinessSettingsSchema, { tenantId }),
      updateBusinessSettings: ({ idempotencyKey, ...body }: UpdateBusinessInput) =>
        request("/api/v1/settings/business", BusinessSettingsSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      listBrands: (query: LifecycleListQuery = {}) =>
        request(
          `/api/v1/settings/brands${buildQuery({ status: query.status, limit: query.limit, cursor: query.cursor })}`,
          BrandListResponseSchema,
          { tenantId },
        ),
      getBrand: (brandId: string) =>
        request(`/api/v1/settings/brands/${encodeURIComponent(brandId)}`, BrandSchema, {
          tenantId,
        }),
      createBrand: ({ idempotencyKey, ...body }: CreateBrandInput) =>
        request("/api/v1/settings/brands", BrandSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateBrand: ({ brandId, idempotencyKey, ...body }: UpdateBrandInput) =>
        request(`/api/v1/settings/brands/${encodeURIComponent(brandId)}`, BrandSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      listBranches: (query: LifecycleListQuery = {}) =>
        request(
          `/api/v1/settings/branches${buildQuery({ status: query.status, limit: query.limit, cursor: query.cursor })}`,
          BranchListResponseSchema,
          { tenantId },
        ),
      getBranch: (branchId: string) =>
        request(`/api/v1/settings/branches/${encodeURIComponent(branchId)}`, BranchSchema, {
          tenantId,
        }),
      createBranch: ({ idempotencyKey, ...body }: CreateBranchInput) =>
        request("/api/v1/settings/branches", BranchSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateBranch: ({ branchId, idempotencyKey, ...body }: UpdateBranchInput) =>
        request(`/api/v1/settings/branches/${encodeURIComponent(branchId)}`, BranchSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      setBranchBrands: ({ branchId, idempotencyKey, ...body }: SetBranchBrandsInput) =>
        request(`/api/v1/settings/branches/${encodeURIComponent(branchId)}/brands`, BranchSchema, {
          tenantId,
          method: "PUT",
          body,
          idempotencyKey,
        }),
      listWarehouses: (query: LifecycleListQuery = {}) =>
        request(
          `/api/v1/settings/warehouses${buildQuery({ status: query.status, limit: query.limit, cursor: query.cursor })}`,
          WarehouseListResponseSchema,
          { tenantId },
        ),
      getWarehouse: (warehouseId: string) =>
        request(`/api/v1/settings/warehouses/${encodeURIComponent(warehouseId)}`, WarehouseSchema, {
          tenantId,
        }),
      createWarehouse: ({ idempotencyKey, ...body }: CreateWarehouseInput) =>
        request("/api/v1/settings/warehouses", WarehouseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateWarehouse: ({ warehouseId, idempotencyKey, ...body }: UpdateWarehouseInput) =>
        request(`/api/v1/settings/warehouses/${encodeURIComponent(warehouseId)}`, WarehouseSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      listInventoryLocations: (query: InventoryLocationListQuery = {}) =>
        request(
          `/api/v1/settings/inventory-locations${buildQuery({ status: query.status, branchId: query.branchId, warehouseId: query.warehouseId, limit: query.limit, cursor: query.cursor })}`,
          InventoryLocationListResponseSchema,
          { tenantId },
        ),
      getInventoryLocation: (locationId: string) =>
        request(
          `/api/v1/settings/inventory-locations/${encodeURIComponent(locationId)}`,
          InventoryLocationSchema,
          { tenantId },
        ),
      createInventoryLocation: ({ idempotencyKey, ...body }: CreateInventoryLocationInput) =>
        request("/api/v1/settings/inventory-locations", InventoryLocationSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateInventoryLocation: ({
        locationId,
        idempotencyKey,
        ...body
      }: UpdateInventoryLocationInput) =>
        request(
          `/api/v1/settings/inventory-locations/${encodeURIComponent(locationId)}`,
          InventoryLocationSchema,
          { tenantId, method: "PATCH", body, idempotencyKey },
        ),
      listRegisters: (query: RegisterListQuery = {}) =>
        request(
          `/api/v1/settings/registers${buildQuery({ status: query.status, branchId: query.branchId, limit: query.limit, cursor: query.cursor })}`,
          RegisterListResponseSchema,
          { tenantId },
        ),
      getRegister: (registerId: string) =>
        request(`/api/v1/settings/registers/${encodeURIComponent(registerId)}`, RegisterSchema, {
          tenantId,
        }),
      createRegister: ({ idempotencyKey, ...body }: CreateRegisterInput) =>
        request("/api/v1/settings/registers", RegisterSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateRegister: ({ registerId, idempotencyKey, ...body }: UpdateRegisterInput) =>
        request(`/api/v1/settings/registers/${encodeURIComponent(registerId)}`, RegisterSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      listStorefrontSettings: () =>
        request("/api/v1/settings/storefront", StorefrontSettingsListResponseSchema, { tenantId }),
      getStorefrontSettings: (brandId: string) =>
        request(
          `/api/v1/settings/storefront/${encodeURIComponent(brandId)}`,
          StorefrontSettingsSchema,
          { tenantId },
        ),
      upsertStorefrontSettings: ({
        brandId,
        idempotencyKey,
        ...body
      }: UpsertStorefrontSettingsInput) =>
        request(
          `/api/v1/settings/storefront/${encodeURIComponent(brandId)}`,
          StorefrontSettingsSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      getStorefrontDeliverySettings: (brandId: string) =>
        request(
          `/api/v1/settings/storefront/${encodeURIComponent(brandId)}/delivery`,
          StorefrontDeliverySettingsSchema,
          { tenantId },
        ),
      updateStorefrontDeliverySettings: ({
        brandId,
        idempotencyKey,
        ...body
      }: UpdateStorefrontDeliveryInput) =>
        request(
          `/api/v1/settings/storefront/${encodeURIComponent(brandId)}/delivery`,
          StorefrontDeliverySettingsSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      getReturnSettings: () =>
        request("/api/v1/settings/returns", ReturnSettingsSchema, { tenantId }),
      updateReturnSettings: ({ idempotencyKey, ...body }: UpdateReturnSettingsInput) =>
        request("/api/v1/settings/returns", ReturnSettingsSchema, {
          tenantId,
          method: "PUT",
          body,
          idempotencyKey,
        }),
      listDevices: (query: DeviceListQuery = {}) =>
        request(
          `/api/v1/settings/devices${buildQuery({ status: query.status, limit: query.limit, cursor: query.cursor })}`,
          DeviceListResponseSchema,
          { tenantId },
        ),
      getDevice: (deviceId: string) =>
        request(`/api/v1/settings/devices/${encodeURIComponent(deviceId)}`, DeviceSchema, {
          tenantId,
        }),
      revokeDevice: ({ deviceId, idempotencyKey, ...body }: RevokeDeviceInput) =>
        request(`/api/v1/settings/devices/${encodeURIComponent(deviceId)}/revoke`, DeviceSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      assignDevice: ({ deviceId, idempotencyKey, ...body }: AssignDeviceInput) =>
        request(
          `/api/v1/settings/devices/${encodeURIComponent(deviceId)}/assignment`,
          DeviceSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      enrollPosDevice: ({ idempotencyKey, ...body }: EnrollPosDeviceInput) =>
        request("/api/v1/pos/devices", PosDeviceResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      rotatePosDeviceCredential: ({
        idempotencyKey,
        deviceId,
        ...body
      }: RotatePosDeviceCredentialInput) =>
        request(
          `/api/v1/pos/devices/${encodeURIComponent(deviceId)}/credentials`,
          PosDeviceResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      revokePosDevice: ({ idempotencyKey, deviceId, ...body }: RevokePosDeviceInput) =>
        request(
          `/api/v1/pos/devices/${encodeURIComponent(deviceId)}/revoke`,
          PosDeviceResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      createOfflineBootstrap: ({ idempotencyKey, ...body }: OfflineBootstrapInput) =>
        request("/api/v1/pos/offline-bootstrap", OfflineBootstrapResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      ingestOfflineSale: ({ idempotencyKey, ...body }: IngestOfflineSaleInput) =>
        request("/api/v1/pos/offline-sales", IngestOfflineSaleResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      ingestOfflineCustomerPayment: ({
        idempotencyKey,
        ...body
      }: IngestOfflineCustomerPaymentInput) =>
        request(
          "/api/v1/pos/offline-customer-payments",
          IngestOfflineCustomerPaymentResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      ingestOfflineAttendance: ({ idempotencyKey, ...body }: IngestOfflineAttendanceInput) =>
        request("/api/v1/pos/offline-attendance", IngestOfflineAttendanceResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      ingestOfflineIntent: ({ idempotencyKey, ...body }: IngestOfflineIntentInput) =>
        request("/api/v1/pos/offline-intents", IngestOfflineIntentResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      issueOfflineReturnGrant: ({ idempotencyKey, ...body }: IssueOfflineReturnGrantInput) =>
        request("/api/v1/pos/offline-return-grants", OfflineReturnGrantResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      ingestOfflineSaleHold: ({ idempotencyKey, ...body }: IngestOfflineSaleHoldInput) =>
        request("/api/v1/pos/offline-sale-holds", IngestOfflineSaleHoldResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      ingestOfflineCustomer: ({ idempotencyKey, ...body }: IngestOfflineCustomerInput) =>
        request("/api/v1/pos/offline-customers", IngestOfflineCustomerResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      ingestOfflineReturn: ({ idempotencyKey, ...body }: IngestOfflineReturnInput) =>
        request("/api/v1/pos/offline-returns", IngestOfflineReturnResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
    };
  }

  return {
    posPinLogin: (body: PosLoginRequest) =>
      request("/api/v1/pos/auth/login", PosLoginResponseSchema, {
        method: "POST",
        body,
      }),
    checkout: ({ idempotencyKey, ...intent }) =>
      request("/api/v1/storefront/checkout", CheckoutResultSchema, {
        method: "POST",
        body: intent,
        idempotencyKey,
      }),
    quote: (body: StorefrontQuoteRequest) =>
      request("/api/v1/storefront/quote", StorefrontQuoteResponseSchema, {
        method: "POST",
        body,
      }),
    getHealth: () => request("/api/v1/health", HealthResponseSchema),
    getMyTenants: () => request("/api/v1/me/tenants", MeTenantsResponseSchema),
    withTenant,
    listPublishedProducts: (query: PublicCatalogListQuery) =>
      request(
        `/api/v1/storefront/products${buildQuery({
          tenantId: query.tenantId,
          brandId: query.brandId,
          limit: query.limit,
        })}`,
        PublicProductListResponseSchema,
      ),
    getPublishedProduct: (query: PublicProductQuery) =>
      request(
        `/api/v1/storefront/products/${encodeURIComponent(query.slug)}${buildQuery({
          tenantId: query.tenantId,
        })}`,
        PublicProductDetailResponseSchema,
      ),
    listPublishedCollections: (query: PublicCollectionListQuery) =>
      request(
        `/api/v1/storefront/collections${buildQuery({
          tenantId: query.tenantId,
          limit: query.limit,
        })}`,
        PublicCollectionListResponseSchema,
      ),
    getPublishedCollection: (query: PublicCollectionQuery) =>
      request(
        `/api/v1/storefront/collections/${encodeURIComponent(query.slug)}${buildQuery({
          tenantId: query.tenantId,
        })}`,
        PublicCollectionDetailResponseSchema,
      ),
    listStorefrontCategories: (query: PublicCategoryListQuery) =>
      request(
        `/api/v1/storefront/categories${buildQuery({ tenantId: query.tenantId })}`,
        PublicCategoryListResponseSchema,
      ),
    listStorefrontVendors: (query: PublicVendorListQuery) =>
      request(
        `/api/v1/storefront/vendors${buildQuery({ tenantId: query.tenantId })}`,
        PublicVendorListResponseSchema,
      ),
    listStorefrontBestSellers: (query: PublicBestSellersQuery) =>
      request(
        `/api/v1/storefront/best-sellers${buildQuery({
          tenantId: query.tenantId,
          brandId: query.brandId,
          days: query.days,
          limit: query.limit,
        })}`,
        PublicBestSellersResponseSchema,
      ),
    subscribeToStorefront: (input: StorefrontSubscribeInput) =>
      request("/api/v1/storefront/subscribe", StorefrontSubscribeResponseSchema, {
        method: "POST",
        body: input,
      }),
    trackStorefrontOrder: (input: StorefrontOrderLookup) =>
      request("/api/v1/storefront/orders/track", StorefrontTrackedOrderSchema, {
        method: "POST",
        body: input,
      }),
    getStorefrontReturnPolicy: (query: { tenantId: string }) =>
      request(
        `/api/v1/storefront/returns-policy${buildQuery({ tenantId: query.tenantId })}`,
        StorefrontReturnPolicySchema,
      ),
    requestStorefrontReturn: (input: StorefrontReturnRequestInput) =>
      request("/api/v1/storefront/return-requests", StorefrontReturnRequestResponseSchema, {
        method: "POST",
        body: input,
      }),
    getStorefrontDeliveryOptions: (query: PublicDeliveryOptionsQuery) =>
      request(
        `/api/v1/storefront/delivery${buildQuery({ tenantId: query.tenantId, brandId: query.brandId })}`,
        PublicDeliveryOptionsSchema,
      ),
    getPublicStorefrontContent: (query: PublicStorefrontContentQuery) =>
      request(
        `/api/v1/storefront/content${buildQuery({
          tenantId: query.tenantId,
          brandId: query.brandId,
        })}`,
        PublicStorefrontContentSchema,
      ),
    getPublicStorefrontSiteText: (query: { tenantId: string }) =>
      request(
        `/api/v1/storefront/site-text${buildQuery({ tenantId: query.tenantId })}`,
        PublicStorefrontSiteTextSchema,
      ),
  };
}

export type {
  HealthResponse,
  MeTenantsResponse,
  MeContextResponse,
  ProductListResponse,
  ProductDetailResponse,
  InventoryListResponse,
  ReceiveInventoryResponse,
  AdjustInventoryResponse,
  TransferInventoryResponse,
  InventoryChannelStateResponse,
  InitializeInventoryChannelsResponse,
  AllocateInventoryChannelsResponse,
  OrderListResponse,
  OrderDetailResponse,
  OrderSummary,
  FulfillOrderRequest,
  CancelOrderRequest,
  CustomerSummary,
  CustomerListResponse,
  CustomerDetailResponse,
  CustomerOrdersResponse,
  CustomerLookupResponse,
  RecordCustomerPaymentRequest,
  RecordCustomerPaymentResponse,
  CustomerPayment,
  CustomerPaymentsResponse,
  CustomerDue,
  CustomerDuesResponse,
  PosContextResponse,
  PosAvailabilityResponse,
  PosSyncConflict,
  PosSyncConflictKind,
  ListPosSyncConflictsResponse,
  CreatePosSaleResponse,
  PosDeviceResponse,
  OfflineBootstrapResponse,
  OfflineStockGrant,
  OfflineSaleCommand,
  IngestOfflineSaleResponse,
  OfflineCustomerPaymentCommand,
  IngestOfflineCustomerPaymentResponse,
  OfflineAttendanceEventType,
  OfflineAttendanceCommand,
  IngestOfflineAttendanceResponse,
  OfflineIntentOperation,
  OfflineIntentCommand,
  IngestOfflineIntentRequest,
  IngestOfflineIntentResponse,
  OfflineIntentDisposition,
  OfflineReturnGrantLine,
  IssueOfflineReturnGrantRequest,
  OfflineReturnGrantResponse,
  OfflineReturnCommand,
  IngestOfflineReturnRequest,
  OfflineReturnReconciliation,
  IngestOfflineReturnResponse,
  OfflineStaffRosterEntry,
  StaffPinVerifier,
  SetStaffOfflinePinRequest,
  SetStaffOfflinePinResponse,
  ProductWriteResponse,
  ProductUpdatedResponse,
  PublishProductResponse,
  UnpublishProductResponse,
  CreateVariantResponse,
  SetVariantPriceResponse,
  SetVariantCostResponse,
  MediaUploadIntentResponse,
  RegisterProductMediaResponse,
  ArchiveProductMediaResponse,
  PublicProduct,
  PublicProductListResponse,
  PublicProductDetailResponse,
  CollectionListResponse,
  CollectionDetailResponse,
  CollectionWriteResponse,
  CollectionUpdatedResponse,
  SetCollectionProductsResponse,
  CollectionStatus,
  PublicCollectionSummary,
  PublicCollectionListResponse,
  PublicCollectionDetail,
  PublicCollectionDetailResponse,
  StorefrontStatus,
};
import {
  ReturnDetailResponseSchema,
  ReturnEligibilityResponseSchema,
  ReturnHistoryResponseSchema,
  type CreateReturnRequest,
  type SettleRefundRequest,
  type ReturnDetailResponse,
  type ReturnEligibilityResponse,
  type ReturnHistoryResponse,
} from "../../../src/contracts/management/returns";
export type {
  CreateReturnRequest,
  SettleRefundRequest,
  ReturnDetailResponse,
  ReturnEligibilityResponse,
  ReturnHistoryResponse,
  Refund,
  OrderReturnSummary,
} from "../../../src/contracts/management/returns";
export type CreateReturnInput = CreateReturnRequest & { orderId: string; idempotencyKey: string };
export type FulfillOrderInput = FulfillOrderRequest & { orderId: string; idempotencyKey: string };
export type CancelOrderInput = CancelOrderRequest & { orderId: string; idempotencyKey: string };
export type SettleRefundInput = SettleRefundRequest & { returnId: string; idempotencyKey: string };
export * from "./forms";
export * from "./site-text";
export * from "./messages";
