'use client';

import { createContext, useContext, useMemo } from 'react';
import { t as translate, type Key, type Locale } from './index';

const Ctx = createContext<Locale>('en');

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <Ctx.Provider value={locale}>{children}</Ctx.Provider>;
}

/** const { t, locale } = useT(); t("common.close") */
export function useT() {
  const locale = useContext(Ctx);
  return useMemo(() => ({
    locale,
    t: (key: Key | string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    indic: locale !== 'en',
  }), [locale]);
}
