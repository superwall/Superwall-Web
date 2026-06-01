// SurveyManager — pure logic for picking + gating survey presentation.
// UI is delegated to a SurveyPresenter (browser/surveyPresenter.ts ships
// the default DOM bottom-sheet impl).
//
// Mirrors Android `SurveyManager.kt` / iOS `SurveyManager.swift`:
//   1. selectSurvey: first survey whose presentationCondition matches.
//      ON_MANUAL_CLOSE  → result === "declined" && closeReason === "manualClose"
//      ON_PURCHASE      → result === "purchased"
//   2. hasSeenSurvey: storage[surveyAssignmentKey] === survey.assignmentKey
//   3. shouldAssignHoldout: probability gate (0 = always holdout;
//      >= randomNumber rolls the dice).
//   4. Storage write happens BEFORE presenting so a holdout still
//      writes — same key won't be re-evaluated either way.

import type {
  PaywallCloseReason,
  PaywallResult,
  Survey,
  SurveyPresentationResult,
} from "../types.ts";

export interface SurveyHostStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
}

export interface SurveyAnswer {
  readonly survey: Survey;
  readonly selectedOption: { id: string; title: string };
  readonly customResponse: string | null;
}

export type SurveyPresenterOutcome =
  | { type: "answered"; answer: SurveyAnswer }
  | { type: "closed" }
  | { type: "dismissed" };

export interface SurveyPresenter {
  present(survey: Survey): Promise<SurveyPresenterOutcome>;
}

/**
 * Random source for holdout selection. Returns a number in `[0, 1)`.
 * Swappable in tests for deterministic outcomes.
 */
export type SurveyRandom = () => number;

const defaultRandom: SurveyRandom = () => Math.random();

/**
 * Pick the first survey whose presentation condition matches the
 * paywall's outcome. Returns `null` when no survey applies.
 */
export const selectSurvey = (
  surveys: ReadonlyArray<Survey>,
  result: PaywallResult,
  closeReason: PaywallCloseReason,
): Survey | null => {
  const isPurchased = result.type === "purchased";
  const isDeclined = result.type === "declined";
  const isManualClose = closeReason === "manualClose";
  for (const s of surveys) {
    if (s.presentationCondition === "ON_MANUAL_CLOSE") {
      if (isDeclined && isManualClose) return s;
    } else if (s.presentationCondition === "ON_PURCHASE") {
      if (isPurchased) return s;
    }
  }
  return null;
};

/**
 * Returns `true` when the user has already been bucketed for this survey
 * (`assignmentKey` previously persisted), regardless of whether they were
 * shown the survey or placed in the holdout group.
 */
export const hasSeenSurvey = async (
  survey: Survey,
  storage: SurveyHostStorage,
  storageKey: string,
): Promise<boolean> => {
  const existing = await storage.get(storageKey);
  return existing === survey.assignmentKey;
};

/**
 * Probability gate. Returns `true` when the user falls in the holdout
 * group (do not present). `presentationProbability === 0` → always
 * holdout. `presentationProbability === 1` → never holdout.
 */
export const shouldAssignHoldout = (
  survey: Survey,
  random: SurveyRandom = defaultRandom,
): boolean => {
  if (survey.presentationProbability <= 0) return true;
  if (survey.presentationProbability >= 1) return false;
  return random() >= survey.presentationProbability;
};

export interface PresentSurveyInput {
  readonly surveys: ReadonlyArray<Survey>;
  readonly result: PaywallResult;
  readonly closeReason: PaywallCloseReason;
  readonly storage: SurveyHostStorage;
  readonly storageKey: string;
  readonly presenter: SurveyPresenter;
  readonly random?: SurveyRandom;
  readonly onResponse: (answer: SurveyAnswer) => void;
  readonly onClose: (survey: Survey) => void;
}

/**
 * Orchestrate the full present-if-applicable flow.
 *
 * Steps:
 *   1. Pick a matching survey (or bail with `"noShow"`).
 *   2. Skip if already seen (`assignmentKey` collision in storage).
 *   3. Persist the `assignmentKey` BEFORE deciding holdout / presenting
 *      so we never re-evaluate the same survey for the same user.
 *   4. Roll the probability dice. Holdout → `"holdout"`.
 *   5. Render via the presenter. On `answered`, fire `onResponse`;
 *      on `closed`, fire `onClose`. Both return `"show"`.
 *
 * Implementation note: matches Android exactly. Storage write order
 * (step 3 before step 4) means even a holdout consumes the assignment
 * — that's intentional, both per the mobile SDK contract.
 */
export const presentSurveyIfAvailable = async (
  input: PresentSurveyInput,
): Promise<SurveyPresentationResult> => {
  const survey = selectSurvey(input.surveys, input.result, input.closeReason);
  if (!survey) return "noShow";
  if (await hasSeenSurvey(survey, input.storage, input.storageKey)) {
    return "noShow";
  }
  // Persist BEFORE presenting so we never double-evaluate.
  try {
    await input.storage.set(input.storageKey, survey.assignmentKey);
  } catch {
    // Storage failure is non-fatal — proceed with presentation.
  }
  if (shouldAssignHoldout(survey, input.random)) {
    return "holdout";
  }
  let outcome: SurveyPresenterOutcome;
  try {
    outcome = await input.presenter.present(survey);
  } catch {
    return "noShow";
  }
  if (outcome.type === "answered") {
    try {
      input.onResponse(outcome.answer);
    } catch {}
    return "show";
  }
  if (outcome.type === "closed") {
    try {
      input.onClose(survey);
    } catch {}
    return "show";
  }
  return "show";
};
