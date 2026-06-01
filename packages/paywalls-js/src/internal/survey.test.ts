import { describe, expect, test } from "bun:test";
import {
  hasSeenSurvey,
  presentSurveyIfAvailable,
  selectSurvey,
  shouldAssignHoldout,
  type SurveyHostStorage,
  type SurveyPresenter,
} from "./survey.ts";
import type {
  PaywallCloseReason,
  PaywallResult,
  Survey,
  SurveyOption,
} from "../types.ts";

const opt = (id: string, title: string): SurveyOption => ({ id, title });

const survey = (overrides: Partial<Survey> = {}): Survey => ({
  id: "s_1",
  assignmentKey: "ak_1",
  title: "Why are you leaving?",
  message: "Pick one",
  options: [opt("a", "Too expensive"), opt("b", "Already paying")],
  presentationCondition: "ON_MANUAL_CLOSE",
  presentationProbability: 1,
  includeOtherOption: false,
  includeCloseOption: false,
  ...overrides,
});

const memoryStorage = (): SurveyHostStorage & { snapshot: () => Record<string, string> } => {
  const store = new Map<string, string>();
  return {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
    snapshot: () => Object.fromEntries(store),
  };
};

const declined: PaywallResult = { type: "declined" };
const purchased: PaywallResult = { type: "purchased", productId: "p_1" };
const restored: PaywallResult = { type: "restored" };
const manual: PaywallCloseReason = "manualClose";
const systemLogic: PaywallCloseReason = "systemLogic";

describe("selectSurvey", () => {
  test("ON_MANUAL_CLOSE matches declined + manualClose", () => {
    const s = survey({ presentationCondition: "ON_MANUAL_CLOSE" });
    expect(selectSurvey([s], declined, manual)).toBe(s);
  });

  test("ON_MANUAL_CLOSE rejects programmatic close", () => {
    const s = survey({ presentationCondition: "ON_MANUAL_CLOSE" });
    expect(selectSurvey([s], declined, systemLogic)).toBeNull();
  });

  test("ON_MANUAL_CLOSE rejects purchased result", () => {
    const s = survey({ presentationCondition: "ON_MANUAL_CLOSE" });
    expect(selectSurvey([s], purchased, manual)).toBeNull();
  });

  test("ON_PURCHASE matches purchased result", () => {
    const s = survey({ presentationCondition: "ON_PURCHASE" });
    expect(selectSurvey([s], purchased, systemLogic)).toBe(s);
  });

  test("ON_PURCHASE rejects restored result", () => {
    const s = survey({ presentationCondition: "ON_PURCHASE" });
    expect(selectSurvey([s], restored, systemLogic)).toBeNull();
  });

  test("returns first matching survey when multiple defined", () => {
    const a = survey({ id: "a", presentationCondition: "ON_PURCHASE" });
    const b = survey({
      id: "b",
      assignmentKey: "ak_2",
      presentationCondition: "ON_MANUAL_CLOSE",
    });
    expect(selectSurvey([a, b], declined, manual)).toBe(b);
  });

  test("empty surveys → null", () => {
    expect(selectSurvey([], declined, manual)).toBeNull();
  });
});

describe("hasSeenSurvey", () => {
  test("false when storage empty", async () => {
    const storage = memoryStorage();
    expect(await hasSeenSurvey(survey(), storage, "k")).toBe(false);
  });

  test("true when storage holds matching assignmentKey", async () => {
    const storage = memoryStorage();
    await storage.set("k", "ak_1");
    expect(await hasSeenSurvey(survey(), storage, "k")).toBe(true);
  });

  test("false when storage holds a different assignmentKey", async () => {
    const storage = memoryStorage();
    await storage.set("k", "ak_OTHER");
    expect(await hasSeenSurvey(survey(), storage, "k")).toBe(false);
  });
});

describe("shouldAssignHoldout", () => {
  test("probability=0 always holdout", () => {
    expect(shouldAssignHoldout(survey({ presentationProbability: 0 }))).toBe(true);
  });

  test("probability=1 never holdout", () => {
    expect(shouldAssignHoldout(survey({ presentationProbability: 1 }))).toBe(false);
  });

  test("random above probability → holdout", () => {
    const s = survey({ presentationProbability: 0.5 });
    expect(shouldAssignHoldout(s, () => 0.9)).toBe(true);
  });

  test("random below probability → present", () => {
    const s = survey({ presentationProbability: 0.5 });
    expect(shouldAssignHoldout(s, () => 0.1)).toBe(false);
  });

  test("random at exactly probability → holdout (>= boundary)", () => {
    const s = survey({ presentationProbability: 0.5 });
    expect(shouldAssignHoldout(s, () => 0.5)).toBe(true);
  });
});

