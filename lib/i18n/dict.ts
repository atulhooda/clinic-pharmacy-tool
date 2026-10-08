// The UI strings in the three languages, one row per key: [English, Hindi, Gujarati]
// (06a §16). An empty Hindi or Gujarati cell falls back to English.
//
// The kit's rows came across with the UI kit from Ritu Desk (desk origin/main @ 8bee594),
// where Hindi and Gujarati were drafted by the engineering side and are still marked for
// review. Rows added here start English-only. Until a native speaker has reviewed a
// language, it is not offered (ENABLED_LOCALES in ./index): no unreviewed translation
// reaches a clinic.
export const D = {
  "common.close": ["Close", "बंद करें", "બંધ કરો"],
  "common.undo": ["Undo", "पूर्ववत", "પાછું વાળો"],
  "event.undoLabel": ["Undo · {mins} min left", "पूर्ववत · {mins} मिनट बाकी", "પાછું વાળો · {mins} મિનિટ બાકી"],
  "a11y.dismiss": ["Dismiss", "हटाएँ", "કાઢી નાખો"],
  "status.active": ["Active", "", ""],
  "status.inactive": ["Inactive", "", ""],
  "status.revoked": ["Revoked", "", ""],
  "status.locked": ["Locked", "", ""],
} as const satisfies Record<string, readonly [string, string, string]>;

export type Key = keyof typeof D;
