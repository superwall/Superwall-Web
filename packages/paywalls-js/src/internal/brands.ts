// Internal-only branded ID types. Not part of the public contract.

import { Schema } from "effect";

export const StorageKey = Schema.String.pipe(Schema.brand("@superwall/StorageKey"));
export type StorageKey = typeof StorageKey.Type;

/** Cast a plain string into a StorageKey. Use only at the public/internal
 *  boundary or for the canonical keys defined in `types.STORAGE_KEYS`. */
export const asStorageKey = (s: string): StorageKey =>
  Schema.decodeUnknownSync(StorageKey)(s);

export const AliasId = Schema.String.pipe(Schema.brand("@superwall/AliasId"));
export type AliasId = typeof AliasId.Type;
export const asAliasId = (s: string): AliasId =>
  Schema.decodeUnknownSync(AliasId)(s);

export const UserId = Schema.String.pipe(Schema.brand("@superwall/UserId"));
export type UserId = typeof UserId.Type;
export const asUserId = (s: string): UserId =>
  Schema.decodeUnknownSync(UserId)(s);

export const VendorId = Schema.String.pipe(Schema.brand("@superwall/VendorId"));
export type VendorId = typeof VendorId.Type;
export const asVendorId = (s: string): VendorId =>
  Schema.decodeUnknownSync(VendorId)(s);

export const DeviceId = Schema.String.pipe(Schema.brand("@superwall/DeviceId"));
export type DeviceId = typeof DeviceId.Type;
export const asDeviceId = (s: string): DeviceId =>
  Schema.decodeUnknownSync(DeviceId)(s);

export const TransactionId = Schema.String.pipe(Schema.brand("@superwall/TransactionId"));
export type TransactionId = typeof TransactionId.Type;
export const asTransactionId = (s: string): TransactionId =>
  Schema.decodeUnknownSync(TransactionId)(s);

export const ProductIdentifier = Schema.String.pipe(Schema.brand("@superwall/ProductIdentifier"));
export type ProductIdentifier = typeof ProductIdentifier.Type;
export const asProductIdentifier = (s: string): ProductIdentifier =>
  Schema.decodeUnknownSync(ProductIdentifier)(s);

export const PresentationId = Schema.String.pipe(Schema.brand("@superwall/PresentationId"));
export type PresentationId = typeof PresentationId.Type;
export const asPresentationId = (s: string): PresentationId =>
  Schema.decodeUnknownSync(PresentationId)(s);