const recordingPresenter = (
  outcome: Parameters<SurveyPresenter["present"]>[0] extends infer _
    ? Awaited<ReturnType<SurveyPresenter["present"]>>
    : never,
): { presenter: SurveyPresenter; calls: Survey[] } => {
  const calls: Survey[] = [];
  return {
    presenter: {
      present: async (s) => {
        calls.push(s);
        return outcome;
      },
    },
    calls,
  };
};

describe("presentSurveyIfAvailable", () => {
  test("noShow when no survey matches", async () => {
    const storage = memoryStorage();
    const { presenter, calls } = recordingPresenter({ type: "closed" });
    const r = await presentSurveyIfAvailable({
      surveys: [survey({ presentationCondition: "ON_PURCHASE" })],
      result: declined,
      closeReason: manual,
      storage,
      storageKey: "k",
      presenter,
      onResponse: () => {},
      onClose: () => {},
    });
    expect(r).toBe("noShow");
    expect(calls).toHaveLength(0);
    expect(storage.snapshot()).toEqual({});
  });

  test("noShow when survey already seen (no presenter call, no re-write)", async () => {
    const storage = memoryStorage();
    await storage.set("k", "ak_1");
    const { presenter, calls } = recordingPresenter({ type: "closed" });
    const r = await presentSurveyIfAvailable({
      surveys: [survey()],
      result: declined,
      closeReason: manual,
      storage,
      storageKey: "k",
      presenter,
      onResponse: () => {},
      onClose: () => {},
    });
    expect(r).toBe("noShow");
    expect(calls).toHaveLength(0);
  });

  test("holdout writes assignmentKey but does not call presenter", async () => {
    const storage = memoryStorage();
    const { presenter, calls } = recordingPresenter({ type: "closed" });
    const r = await presentSurveyIfAvailable({
      surveys: [survey({ presentationProbability: 0 })],
      result: declined,
      closeReason: manual,
      storage,
      storageKey: "k",
      presenter,
      random: () => 0.5,
      onResponse: () => {},
      onClose: () => {},
    });
    expect(r).toBe("holdout");
    expect(calls).toHaveLength(0);
    expect(storage.snapshot()).toEqual({ k: "ak_1" });
  });

  test("answered → onResponse fires with the typed answer", async () => {
    const storage = memoryStorage();
    const responses: Array<{
      id: string;
      title: string;
      custom: string | null;
    }> = [];
    const { presenter } = recordingPresenter({
      type: "answered",
      answer: {
        survey: survey(),
        selectedOption: { id: "a", title: "Too expensive" },
        customResponse: null,
      },
    });
    const r = await presentSurveyIfAvailable({
      surveys: [survey()],
      result: declined,
      closeReason: manual,
      storage,
      storageKey: "k",
      presenter,
      onResponse: (answer) =>
        responses.push({
          id: answer.selectedOption.id,
          title: answer.selectedOption.title,
          custom: answer.customResponse,
        }),
      onClose: () => {},
    });
    expect(r).toBe("show");
    expect(responses).toEqual([{ id: "a", title: "Too expensive", custom: null }]);
    expect(storage.snapshot()).toEqual({ k: "ak_1" });
  });

  test("closed → onClose fires with the survey", async () => {
    const storage = memoryStorage();
    const closes: string[] = [];
    const { presenter } = recordingPresenter({ type: "closed" });
    const r = await presentSurveyIfAvailable({
      surveys: [survey()],
      result: declined,
      closeReason: manual,
      storage,
      storageKey: "k",
      presenter,
      onResponse: () => {},
      onClose: (s) => closes.push(s.id),
    });
    expect(r).toBe("show");
    expect(closes).toEqual(["s_1"]);
  });

  test("presenter throws → show outcome with no event side-effects", async () => {
    const storage = memoryStorage();
    let responseFired = false;
    let closeFired = false;
    const presenter: SurveyPresenter = {
      present: async () => {
        throw new Error("boom");
      },
    };
    const r = await presentSurveyIfAvailable({
      surveys: [survey()],
      result: declined,
      closeReason: manual,
      storage,
      storageKey: "k",
      presenter,
      onResponse: () => {
        responseFired = true;
      },
      onClose: () => {
        closeFired = true;
      },
    });
    expect(r).toBe("noShow");
    expect(responseFired).toBe(false);
    expect(closeFired).toBe(false);
    // Assignment key was already consumed before presenter ran — matches Android.
    expect(storage.snapshot()).toEqual({ k: "ak_1" });
  });
});
