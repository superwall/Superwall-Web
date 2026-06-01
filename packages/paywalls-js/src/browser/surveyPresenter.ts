// Default `SurveyPresenter` for the browser. Renders a bottom-sheet
// overlay with the survey title, message, options, and (when configured)
// an "Other" free-text input + "Close" button. Mirrors the Android
// BottomSheetDialog UX so it feels consistent with the mobile SDKs.
//
// Single survey at a time — second `present()` while the first hasn't
// resolved replaces the active sheet. The bottom sheet's z-index is well
// above typical app content (defaults to 2147482900, just below the
// `BrowserPresenterOptions` z-index so paywalls still win on collision).

import type {
  SurveyPresenter,
  SurveyPresenterOutcome,
} from "../presenter.ts";
import type { Survey } from "../types.ts";

export interface BrowserSurveyPresenterOptions {
  /** Mount point for the overlay portal. Default: `document.body`. */
  container?: HTMLElement | (() => HTMLElement);
  /** Overlay z-index. Default: 2147482900. */
  zIndex?: number;
}

const DEFAULT_Z_INDEX = 2147482900;
const ENTER_DURATION_MS = 220;
const SCRIM = "rgba(0,0,0,0.6)";

const resolveContainer = (
  options: BrowserSurveyPresenterOptions,
): HTMLElement => {
  if (options.container) {
    return typeof options.container === "function"
      ? options.container()
      : options.container;
  }
  return document.body;
};

export const createBrowserSurveyPresenter = (
  options: BrowserSurveyPresenterOptions = {},
): SurveyPresenter => {
  let activeTearDown: (() => void) | null = null;

  const present: SurveyPresenter["present"] = (survey) =>
    new Promise<SurveyPresenterOutcome>((resolve) => {
      // Replace any in-flight presentation. Caller is single-threaded
      // per register() call so this should be rare; behavior here is
      // safety, not the happy path.
      activeTearDown?.();

      if (typeof document === "undefined") {
        resolve({ type: "noShow" } as never);
        return;
      }

      const overlay = document.createElement("div");
      overlay.dataset["swSurvey"] = "overlay";
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: String(options.zIndex ?? DEFAULT_Z_INDEX),
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        background: SCRIM,
        opacity: "0",
        transition: `opacity ${ENTER_DURATION_MS}ms ease-out`,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      });

      const sheet = document.createElement("div");
      sheet.dataset["swSurvey"] = "sheet";
      Object.assign(sheet.style, {
        background: "#ffffff",
        color: "#0b0d10",
        width: "min(560px, 96vw)",
        maxHeight: "92vh",
        borderRadius: "16px 16px 0 0",
        boxShadow: "0 -16px 48px rgba(0,0,0,0.32)",
        padding: "20px 20px 12px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        transform: "translateY(100%)",
        transition: `transform ${ENTER_DURATION_MS}ms ease-out`,
      });

      const titleEl = document.createElement("h2");
      titleEl.textContent = survey.title;
      Object.assign(titleEl.style, {
        margin: "0",
        fontSize: "18px",
        fontWeight: "600",
        lineHeight: "1.3",
      });
      sheet.appendChild(titleEl);

      const messageEl = document.createElement("p");
      messageEl.textContent = survey.message;
      Object.assign(messageEl.style, {
        margin: "0 0 8px",
        fontSize: "14px",
        lineHeight: "1.45",
        color: "#46505f",
      });
      sheet.appendChild(messageEl);

      const list = document.createElement("div");
      list.dataset["swSurvey"] = "options";
      Object.assign(list.style, {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        overflow: "auto",
      });
      sheet.appendChild(list);

      let resolved = false;
      const finish = (outcome: SurveyPresenterOutcome): void => {
        if (resolved) return;
        resolved = true;
        // Slide-out animation, then remove from DOM.
        sheet.style.transform = "translateY(100%)";
        overlay.style.opacity = "0";
        const remove = (): void => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        };
        setTimeout(remove, ENTER_DURATION_MS);
        activeTearDown = null;
        resolve(outcome);
      };

      const makeButton = (
        label: string,
        kind: "option" | "close",
        onClick: () => void,
      ): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        Object.assign(btn.style, {
          appearance: "none",
          background: kind === "close" ? "transparent" : "#f3f5f9",
          color: kind === "close" ? "#46505f" : "#0b0d10",
          border: kind === "close" ? "0" : "1px solid #d8dde4",
          borderRadius: "10px",
          padding: "12px 14px",
          font: "inherit",
          fontSize: "15px",
          textAlign: "left",
          cursor: "pointer",
        });
        btn.addEventListener("click", onClick);
        return btn;
      };

      // Standard options. Match Android: preserve declared order (iOS
      // shuffles; we deliberately don't, since deterministic order is
      // easier to reason about across mobile and web).
      for (const option of survey.options) {
        list.appendChild(
          makeButton(option.title, "option", () =>
            finish({
              type: "answered",
              answer: {
                survey,
                selectedOption: { id: option.id, title: option.title },
                customResponse: null,
              },
            }),
          ),
        );
      }

      if (survey.includeOtherOption) {
        list.appendChild(
          makeButton("Other", "option", () => {
            mountOtherInput();
          }),
        );
      }

      if (survey.includeCloseOption) {
        list.appendChild(
          makeButton("Close", "close", () => finish({ type: "closed" })),
        );
      }

      // Free-text capture for the Other path. Mirrors Android's
      // AlertDialog with an enable-on-non-empty Submit button.
      const mountOtherInput = (): void => {
        list.replaceChildren();
        const input = document.createElement("textarea");
        input.placeholder = "Your response";
        input.rows = 3;
        Object.assign(input.style, {
          width: "100%",
          padding: "10px",
          borderRadius: "10px",
          border: "1px solid #d8dde4",
          font: "inherit",
          fontSize: "15px",
          resize: "vertical",
        });
        list.appendChild(input);

        const actions = document.createElement("div");
        Object.assign(actions.style, {
          display: "flex",
          justifyContent: "flex-end",
          gap: "8px",
        });
        const submit = makeButton("Submit", "option", () => {
          const text = input.value.trim();
          if (!text) return;
          finish({
            type: "answered",
            answer: {
              survey,
              selectedOption: { id: "000", title: "Other" },
              customResponse: text,
            },
          });
        });
        submit.disabled = true;
        Object.assign(submit.style, {
          opacity: "0.5",
          cursor: "not-allowed",
        });
        input.addEventListener("input", () => {
          const enabled = input.value.trim().length > 0;
          submit.disabled = !enabled;
          submit.style.opacity = enabled ? "1" : "0.5";
          submit.style.cursor = enabled ? "pointer" : "not-allowed";
        });
        actions.appendChild(submit);
        list.appendChild(actions);
        setTimeout(() => input.focus(), 0);
      };

      overlay.appendChild(sheet);
      const container = resolveContainer(options);
      container.appendChild(overlay);

      activeTearDown = () => {
        if (resolved) return;
        finish({ type: "dismissed" });
      };

      // Animate in.
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(() => {
          overlay.style.opacity = "1";
          sheet.style.transform = "translateY(0)";
        });
      } else {
        overlay.style.opacity = "1";
        sheet.style.transform = "translateY(0)";
      }
    });

  return { present };
};
