// @superwall/paywalls-js/browser — factories for the browser environment.

export {
  createBrowserStorage,
  type BrowserStorageOptions,
} from "./storage.ts";
export {
  createBrowserPresenter,
  type BrowserPresenterOptions,
} from "./presenter.ts";
export {
  createBrowserSurveyPresenter,
  type BrowserSurveyPresenterOptions,
} from "./surveyPresenter.ts";
export {
  readCookie,
  writeCookie,
  deleteCookie,
  type CookieWriteOptions,
} from "./cookies.ts";
