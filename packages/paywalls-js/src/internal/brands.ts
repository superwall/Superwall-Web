// Internal-only branded ID types. Not part of the public contract.

import { Schema } from "effect";

export const StorageKey = Schema.String.pipe(Schema.brand("@superwall/StorageKey"));
export type StorageKey = typeof StorageKey.Type;

/** Cast a plain string into a StorageKey. Use only at the public/internal
 *  boundary or for the canonical keys defined in `types.STORAGE_KEYS`. */
export const asStorageKey = (s: string): StorageKey => s as StorageKey;

export const AliasId = Schema.String.pipe(Schema.brand("@superwall/AliasId"));
export type AliasId = typeof AliasId.Type;
export const asAliasId = (s: string): AliasId => s as AliasId;

export const UserId = Schema.String.pipe(Schema.brand("@superwall/UserId"));
export type UserId = typeof UserId.Type;
export const asUserId = (s: string): UserId => s as UserId;

export const VendorId = Schema.String.pipe(Schema.brand("@superwall/VendorId"));
export type VendorId = typeof VendorId.Type;
export const asVendorId = (s: string): VendorId => s as VendorId;

export const DeviceId = Schema.String.pipe(Schema.brand("@superwall/DeviceId"));
export type DeviceId = typeof DeviceId.Type;
export const asDeviceId = (s: string): DeviceId => s as DeviceId;
