// @superwall/paywalls-js/browser — factories for the browser environment.
// Per API.md §0 + §5 + §7.

export {
  createBrowserStorage,
  type BrowserStorageOptions,
} from "./storage.ts";
export {
  createBrowserPresenter,
  type BrowserPresenterOptions,
} from "./presenter.ts";
export {
  readCookie,
  writeCookie,
  deleteCookie,
  type CookieWriteOptions,
} from "./cookies.ts";
