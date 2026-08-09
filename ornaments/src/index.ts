// @myne/ornaments — the shared ornament layer (myne#394).
//
// Two things ship from here and they are deliberately the only two: the role
// contract a component declares through, and the stylesheet those roles resolve
// against. Everything else about ornament — which primitive, how strong, what
// colour — is the active theme's, arriving as CSS custom properties the host has
// already validated.
//
// The stylesheet is NOT re-exported from this module: a client imports
// `@myne/ornaments/ornaments.css` from its own entry point, the same way it
// imports its token sheet, so bundlers that treat CSS as a side effect can see it.

export {
  applyOrnamentAttributes,
  clearOrnamentAttributes,
  isOrnamentRole,
  ornamentAttr,
  ornamentAttributes,
  ORNAMENT_ON_ATTR,
  ORNAMENT_TINT_ATTR,
  ornamentRole,
  ornamentToken,
  ORNAMENT_PRIMITIVES,
  ORNAMENT_PRIMITIVE_NAMES,
  ORNAMENT_ROLES,
  ROLE_PRIMITIVES,
  roleAccepts,
  ROLE_ATTR,
  type OrnamentRole,
} from "./roles";
