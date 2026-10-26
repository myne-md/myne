// Re-export shim. The account-number display logic (both the entry mask and the
// person-number formatter) lives in `@myne/client-core/person-account`, shared
// with mobile and web, so the three clients cannot group a number differently.
export * from "@myne/client-core/person-account";
