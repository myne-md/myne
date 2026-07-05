// i18n bridge — forwards to the host-injected `t`. Editor files import this as a
// default object with `.t`, so their `i18n.t(...)` call sites are unchanged.
import { getHost } from "./host";
const i18n = { t: (key: string, opts?: Record<string, unknown>): string => getHost().t(key, opts) };
export default i18n;
